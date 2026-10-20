import { mkdir, open, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { modelDirectory, atomicJson } from './store.js';

export const models = {
    whisper: { repository: 'ggerganov/whisper.cpp', file: 'ggml-large-v3.bin', label: 'Whisper large-v3' },
    llama: { repository: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', label: 'Qwen3 4B Q4_K_M' },
    formatter: { repository: 'spokenly/cleanup-1-gguf', file: 'cleanup-1-q8_0.gguf', label: 'Spokenly Cleanup 1 · 0.6B Q8' },
    'formatter-quality': { repository: 'justusraw/Qwen3.5-4B-Parakeet-formatter', file: 'Qwen3.5-4B-dictation-v3-MTP-Q4_K_M.gguf', label: 'Qwen3.5 4B dictation fine-tune' },
    'dictation-whisper': { repository: 'ggerganov/whisper.cpp', file: 'ggml-large-v3-turbo.bin', label: "Whisper large-v3-turbo for dictation" },
};

export async function installModel(kind: keyof typeof models, progress: (received: number, total: number) => void, signal?: AbortSignal): Promise<string> {
    const model = models[kind];
    await mkdir(modelDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(modelDirectory, model.file);
    if (existsSync(target)) return target;
    const metadataResponse = await fetch('https://huggingface.co/api/models/' + model.repository + '?blobs=true', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!metadataResponse.ok) throw new Error("Model metadata unavailable (HTTP " + metadataResponse.status + ').');
    const metadata = await metadataResponse.json() as { sha: string; siblings: { rfilename: string; lfs?: { sha256: string; size: number } }[] };
    const published = metadata.siblings.find(item => item.rfilename === model.file)?.lfs;
    if (!published?.sha256 || !/^[a-f0-9]{40}$/.test(metadata.sha)) throw new Error("Published checksum missing. Download canceled.");
    const url = 'https://huggingface.co/' + model.repository + '/resolve/' + metadata.sha + '/' + model.file;
    const temp = target + '.' + randomUUID() + '.part';
    const file = await open(temp, 'wx', 0o600);
    const hash = createHash('sha256');
    let received = 0;
    const controller = new AbortController();
    const downloadSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const range = async (start: number, end: number): Promise<Buffer> => {
        for (let attempt = 0; ; attempt++) {
            try {
                downloadSignal.throwIfAborted();
                const response = await fetch(url + '?download=true&part=' + start, { headers: { Range: 'bytes=' + start + '-' + end },
                    signal: AbortSignal.any([downloadSignal, AbortSignal.timeout(60_000)]) });
                if (response.status !== 206 || response.headers.get('content-range') !== 'bytes ' + start + '-' + end + '/' + published.size) {
                    await response.body?.cancel();
                    throw new Error("Model download returned an invalid byte range (HTTP " + response.status + ').');
                }
                const data = Buffer.from(await response.arrayBuffer());
                if (data.length !== end - start + 1) throw new Error("Model download was interrupted.");
                return data;
            } catch (error) { downloadSignal.throwIfAborted(); if (attempt === 2) throw error; }
        }
    };
    try {
        while (received < published.size) {
            // Bounded range requests survive CDNs that truncate large responses.
            const requests: Promise<Buffer>[] = [];
            const block = 16 * 1024 * 1024;
            for (let start = received; start < Math.min(published.size, received + block * 4); start += block) requests.push(range(start, Math.min(published.size, start + block) - 1));
            const results = await Promise.allSettled(requests);
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
            for (const result of results) {
                if (result.status !== 'fulfilled') continue;
                const chunk = result.value;
                hash.update(chunk);
                let offset = 0;
                while (offset < chunk.length) {
                    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
                    if (!bytesWritten) throw new Error("Could not write model file.");
                    offset += bytesWritten;
                }
                received += chunk.length;
                progress(received, published.size);
            }
        }
        if (received !== published.size || hash.digest('hex') !== published.sha256) throw new Error("Model size or SHA-256 mismatch (" + received + ' / ' + published.size + ' Bytes).');
        await file.sync();
        await file.close();
        await rename(temp, target);
        await atomicJson(target + '.json', { repository: model.repository, revision: metadata.sha, sha256: published.sha256, size: received });
        return target;
    } catch (error) {
        controller.abort();
        await file.close().catch(() => {});
        await rm(temp, { force: true });
        throw error;
    }
}
