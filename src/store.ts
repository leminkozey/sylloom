import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Chunk, Decision, Session, Settings } from './types.js';
import { cleanText } from './types.js';
import { lockController } from './native/controller-lock.js';

export const home = path.resolve(process.env.SYLLOOM_HOME || process.env.MEETING_HOME || fileURLToPath(new URL('../data/', import.meta.url)));
export const modelDirectory = path.join(home, 'models');
export const defaults: Settings = {
    input: 'default', output: 'default', language: 'auto', live: false,
    whisperBinary: 'whisper-server', whisperModel: path.join(modelDirectory, 'ggml-large-v3.bin'),
    llm: 'llama', llmBinary: 'llama-server', llmModel: path.join(modelDirectory, 'Qwen3-4B-Q4_K_M.gguf'),
    ollamaModel: 'qwen3:4b', ollamaUrl: 'http://127.0.0.1:11434',
    dictationModel: path.join(modelDirectory, 'cleanup-1-q8_0.gguf'), dictationFormat: 'message',
    dictationWhisperModel: path.join(modelDirectory, 'ggml-large-v3-turbo.bin'), dictationWarmSeconds: 120,
    dictationPolish: 'auto', dictationAutoInsert: true,
    globalShortcuts: true, copyLatestShortcut: true, dictationIndicator: true, dictationNotifications: true,
    calendarFile: '', bridgeEnabled: true, teamsPort: 8124,
    detectAppleCalls: true, detectWhatsAppCalls: true, detectTeamsCalls: true,
    callAutoStop: true, calendarAutoRefresh: true, calendarOutlook: false, calendarSystem: false,
    meetingReminders: true, reminderMinutes: 5,
};

export async function atomicJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp';
    const output = await open(temp, 'wx', 0o600);
    try {
        await output.writeFile(JSON.stringify(value, null, 2) + '\n');
        await output.sync(); await output.close();
        await rename(temp, file);
    } finally {
        await output.close().catch(() => {});
        await rm(temp, { force: true }).catch(() => {});
    }
}

export function sessionDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid recording ID.");
    return path.join(home, 'recordings', id);
}

export async function settings(): Promise<Settings> {
    const file = path.join(home, 'settings.json');
    if (!existsSync(file)) return { ...defaults };
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const config = { ...defaults, ...saved, live: false };
    if (config.whisperModel === path.join(modelDirectory, 'ggml-small-q5_1.bin')) config.whisperModel = defaults.whisperModel;
    return config;
}

export async function saveSettings(value: Settings): Promise<void> {
    await atomicJson(path.join(home, 'settings.json'), value);
}

export async function saveSession(session: Session): Promise<void> {
    await atomicJson(path.join(sessionDirectory(session.id), 'session.json'), session);
}

export async function loadSession(id: string): Promise<Session> {
    return validateSession(JSON.parse(await readFile(path.join(sessionDirectory(id), 'session.json'), 'utf8')), id);
}

export function validateSession(value: unknown, id: string): Session {
    const item = value as Session | null;
    const date = (input: unknown) => typeof input === 'string' && Number.isFinite(Date.parse(input));
    if (!item || item.id !== id || !(item.name === null || typeof item.name === 'string') || !date(item.startedAt) ||
        !(item.stoppedAt === null || date(item.stoppedAt)) || !['recording', 'paused', 'stopped', 'done'].includes(item.state) ||
        ![null, 'summarize', 'note-only', 'keep', 'delete'].includes(item.decision) || typeof item.recovered !== 'boolean' ||
        !Array.isArray(item.events) || !item.events.every(event => event && date(event.at) && typeof event.message === 'string') ||
        (item.transcriptionRevision !== undefined && (!Number.isSafeInteger(item.transcriptionRevision) || item.transcriptionRevision < 0)) ||
        (item.state === 'done' && (!item.name || item.decision === null))) throw new Error('Recording metadata is invalid or incomplete. Original files preserved.');
    return item;
}

export type SessionIssue = { id: string; file: string; message: string };
export async function scanSessions(): Promise<{ sessions: Session[]; issues: SessionIssue[] }> {
    const root = path.join(home, 'recordings');
    if (!existsSync(root)) return { sessions: [], issues: [] };
    const result: Session[] = [];
    const issues: SessionIssue[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
        try { result.push(await loadSession(entry.name)); }
        catch { issues.push({ id: entry.name, file: path.join(root, entry.name, 'session.json'), message: 'Unreadable recording metadata. Original files preserved.' }); }
    }
    return { sessions: result.sort((a, b) => b.startedAt.localeCompare(a.startedAt)), issues };
}

export async function sessions(): Promise<Session[]> { return (await scanSessions()).sessions; }

export async function assertNoActiveSession(): Promise<void> {
    const catalog = await scanSessions();
    if (catalog.issues.length) throw new Error('Recording metadata needs attention: ' + catalog.issues[0]!.id + '. Open Storage and recovery or run "sylloom recovery". New meetings are blocked until the metadata is repaired; dictation is available.');
    const active = catalog.sessions.find(session => session.state === 'recording' || session.state === 'paused');
    if (active) throw new Error("Recording still active: " + active.id + ". Stop it before starting another recording.");
}

export async function createSession(): Promise<Session> {
    await assertNoActiveSession();
    const session: Session = {
        id: randomUUID(), name: null, startedAt: new Date().toISOString(), stoppedAt: null,
        state: 'recording', decision: null, recovered: false, events: [],
    };
    await mkdir(path.join(sessionDirectory(session.id), 'chunks'), { recursive: true, mode: 0o700 });
    await saveSession(session);
    return session;
}

export async function nameSession(session: Session, name: string): Promise<void> {
    const value = cleanText(name).replace(/\s+/g, ' ').trim();
    if (!value || value.length > 160) throw new Error("Enter a name from 1 to 160 characters.");
    session.name = value;
    await saveSession(session);
}

export function chunkFile(id: string, source: string, offset: number, directory = sessionDirectory(id)): string {
    return path.join(directory, 'chunks', source + '-' + String(offset).padStart(12, '0') + '.json');
}

function validChunk(value: unknown, file: string): value is Chunk {
    const job = value as Chunk | null;
    return Boolean(job && ['mic', 'system'].includes(job.source) && Number.isSafeInteger(job.offset) && job.offset >= 0 &&
        Number.isSafeInteger(job.samples) && job.samples > 0 && Number.isSafeInteger(job.offset + job.samples) &&
        file === path.basename(chunkFile('', job.source, job.offset, '.')) &&
        (job.profile === undefined || typeof job.profile === 'string') && ['done', 'error'].includes(job.state) &&
        (job.language === undefined || (typeof job.language === 'string' && /^[a-z -]{2,40}$/i.test(job.language))) &&
        (job.error === undefined || typeof job.error === 'string') && Array.isArray(job.segments) &&
        job.segments.every(segment => segment && segment.source === job.source && typeof segment.text === 'string' &&
            Number.isFinite(segment.start) && segment.start >= 0 && Number.isFinite(segment.end) && segment.end > segment.start) &&
        (job.state !== 'error' || job.segments.length === 0));
}

export async function chunks(id: string, directory = sessionDirectory(id), warnings: string[] = []): Promise<Chunk[]> {
    const root = path.join(directory, 'chunks');
    if (!existsSync(root)) return [];
    const result: Chunk[] = [];
    for (const file of await readdir(root)) {
        if (!/^(mic|system)-\d+\.json$/.test(file)) continue;
        const input = await readFile(path.join(root, file), 'utf8');
        let value: unknown;
        try { value = JSON.parse(input); } catch { /* Rebuild invalid checkpoints from the saved audio. */ }
        if (validChunk(value, file)) result.push(value);
        else {
            const rejected = path.join(root, 'rejected');
            await mkdir(rejected, { recursive: true, mode: 0o700 });
            await rename(path.join(root, file), path.join(rejected, file + '.' + randomUUID() + '.json'));
            warnings.push('Invalid transcription checkpoint preserved in chunks/rejected: ' + file + '. Rebuilding from saved audio.');
        }
    }
    return result.sort((a, b) => a.offset - b.offset || a.source.localeCompare(b.source));
}

export async function completeSession(session: Session, decision: Decision): Promise<void> {
    if (!session.name || session.state !== 'stopped') throw new Error("Stop and name the recording first.");
    if (decision === 'note-only' && !existsSync(path.join(sessionDirectory(session.id), 'note.md'))) throw new Error("Structured note is missing. Transcript preserved.");
    if (decision === 'delete' || decision === 'note-only') {
        // Save the deletion intent before deleting anything; recovery finishes it idempotently.
        session.decision = decision;
        await saveSession(session);
        await rm(path.join(sessionDirectory(session.id), 'chunks'), { recursive: true, force: true });
        await rm(path.join(sessionDirectory(session.id), 'transcript.md'), { force: true });
        await rm(path.join(sessionDirectory(session.id), 'transcript.md.tmp'), { force: true });
        await rm(path.join(home, 'views', session.id + '-transcript.html'), { force: true });
        if (decision === 'delete') {
            await rm(path.join(sessionDirectory(session.id), 'note.md'), { force: true });
            await rm(path.join(sessionDirectory(session.id), 'note.md.tmp'), { force: true });
            await rm(path.join(home, 'views', session.id + '-note.html'), { force: true });
        }
    }
    session.decision = decision;
    session.state = 'done';
    await saveSession(session);
}

export async function acquireLock(): Promise<() => Promise<void>> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const directory = path.join(home, 'control.lock');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Older versions remove control.lock on release. Keep the kernel lock
    // outside that directory so their late cleanup cannot unlink its inode.
    const ownerFile = path.join(home, 'controller.lock');
    const owner = await open(ownerFile, 'a+', 0o600);
    let unlock: (() => void) | undefined;
    try {
        unlock = lockController(owner.fd, ownerFile);
        if (!unlock) throw new Error('Sylloom is already running. Close the other controller first.');
        const legacy = (await owner.stat()).size === 0;
        // Respect an older controller that used a PID directory instead of flock.
        if (legacy && existsSync(path.join(directory, 'pid'))) {
            const pid = Number(await readFile(path.join(directory, 'pid'), 'utf8'));
            if (Number.isSafeInteger(pid) && pid > 0) {
                let alive = true;
                try { process.kill(pid, 0); } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                    alive = false;
                }
                if (alive) throw new Error('Sylloom is already running (PID ' + pid + ').');
            }
        }
        if (legacy) await owner.writeFile('flock-v1\n');
        await writeFile(path.join(directory, 'pid'), String(process.pid), { mode: 0o600 });
    } catch (error) { unlock?.(); await owner.close(); throw error; }
    let releasing: Promise<void> | undefined;
    return () => releasing ||= (async () => {
        try { await rm(path.join(directory, 'pid'), { force: true }); }
        finally { unlock?.(); await owner.close(); }
    })();
}
