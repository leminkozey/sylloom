import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publicFiles, checkPublicFiles } from '../scripts/release.js';
import { parseNote, renderNote, attachEvidence } from '../src/notes.js';
import type { Session } from '../src/types.js';

test('public source selection excludes local state, models and workspace history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-public-test-'));
    try {
        for (const directory of ['src', 'data/recordings', 'node_modules', '.git', 'release']) await mkdir(path.join(root, directory), { recursive: true });
        for (const file of ['LICENSE', 'README.md', 'src/cli.ts', 'data/recordings/transcript.md', 'node_modules/private.txt', '.git/config', 'release/old.tar.gz']) await writeFile(path.join(root, file), 'fixture');
        assert.deepEqual(await publicFiles(root), ['LICENSE', 'README.md', 'src/cli.ts']);
        await checkPublicFiles(root, await publicFiles(root));
        await symlink(path.join(root, 'data/recordings/transcript.md'), path.join(root, 'src/leak.ts'));
        await assert.rejects(publicFiles(root), /symlink/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('public source scan rejects private paths and credential-like values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-privacy-test-'));
    try {
        for (const content of [path.posix.join('/', 'Users', 'fixture-account', 'recording.wav'), ['qa', 'private.invalid'].join('@'), 'sk-' + 'x'.repeat(30)]) {
            await writeFile(path.join(root, 'README.md'), content);
            await assert.rejects(checkPublicFiles(root, ['README.md']), /Release check found/);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('website assets have an explicit binary allowlist and page source still gets privacy checks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-site-release-'));
    try {
        await mkdir(path.join(root, 'website/assets/fonts'), { recursive: true });
        await writeFile(path.join(root, 'website/assets/ocean.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        await writeFile(path.join(root, 'website/assets/fonts/instrument-sans.ttf'), Buffer.from([0, 1, 0, 0]));
        await writeFile(path.join(root, 'website/index.html'), '<h1>Sylloom</h1>');
        await checkPublicFiles(root, await publicFiles(root));
        await writeFile(path.join(root, 'website/assets/ocean.jpg'), 'Unexpected replacement');
        await assert.rejects(checkPublicFiles(root, ['website/assets/ocean.jpg']), /Invalid website asset/);
        await writeFile(path.join(root, 'website/assets/private.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        await assert.rejects(publicFiles(root), /Unexpected website asset/);
        await writeFile(path.join(root, 'website/index.html'), path.posix.join('/', 'Users', 'fixture-account', 'recording.wav'));
        await assert.rejects(checkPublicFiles(root, ['website/index.html']), /Release check found/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('placeholder actions are omitted while real actions without owners survive', () => {
    const note = parseNote(JSON.stringify({ overview: 'A short recording check.', topics: ['Recording setup'], decisions: ['Not mentioned'],
        openQuestions: [], risks: [], nextSteps: [
            { task: 'Nicht genannt', owner: 'Nicht genannt', due: 'Nicht genannt', source: '00:00:01' },
            { task: 'Not mentioned', owner: '', due: '', source: '00:00:02' },
            { task: 'Check the microphone', owner: 'Unknown', due: 'Not specified', source: '00:00:03' },
        ] }));
    assert.equal(note.nextSteps.length, 1); assert.equal(note.nextSteps[0]?.owner, '');
    const session: Session = { id: '', name: 'Recording check', startedAt: '2026-01-01', stoppedAt: '', state: 'stopped', decision: null, recovered: false, events: [] };
    const rendered = renderNote(session, note);
    assert.match(rendered, /- \[ \] Check the microphone/);
    assert.doesNotMatch(rendered, /Nicht genannt|Not mentioned|Owner:|Due:|## Decisions/);
    const empty = renderNote(session, { ...note, nextSteps: [] });
    assert.match(empty, /No specific next steps agreed/); assert.doesNotMatch(empty, /- \[ \]/);
});

test('English date labels must match the original source date and owner', () => {
    const weekday = (day: number) => new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, day)));
    const note = { overview: 'Import check.', topics: [], decisions: [], openQuestions: [], risks: [], nextSteps: [
        { task: 'Check the import', owner: 'Alex', due: weekday(2), source: '00:00:09' },
    ] };
    const transcript = '[00:00:09] System audio: Alex prüft am Dienstag den Import.';
    attachEvidence(note, transcript);
    assert.throws(() => attachEvidence({ ...note, nextSteps: [{ ...note.nextSteps[0]!, due: weekday(3) }] }, transcript));
    assert.throws(() => attachEvidence({ ...note, nextSteps: [{ ...note.nextSteps[0]!, owner: 'Sam' }] }, transcript));
});
