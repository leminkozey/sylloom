import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Dictation } from '../src/dictation.js';
import type { Choice } from '../src/terminal/screen.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-regressions-'));
process.env.SYLLOOM_HOME = root;
const { defaults, saveSession, loadSession, sessionDirectory } = await import('../src/store.js');
const { Transcription, IncompleteTranscriptionError } = await import('../src/transcription.js');
const { ModelServer } = await import('../src/server.js');
const { WavWriter, RATE } = await import('../src/wav.js');
const { recoverDictations } = await import('../src/dictation.js');
const { libraryMenu } = await import('../src/library-ui.js');
const { Screen } = await import('../src/terminal/screen.js');
const { Recorder } = await import('../src/recorder.js');
const { recoverSessions, finishSession } = await import('../src/workflow.js');

const item = (changes: Partial<Dictation> = {}): Dictation => ({ id: randomUUID(), name: 'Review fixture',
    startedAt: '2026-10-19T10:00:00Z', stoppedAt: null, state: 'recording', decision: null,
    recovered: false, events: [], format: 'message', ...changes });
async function saved(data: Dictation): Promise<string> {
    const directory = path.join(root, 'dictations', data.id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'session.json'), JSON.stringify(data)); return directory;
}
async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) await delay(5);
    assert.ok(check(), 'Library did not refresh');
}

test('transcription keeps real repetitions across chunk boundaries and excludes shared context', async () => {
    const session = item({ state: 'stopped', stoppedAt: '2026-10-19T10:05:02Z' });
    await saveSession(session);
    const directory = sessionDirectory(session.id);
    const wav = new WavWriter(path.join(directory, 'mic.wav'));
    wav.append(Buffer.alloc(RATE * 302 * 2).fill(Buffer.from([0xe8, 0x03]))); wav.close();
    const phrase = 'We approve the proposal.';
    const bodies = [
        { text: phrase, segments: [{ start: 298, end: 299, text: phrase }, { start: 300.1, end: 301.5, text: phrase }] },
        { text: phrase, segments: [{ start: 6, end: 7, text: phrase }, { start: 8.1, end: 9.5, text: phrase }] },
    ];
    const server = new ModelServer('unused', 'unused', 'whisper');
    server.start = async () => 'http://127.0.0.1:1'; server.stop = async () => {};
    const fetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(bodies.shift()));
    const transcription = new Transcription(session, defaults, directory, server);
    try {
        await transcription.initialize(); await transcription.drain();
        assert.equal(transcription.failures, 0);
        assert.deepEqual(transcription.segments.map(segment => [segment.start, segment.text]), [[298, phrase], [300.1, phrase]]);
        assert.equal((await readFile(path.join(directory, 'transcript.md'), 'utf8')).split(phrase).length - 1, 2);
    } finally { globalThis.fetch = fetch; await transcription.close(); }
});

test('one broken interrupted WAV cannot block recovery of other dictations or destroy its original bytes', async () => {
    const broken = item(); const brokenDirectory = await saved(broken);
    const bytes = Buffer.alloc(45, 7); const file = path.join(brokenDirectory, 'mic.wav'); await writeFile(file, bytes);
    const healthy = item(); const healthyDirectory = await saved(healthy);
    const wav = new WavWriter(path.join(healthyDirectory, 'mic.wav')); wav.append(Buffer.alloc(RATE * 2)); wav.close();
    await recoverDictations(); await recoverDictations();
    const result = JSON.parse(await readFile(path.join(brokenDirectory, 'session.json'), 'utf8'));
    assert.equal(result.state, 'stopped'); assert.equal(result.outcome, 'interrupted'); assert.equal(result.decision, null);
    assert.match(result.error, /Audio recovery failed/);
    assert.deepEqual(await readFile(file), bytes);
    assert.equal(result.events.filter((event: { message: string }) => event.message.includes('Audio recovery failed')).length, 1);
    assert.equal(JSON.parse(await readFile(path.join(healthyDirectory, 'session.json'), 'utf8')).outcome, 'interrupted');
});

test('meeting recovery preserves a broken track, recovers healthy audio and keeps the transcript decision open', async () => {
    const broken = item(); await saveSession(broken);
    const directory = sessionDirectory(broken.id);
    const file = path.join(directory, 'mic.wav'); const bytes = Buffer.alloc(45, 7); await writeFile(file, bytes);
    const system = new WavWriter(path.join(directory, 'system.wav')); system.append(Buffer.alloc(RATE * 3 * 2)); system.close();
    const healthy = item(); await saveSession(healthy);
    const mic = new WavWriter(path.join(sessionDirectory(healthy.id), 'mic.wav')); mic.append(Buffer.alloc(RATE * 2)); mic.close();
    await recoverSessions(); await recoverSessions();
    const recovered = await loadSession(broken.id);
    assert.equal(recovered.state, 'stopped'); assert.equal(recovered.recovered, true);
    assert.equal(recovered.decision, null); assert.equal(recovered.stoppedAt, '2026-10-19T10:00:03.000Z');
    assert.deepEqual(await readFile(file), bytes);
    assert.equal(recovered.events.filter(event => /mic: Audio recovery failed/.test(event.message)).length, 1);
    assert.equal((await loadSession(healthy.id)).state, 'stopped');
});

test('stopping during device discovery never opens a late audio stream or creates unfinished WAV files', async () => {
    const directory = path.join(root, 'stopped-during-discovery'); await mkdir(directory);
    let release!: () => void;
    const discovery = new Promise<void>(resolve => { release = resolve; });
    const recorder = new Recorder(item(), { ...defaults }, { directory, save: async () => {} });
    const starts: string[] = [];
    recorder.audio.devices = async () => {
        await discovery;
        return (['mic', 'system'] as const).map(source => ({ id: 'fixture-' + source, name: 'Fixture', sourceKind: source,
            isDefault: true, formatAvailable: true, channels: 1, sampleRate: 48000, isLoopback: source === 'system' }));
    };
    recorder.audio.request = async <T>(command: string, source?: string) => { if (command === 'start') starts.push(source!); return undefined as T; };
    const starting = recorder.start();
    try {
        await recorder.stop(); release(); await starting;
        assert.deepEqual(starts, []);
        assert.equal(existsSync(path.join(directory, 'mic.wav')), false);
        assert.equal(existsSync(path.join(directory, 'system.wav')), false);
        assert.equal(recorder.session.state, 'stopped');
    } finally { release(); await starting; await recorder.stop(); }
});

test('an already canceled finish cannot delete saved text or start transcription', async () => {
    for (const decision of ['delete', 'keep'] as const) {
        const session = item({ state: 'stopped' }); await saveSession(session);
        const file = path.join(sessionDirectory(session.id), 'transcript.md'); await writeFile(file, 'Original transcript');
        let drains = 0;
        const transcription = Object.assign(new EventEmitter(), { failures: 0, processing: '',
            drain: async () => { drains++; }, close: async () => {} }) as InstanceType<typeof Transcription>;
        const controller = new AbortController(); controller.abort(new Error('Canceled before finishing'));
        await assert.rejects(finishSession(session, decision, defaults, () => {}, transcription, controller.signal), /Canceled before finishing/);
        assert.equal(drains, 0); assert.equal(await readFile(file, 'utf8'), 'Original transcript');
        const saved = await loadSession(session.id); assert.equal(saved.state, 'stopped'); assert.equal(saved.decision, null);
    }
});

test('missing timestamps on shared audio context produce an explicit error instead of guessing away words', async () => {
    const session = item({ state: 'stopped' }); await saveSession(session);
    const directory = sessionDirectory(session.id);
    const wav = new WavWriter(path.join(directory, 'mic.wav'));
    wav.append(Buffer.alloc(RATE * 302 * 2).fill(Buffer.from([0xe8, 0x03]))); wav.close();
    const server = new ModelServer('unused', 'unused', 'whisper');
    server.start = async () => 'http://127.0.0.1:1'; server.stop = async () => {};
    const fetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ text: 'Context without timestamps.' }));
    const transcription = new Transcription(session, defaults, directory, server);
    try {
        await transcription.initialize();
        await assert.rejects(transcription.drain(), IncompleteTranscriptionError);
        assert.equal(transcription.failures, 2);
        assert.match(transcription.error, /segment timestamps/);
        assert.equal(transcription.segments.length, 0);
        assert.match(await readFile(path.join(directory, 'transcript.md'), 'utf8'), /Incomplete/);
    } finally { globalThis.fetch = fetch; await transcription.close(); }
});

test('a handled Insights failure does not crash Node and a repaired ledger can be loaded again', async () => {
    const directory = path.join(root, 'stats'); await mkdir(directory);
    await writeFile(path.join(directory, 'usage.json'), '{broken');
    const source = new URL('../src/insights.ts', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import { writeFile } from 'node:fs/promises';
        const { loadInsights } = await import(${JSON.stringify(source)});
        await assert.rejects(loadInsights(new Date(), { items: [], warnings: [] }));
        await new Promise(resolve => setTimeout(resolve, 20));
        await writeFile(process.env.SYLLOOM_HOME + '/usage.json', JSON.stringify({ version: 1, entries: [] }));
        assert.equal((await loadInsights(new Date(), { items: [], warnings: [] })).words, 0);
        console.log('survived');
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        env: { ...process.env, SYLLOOM_HOME: directory }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.match(child.stdout, /survived/);
});

test('an open Library discovers global dictations, keeps search and filters, and releases its listener', async () => {
    const service = new EventEmitter(); const query = 'freshrepro'; let callbacks = 0;
    const screen = { quitRequested: false, dictation: service,
        browse: async (_title: string, choices: (query: string) => Choice[], options: { shortcut: (key: object) => boolean; search: { query: string } }) => {
            callbacks++; assert.equal(choices(query).length, 0);
            const data = item({ raw: query, text: query, state: 'done', outcome: 'completed' });
            const directory = await saved(data); service.emit('update');
            await waitFor(() => choices(query).some(choice => choice.value === 'dictation:' + data.id));
            assert.ok(choices(query)[0]?.hint?.includes('completed'));
            options.search.query = query;
            assert.equal(options.shortcut({ ctrl: true, name: 'p' }), true);
            assert.equal(choices(query).length, 0);
            await writeFile(path.join(directory, 'session.json'), JSON.stringify({ ...data, pinned: true }));
            assert.equal(options.shortcut({ ctrl: true, name: 'r' }), true);
            await waitFor(() => choices(query).length === 1);
            assert.equal(options.search.query, query);
            return undefined;
        },
    };
    await libraryMenu(screen as unknown as InstanceType<typeof Screen>, async () => {});
    assert.equal(callbacks, 1); assert.equal(service.listenerCount('update'), 0);
});

test('live Library refresh preserves the selected item while new rows arrive', async () => {
    const screen = Object.create(Screen.prototype);
    screen.frame = () => {};
    let choices: Choice[] = [{ value: 'first', name: 'First' }, { value: 'second', name: 'Second' }];
    const pending = screen.browse('Library', () => choices, { detail: () => '' });
    screen.keyHandler('', { name: 'down' });
    choices = [{ value: 'new', name: 'New' }, ...choices]; screen.redraw();
    screen.keyHandler('', { name: 'return' });
    assert.equal(await pending, 'second');
});

after(async () => { await rm(root, { recursive: true, force: true }); });
