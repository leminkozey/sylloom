import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Dictation } from '../src/dictation.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-speech-rules-'));
process.env.SYLLOOM_HOME = root;
const rules = await import('../src/speech-rules.js');
const { defaults, atomicJson } = await import('../src/store.js');
const { DictationService, dictationDirectory } = await import('../src/dictation.js');
const { recordUsage, loadInsights } = await import('../src/insights.js');
const { speechRulesMenu } = await import('../src/speech-rules-ui.js');
const { Transcription, transcriptionProfile } = await import('../src/transcription.js');
const { ModelServer } = await import('../src/server.js');
const { WavWriter, RATE } = await import('../src/wav.js');

test('corrections match whole words once and preserve URLs, addresses, all path forms and Markdown code', () => {
    let profile = rules.addCorrection(rules.emptySpeechRules(), 'flow', 'Sylloom');
    profile = rules.addCorrection(profile, 'Sylloom', 'Other');
    const protectedText = ['Workflow', 'flow-state', '/tmp/flow', '/flow', '~/flow', 'C:\\flow', '\\\\flow', 'flow.txt', 'https://flow.test/x', 'HTTPS://example.test?q=flow', ['flow', 'example.test'].join('@'), '`flow`', '```\nflow\n```'].join(' ');
    assert.equal(rules.applyTextRules(protectedText, profile), protectedText);
    assert.equal(rules.applyTextRules('Flow. flow, Sylloom!', profile), 'Sylloom. Sylloom, Other!');
    profile = rules.addCorrection(profile, 'Klammer auf', '(');
    assert.equal(rules.applyTextRules('Klammer auf test', profile), '( test');
    assert.equal(rules.applyTextRules('flow', { ...profile, enabled: false }), 'flow');
    assert.equal(rules.applyTextRules('flow', rules.toggleSpeechRule(profile, profile.corrections[0]!.id)), 'flow');
});

test('word spellings and explicit corrections have deterministic precedence without mutating source text', () => {
    let profile = rules.addWord(rules.emptySpeechRules(), 'Sylloom');
    profile = rules.addWord(profile, 'Café');
    profile = rules.addCorrection(profile, 'sylloom', 'Sylloom CLI');
    const original = 'sylloom and cafe\u0301.';
    assert.equal(rules.applyTextRules(original, profile), 'Sylloom CLI and Café.');
    assert.equal(original, 'sylloom and cafe\u0301.');
    assert.equal(rules.dictionaryPrompt(profile), 'Sylloom, Café');
    assert.equal(rules.dictionaryPrompt({ ...profile, enabled: false }), '');
});

test('invalid and duplicate triggers fail before storage, while punctuation replacements are supported', () => {
    const profile = rules.addSnippet(rules.emptySpeechRules(), 'Textbaustein Signatur', 'Thanks.\n\nAlex & team');
    assert.throws(() => rules.addSnippet(profile, ' textbaustein   signatur. ', 'Other'), /already exists/);
    for (const trigger of ['', '...', '👋']) assert.throws(() => rules.addSnippet(profile, trigger, 'Body'));
    assert.throws(() => rules.addSnippet(profile, 'Other trigger', ' '));
    assert.throws(() => rules.addWord(rules.addWord(profile, 'Café'), 'CAFÉ'), /already exists/);
    assert.throws(() => rules.addCorrection(rules.addCorrection(profile, 'flow', 'Sylloom'), 'FLOW', 'Other'), /already exists/);
});

test('whole-dictation snippets preserve exact paragraphs and never expand inside a sentence', () => {
    const body = 'Thanks & regards,\n\nAlex\n* Product team *';
    const profile = rules.addSnippet(rules.emptySpeechRules(), 'Textbaustein Signatur', body);
    assert.equal(rules.matchSnippet('  Textbaustein Signatur! ', profile)?.text, body);
    assert.equal(rules.matchSnippet('Please add Textbaustein Signatur here.', profile), undefined);
    assert.equal(rules.matchSnippet('Textbaustein Signatur', { ...profile, enabled: false }), undefined);
});

test('unreadable speech data is preserved and never reset to an empty profile', async () => {
    const file = path.join(root, 'speech-rules.json'); await writeFile(file, '{broken');
    await assert.rejects(rules.loadSpeechRules(), /preserved/);
    assert.equal(await readFile(file, 'utf8'), '{broken');
    await rm(file);
});

test('dictation expands snippets without a formatter and counts only actually spoken words', async () => {
    const body = 'One long predefined paragraph with extra words.\n\nRegards & thanks.';
    await rules.saveSpeechRules(rules.addSnippet(rules.emptySpeechRules(), 'Textbaustein Signatur', body));
    const item: Dictation = { id: randomUUID(), name: 'Synthetic snippet', startedAt: '2026-10-19T10:00:00Z', stoppedAt: '2026-10-19T10:00:02Z',
        state: 'stopped', decision: null, recovered: false, events: [], format: 'email', raw: 'Textbaustein Signatur.' };
    const directory = dictationDirectory(item.id);
    await atomicJson(path.join(directory, 'session.json'), item);
    const service = new DictationService({ ...defaults, dictationPolish: 'always', dictationNotifications: false });
    const internal = service as unknown as { previous: Dictation; process(item: Dictation, signal: AbortSignal): Promise<void> };
    internal.previous = structuredClone(item);
    try {
        await internal.process(item, new AbortController().signal);
        assert.equal(item.raw, 'Textbaustein Signatur.'); assert.equal(item.text, body);
        assert.equal(item.timings?.usedFormatter, false);
        await recordUsage(item, directory);
        const insights = await loadInsights(new Date('2026-10-19T12:00:00Z'));
        assert.equal(insights.words, 2);
    } finally { await service.close(); await rm(path.join(root, 'speech-rules.json')); }
});

test('the dictation vocabulary is sent locally and participates in checkpoint identity', async () => {
    const item: Dictation = { id: randomUUID(), name: 'Vocabulary fixture', startedAt: '2026-10-19T10:00:00Z', stoppedAt: '2026-10-19T10:00:01Z', state: 'stopped', decision: null, recovered: false, events: [], format: 'message' };
    const directory = dictationDirectory(item.id); await atomicJson(path.join(directory, 'session.json'), item);
    const wav = new WavWriter(path.join(directory, 'mic.wav')); wav.append(Buffer.alloc(RATE * 2).fill(Buffer.from([0xe8, 0x03]))); wav.close();
    const server = new ModelServer('unused', 'unused', 'whisper'); server.start = async () => 'http://127.0.0.1:1'; server.stop = async () => {};
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => { assert.equal((options!.body as FormData).get('prompt'), 'Sylloom'); return new Response(JSON.stringify({ text: 'Sylloom.', segments: [{ start: 0, end: 1, text: 'Sylloom.' }] })); };
    const transcription = new Transcription(item, defaults, directory, server, 'Sylloom');
    try { await transcription.initialize(); await transcription.drain(); assert.notEqual(transcriptionProfile(defaults), transcriptionProfile(defaults, 0, 'Sylloom')); }
    finally { globalThis.fetch = previousFetch; await transcription.close(); }
});

test('snippets validate the trigger before opening a long editor and provide a scrollable plain preview', async () => {
    await rules.saveSpeechRules(rules.emptySpeechRules());
    let edited = false;
    let actions = ['snippets', 'add', 'back', 'back'];
    const invalidScreen = { quitRequested: false, select: async () => actions.shift(), input: async (_title: string, _detail: string, _initial: string, options?: { multiline?: boolean }) => {
        if (options?.multiline) edited = true; return '...';
    }, notice: async () => {} } as unknown as import('../src/terminal/screen.js').Screen;
    await speechRulesMenu(invalidScreen); assert.equal(edited, false);
    const body = Array.from({ length: 25 }, (_, index) => 'Line ' + index).join('\n');
    actions = ['snippets', 'add', 'use', 'back', 'save'];
    let inputs = ['Textbaustein Long', body], preview = '';
    const screen = { quitRequested: false, select: async () => actions.shift(), input: async () => inputs.shift(),
        view: async (_title: string, text: () => string, options: { markdown: boolean }) => { assert.equal(options.markdown, false); preview = text(); }, notice: async () => {} } as unknown as import('../src/terminal/screen.js').Screen;
    await speechRulesMenu(screen); assert.ok(preview.includes('Line 24'));
    assert.equal((await rules.loadSpeechRules()).snippets[0]?.text, body);
});

test('command-line rules preserve multiline files and support safe previews and disabling', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sylloom-rules-cli-'));
    const command = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'rules', ...args], { env: { ...process.env, SYLLOOM_HOME: directory }, encoding: 'utf8', timeout: 10000 });
    try {
        const text = 'First & second.\n\nThird line'; const file = path.join(directory, 'snippet.txt'); await writeFile(file, text);
        assert.equal(command(['snippet', 'Textbaustein Check', '--file', file]).status, 0);
        assert.equal(JSON.parse(command(['preview', 'Textbaustein Check.']).stdout).after, text);
        assert.equal(command(['disable']).status, 0);
        assert.equal(JSON.parse(command(['preview', 'Textbaustein Check.']).stdout).after, 'Textbaustein Check.');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

after(async () => { await rm(root, { recursive: true, force: true }); });
