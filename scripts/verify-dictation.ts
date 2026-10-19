// macOS integration check. Uses synthetic speech and restores every clipboard item/type.
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { preserveClipboard } from './clipboard-qa.js';

if (process.platform !== 'darwin') throw new Error('This integration check requires macOS.');

const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-dictation-verify-'));
process.env.SYLLOOM_HOME = root;
const { defaults, atomicJson } = await import('../src/store.js');
const { DictationService, dictationDirectory, dictations } = await import('../src/dictation.js');
const config = { ...defaults, language: 'de',
    whisperModel: fileURLToPath(new URL('../data/models/ggml-large-v3.bin', import.meta.url)),
    dictationWhisperModel: fileURLToPath(new URL('../data/models/ggml-large-v3-turbo.bin', import.meta.url)),
    dictationModel: fileURLToPath(new URL('../data/models/Qwen3.5-4B-dictation-v3-MTP-Q4_K_M.gguf', import.meta.url)),
};
const service = new DictationService(config);
const restore = preserveClipboard();
try {
    const aiff = path.join(root, 'speech.aiff');
    const wav = path.join(root, 'speech.wav');
    const raw = 'Hallo Sam, ich schicke dir den Export morgen, nein, am Donnerstag. Neuer Absatz. Bitte prüfe die doppelten Rechnungen und die fehlenden Kundennummern. Der Produktivlauf bleibt pausiert.';
    for (const [binary, args] of [
        ['say', ['-v', 'Anna (German (Germany))', '-r', '180', '-o', aiff, raw]],
        ['ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1', wav]],
    ] as [string, string[]][]) {
        const result = spawnSync(binary, args, { encoding: 'utf8' });
        if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
    }
    const item = { id: randomUUID(), name: 'Synthetic dictation', startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), state: 'stopped' as const, decision: null, recovered: false, events: [], format: 'message' as const };
    const directory = dictationDirectory(item.id); await mkdir(path.join(directory, 'chunks'), { recursive: true });
    await copyFile(wav, path.join(directory, 'mic.wav')); await atomicJson(path.join(directory, 'session.json'), item);
    service.on('update', () => console.log(service.message));
    const start = Date.now(); await service.retry(item);
    assert.equal(service.state, 'ready', service.message);
    const saved = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
    assert.equal(saved.delivery.kind, 'clipboard', 'History retries never insert into an app');
    assert.match(saved.text, /Donnerstag/); assert.doesNotMatch(saved.text, /morgen|neuer Absatz/i);
    assert.match(saved.text, /\n\n/); assert.match(saved.text, /pausiert/);
    assert.match(saved.raw, /Sam/); assert.ok(saved.copiedAt);
    const clipboard = spawnSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
    assert.equal(clipboard.status, 0); assert.equal(clipboard.stdout, saved.text);
    console.log(JSON.stringify({ audioToClipboard: true, ms: Date.now() - start, timings: saved.timings, text: saved.text }, null, 2));
    await service.releaseModels();
    const failed = new DictationService({ ...config, dictationPolish: 'always', dictationModel: path.join(root, 'missing-formatter.gguf') });
    try {
        const original = 'Bitte Sam den geprüften Export schicken.';
        const broken = { ...item, id: randomUUID(), raw: original };
        await atomicJson(path.join(dictationDirectory(broken.id), 'session.json'), broken);
        await failed.retry(broken);
        const retained = JSON.parse(await readFile(path.join(dictationDirectory(broken.id), 'session.json'), 'utf8'));
        assert.equal(retained.outcome, 'failed'); assert.equal(retained.raw, original); assert.equal(retained.delivery.raw, true);
        assert.equal(spawnSync('/usr/bin/pbpaste', [], { encoding: 'utf8' }).stdout, original);
        console.log(JSON.stringify({ formatterFailureRetainsTranscript: true, originalTextClipboardFallback: true, historyRetriesCopyOnly: true }));
    } finally { await failed.close(); }
    if (process.argv.includes('--audio')) {
        const children = () => spawnSync('ps', ['-axo', 'ppid=,comm='], { encoding: 'utf8' }).stdout
            .split('\n').filter(line => Number(line.trim().split(/\s+/)[0]) === process.pid && /(?:whisper|llama)-server$/.test(line));
        const capture = new DictationService(config);
        try {
            const starting = capture.toggle();
            await capture.cancel(); await starting;
            assert.equal(capture.state, 'idle'); assert.equal(children().length, 0);

            await capture.toggle(); assert.equal(capture.state, 'recording', capture.message);
            await delay(3500);
            assert.equal(children().length, 2, 'Both local models should preload while the microphone records');
            assert.equal(capture.current?.raw, undefined);
            assert.deepEqual(await readdir(path.join(dictationDirectory(capture.current!.id), 'chunks')), [], 'No transcription before stop');
            await capture.cancel(); assert.equal(capture.state, 'idle'); assert.equal(children().length, 0);
            assert.equal((await dictations()).filter(item => item.outcome === 'canceled').length, 2, 'Every canceled capture remains in Library');

            await capture.toggle(); assert.equal(capture.state, 'recording', capture.message);
            await capture.close(); assert.equal(children().length, 0);
            assert.equal((await dictations()).find(item => item.id === capture.current?.id)?.outcome, 'interrupted');
            console.log(JSON.stringify({ microphonePrewarm: true, noTranscriptionDuringCapture: true, cancelAndShutdownReleaseModels: true }));
        } finally { await capture.close(); }
    }
} finally {
    await service.close(); restore(); await rm(root, { recursive: true, force: true });
}
