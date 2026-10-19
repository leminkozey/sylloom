// Compare the old cold pipeline with optimized cold and repeated dictations.
// Synthetic speech only; all clipboard items/types are restored afterwards.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { preserveClipboard } from './clipboard-qa.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-latency-'));
process.env.SYLLOOM_HOME = root;
const { defaults, atomicJson } = await import('../src/store.js');
const { DictationService, dictationDirectory } = await import('../src/dictation.js');
const config = { ...defaults, language: 'de',
    whisperModel: fileURLToPath(new URL('../data/models/ggml-large-v3.bin', import.meta.url)),
    dictationWhisperModel: fileURLToPath(new URL('../data/models/ggml-large-v3-turbo.bin', import.meta.url)),
    dictationModel: fileURLToPath(new URL('../data/models/Qwen3.5-4B-dictation-v3-MTP-Q4_K_M.gguf', import.meta.url)),
};
const restore = preserveClipboard();
const results: unknown[] = [];
try {
    for (const sample of [
        { name: 'Message', text: 'Hallo Sam. Der Import bleibt pausiert. Ich prüfe die Kundennummer morgen.', check: /pausiert/ },
        { name: 'Correction and paragraphs', text: 'Hallo Sam, ich schicke dir den Export morgen, nein, am Donnerstag. Neuer Absatz. Bitte prüfe die doppelten Rechnungen und die fehlenden Kundennummern. Der Produktivlauf bleibt pausiert.', check: /Donnerstag/ },
    ]) {
        const aiff = path.join(root, 'speech.aiff'); const wav = path.join(root, 'speech.wav');
        for (const [binary, args] of [
            ['say', ['-v', 'Anna (German (Germany))', '-r', '180', '-o', aiff, sample.text]],
            ['ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1', wav]],
        ] as [string, string[]][]) {
            const result = spawnSync(binary, args, { encoding: 'utf8' });
            if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
        }
        for (const variant of ['before', 'optimized'] as const) {
            const selected = variant === 'before' ? { ...config, dictationWhisperModel: config.whisperModel, dictationPolish: 'always' as const, dictationWarmSeconds: 0 } : config;
            const service = new DictationService(selected);
            try {
                for (let pass = 0; pass < (variant === 'before' ? 1 : 2); pass++) {
                    const item = { id: randomUUID(), name: sample.name, startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), state: 'stopped' as const, decision: null, recovered: false, events: [], format: 'message' as const };
                    const directory = dictationDirectory(item.id); await mkdir(path.join(directory, 'chunks'), { recursive: true });
                    await copyFile(wav, path.join(directory, 'mic.wav')); await atomicJson(path.join(directory, 'session.json'), item);
                    const start = performance.now(); await service.retry(item);
                    assert.equal(service.state, 'ready', service.message);
                    const saved = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
                    assert.match(saved.text, sample.check);
                    if (sample.name.includes('Correction')) { assert.doesNotMatch(saved.text, /morgen|neuer Absatz/i); assert.match(saved.text, /\n\n/); }
                    const result = { sample: sample.name, variant, pass, ms: Math.round(performance.now() - start), timings: saved.timings, text: saved.text };
                    results.push(result); console.log(JSON.stringify(result));
                }
            } finally { await service.close(); }
        }
    }
    const output = fileURLToPath(new URL('../data/latency-qa/comparison.json', import.meta.url));
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(results, null, 2));
} finally { restore(); await rm(root, { recursive: true, force: true }); }
