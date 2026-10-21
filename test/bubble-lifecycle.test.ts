import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNotifications } from '../src/notification.js';
import { attachIndicator } from '../src/indicator.js';
import type { Popup } from '../src/native/call-popup.js';

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
    const detach = attachIndicator(service, assert.fail, () => ({ render() { renders++; }, hide() { hidden++; }, close() {} }));
    service.on('update', () => { if (service.state === 'error') failed(); });
    const operation = service.toggle();
    try {
        await failure;
        assert.equal(service.busy, true, 'Native cleanup is still pending');
        assert.match(service.message, /No audio device/);
        context.mock.timers.tick(1500); assert.equal(hidden, 1);
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

test('notification updates survive an interrupted hide and expire exactly once', async context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let shown = 0, hidden = 0, closed = 0, loaded = 0;
    const notifications = createNotifications(async () => { loaded++; return { show() { shown++; }, hide() { hidden++; }, close() { closed++; } }; });
    await notifications.show('First'); context.mock.timers.tick(3900);
    await notifications.show('Second'); context.mock.timers.tick(200);
    assert.equal(hidden, 0); assert.equal(shown, 2); assert.equal(loaded, 1);
    notifications.hide(); context.mock.timers.tick(100);
    await notifications.show('Third'); context.mock.timers.tick(350);
    assert.equal(closed, 0, 'An old close timeout must not destroy the new notification');
    context.mock.timers.tick(3650); assert.equal(hidden, 2);
    context.mock.timers.tick(350); assert.equal(closed, 1);
    notifications.close(); assert.equal(closed, 1);
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

test('late native loading shows only the newest message and closes on shutdown', async () => {
    let resolve!: (surface: Popup) => void, closed = 0;
    const shown: string[] = [], pending = new Promise<Popup>(done => { resolve = done; });
    const notifications = createNotifications(() => pending);
    const first = notifications.show('Stale'), last = notifications.show('Current');
    resolve({ show(_title, message) { shown.push(message); }, hide() {}, close() { closed++; } });
    await Promise.all([first, last]); assert.deepEqual(shown, ['Current']);
    notifications.close(); assert.equal(closed, 1);
    const stopped = createNotifications(() => pending); stopped.close(); await stopped.show('Ignored');
    assert.deepEqual(shown, ['Current']);
});

after(async () => { await rm(root, { recursive: true, force: true }); });
