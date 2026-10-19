import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { openSync, closeSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-tests-'));
process.env.SYLLOOM_HOME = root;
const store = await import('../src/store.js');
const { WavWriter, RATE, wavHeader, readWavSlice, repairWav, sampleCount, hasSpeechEnergy } = await import('../src/wav.js');
const { resolveDevice } = await import('../src/audio.js');
const { localUrl } = await import('../src/server.js');
const { fit } = await import('../src/terminal/screen.js');
const { parseNote, renderNote, splitTranscript, validateEvidence, attachEvidence } = await import('../src/notes.js');
const { recoverSessions } = await import('../src/workflow.js');

test('WAV preserves gaps, recovers interrupted headers and exposes exact slices', async () => {
    const file = path.join(root, 'audio.wav');
    const writer = new WavWriter(file);
    const pcm = Buffer.alloc(RATE * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(4096, offset);
    writer.append(pcm);
    writer.padTo(RATE * 2);
    writer.append(pcm);
    writer.close();
    assert.equal(sampleCount(file), RATE * 3);
    assert.equal(hasSpeechEnergy(readWavSlice(file, 0, RATE)), true);
    assert.equal(hasSpeechEnergy(readWavSlice(file, RATE, RATE)), false);
    const fd = openSync(file, 'r+'); writeSync(fd, wavHeader(0), 0, 44, 0); closeSync(fd);
    repairWav(file);
    assert.equal((await readFile(file)).readUInt32LE(40), RATE * 3 * 2);
    assert.throws(() => wavHeader(0x100000000));
});

test('device selection follows defaults, falls back on disconnect and returns to pinned device', () => {
    const device = (id: string, sourceKind: string, isDefault: boolean) => ({ id, name: id, sourceKind, isDefault, channels: 1, sampleRate: 48000, formatAvailable: true, isLoopback: sourceKind === 'system' });
    const builtIn = device('builtin', 'mic', true);
    const headset = device('headset', 'mic', false);
    assert.equal(resolveDevice([builtIn, headset], 'mic', 'default')?.id, 'builtin');
    assert.equal(resolveDevice([builtIn, { ...headset, isDefault: true }].map(d => d.id === 'builtin' ? { ...d, isDefault: false } : d), 'mic', 'default')?.id, 'headset');
    assert.equal(resolveDevice([builtIn, headset], 'mic', 'headset')?.id, 'headset');
    assert.equal(resolveDevice([builtIn], 'mic', 'headset')?.id, 'builtin');
    assert.equal(resolveDevice([builtIn, headset], 'mic', 'headset')?.id, 'headset');
    assert.equal(resolveDevice([builtIn, { ...headset, formatAvailable: false }], 'mic', 'headset')?.id, 'builtin');
    assert.equal(resolveDevice([], 'system', 'default'), undefined);
});

test('local model endpoints reject external addresses and embedded credentials', () => {
    assert.equal(localUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
    assert.equal(localUrl('http://[::1]:8080'), 'http://[::1]:8080');
    for (const value of ['https://example.com', 'http://example.com', 'http://127.0.0.1.example.com', 'http://user:secret@localhost:8080', 'file:///tmp/model']) assert.throws(() => localUrl(value));
});

test('Unicode cropping keeps terminal cells', () => {
    assert.equal(fit('A界B', 3), 'A…');
    assert.equal(fit('👩‍💻 test', 2), '…');
});

test('structured notes reject malformed tasks and omit unknown owners without losing real actions', () => {
    const value = { overview: 'Import pausiert.', topics: ['CSV-Import'], decisions: ['Pausieren'], openQuestions: ['Altbestand betroffen?'], nextSteps: [{ task: 'Duplikate prüfen', owner: 'Nicht genannt', due: 'Nicht genannt', source: '[00:00:10]', evidence: 'Wir prüfen die Duplikate.' }], risks: [] };
    const note = parseNote(JSON.stringify(value));
    assert.equal(note.nextSteps[0]?.owner, '');
    assert.throws(() => parseNote(JSON.stringify({ ...value, nextSteps: [{ task: 'Test' }] })));
    assert.throws(() => parseNote('kein JSON'));
    validateEvidence(note, '[00:00:10] Systemaudio: Wir prüfen die Duplikate.');
    attachEvidence(note, '[00:00:10] Systemaudio: Wir prüfen die Duplikate.');
    assert.equal(note.nextSteps[0]?.evidence, 'Wir prüfen die Duplikate.');
    assert.throws(() => validateEvidence({ ...note, nextSteps: [{ ...note.nextSteps[0]!, owner: 'Erfundene Person' }] }, '[00:00:10] Systemaudio: Wir prüfen die Duplikate.'));
    assert.throws(() => validateEvidence(note, '[00:00:20] Systemaudio: Keine Aufgaben vereinbart.'));
    const session = { id: '', name: 'Import', startedAt: '2026-10-19', stoppedAt: '', state: 'stopped', decision: null, recovered: false, events: [] } as const;
    const output = renderNote({ ...session, events: [] }, note);
    assert.match(output, /## Open questions/);
    assert.doesNotMatch(output, /Owner:|Due:|Nicht genannt|Not mentioned/);
    assert.match(output, /- \[ \] Duplikate prüfen/);
    const transcript = 'A'.repeat(25_000);
    assert.equal(splitTranscript(transcript).join(''), transcript);
});

test('an unfinished recording blocks the next one; crash recovery never decides for the user', async () => {
    const session = await store.createSession();
    await assert.rejects(store.createSession(), /still pending/);
    await assert.rejects(store.nameSession(session, '  '));
    await assert.rejects(store.completeSession(session, 'keep'), /Stop and name/);
    const file = path.join(store.sessionDirectory(session.id), 'mic.wav');
    const writer = new WavWriter(file); writer.append(Buffer.alloc(RATE * 2)); writer.close();
    await recoverSessions();
    const recovered = await store.loadSession(session.id);
    assert.equal(recovered.state, 'stopped');
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.decision, null);
    assert.equal(recovered.name, null);
    await store.nameSession(recovered, '../Prüfung\x1b[31m München');
    assert.equal(recovered.name, '../Prüfung München');
    await assert.rejects(store.completeSession(recovered, 'note-only'), /note is missing/);
    await writeFile(path.join(store.sessionDirectory(session.id), 'transcript.md'), 'Privater Testtext');
    await writeFile(path.join(store.sessionDirectory(session.id), 'transcript.md.tmp'), 'Privater Testtext');
    await store.atomicJson(store.chunkFile(session.id, 'mic', 0), { text: 'Privater Testtext' });
    await store.completeSession(recovered, 'delete');
    assert.equal((await store.loadSession(session.id)).state, 'done');
    assert.ok((await stat(file)).size > 44);
    await assert.rejects(readFile(path.join(store.sessionDirectory(session.id), 'transcript.md')));
    await assert.rejects(readFile(path.join(store.sessionDirectory(session.id), 'transcript.md.tmp')));
    await assert.rejects(stat(path.join(store.sessionDirectory(session.id), 'chunks')));
    assert.throws(() => store.sessionDirectory('../../unsafe'));
});

test('the storage lock excludes a second controller', async () => {
    const release = await store.acquireLock();
    await assert.rejects(store.acquireLock(), /already running/);
    await release();
    const releaseAgain = await store.acquireLock();
    await releaseAgain();
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });
