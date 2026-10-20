import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';

const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-documents-'));
process.env.SYLLOOM_HOME = root;
const store = await import('../src/store.js');
const { renderMarkdown } = await import('../src/terminal/markdown.js');
const { exportDocument, exportName, renderHtml } = await import('../src/documents.js');
const { Transcription, decodeSegments, transcriptionProfile } = await import('../src/transcription.js');
const { ModelServer } = await import('../src/server.js');
const { WavWriter, RATE } = await import('../src/wav.js');
const { reopenSession } = await import('../src/workflow.js');

const markdown = '# Prüfung München\n\n## Nächste Schritte\n\n- [ ] **Import prüfen**\n  - Verantwortlich: Alex\n- [x] Export getestet\n\n' +
    '| Aufgabe | Status |\n| --- | --- |\n| Oberfläche 界 👩‍💻 | Offen |\n\n' +
    '> Eine wichtige Entscheidung.\n\n```ts\nconst value = 42;\n```\n\n[Dokumentation](https://example.com/docs)\n';

test('Markdown renders headings, tasks, nesting, tables and code within terminal columns', () => {
    const output = renderMarkdown(markdown, 32);
    const text = output.join('\n');
    assert.match(text, /Prüfung München/);
    assert.match(text, /☐ Import prüfen/);
    assert.match(text, /☑ Export getestet/);
    assert.match(text, /Verantwortlich: Alex/);
    assert.match(text, /│ Eine wichtige Entscheidung/);
    assert.match(text, /const value = 42;/);
    assert.doesNotMatch(text, /^#{1,6} |\*\*|```|\[ \]/m);
    for (const line of output) assert.ok(stringWidth(line) <= 32, 'Line exceeds terminal width: ' + line);
    assert.doesNotMatch(renderMarkdown('&#x1b;[31m **Text**\n<script>alert(1)</script>', 24).join('\n'), /\x1b|<script>/);
});

test('HTML export keeps document structure and removes active content and external resources', () => {
    const html = renderHtml(markdown + '\n<script>alert(1)</script><img src="https://remote.invalid/tracker"><iframe src="https://remote.invalid"></iframe>' +
        '<a href="javascript:alert(1)" onclick="alert(1)">Link</a>', 'Titel <script> & Test');
    assert.match(html, /<h2>Nächste Schritte<\/h2>/);
    assert.match(html, /<table>/);
    assert.match(html, /disabled="disabled"/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /Titel &lt;script&gt; &amp; Test/);
    assert.doesNotMatch(html, /<script>|<iframe|<img|onclick|javascript:|remote\.invalid/);
});

test('settings migration disables live work and upgrades only the original bundled model', async () => {
    await store.atomicJson(path.join(root, 'settings.json'), { ...store.defaults, live: true,
        whisperModel: path.join(store.modelDirectory, 'ggml-small-q5_1.bin'), input: 'Headset', output: 'Speakers' });
    let config = await store.settings();
    assert.equal(config.live, false);
    assert.equal(path.basename(config.whisperModel), 'ggml-large-v3.bin');
    assert.equal(config.input, 'Headset'); assert.equal(config.output, 'Speakers');
    await store.saveSettings({ ...config, whisperModel: '/custom/model.bin' });
    config = await store.settings();
    assert.equal(config.whisperModel, '/custom/model.bin');
});

test('automatic recognition retains detected language in reusable checkpoints without translation', async context => {
    const session = { id: randomUUID(), name: 'Language fixture', startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(),
        state: 'stopped' as const, decision: null, recovered: false, events: [] };
    const directory = path.join(root, 'language-fixture'); await mkdir(path.join(directory, 'chunks'), { recursive: true });
    const pcm = Buffer.alloc(RATE * 2);
    for (let sample = 0; sample < RATE; sample++) pcm.writeInt16LE(Math.round(Math.sin(sample * 0.1) * 8000), sample * 2);
    const writer = new WavWriter(path.join(directory, 'mic.wav')); writer.append(pcm); writer.close();
    context.mock.method(ModelServer.prototype, 'start', async () => 'http://localhost');
    context.mock.method(ModelServer.prototype, 'stop', async () => {});
    let requests = 0;
    context.mock.method(globalThis, 'fetch', async (_url, init) => {
        const form = init?.body as FormData; requests++;
        assert.equal(form.get('language'), 'auto'); assert.equal(form.get('translate'), 'false');
        assert.equal(form.get('no_language_probabilities'), 'true');
        return Response.json({ text: 'Please do not send the file.', language: 'english' });
    });
    const config = { ...store.defaults, language: 'auto' };
    const first = new Transcription(session, config, directory);
    try { await first.initialize(); await first.drain(); assert.equal(first.language, 'english'); } finally { await first.close(); }
    const cached = new Transcription(session, config, directory);
    try { await cached.initialize(); assert.equal(cached.language, 'english'); await cached.drain(); assert.equal(requests, 1); } finally { await cached.close(); }
});

test('offline transcription refuses a running recording and ignores old live/model checkpoints', async () => {
    const session = await store.createSession();
    const config = { ...store.defaults };
    const transcription = new Transcription(session, config);
    try {
        await assert.rejects(transcription.initialize(), /only after recording stops/);
        const writer = new WavWriter(path.join(store.sessionDirectory(session.id), 'system.wav'));
        writer.append(Buffer.alloc(RATE * 2)); writer.close();
        await store.atomicJson(store.chunkFile(session.id, 'system', 0), { source: 'system', offset: 0, samples: RATE,
            state: 'done', segments: [{ source: 'system', start: 0, end: 1, text: 'Altes Live-Transkript' }] });
        session.state = 'stopped'; await store.saveSession(session);
        await transcription.initialize();
        assert.equal(transcription.jobs.length, 0);
        await transcription.drain();
        assert.equal(transcription.jobs.length, 1);
        assert.ok(transcription.jobs[0]?.profile);
        assert.equal(transcription.segments.length, 0);
        assert.doesNotMatch(await readFile(path.join(store.sessionDirectory(session.id), 'transcript.md'), 'utf8'), /Altes Live/);
        assert.notEqual(transcriptionProfile(config), transcriptionProfile({ ...config, language: 'en' }));
        assert.notEqual(transcriptionProfile(config), transcriptionProfile(config, 1));
        await store.nameSession(session, 'Prüfung München');
        await writeFile(path.join(store.sessionDirectory(session.id), 'note.md'), markdown);
        await store.completeSession(session, 'summarize');
    } finally { await transcription.close(); }
});

test('overlap decoding assigns segments once and preserves real source timestamps', () => {
    const job = { source: 'system' as const, offset: RATE * 300, samples: RATE * 300, state: 'done' as const, segments: [] };
    const segments = decodeSegments({ text: 'Text', segments: [
        { start: 1, end: 4, text: 'Voriger Abschnitt' },
        { start: 10, end: 15, text: 'Neue Aussage\n mit Umlauten: üß.' },
        { start: 309, end: 312, text: 'Nächster Abschnitt' },
    ] }, job, RATE * 292);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.start, 302);
    assert.equal(segments[0]?.text, 'Neue Aussage mit Umlauten: üß.');
    assert.throws(() => decodeSegments({}, job, RATE * 292), /valid transcript/);
});

test('exports preserve Markdown, protect existing files and respect transcript deletion', async () => {
    const session = (await store.sessions())[0]!;
    const output = path.join(root, 'exports', 'Notiz.md');
    await exportDocument(session, 'note', output, 'md');
    assert.equal(await readFile(output, 'utf8'), markdown);
    await writeFile(output, 'Vorhandene Datei');
    await assert.rejects(exportDocument(session, 'note', output, 'md'), /already exists/);
    assert.equal(await readFile(output, 'utf8'), 'Vorhandene Datei');
    await exportDocument(session, 'note', output, 'md', true);
    assert.equal(await readFile(output, 'utf8'), markdown);
    await assert.rejects(exportDocument(session, 'note', path.join(root, 'test.pdf'), 'html'), /\.html/);
    assert.doesNotMatch(exportName({ ...session, name: '../../Prüfung' }, 'note', 'md'), /[/\\]/);
    const html = path.join(root, 'exports', 'Notiz.html');
    await exportDocument(session, 'note', html, 'html');
    assert.match(await readFile(html, 'utf8'), /<h1>Prüfung München<\/h1>/);
    await store.atomicJson(path.join(root, 'views', session.id + '-transcript.html'), { content: 'Cached raw transcript' });
    await reopenSession(session);
    assert.equal(session.transcriptionRevision, 1);
    await store.completeSession(session, 'note-only');
    await assert.rejects(exportDocument(session, 'transcript', path.join(root, 'raw.md'), 'md'));
    await assert.rejects(readFile(path.join(root, 'views', session.id + '-transcript.html')));
    assert.match(await readFile(html, 'utf8'), /Prüfung München/);
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });
