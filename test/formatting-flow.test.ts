import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Dictation } from '../src/dictation.js';
import type { Screen } from '../src/terminal/screen.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-formatting-'));
process.env.SYLLOOM_HOME = root;
const { defaults, atomicJson } = await import('../src/store.js');
const { DictationService, dictationDirectory } = await import('../src/dictation.js');
const { dictationItemMenu } = await import('../src/dictation-ui.js');
const { ModelServer } = await import('../src/server.js');
const { DictationModels } = await import('../src/dictation-models.js');
const fixture = (): Dictation => ({ id: randomUUID(), name: 'Formatting fixture', startedAt: '2026-10-20T10:00:00Z',
    stoppedAt: '2026-10-20T10:00:01Z', state: 'stopped', decision: null, recovered: false, events: [],
    format: 'message', raw: 'Hallo Lea.', text: 'Previous result.' });

test('listening preloads models before capture and respects explicit warm Off', async context => {
    let loads = 0;
    context.mock.method(DictationModels.prototype, 'prewarm', async () => { loads++; return true; });
    for (const seconds of [120, 0]) {
        const service = new DictationService({ ...defaults, globalShortcuts: false, dictationIndicator: false, dictationWarmSeconds: seconds });
        try {
            service.listen(); await Promise.resolve();
            assert.equal(loads, 1); assert.equal(service.current, undefined); assert.equal(service.recorder, undefined);
            assert.equal(service.message, 'Ready to dictate');
        } finally { await service.close(); }
    }
});

test('startup preloads expire after the configured idle time but never during capture', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let stopped = 0;
    const service = new DictationService({ ...defaults, globalShortcuts: false, dictationIndicator: false, dictationWarmSeconds: 30 });
    const internal = service as unknown as { models: InstanceType<typeof DictationModels> };
    await internal.models.close();
    internal.models = new DictationModels(() => ({ reusable: true, start: async () => 'http://localhost',
        stop: async () => { stopped++; } }) as unknown as ModelServer);
    try {
        await service.prewarm();
        context.mock.timers.tick(29_999); assert.equal(stopped, 0);
        context.mock.timers.tick(1); await Promise.resolve(); assert.equal(stopped, 2);

        let ready!: (value: boolean) => void;
        context.mock.method(DictationModels.prototype, 'prewarm', () => new Promise<boolean>(resolve => { ready = resolve; }));
        const release = context.mock.method(DictationModels.prototype, 'release');
        const pending = service.prewarm();
        service.state = 'recording'; ready(true); await pending;
        assert.equal(release.mock.callCount(), 0, 'A recording owns the model until processing finishes');
    } finally { await service.close(); }
});

test('an unsupported detected language skips cleanup and is reported honestly in saved timings', async context => {
    context.mock.method(globalThis, 'fetch', async () => assert.fail('Unsupported text must not reach the model'));
    const item = { ...fixture(), recognitionLanguage: 'italian', raw: 'Ehm, domani non inviare il documento.' };
    const directory = dictationDirectory(item.id);
    const service = new DictationService({ ...defaults, dictationPolish: 'always', dictationNotifications: false });
    const internal = service as unknown as { previous: Dictation; process(item: Dictation, signal: AbortSignal, directory: string, persist: (item: Dictation) => Promise<void>): Promise<void> };
    internal.previous = structuredClone(item);
    try {
        await internal.process(item, new AbortController().signal, directory, value => atomicJson(path.join(directory, 'session.json'), value));
        const saved = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
        assert.equal(saved.text, item.raw); assert.equal(saved.timings.usedFormatter, false); assert.equal(saved.recognitionLanguage, 'italian');
    } finally { await service.close(); }
});

test('explicit formatting reaches the model even for clean text with formatting switched off', async context => {
    const model = path.join(root, 'formatter.gguf'); await writeFile(model, 'Synthetic model fixture');
    const config = { ...defaults, dictationPolish: 'off' as const, dictationModel: model, dictationNotifications: false };
    let requests = 0;
    context.mock.method(ModelServer.prototype, 'start', async () => 'http://127.0.0.1:1');
    context.mock.method(ModelServer.prototype, 'stop', async () => {});
    context.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests++;
        assert.match(String(options?.body), /Hallo Lea/);
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cleaned_text: 'Hallo Lea!' }) } }] });
    });
    for (const force of [false, true]) {
        const item = fixture(), directory = dictationDirectory(item.id);
        await atomicJson(path.join(directory, 'session.json'), item);
        const service = new DictationService(config);
        const internal = service as unknown as { previous: Dictation; process(item: Dictation, signal: AbortSignal, directory: string, persist: (item: Dictation) => Promise<void>, force: boolean): Promise<void> };
        // Exercise the saved-text processing branch without delivery or clipboard writes.
        internal.previous = structuredClone(item);
        try {
            await internal.process(item, new AbortController().signal, directory, value => atomicJson(path.join(directory, 'session.json'), value), force);
            const saved: Dictation = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
            assert.equal(saved.text, force ? 'Hallo Lea!' : 'Hallo Lea.');
            assert.equal(saved.raw, 'Hallo Lea.'); assert.equal(saved.timings?.usedFormatter, force);
            assert.equal(config.dictationPolish, 'off'); assert.equal(saved.delivery, undefined);
        } finally { await service.close(); }
    }
    assert.equal(requests, 1);
});

test('the history Reformat action forces formatting while retranscription uses the normal retry path', async () => {
    const item = fixture();
    for (const action of ['retry', 'transcribe']) {
        const selected = [action, 'message'];
        const calls: string[] = [];
        const screen = { quitRequested: false, select: async () => selected.shift() } as unknown as Screen;
        const service = { busy: false,
            reformat: async (recording: Dictation) => { assert.equal(recording, item); calls.push('reformat'); },
            retry: async (recording: Dictation, _format: string, retranscribe: boolean) => { assert.equal(recording, item); assert.equal(retranscribe, true); calls.push('transcribe'); },
        } as unknown as InstanceType<typeof DictationService>;
        await dictationItemMenu(screen, service, item);
        assert.deepEqual(calls, [action === 'retry' ? 'reformat' : 'transcribe']);
    }
});

after(async () => { await rm(root, { recursive: true, force: true }); });
