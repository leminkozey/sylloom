import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dictation } from '../src/dictation.js';
import type { Usage } from '../src/insights.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-library-'));
process.env.SYLLOOM_HOME = root;
const { loadLibrary, searchLibrary, updateLibraryItem, countWords } = await import('../src/library.js');
const { summarizeUsage, activityCalendar, recordUsage, loadInsights } = await import('../src/insights.js');
const { insightsHtml, shareText, shareUrl, renderInsights, insightsMenu } = await import('../src/insights-ui.js');
const { libraryMenu } = await import('../src/library-ui.js');
import type { Screen } from '../src/terminal/screen.js';
const { recoverDictations } = await import('../src/dictation.js');
const { WavWriter, RATE } = await import('../src/wav.js');
const item = (changes: Partial<Dictation> = {}): Dictation => ({ id: randomUUID(), name: 'Dictation', startedAt: '2026-10-18T10:00:00Z',
    stoppedAt: '2026-10-18T10:00:30Z', state: 'done', outcome: 'completed', decision: null, recovered: false, events: [], format: 'message', ...changes });
async function saved(data: Dictation, kind = 'dictations'): Promise<string> {
    const directory = path.join(root, kind, data.id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'session.json'), JSON.stringify(data)); return directory;
}

test('Library searches original speech and notes, ignores accents, filters and pins', async () => {
    const voice = item({ raw: 'Bitte übermorgen den Import prüfen.', text: 'Bitte den Import prüfen.' }); await saved(voice);
    const meeting = item({ name: 'Planning', pinned: true, decision: 'summarize' }); const directory = await saved(meeting, 'recordings');
    await writeFile(path.join(directory, 'note.md'), '# Release\nOffen: Café und Import.');
    const corrupt = path.join(root, 'dictations', randomUUID()); await mkdir(corrupt); await writeFile(path.join(corrupt, 'session.json'), '{');
    const library = await loadLibrary();
    assert.equal(searchLibrary(library.items, 'ubermorgen import')[0]?.id, voice.id);
    assert.equal(searchLibrary(library.items, 'cafe', { kind: 'meeting' })[0]?.id, meeting.id);
    assert.equal(searchLibrary(library.items, '', { pinned: true })[0]?.id, meeting.id);
    assert.equal(searchLibrary(library.items)[0]?.id, meeting.id);
    assert.equal(library.warnings.length, 1);
    assert.equal(countWords('Hallo 👋 世界! zwei Wörter.'), 4);
    const selected = library.items.find(value => value.id === voice.id)!;
    await writeFile(path.join(selected.directory, 'session.json'), JSON.stringify({ ...voice, copiedAt: 'preserved' }));
    await updateLibraryItem(selected, { name: 'Import check', pinned: true });
    const metadata = JSON.parse(await readFile(path.join(selected.directory, 'session.json'), 'utf8'));
    assert.equal(metadata.copiedAt, 'preserved'); assert.equal(metadata.raw, voice.raw); assert.equal(metadata.pinned, true);
    await assert.rejects(updateLibraryItem(selected, { name: ' ' }), /name/);
});

test('usage computes weighted WPM, local-day streaks, gaps and duplicate retries', () => {
    const now = new Date(2026, 9, 19, 12);
    const usage = (day: number, words: number, seconds: number): Usage => ({ id: randomUUID(), at: new Date(2026, 9, day, 12).toISOString(), words, seconds });
    const previous = usage(18, 120, 60); const today = usage(19, 30, 60);
    const stats = summarizeUsage([usage(15, 20, 20), previous, previous, today, usage(20, 900, 1)], now);
    assert.equal(stats.words, 170); assert.equal(stats.dictations, 3); assert.equal(stats.wpm, 73);
    assert.equal(stats.currentStreak, 2); assert.equal(stats.longestStreak, 2); assert.equal(stats.today.words, 30);
    assert.equal(summarizeUsage([previous], now).currentStreak, 1);
    assert.equal(summarizeUsage([usage(17, 10, 10)], now).currentStreak, 0);
    assert.equal(summarizeUsage([usage(19, 200, 0)], now).wpm, 0);
    assert.equal(summarizeUsage([], now).longestStreak, 0);
    const dst = [25, 26, 27].map(day => ({ ...usage(day, 10, 10), at: new Date(2026, 9, day, 12).toISOString() }));
    assert.equal(summarizeUsage(dst, new Date(2026, 9, 27, 12)).currentStreak, 3);
});

test('calendar starts on Monday, marks future days and clamps requested sizes', () => {
    const now = new Date(2026, 9, 19, 12); const cells = activityCalendar([], now, 4);
    assert.equal(cells.length, 28); assert.equal(new Date(cells[0]!.date).getUTCDay(), 1);
    assert.equal(cells.filter(cell => cell.future).length, 6);
    assert.equal(activityCalendar([], now, 999).length, 371);
    assert.equal(activityCalendar([], now, -3).length, 7);
});

test('activity backfills history once, survives deletion and refuses corrupt ledger writes', async () => {
    const data = item({ raw: 'Eins zwei drei vier.' }); const directory = await saved(data);
    await recordUsage(data, directory); await recordUsage(data, directory);
    const before = await loadInsights(new Date('2026-10-19T12:00:00Z'));
    await rm(directory, { recursive: true });
    const after = await loadInsights(new Date('2026-10-19T12:00:00Z'));
    assert.equal(after.words, before.words); assert.equal(after.dictations, before.dictations);
    const ledger = path.join(root, 'usage.json'); await writeFile(ledger, '{broken');
    await assert.rejects(recordUsage(data, directory)); assert.equal(await readFile(ledger, 'utf8'), '{broken');
    await rm(ledger);
});

test('interrupted microphone WAVs are recovered and retained without a transcript decision', async () => {
    const data = item({ state: 'recording', outcome: undefined, stoppedAt: null }); const directory = await saved(data);
    const wav = new WavWriter(path.join(directory, 'mic.wav')); wav.append(Buffer.alloc(RATE * 2)); wav.close();
    await recoverDictations();
    const result = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
    assert.equal(result.outcome, 'interrupted'); assert.equal(result.state, 'stopped'); assert.equal(result.decision, null);
    assert.equal((await readFile(path.join(directory, 'mic.wav'))).length, 44 + RATE * 2);
});

test('dashboard and X draft expose aggregates only, with no Library text or paths', async () => {
    const stats = await loadInsights(new Date('2026-10-19T12:00:00Z'));
    stats.warnings.push('PRIVATE_CONTEXT');
    const html = insightsHtml(stats); assert.doesNotMatch(html, /PRIVATE_CONTEXT|übermorgen|Import check/);
    assert.match(html, /Content-Security-Policy/); assert.match(html, /script nonce=/);
    assert.equal(new URL(shareUrl(stats)).searchParams.get('text'), shareText(stats));
    assert.equal(new URL(shareUrl(stats)).hostname, 'x.com');
    assert.ok(shareText(stats).length < 280);
    assert.equal(renderInsights(stats, 40).filter(line => line.startsWith('Mon'))[0]?.length, 39);
});

test('quitting an item or share preview exits immediately without reopening its parent', async () => {
    let pages = 0;
    const share = { quitRequested: false, page: async () => { assert.equal(++pages, 1); return 'share'; },
        select: async () => { share.quitRequested = true; return 'quit'; } };
    await insightsMenu(share as unknown as Screen); assert.equal(pages, 1);
    let searches = 0;
    const library = { quitRequested: false, browse: async (_title: string, choices: (query: string) => { value: string }[]) => {
        assert.equal(++searches, 1); return choices('')[0]!.value;
    } };
    await libraryMenu(library as unknown as Screen, async () => { library.quitRequested = true; });
    assert.equal(searches, 1);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
