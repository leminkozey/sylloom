import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Chunk, Decision, Session, Settings } from './types.js';
import { cleanText } from './types.js';

export const home = path.resolve(process.env.SYLLOOM_HOME || process.env.MEETING_HOME || fileURLToPath(new URL('../data/', import.meta.url)));
export const modelDirectory = path.join(home, 'models');
export const defaults: Settings = {
    input: 'default', output: 'default', language: 'auto', live: false,
    whisperBinary: 'whisper-server', whisperModel: path.join(modelDirectory, 'ggml-large-v3.bin'),
    llm: 'llama', llmBinary: 'llama-server', llmModel: path.join(modelDirectory, 'Qwen3-4B-Q4_K_M.gguf'),
    ollamaModel: 'qwen3:4b', ollamaUrl: 'http://127.0.0.1:11434',
    dictationModel: path.join(modelDirectory, 'Qwen3.5-4B-dictation-v3-MTP-Q4_K_M.gguf'), dictationFormat: 'message',
    dictationWhisperModel: path.join(modelDirectory, 'ggml-large-v3-turbo.bin'), dictationWarmSeconds: 120,
    dictationPolish: 'auto',
};

export async function atomicJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file);
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
    const session = JSON.parse(await readFile(path.join(sessionDirectory(id), 'session.json'), 'utf8')) as Session;
    if (session.id !== id) throw new Error("Recording ID does not match its metadata.");
    return session;
}

export async function sessions(): Promise<Session[]> {
    const root = path.join(home, 'recordings');
    if (!existsSync(root)) return [];
    const result: Session[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
        result.push(await loadSession(entry.name));
    }
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function createSession(): Promise<Session> {
    const pending = (await sessions()).find(session => session.state !== 'done');
    if (pending) throw new Error("Recording still pending: " + pending.id + ". Finish it first with \"sylloom finish\".");
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

export async function chunks(id: string, directory = sessionDirectory(id)): Promise<Chunk[]> {
    const root = path.join(directory, 'chunks');
    if (!existsSync(root)) return [];
    const result: Chunk[] = [];
    for (const file of await readdir(root)) {
        if (!/^(mic|system)-\d+\.json$/.test(file)) continue;
        result.push(JSON.parse(await readFile(path.join(root, file), 'utf8')) as Chunk);
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
    try {
        await mkdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let pid: number;
        try { pid = Number(await readFile(path.join(directory, 'pid'), 'utf8')); }
        catch { throw new Error("Recording lock has no PID. Check " + directory); }
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid recording lock: " + directory);
        try { process.kill(pid, 0); }
        catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
            await rm(directory, { recursive: true });
            return acquireLock();
        }
        throw new Error("Sylloom is already running (PID " + pid + ').');
    }
    await writeFile(path.join(directory, 'pid'), String(process.pid), { mode: 0o600 });
    return () => rm(directory, { recursive: true, force: true });
}
