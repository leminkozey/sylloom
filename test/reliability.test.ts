import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from '../src/types.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-reliability-'));
process.env.SYLLOOM_HOME = root;
const { defaults, sessionDirectory, saveSession } = await import('../src/store.js');
const { Recorder } = await import('../src/recorder.js');
const { ModelServer } = await import('../src/server.js');
const { Transcription } = await import('../src/transcription.js');
const { finishSession } = await import('../src/workflow.js');
const { WavWriter, RATE } = await import('../src/wav.js');
const { parseFormatted, dictationParagraphs } = await import('../src/formatter.js');
const { DictationService, dictationDirectory, dictations } = await import('../src/dictation.js');

const session = (): Session => ({ id: randomUUID(), name: 'Test', state: 'recording', startedAt: new Date().toISOString(), stoppedAt: null, decision: null, recovered: false, events: [] });

test('concurrent recorder controls preserve hardware and metadata state', async () => {
    const item = session();
    const recorder = new Recorder(item, { ...defaults }, { save: async () => {} });
    const commands: { command: string; gain?: number }[] = [];
    recorder.audio.request = async <T>(command: string, _source?: unknown, _device?: unknown, gain?: number) => {
        await new Promise(resolve => setTimeout(resolve, 5)); commands.push({ command, gain }); return undefined as T;
    };
    try {
        await Promise.all([recorder.toggleMute('mic'), recorder.toggleMute('mic')]);
        assert.deepEqual(commands.map(item => item.gain), [0, 1]);
        assert.equal(recorder.muted.mic, false);
        commands.length = 0;
        await Promise.all([recorder.pause(true), recorder.pause(true), recorder.pause(false)]);
        assert.deepEqual(commands.map(item => item.command), ['pause', 'resume']);
        assert.equal(item.state, 'recording');
        await recorder.stop();
        await assert.rejects(recorder.pause(), /stopping/);
        assert.equal(item.state, 'stopped');
    } finally { await recorder.stop(); }
});

test('mic-only capture never opens system audio and closes a valid WAV', async () => {
    const directory = path.join(root, 'mic-only'); await mkdir(directory);
    const recorder = new Recorder(session(), { ...defaults }, { sources: ['mic'], directory, save: async () => {} });
    const starts: string[] = [];
    recorder.audio.devices = async () => [{ id: 'test-mic', name: 'Test', sourceKind: 'mic', isDefault: true, formatAvailable: true, channels: 1, sampleRate: 48000, isLoopback: false }];
    recorder.audio.request = async <T>(command: string, source?: string) => { if (command === 'start') starts.push(source!); return undefined as T; };
    try {
        await recorder.start();
        recorder.audio.emit('pcm', { source: 'mic', pcm: new Uint8Array(640), frame: 0, flags: 0, rms: 0, at: Date.now(), dropped: 0 });
        await recorder.stop();
        assert.deepEqual(starts, ['mic']);
        const wav = await readFile(path.join(directory, 'mic.wav'));
        assert.equal(wav.readUInt32LE(40), wav.length - 44);
        await assert.rejects(readFile(path.join(directory, 'system.wav')));
    } finally { await recorder.stop(); }
});

test('saving failures cannot silently finish a keep-transcript decision', async () => {
    const item = { ...session(), state: 'stopped' as const }; await saveSession(item);
    const failed = new Error('EACCES: transcript.md');
    const transcription = Object.assign(new (await import('node:events')).EventEmitter(), {
        failures: 0, warnings: [], processing: '', drain: async () => { throw failed; }, close: async () => {},
    }) as InstanceType<typeof Transcription>;
    await assert.rejects(finishSession(item, 'keep', defaults, () => {}, transcription), /EACCES/);
    assert.equal(item.state, 'stopped'); assert.equal(item.decision, null);
    assert.equal(transcription.listenerCount('update'), 0, 'A failed finish must release its progress callback');
});

test('failed checkpoint writes never advance the transcription cursor', async () => {
    const item = { ...session(), state: 'stopped' as const }; await saveSession(item);
    const directory = sessionDirectory(item.id);
    const writer = new WavWriter(path.join(directory, 'mic.wav')); writer.append(Buffer.alloc(RATE * 2)); writer.close();
    await writeFile(path.join(directory, 'chunks'), 'blocked');
    const transcription = new Transcription(item, defaults);
    try {
        await assert.rejects(transcription.drain(), /ENOTDIR|EEXIST/);
        assert.equal(transcription.jobs.length, 0);
        await rm(path.join(directory, 'chunks')); await mkdir(path.join(directory, 'chunks'));
        await transcription.initialize(); await transcription.drain();
        assert.equal(transcription.jobs.length, 1);
    } finally { await transcription.close(); }
});

test('missing model binaries fail without hanging shutdown', { timeout: 4000 }, async () => {
    const model = path.join(root, 'model.bin'); await writeFile(model, 'test');
    const server = new ModelServer(path.join(root, 'missing-binary'), model, 'llama');
    try { await assert.rejects(server.start(), /missing-binary/); }
    finally { await server.stop(); }
});

test('formatter rejects empty, truncated and malformed content before clipboard access', () => {
    assert.deepEqual(dictationParagraphs('Hallo Sam. Neuer Absatz. Bitte prüfen. Absatzwechsel Danke.'), ['Hallo Sam.', 'Bitte prüfen.', 'Danke.']);
    assert.equal(parseFormatted('{"cleaned_text":"Hallo Alex.\\n\\nBitte den Import prüfen."}'), 'Hallo Alex.\n\nBitte den Import prüfen.');
    assert.throws(() => parseFormatted('{"cleaned_text":" "}'), /no text/);
    assert.throws(() => parseFormatted('{"text":"wrong field"}'), /valid text/);
    assert.throws(() => parseFormatted('{"cleaned_text":"unfinished'));
});

test('blocked dictation never opens a microphone; recovery stays separate from meetings', async () => {
    const service = new DictationService({ ...defaults }, () => true);
    try {
        await service.toggle();
        assert.equal(service.recorder, undefined); assert.equal(service.current, undefined);
        const item = { ...session(), format: 'message', state: 'stopped' };
        const directory = dictationDirectory(item.id); await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'session.json'), JSON.stringify(item));
        assert.equal((await dictations()).length, 1);
        await service.remove((await dictations())[0]!);
        assert.equal((await dictations()).length, 0);
    } finally { await service.close(); }
});

test('canceling a reformat preserves the saved text and previous format', async () => {
    const item = { ...session(), state: 'done' as const, format: 'message' as const, raw: 'Hallo Sam.', text: 'Hallo Sam.' };
    const directory = dictationDirectory(item.id); await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'session.json'); await writeFile(file, JSON.stringify(item));
    const model = path.join(root, 'formatter.bin'); await writeFile(model, 'test');
    const service = new DictationService({ ...defaults, dictationModel: model });
    try {
        const pending = service.retry(item, 'email');
        await service.cancel(); await pending;
        const saved = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(saved.format, 'message'); assert.equal(saved.text, 'Hallo Sam.');
        assert.equal(service.current?.format, 'message'); assert.equal(service.state, 'idle');
    } finally { await service.close(); }
});

after(async () => { await rm(root, { recursive: true, force: true }); });
