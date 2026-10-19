import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Dictation } from '../src/dictation.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-hardening-'));
process.env.SYLLOOM_HOME = root;
const { defaults, atomicJson } = await import('../src/store.js');
const { DictationService, dictationDirectory } = await import('../src/dictation.js');
const { ModelServer } = await import('../src/server.js');
const { summarize } = await import('../src/notes.js');
const { repairWav, wavHeader, WavWriter } = await import('../src/wav.js');

test('a storage failure reports an error instead of rejecting the background dictation operation', async () => {
    const file = path.join(root, 'dictations'); await writeFile(file, 'Preserved obstruction');
    const service = new DictationService({ ...defaults, dictationNotifications: false });
    try {
        await service.toggle();
        assert.equal(service.state, 'error'); assert.equal(service.busy, false);
        assert.match(service.message, /could not be saved/i);
        assert.equal(service.recorder, undefined); assert.ok(service.current);
        assert.equal(await readFile(file, 'utf8'), 'Preserved obstruction');
    } finally { await service.close().catch(() => {}); await rm(file); }
});

test('failed atomic replacement preserves its destination and removes its temporary file', async () => {
    const directory = path.join(root, 'atomic-failure'), target = path.join(directory, 'destination');
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'original'), 'Preserved original');
    await assert.rejects(atomicJson(target, { state: 'new' }));
    assert.deepEqual(await readdir(directory), ['destination']);
    assert.equal(await readFile(path.join(target, 'original'), 'utf8'), 'Preserved original');
});

test('a closed dictation service refuses retries without changing saved history', async () => {
    const item: Dictation = { id: randomUUID(), name: 'Shutdown fixture', startedAt: '2026-10-19T12:00:00Z',
        stoppedAt: '2026-10-19T12:00:10Z', state: 'done', decision: null, recovered: false, events: [],
        format: 'message', outcome: 'completed', raw: 'Original transcript.', text: 'Original result.' };
    const directory = dictationDirectory(item.id); await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'session.json'); const saved = JSON.stringify(item); await writeFile(file, saved);
    const service = new DictationService({ ...defaults, dictationNotifications: false, dictationPolish: 'always' });
    await service.close();
    await assert.rejects(service.retry(item, 'email'), /clos/i);
    assert.equal(await readFile(file, 'utf8'), saved); assert.equal(service.current, undefined);
});

test('model shutdown wins over a late healthy response and a cached ready URL', { timeout: 5000 }, async () => {
    const binary = path.join(root, 'model-fixture.mjs'), model = path.join(root, 'model-fixture.bin');
    await writeFile(binary, '#!' + process.execPath + '\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    await writeFile(model, 'Fixture, no model weights');
    const originalFetch = globalThis.fetch;
    try {
        for (const delayed of [true, false]) {
            let reached!: () => void, release!: () => void;
            const health = new Promise<void>(resolve => { reached = resolve; });
            const gate = new Promise<void>(resolve => { release = resolve; });
            globalThis.fetch = async () => { reached(); if (delayed) await gate; return new Response('{}'); };
            const server = new ModelServer(binary, model, 'llama');
            const starting = server.start();
            try {
                await health;
                if (!delayed) await starting;
                await server.stop(); release();
                if (delayed) await assert.rejects(starting, /canceled/);
                await assert.rejects(server.start(), /canceled/);
                assert.equal(server.reusable, false);
            } finally { release(); await starting.catch(() => {}); await server.stop(); }
        }
    } finally { globalThis.fetch = originalFetch; }
});

test('an already canceled note cannot start a model or report processing', async context => {
    let starts = 0; const progress: string[] = [];
    context.mock.method(ModelServer.prototype, 'start', async () => { starts++; throw new Error('Unexpected model startup'); });
    const session: Dictation = { id: randomUUID(), name: 'Canceled note', startedAt: '2026-10-19T12:00:00Z',
        stoppedAt: '2026-10-19T12:00:10Z', state: 'stopped', decision: null, recovered: false, events: [], format: 'message' };
    await assert.rejects(summarize(session, '[00:00:01] Microphone: Fixture speech.', defaults,
        message => progress.push(message), AbortSignal.abort(new Error('Note already canceled'))), /Note already canceled/);
    assert.equal(starts, 0); assert.deepEqual(progress, []);
});

test('WAV recovery refuses foreign or damaged headers without rewriting their bytes', async () => {
    const wrongFormat = Buffer.concat([wavHeader(4), Buffer.alloc(4)]); wrongFormat.writeUInt16LE(2, 22);
    for (const [index, bytes] of [Buffer.alloc(48, 7), wrongFormat].entries()) {
        const file = path.join(root, 'invalid-' + index + '.wav'); await writeFile(file, bytes);
        assert.throws(() => repairWav(file), /audio file|WAV/i);
        assert.deepEqual(await readFile(file), bytes);
    }
});

test('a failed WAV header write still closes its file descriptor', () => {
    const file = path.join(root, 'close-failure.wav'); const writer = new WavWriter(file);
    const internal = writer as unknown as { fd: number };
    closeSync(internal.fd); const readonly = openSync(file, 'r'); internal.fd = readonly;
    try {
        assert.throws(() => writer.close());
        assert.throws(() => fstatSync(readonly), 'The failed writer leaked its descriptor');
        assert.doesNotThrow(() => writer.close(), 'Closing after a failure must be idempotent');
    } finally { try { closeSync(readonly); } catch {} }
});

after(async () => { await rm(root, { recursive: true, force: true }); });
