import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { emitKeypressEvents } from 'node:readline';
import type { Dictation } from '../src/dictation.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-user-flows-'));
process.env.SYLLOOM_HOME = root;
const { defaults, atomicJson, sessionDirectory, loadSession } = await import('../src/store.js');
const { DictationService, dictationDirectory } = await import('../src/dictation.js');
const { dictationItemMenu } = await import('../src/dictation-ui.js');
const { Screen, editorLayout } = await import('../src/terminal/screen.js');
const { manageSettings } = await import('../src/settings-ui.js');
const { bridgeMenu } = await import('../src/bridge-ui.js');
const { restoreRecordingMetadata, inspectRecordingRecovery } = await import('../src/workflow.js');
const { WavWriter, RATE } = await import('../src/wav.js');
const { loadInsights } = await import('../src/insights.js');
const { installationStatus, installCommand } = await import('../src/installation.js');
const { sourceFingerprint } = await import('../src/build-info.js');

const item = (changes: Partial<Dictation> = {}): Dictation => ({ id: randomUUID(), name: 'Synthetic dictation',
    startedAt: '2026-10-19T10:00:00Z', stoppedAt: '2026-10-19T10:00:02Z', state: 'stopped', decision: null,
    recovered: false, events: [], format: 'message', ...changes });

test('copy latest never silently substitutes older text, including after a service restart', async () => {
    const previous = item({ startedAt: '2026-10-18T10:00:00Z', text: 'Old text.', raw: 'Old text.', state: 'done', outcome: 'completed' });
    const latest = item({ outcome: 'failed', error: 'No speech detected.' });
    for (const data of [previous, latest]) await atomicJson(path.join(dictationDirectory(data.id), 'session.json'), data);
    for (let restart = 0; restart < 2; restart++) {
        const service = new DictationService({ ...defaults, dictationNotifications: false });
        try { await service.copyLatest(); assert.match(service.message, /Latest dictation has no text.*Clipboard unchanged/); }
        finally { await service.close(); }
    }
    assert.equal(JSON.parse(await readFile(path.join(dictationDirectory(previous.id), 'session.json'), 'utf8')).copiedAt, undefined);
    const damaged = path.join(root, 'dictations', randomUUID()); await mkdir(damaged); await writeFile(path.join(damaged, 'session.json'), '{broken');
    const service = new DictationService({ ...defaults, dictationNotifications: false });
    try { await service.copyLatest(); assert.match(service.message, /Some dictations are unreadable/); }
    finally { await service.close(); await rm(damaged, { recursive: true }); }
});

test('multiline paste preserves LF and CRLF and cannot execute a pasted Save or Escape', async () => {
    const screen = Object.create(Screen.prototype);
    Object.defineProperty(screen, 'width', { value: 18 }); Object.defineProperty(screen, 'capacity', { value: 10 });
    screen.frame = () => {};
    const pending = screen.input('Edit', '', '', { multiline: true });
    const input = new PassThrough(); emitKeypressEvents(input);
    input.on('keypress', (text, key) => screen.keyHandler?.(text, key));
    input.write('\x1b[200~first\nsecond\r\nthird\x13\x1b\x1b[201~');
    assert.equal(screen.editingActive, true);
    screen.keyHandler('', { name: 's', ctrl: true });
    assert.equal(await pending, 'first\nsecond\nthird');
    assert.equal(screen.editingActive, false); input.destroy();
});

test('visual cursor navigation crosses soft wraps and End reaches the end of a wrapped line', async () => {
    assert.deepEqual(editorLayout(['a', 'b', 'c', 'd'], 3).positions[3], { row: 1, column: 0 });
    const screen = Object.create(Screen.prototype);
    Object.defineProperty(screen, 'width', { value: 6 }); Object.defineProperty(screen, 'capacity', { value: 10 });
    screen.frame = () => {};
    const edit = screen.input('Edit', '', 'abcdef', { multiline: true });
    screen.keyHandler('', { name: 'up' });
    screen.keyHandler('', { name: 'end' });
    screen.keyHandler('!', { name: '!' });
    screen.keyHandler('', { name: 's', ctrl: true });
    assert.equal(await edit, 'abc!def');
});

test('manual editing preserves original recognition, audio and previous text without inflating activity', async () => {
    const data = item({ raw: 'Two words.', text: 'Previous result.', state: 'done', outcome: 'completed' });
    const directory = dictationDirectory(data.id); await atomicJson(path.join(directory, 'session.json'), data);
    const audio = Buffer.from('Synthetic original audio bytes'); await writeFile(path.join(directory, 'mic.wav'), audio);
    const service = new DictationService({ ...defaults, dictationNotifications: false });
    try {
        const before = await loadInsights(new Date('2026-10-19T12:00:00Z'));
        await service.edit(data, 'Much longer edited message.\n\nRegards & thanks.');
        const saved = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
        assert.equal(saved.raw, 'Two words.'); assert.equal(saved.edits[0].text, 'Previous result.');
        assert.equal(saved.delivery, undefined); assert.deepEqual(await readFile(path.join(directory, 'mic.wav')), audio);
        assert.equal((await loadInsights(new Date('2026-10-19T12:00:00Z'))).words, before.words);
        const manual = item(); await atomicJson(path.join(dictationDirectory(manual.id), 'session.json'), manual);
        await service.edit(manual, 'These words were only typed.');
        assert.equal((await loadInsights(new Date('2026-10-19T12:00:00Z'))).words, before.words);
    } finally { await service.close(); }
});

test('a failed edit save reopens the draft rather than discarding it', async () => {
    const data = item({ raw: 'Original.', text: 'Original.', state: 'done', outcome: 'completed' });
    await atomicJson(path.join(dictationDirectory(data.id), 'session.json'), data);
    const service = new DictationService({ ...defaults, dictationNotifications: false });
    const actions = ['edit', 'back']; const inputs = ['', 'Fixed text.']; const drafts: string[] = []; let notices = 0;
    const screen = { quitRequested: false, select: async () => actions.shift(), input: async (_title: string, _detail: string, initial: string) => { drafts.push(initial); return inputs.shift(); },
        notice: async () => { notices++; } } as unknown as import('../src/terminal/screen.js').Screen;
    try { await dictationItemMenu(screen, service, data); assert.deepEqual(drafts, ['Original.', '']); assert.equal(notices, 1); assert.equal(data.text, 'Fixed text.'); }
    finally { await service.close(); }
});

test('recording device drafts and call detection switches apply only on Save', async () => {
    const config = { ...defaults }; let actions = ['recording', 'mic', 'back', 'back'];
    const screen = { quitRequested: false, select: async () => actions.shift() } as unknown as import('../src/terminal/screen.js').Screen;
    await manageSettings(screen, config, async (_source, draft) => { draft!.input = 'Synthetic mic'; });
    assert.equal(config.input, 'default');
    actions = ['recording', 'mic', 'save', 'back'];
    await manageSettings(screen, config, async (_source, draft) => { draft!.input = 'Synthetic mic'; });
    assert.equal(config.input, 'Synthetic mic');
    actions = ['toggle', 'back']; await bridgeMenu(screen, config); assert.equal(config.bridgeEnabled, true);
    actions = ['toggle', 'save']; await bridgeMenu(screen, config); assert.equal(config.bridgeEnabled, false);
    assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).bridgeEnabled, false);
});

test('metadata recovery preserves corrupt bytes and documents, requires usable audio and leaves the decision pending', async () => {
    const id = randomUUID(), directory = sessionDirectory(id); await mkdir(directory, { recursive: true });
    const original = '{broken metadata'; await writeFile(path.join(directory, 'session.json'), original);
    await writeFile(path.join(directory, 'note.md'), '# Existing note'); await writeFile(path.join(directory, 'transcript.md'), 'Existing transcript');
    await writeFile(path.join(directory, 'mic.wav'), 'Foreign audio');
    assert.ok((await inspectRecordingRecovery(id)).some(file => file.status.includes('Damaged')));
    await assert.rejects(restoreRecordingMetadata(id), /No recoverable audio/);
    assert.equal(await readFile(path.join(directory, 'session.json'), 'utf8'), original);
    const writer = new WavWriter(path.join(directory, 'system.wav')); writer.append(Buffer.alloc(RATE * 2)); writer.close();
    const repaired = await restoreRecordingMetadata(id);
    assert.equal(repaired.name, null); assert.equal(repaired.decision, null); assert.equal(repaired.state, 'stopped');
    assert.equal((await loadSession(id)).recovered, true);
    const backup = (await readdir(directory)).find(file => file.startsWith('session.json.unreadable-'))!;
    assert.equal(await readFile(path.join(directory, backup), 'utf8'), original);
    assert.equal(await readFile(path.join(directory, 'note.md'), 'utf8'), '# Existing note');
    assert.equal(await readFile(path.join(directory, 'transcript.md'), 'utf8'), 'Existing transcript');
    await assert.rejects(restoreRecordingMetadata(id), /already has valid metadata/);
});

test('a failed metadata backup cannot replace the unreadable original', async () => {
    const id = randomUUID(), directory = sessionDirectory(id); await mkdir(path.join(directory, 'session.json'), { recursive: true });
    const writer = new WavWriter(path.join(directory, 'mic.wav')); writer.append(Buffer.alloc(RATE * 2)); writer.close();
    await assert.rejects(restoreRecordingMetadata(id));
    await writeFile(path.join(directory, 'session.json', 'still-a-directory'), 'Preserved');
    assert.equal(await readFile(path.join(directory, 'session.json', 'still-a-directory'), 'utf8'), 'Preserved');
});

test('installation status distinguishes source, stale build and the real launcher target', async () => {
    const project = await mkdtemp(path.join(tmpdir(), "sylloom-status-space'-")); const bin = path.join(project, 'bin');
    try {
        await mkdir(path.join(project, 'src')); await mkdir(path.join(project, 'dist'));
        await writeFile(path.join(project, 'package.json'), JSON.stringify({ version: '0.2.0' }));
        await writeFile(path.join(project, 'package-lock.json'), '{}'); await writeFile(path.join(project, 'tsconfig.json'), '{}');
        await writeFile(path.join(project, 'src', 'cli.ts'), 'export {};'); await writeFile(path.join(project, 'dist', 'cli.js'), ''); await writeFile(path.join(project, 'sylloom'), '');
        await writeFile(path.join(project, 'dist', 'build-info.json'), JSON.stringify({ version: '0.1.0', sourceHash: await sourceFingerprint(project), builtAt: '2026-10-19T10:00:00Z' }));
        await installCommand({ project, binDirectory: bin, configurePath: false, environment: { PATH: bin } });
        const status = await installationStatus(project, { PATH: bin });
        assert.equal(status.sourceVersion, '0.2.0'); assert.equal(status.builtVersion, '0.1.0'); assert.equal(status.launcherMatchesSource, true);
        assert.equal(status.buildMatchesSource, false);
        await writeFile(path.join(project, 'src', 'cli.ts'), 'export const changed = true;');
        assert.equal((await installationStatus(project, { PATH: bin })).buildMatchesSource, false);
    } finally { await rm(project, { recursive: true, force: true }); }
});

after(async () => { await rm(root, { recursive: true, force: true }); });
