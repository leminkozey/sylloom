import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNotifications } from '../src/notification.js';
import { attachIndicator } from '../src/indicator.js';
import type { BubbleNotice } from '../src/bubble-feedback.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-bubbles-'));
process.env.SYLLOOM_HOME = root;
const { defaults } = await import('../src/store.js');
const { DictationService, dictationDirectory } = await import('../src/dictation.js');
const { DictationModels } = await import('../src/dictation-models.js');
const { Audio } = await import('../src/audio.js');

test('missing microphone dismisses feedback before slow cleanup and retains the failed attempt', { timeout: 5000 }, async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let release!: () => void, failed!: () => void, discoveries = 0, opens = 0, hidden = 0, renders = 0;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const failure = new Promise<void>(resolve => { failed = resolve; });
    context.mock.method(Audio.prototype, 'devices', async () => { discoveries++; return []; });
    context.mock.method(Audio.prototype, 'request', async (command: string) => {
        if (command === 'start') opens++;
        assert.equal(command, 'stop', 'A known missing microphone must never be opened');
        await cleanup;
    });
    context.mock.method(DictationModels.prototype, 'prewarm', async () => false);
    const service = new DictationService({ ...defaults, dictationNotifications: false });
    const views: import('../src/indicator.js').IndicatorView[] = [];
    const detach = attachIndicator(service, assert.fail, () => ({ render(view) { renders++; views.push(view); }, hide() { hidden++; }, close() {} }));
    service.on('update', () => { if (service.state === 'error') failed(); });
    const operation = service.toggle();
    try {
        await failure;
        assert.equal(service.busy, true, 'Native cleanup is still pending');
        assert.match(service.message, /No audio device/);
        assert.equal(views.some(view => view.phase === 'recording'), false, 'No active recording wave before a known missing microphone');
        assert.deepEqual(views.at(-1), { phase: 'error', level: 0, feedback: 'microphone' });
        context.mock.timers.tick(2100); assert.equal(hidden, 1);
        const expired = renders, id = service.current!.id;
        const repeated = service.toggle();
        assert.equal(service.current!.id, id); assert.equal(discoveries, 1); assert.equal(opens, 0);
        release(); await operation; await repeated;
        assert.equal(service.busy, false); assert.equal(service.state, 'error');
        assert.equal(renders, expired, 'Persisting the error must not resurrect the bubble');
        const directory = dictationDirectory(id);
        assert.equal(JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')).outcome, 'failed');
        assert.equal(existsSync(path.join(directory, 'mic.wav')), false);
    } finally { release(); await operation; detach(); await service.close(); }
});

test('notification delivery uses friendly copy and no native close button or corner placement', async () => {
    const notices: BubbleNotice[] = []; let hidden = 0;
    const notifications = createNotifications(async () => ({ show(notice) { notices.push(notice); }, hide() { hidden++; } }));
    await notifications.show('Global shortcut is unavailable (macOS -9878)');
    assert.equal(notices.length, 1); assert.equal(notices[0]!.title, 'Shortcut unavailable');
    assert.doesNotMatch(JSON.stringify(notices), /9878|macOS/);
    notifications.hide(); assert.equal(hidden, 1); notifications.close();
});

test('cancel during slow device discovery dismisses the bubble without waiting for the driver', { timeout: 5000 }, async context => {
    let release!: () => void, discovering!: () => void, hidden = 0;
    const gate = new Promise<[]>(resolve => { release = () => resolve([]); });
    const started = new Promise<void>(resolve => { discovering = resolve; });
    context.mock.method(Audio.prototype, 'devices', async () => { discovering(); return gate; });
    context.mock.method(Audio.prototype, 'request', async (command: string) => { assert.equal(command, 'stop'); });
    context.mock.method(DictationModels.prototype, 'prewarm', async () => false);
    const service = new DictationService({ ...defaults, dictationNotifications: false });
    const detach = attachIndicator(service, assert.fail, () => ({ render() {}, hide() { hidden++; }, close() {} }));
    const operation = service.toggle();
    try {
        await started;
        const canceling = service.cancel();
        assert.equal(hidden, 1, 'Esc must dismiss the indicator while native discovery is still pending');
        assert.equal(service.busy, true, 'A new capture must still wait for cleanup');
        release(); await canceling; await operation;
        assert.equal(service.busy, false); assert.equal(service.current?.outcome, 'canceled');
    } finally { release(); await operation; detach(); await service.close(); }
});

test('late native loading shows only the newest friendly message and cannot display after shutdown', async () => {
    type Sink = { show(notice: BubbleNotice): void; hide(): void };
    let resolve!: (surface: Sink) => void;
    const shown: string[] = [], pending = new Promise<Sink>(done => { resolve = done; });
    const notifications = createNotifications(() => pending);
    const first = notifications.show('Microphone unavailable'), last = notifications.show('Copied');
    resolve({ show(notice) { shown.push(notice.title); }, hide() {} });
    await Promise.all([first, last]); assert.deepEqual(shown, ['Copied to clipboard']);
    notifications.close();
    const stopped = createNotifications(() => pending); stopped.close(); await stopped.show('Ignored');
    assert.deepEqual(shown, ['Copied to clipboard']);
});

after(async () => { await rm(root, { recursive: true, force: true }); });
