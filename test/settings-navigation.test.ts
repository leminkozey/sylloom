import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-settings-navigation-'));
process.env.SYLLOOM_HOME = root;
const { defaults } = await import('../src/store.js');
const { Screen } = await import('../src/terminal/screen.js');
const { default: switchList } = await import('../src/terminal/switch-list.js');
const { default: renderList } = await import('../src/terminal/render-list.js');
const { manageSettings } = await import('../src/settings-ui.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const terminal = () => {
    const screen = Object.create(Screen.prototype); let output = '';
    Object.defineProperty(screen, 'width', { value: 52, configurable: true }); Object.defineProperty(screen, 'capacity', { value: 15 });
    screen.frame = (_title: string, _detail: string, lines: string[]) => { output = lines.join('\n'); };
    return { screen, output: () => output };
};

test('Velora switches keep a local draft, block dependencies and save with the selected action', async () => {
    const { screen, output } = terminal();
    const original = [{ value: 'master', name: 'Global shortcuts', enabled: true, hint: 'Master switch' },
        { value: 'copy', name: 'Copy latest', enabled: true, hint: 'Copy latest text', requires: 'master' }];
    const pending = switchList(screen, 'Settings', { rows: original });
    screen.keyHandler(' ', { name: 'space' }); await tick();
    assert.match(output(), /Global shortcuts[^\n]*│ Off/); assert.match(output(), /Copy latest[^\n]*│ Off/);
    assert.equal(original[0]!.enabled, true);
    screen.keyHandler('', { name: 'down' }); screen.keyHandler('', { name: 'return' }); await tick();
    assert.match(output(), /Enable global shortcuts first/);
    screen.keyHandler('', { name: 'down' }); screen.keyHandler(' ', { name: 'space' });
    const saved = await pending;
    assert.equal(saved?.action, 'save'); assert.deepEqual(saved?.rows.map(row => row.enabled), [false, false]);
    const discard = switchList(screen, 'Settings', { rows: original });
    screen.keyHandler(' ', { name: 'space' }); await tick(); screen.keyHandler('', { name: 'escape' });
    assert.equal(await discard, null); assert.equal(original[1]!.enabled, true);
});

test('scrolling keeps Save and Discard visible with Unicode cells and selection hints', () => {
    const output = renderList({ rows: Array.from({ length: 20 }, (_, index) => ({ value: String(index), cells: ['界 👩‍💻 Setting ' + index, index % 2 ? 'On' : 'Off'] })),
        columns: [{ title: '' }, { title: '', width: 12 }], actions: [{ value: 'save', name: 'Save changes' }, { value: 'back', name: 'Discard changes' }],
        selected: '19', width: 38, height: 13, detail: 'Changes stay local until saved.' });
    assert.match(output, /› 界 👩‍💻 Setting 19/); assert.match(output, /More above/);
    assert.match(output, /Save changes/); assert.match(output, /Discard changes/);
    for (const line of output.trimEnd().split('\n')) assert.ok(stringWidth(line) <= 40, line);
    assert.ok(output.trimEnd().split('\n').length <= 13);
});

test('left and right set a switch explicitly and unavailable rows cannot activate', async () => {
    const { screen } = terminal();
    const pending = screen.select('Settings', [{ value: 'flag', name: 'Flag', toggle: false }, { value: 'locked', name: 'Unavailable option', unavailable: 'Not supported' }], { back: true });
    screen.keyHandler('', { name: 'left' });
    screen.keyHandler('', { name: 'down' }); screen.keyHandler('', { name: 'return' });
    assert.equal(typeof screen.keyHandler, 'function');
    screen.keyHandler('', { name: 'up' }); screen.keyHandler('', { name: 'right' });
    assert.equal(await pending, 'flag');
});

test('a terminal too small to display choices cannot activate an invisible action', async () => {
    const { screen } = terminal(); Object.defineProperty(screen, 'width', { value: 24, configurable: true });
    const pending = screen.select('Settings', [{ value: 'record', name: 'Start recording' }], { back: true });
    screen.keyHandler('', { name: 'return' }); assert.equal(typeof screen.keyHandler, 'function');
    screen.keyHandler('', { name: 'escape' }); assert.equal(await pending, 'back');
});

test('language and warm-time pickers retain current values and discard unsaved changes', async () => {
    const config = { ...defaults }; let visits = 0;
    const actions = ['models', 'language', 'de', 'warm', '300', 'back', 'models', 'language', 'en', 'warm', '60', 'save', 'back'];
    const screen = { quitRequested: false, select: async (title: string, choices: { value: string; state?: string }[], options: { initialValue?: string }) => {
        if (title === 'Settings' && ++visits === 2) { assert.equal(config.language, 'auto'); assert.equal(config.dictationWarmSeconds, 120); }
        if (title === 'Recognition language') assert.equal(choices.find(row => row.value === 'auto')?.state, 'Selected');
        if (title === 'Keep models warm') assert.equal(options.initialValue, '120');
        return actions.shift()!;
    } } as unknown as import('../src/terminal/screen.js').Screen;
    await manageSettings(screen, config, async () => {});
    assert.equal(config.language, 'en'); assert.equal(config.dictationWarmSeconds, 60);
    const saved = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
    assert.equal(saved.language, 'en'); assert.equal(saved.dictationWarmSeconds, 60);
});

after(async () => { await rm(root, { recursive: true, force: true }); });
