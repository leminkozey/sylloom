import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { atomicJson, home, validateSession } from './store.js';
import { RATE, sampleCount } from './wav.js';
import { cleanText } from './types.js';
import type { Session } from './types.js';
import type { Dictation } from './dictation.js';

export type LibraryKind = 'meeting' | 'dictation';
export type LibraryItem = { kind: LibraryKind; id: string; title: string; date: string; status: string; pinned: boolean;
    words: number; seconds: number; text: string; note?: string; transcript?: string; data: Session | Dictation; directory: string };
export type Library = { items: LibraryItem[]; warnings: string[] };
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
export const countWords = (text: string): number => [...segmenter.segment(text)].filter(part => part.isWordLike).length;
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

export function recordingSeconds(directory: string, item: Session): number {
    const lengths = ['mic', 'system'].map(source => {
        try { return sampleCount(path.join(directory, source + '.wav')) / RATE; } catch { return 0; }
    });
    const elapsed = item.stoppedAt ? (Date.parse(item.stoppedAt) - Date.parse(item.startedAt)) / 1000 : 0;
    return Math.max(...lengths, Number.isFinite(elapsed) ? elapsed : 0);
}

export async function loadLibrary(root = home): Promise<Library> {
    const items: LibraryItem[] = []; const warnings: string[] = [];
    for (const kind of ['meeting', 'dictation'] as const) {
        const collection = path.join(root, kind === 'meeting' ? 'recordings' : 'dictations');
        if (!existsSync(collection)) continue;
        const directories = (await readdir(collection, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name));
        for (let offset = 0; offset < directories.length; offset += 16) {
            await Promise.all(directories.slice(offset, offset + 16).map(async entry => {
                const directory = path.join(collection, entry.name);
                try {
                    const data = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')) as Dictation;
                    if (kind === 'meeting') validateSession(data, entry.name);
                    if (data.id !== entry.name || typeof data.startedAt !== 'string' || !Number.isFinite(Date.parse(data.startedAt))) throw new Error('Invalid metadata');
                    const document = async (file: string): Promise<string | undefined> => {
                        const source = path.join(directory, file); if (!existsSync(source)) return undefined;
                        try { return cleanText(await readFile(source, 'utf8')); }
                        catch { warnings.push('Could not index ' + kind + ' document: ' + entry.name); return undefined; }
                    };
                    const [note, transcript] = await Promise.all([document('note.md'), document('transcript.md')]);
                    const text = kind === 'dictation' ? [data.text, data.raw].filter(Boolean).join('\n\n') : [note, transcript].filter(Boolean).join('\n\n');
                    const title = data.name && !['Dictation', 'Diktat'].includes(data.name) ? data.name :
                        kind === 'dictation' ? (data.text || data.raw || '').replace(/\s+/g, ' ').slice(0, 90) || 'Untitled dictation' : 'Untitled recording';
                    const status = kind === 'dictation' ? data.outcome || (data.error ? 'failed' : data.text ? 'completed' : data.state === 'recording' ? 'recording' : 'pending') :
                        data.state === 'done' ? note ? 'note' : data.decision === 'delete' ? 'audio only' : 'transcript' : data.state === 'stopped' ? 'pending' : data.state;
                    items.push({ kind, id: data.id, title: cleanText(title), date: data.startedAt, status, pinned: Boolean(data.pinned),
                        words: countWords(kind === 'dictation' ? data.raw || data.text || '' : note || transcript || ''),
                        seconds: recordingSeconds(directory, data), text, note, transcript, data, directory });
                } catch { warnings.push('Could not read ' + kind + ': ' + entry.name); }
            }));
        }
    }
    return { items: items.sort((a, b) => b.date.localeCompare(a.date)), warnings };
}

export type LibraryFilter = { kind?: LibraryKind; pinned?: boolean; attention?: boolean; sort?: 'recent' | 'oldest' | 'words'; from?: string; to?: string; status?: string };
export function localDay(value: string | Date): string {
    const date = new Date(value); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
export function validDay(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function searchLibrary(items: LibraryItem[], query = '', filter: LibraryFilter = {}): LibraryItem[] {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    const matching = items.filter(item => (!filter.kind || item.kind === filter.kind) && (!filter.pinned || item.pinned) &&
        (!filter.attention || ['failed', 'canceled', 'interrupted', 'pending'].includes(item.status)) &&
        (!filter.from || localDay(item.date) >= filter.from) && (!filter.to || localDay(item.date) <= filter.to) && (!filter.status || item.status === filter.status) &&
        terms.every(term => normalize(item.title + '\n' + item.text + '\n' + item.date + '\n' + item.status).includes(term)));
    const score = (item: LibraryItem) => terms.reduce((sum, term) => sum + (normalize(item.title).includes(term) ? 10 : 0), 0);
    return matching.sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b) - score(a) ||
        (filter.sort === 'oldest' ? a.date.localeCompare(b.date) : filter.sort === 'words' ? b.words - a.words : b.date.localeCompare(a.date)));
}

export function librarySnippet(item: LibraryItem, query = '', limit = 160): string {
    const source = cleanText(item.text).replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    const term = normalize(query).trim().split(/\s+/).find(Boolean);
    const start = term ? Math.max(0, normalize(source).indexOf(term) - 40) : 0;
    return (start ? '…' : '') + source.slice(start, start + limit) + (source.length > start + limit ? '…' : '');
}

export async function updateLibraryItem(item: LibraryItem, changes: { name?: string; pinned?: boolean }): Promise<void> {
    const file = path.join(item.directory, 'session.json');
    const current = JSON.parse(await readFile(file, 'utf8')) as Session;
    if (current.id !== item.id) throw new Error('Library item does not match its metadata.');
    if (changes.name !== undefined) {
        const name = cleanText(changes.name).replace(/\s+/g, ' ').trim();
        if (!name || name.length > 160) throw new Error('Enter a name from 1 to 160 characters.');
        current.name = name;
    }
    if (changes.pinned !== undefined) current.pinned = changes.pinned;
    await atomicJson(file, current);
    Object.assign(item.data, current); item.pinned = Boolean(current.pinned); item.title = current.name || item.title;
}
