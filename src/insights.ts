import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { atomicJson, home } from './store.js';
import { countWords, loadLibrary, recordingSeconds } from './library.js';
import type { Dictation } from './dictation.js';
import type { Library } from './library.js';

export type Usage = { id: string; at: string; words: number; seconds: number };
export type DayUsage = { date: string; words: number; seconds: number; dictations: number };
export type Insights = { words: number; seconds: number; dictations: number; wpm: number; currentStreak: number; longestStreak: number;
    today: DayUsage; days: DayUsage[]; meetingCount: number; meetingSeconds: number; notes: number; warnings: string[] };
const usageFile = () => path.join(home, 'usage.json');
let writes = Promise.resolve();

export function dayKey(value: Date): string {
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
}
const dayNumber = (key: string) => Date.parse(key + 'T00:00:00Z') / 86_400_000;

async function readUsage(): Promise<Usage[]> {
    if (!existsSync(usageFile())) return [];
    const data = JSON.parse(await readFile(usageFile(), 'utf8')) as { version: number; entries: Usage[] };
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.some(entry => !/^[a-f0-9-]{36}$/.test(entry.id) ||
        !Number.isFinite(Date.parse(entry.at)) || !Number.isInteger(entry.words) || entry.words < 0 || !Number.isFinite(entry.seconds) || entry.seconds < 0)) {
        throw new Error('Usage data is invalid. Your saved history is preserved.');
    }
    return data.entries;
}

function usageFor(item: Dictation, directory: string): Usage | undefined {
    const words = countWords(item.raw || (item.editedAt ? '' : item.text) || '');
    if (!words) return undefined;
    return { id: item.id, at: item.stoppedAt || item.startedAt, words, seconds: recordingSeconds(directory, item) };
}

export function recordUsage(item: Dictation, directory: string): Promise<void> {
    const entry = usageFor(item, directory);
    if (!entry) return Promise.resolve();
    const job = writes.catch(() => {}).then(async () => {
        const entries = await readUsage();
        const index = entries.findIndex(value => value.id === entry.id);
        if (index < 0) entries.push(entry); else entries[index] = entry;
        await atomicJson(usageFile(), { version: 1, entries });
    });
    writes = job; return job;
}

export function summarizeUsage(entries: Usage[], now = new Date()): Omit<Insights, 'meetingCount' | 'meetingSeconds' | 'notes' | 'warnings'> {
    const days = new Map<string, DayUsage>(); const unique = new Map(entries.map(entry => [entry.id, entry]));
    let timedWords = 0;
    for (const entry of unique.values()) {
        const date = dayKey(new Date(entry.at));
        if (date > dayKey(now) || !entry.words) continue;
        const day = days.get(date) || { date, words: 0, seconds: 0, dictations: 0 };
        day.words += entry.words; day.seconds += entry.seconds; day.dictations++; days.set(date, day);
        if (entry.seconds > 0) timedWords += entry.words;
    }
    const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    const words = sorted.reduce((sum, day) => sum + day.words, 0);
    const seconds = sorted.reduce((sum, day) => sum + day.seconds, 0);
    let longestStreak = 0, run = 0, previous = -Infinity;
    for (const day of sorted) { const index = dayNumber(day.date); run = index === previous + 1 ? run + 1 : 1; longestStreak = Math.max(longestStreak, run); previous = index; }
    const todayKey = dayKey(now); const todayNumber = dayNumber(todayKey);
    let cursor = days.has(todayKey) ? todayNumber : todayNumber - 1;
    let currentStreak = 0;
    const active = new Set(sorted.map(day => dayNumber(day.date)));
    while (active.has(cursor)) { currentStreak++; cursor--; }
    return { words, seconds, dictations: sorted.reduce((sum, day) => sum + day.dictations, 0), wpm: seconds > 0 ? Math.round(timedWords / seconds * 60) : 0,
        currentStreak, longestStreak, today: days.get(todayKey) || { date: todayKey, words: 0, seconds: 0, dictations: 0 }, days: sorted };
}

export async function loadInsights(now = new Date(), supplied?: Library, persistBackfill = true): Promise<Insights> {
    const library = supplied || await loadLibrary();
    // Backfill existing history once; retries update the same ID, never add activity.
    const entries = library.items.filter(item => item.kind === 'dictation' && ((item.data as Dictation).raw || (item.data as Dictation).text)).map(item => ({ item, data: item.data as Dictation }));
    const backfill = writes.catch(() => {}).then(async () => {
        const saved = await readUsage(); const ids = new Set(saved.map(entry => entry.id)); let changed = false;
        for (const { item, data } of entries) {
            const entry = usageFor(data, item.directory);
            if (entry && !ids.has(entry.id)) { saved.push(entry); ids.add(entry.id); changed = true; }
        }
        if (changed && persistBackfill) await atomicJson(usageFile(), { version: 1, entries: saved });
        return saved;
    });
    // The caller observes backfill errors; the separate queue tail must stay handled.
    writes = backfill.then(() => {}, () => {});
    const records = await backfill;
    const meetings = library.items.filter(item => item.kind === 'meeting');
    return { ...summarizeUsage(records, now), meetingCount: meetings.length, meetingSeconds: meetings.reduce((sum, item) => sum + item.seconds, 0),
        notes: meetings.filter(item => item.note).length, warnings: library.warnings };
}

export const activityLevel = (words: number): number => words <= 0 ? 0 : words < 100 ? 1 : words < 500 ? 2 : words < 1000 ? 3 : 4;
export function activityCalendar(days: DayUsage[], now = new Date(), weeks = 53): { date: string; words: number; level: number; future: boolean }[] {
    weeks = Number.isFinite(weeks) ? Math.max(1, Math.min(53, Math.floor(weeks))) : 53;
    const today = dayNumber(dayKey(now));
    const monday = today - (new Date(today * 86_400_000).getUTCDay() + 6) % 7;
    const start = monday - (Math.max(1, Math.min(53, weeks)) - 1) * 7;
    const activity = new Map(days.map(day => [day.date, day.words]));
    return Array.from({ length: weeks * 7 }, (_, index) => {
        const date = new Date((start + index) * 86_400_000).toISOString().slice(0, 10);
        const words = activity.get(date) || 0;
        return { date, words, level: activityLevel(words), future: start + index > today };
    });
}
