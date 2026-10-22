import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseShortcut, shortcutEdges, polledShortcut } from '../src/shortcut.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-shortcuts-'));
process.env.SYLLOOM_HOME = root;
const { defaults, settings } = await import('../src/store.js');
const { DictationService } = await import('../src/dictation.js');
const { Recorder } = await import('../src/recorder.js');
const { DictationModels } = await import('../src/dictation-models.js');
const { manageSettings } = await import('../src/settings-ui.js');

test('shortcut mappings preserve modifiers and protect normal typing and reserved function keys', () => {
    assert.deepEqual(parseShortcut(' option + ctrl + space ', 'darwin'), { label: 'Ctrl+Option+Space', code: 49, modifiers: 6144 });
    assert.deepEqual(parseShortcut('Shift+F8', 'win32'), { label: 'Shift+F8', code: 0x77, modifiers: 4 });
    assert.equal(parseShortcut('F8', 'darwin').code, 100);
    assert.equal(parseShortcut('F19', 'win32').code, 0x82);
    assert.equal(parseShortcut('Fn', 'darwin').polled, true);
    assert.equal(parseShortcut('Right Option', 'darwin').code, 61);
    assert.equal(parseShortcut('Right Ctrl', 'win32').code, 0xa3);
    for (const key of ['Space', 'C', 'Escape', 'F12', 'A', 'Ctrl++Space', 'Fn+Space']) assert.throws(() => parseShortcut(key, 'darwin'));
    assert.throws(() => parseShortcut('Fn', 'win32'));
});

test('held keys fire once and release once; a key held before startup must first be released', () => {
    const calls: string[] = [];
    const edge = shortcutEdges(() => calls.push('down'), () => calls.push('up'));
    [false, true, true, true, false, false].forEach(edge);
    assert.deepEqual(calls, ['down', 'up']); calls.length = 0;
    const poll = polledShortcut(() => calls.push('down'), () => calls.push('up'), true);
    [true, true, false, false].forEach(poll); assert.deepEqual(calls, []);
    [true, true, false].forEach(poll); assert.deepEqual(calls, ['down', 'up']);
});

test('releasing push-to-talk during microphone startup finishes exactly once after startup', async context => {
    let finishStart!: () => void;
    const gate = new Promise<void>(resolve => { finishStart = resolve; });
    context.mock.method(Recorder.prototype, 'start', () => gate);
    context.mock.method(DictationModels.prototype, 'prewarm', async () => true);
    const service = new DictationService({ ...defaults, dictationTalkMode: 'hold', dictationAutoInsert: false, dictationNotifications: false, dictationWarmSeconds: 0 });
    let finishes = 0;
    context.mock.method(service as unknown as { stopAndProcess(): Promise<void> }, 'stopAndProcess', async () => { finishes++; service.state = 'idle'; });
    try {
        const starting = service.shortcutPress(); assert.equal(service.state, 'starting');
        await service.shortcutPress(); assert.equal(service.state, 'starting');
        await service.shortcutRelease(); await service.shortcutRelease();
        finishStart(); await starting;
        assert.equal(finishes, 1);
        await service.shortcutRelease(); assert.equal(finishes, 1);
    } finally { finishStart(); await service.close(); }
});

test('hold release cannot stop a recording started from the menu, and toggle mode ignores release', async context => {
    const service = new DictationService({ ...defaults, dictationTalkMode: 'hold' });
    let toggles = 0;
    context.mock.method(service, 'toggle', async () => { toggles++; });
    try {
        service.state = 'recording'; await service.shortcutRelease(); await service.shortcutPress(); assert.equal(toggles, 0);
        service.state = 'processing'; await service.shortcutPress(); await service.shortcutRelease(); assert.equal(toggles, 0);
        service.state = 'idle'; service.config.dictationTalkMode = 'toggle';
        await service.shortcutPress(); await service.shortcutRelease(); await service.shortcutPress();
        assert.equal(toggles, 2);
    } finally { service.state = 'idle'; await service.close(); }
});

test('shortcut settings keep drafts, show platform keys, and apply key and mode together only on Save', async () => {
    const config = { ...defaults }; let visits = 0, listens = 0;
    const actions = ['shortcuts', 'talk-mode', 'hold', 'talk-key', 'F8', 'back', 'shortcuts', 'talk-mode', 'hold', 'talk-key', 'F9', 'save', 'back'];
    const screen = { quitRequested: false, dictation: { busy: false, listen: () => { listens++; } },
        select: async (title: string, choices: { value: string; state?: string }[]) => {
            if (title === 'Settings' && ++visits === 2) { assert.equal(config.dictationTalkMode, 'toggle'); assert.equal(config.dictationShortcut, defaults.dictationShortcut); assert.equal(listens, 0); }
            if (title === 'Dictation key') assert.ok(choices.some(row => row.value === (process.platform === 'win32' ? 'Right Ctrl' : 'Fn')));
            return actions.shift()!;
        }, notice: async (_title: string, message: string) => assert.fail(message),
    } as unknown as import('../src/terminal/screen.js').Screen;
    await manageSettings(screen, config, async () => {});
    assert.equal(config.dictationTalkMode, 'hold'); assert.equal(config.dictationShortcut, 'F9'); assert.equal(listens, 1);
    const saved = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
    assert.equal(saved.dictationTalkMode, 'hold'); assert.equal(saved.dictationShortcut, 'F9');
    assert.equal((await settings()).dictationShortcut, 'F9');
});

test('an occupied shortcut restores persisted and running settings while retaining the edit draft', async () => {
    const config = { ...defaults }; let notices = 0, listens = 0;
    const actions = ['shortcuts', 'talk-key', 'F8', 'save', 'talk-key', 'F9', 'save', 'back'];
    const dictation = { busy: false, hotkeyError: '', listen() { listens++; this.hotkeyError = config.dictationShortcut === 'F8' ? 'Shortcut occupied' : ''; } };
    const screen = { quitRequested: false, dictation, select: async () => actions.shift()!,
        notice: async (_title: string, message: string) => {
            notices++; assert.match(message, /Previous shortcuts restored/);
            assert.equal(config.dictationShortcut, defaults.dictationShortcut);
            assert.equal((await settings()).dictationShortcut, defaults.dictationShortcut);
        },
    } as unknown as import('../src/terminal/screen.js').Screen;
    await manageSettings(screen, config, async () => {});
    assert.equal(notices, 1); assert.equal(listens, 3);
    assert.equal(config.dictationShortcut, 'F9');
});

after(async () => { await rm(root, { recursive: true, force: true }); });
