import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ModelServer } from './server.js';
import { atomicJson, chunkFile, chunks, sessionDirectory } from './store.js';
import { hasSpeechEnergy, RATE, readWavSlice, sampleCount } from './wav.js';
import type { Chunk, Segment, Session, Settings, Source } from './types.js';
import { cleanText, errorMessage } from './types.js';
import { onShutdown } from './lifecycle.js';

const CHUNK_SAMPLES = RATE * 300;
const OVERLAP = RATE * 8;

export class IncompleteTranscriptionError extends Error {}

export function transcriptionProfile(config: Settings, revision = 0): string {
    const model = existsSync(config.whisperModel) ? statSync(config.whisperModel) : undefined;
    return createHash('sha256').update(JSON.stringify({ version: 'offline-v2', model: config.whisperModel,
        size: model?.size, modified: model?.mtimeMs, language: config.language, revision })).digest('hex');
}

export function decodeSegments(body: { text?: unknown; segments?: { start: number; end: number; text: string }[] }, job: Chunk, sliceStart: number): Segment[] {
    const clean = (value: string) => cleanText(value).replace(/\s+/g, ' ').trim();
    if (typeof body.text !== 'string') throw new Error("Whisper did not return a valid transcript.");
    if (!Array.isArray(body.segments)) {
        const text = clean(body.text);
        return text ? [{ source: job.source, start: job.offset / RATE, end: (job.offset + job.samples) / RATE, text }] : [];
    }
    const result: Segment[] = [];
    for (const item of body.segments) {
        if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= item.start || typeof item.text !== 'string') continue;
        const start = sliceStart / RATE + item.start;
        const end = sliceStart / RATE + item.end;
        const middle = (start + end) / 2;
        if (middle < job.offset / RATE || middle >= (job.offset + job.samples) / RATE) continue;
        const text = clean(item.text);
        if (text) result.push({ source: job.source, start: Math.max(0, start), end, text });
    }
    return result;
}

export function timestamp(seconds: number): string {
    const value = Math.max(0, Math.floor(seconds));
    return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(part => String(part).padStart(2, '0')).join(':');
}

export function transcriptText(segments: Segment[]): string {
    return [...segments].sort((a, b) => a.start - b.start || a.source.localeCompare(b.source))
        .map(segment => '[' + timestamp(segment.start) + '] ' + (segment.source === 'mic' ? "Microphone" : "System audio") + ': ' + segment.text).join('\n\n');
}

export function removeOverlap(previous: string, current: string): string {
    const before = previous.trim().split(/\s+/);
    const after = current.trim().split(/\s+/);
    const normalize = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    for (let count = Math.min(35, before.length, after.length); count >= 2; count--) {
        if (before.slice(-count).map(normalize).join(' ') === after.slice(0, count).map(normalize).join(' ')) return after.slice(count).join(' ');
    }
    return current.trim();
}

export class Transcription extends EventEmitter {
    private server: ModelServer;
    private running?: Promise<void>;
    private closed = false;
    private controller = new AbortController();
    private unregister = () => {};
    private cursors: Record<Source, number> = { mic: 0, system: 0 };
    private profile = '';
    private ownsServer: boolean;
    jobs: Chunk[] = [];
    processing = '';
    error = '';
    constructor(readonly session: Session, readonly config: Settings, private directory = sessionDirectory(session.id), sharedServer?: ModelServer) {
        super();
        this.server = sharedServer || new ModelServer(config.whisperBinary, config.whisperModel, 'whisper');
        this.ownsServer = !sharedServer;
        this.unregister = onShutdown(() => this.close());
    }
    get segments(): Segment[] { return this.jobs.flatMap(job => job.segments).sort((a, b) => a.start - b.start); }
    get failures(): number { return this.jobs.filter(job => job.state === 'error').length; }

    async initialize(): Promise<void> {
        if (this.session.state !== 'stopped') throw new Error("Transcription starts only after recording stops.");
        this.profile = transcriptionProfile(this.config, this.session.transcriptionRevision);
        this.jobs = [];
        this.cursors = { mic: 0, system: 0 };
        for (const job of await chunks(this.session.id, this.directory)) {
            if (job.profile !== this.profile || job.offset !== this.cursors[job.source]) continue;
            this.jobs.push(job);
            this.cursors[job.source] += job.samples;
        }
    }

    private tick(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.running) return this.running;
        this.running = this.process().finally(() => { this.running = undefined; });
        return this.running;
    }

    private async process(): Promise<void> {
        for (;;) {
            let next: { source: Source; samples: number } | undefined;
            for (const source of ['mic', 'system'] as const) {
                const file = path.join(this.directory, source + '.wav');
                if (!existsSync(file)) continue;
                const available = sampleCount(file) - this.cursors[source];
                if (available > 0) {
                    if (!next || this.cursors[source] < this.cursors[next.source]) next = { source, samples: Math.min(CHUNK_SAMPLES, available) };
                }
            }
            if (!next || this.closed) break;
            const offset = this.cursors[next.source];
            const job: Chunk = { profile: this.profile, source: next.source, offset, samples: next.samples, state: 'done', segments: [] };
            const total = sampleCount(path.join(this.directory, next.source + '.wav'));
            this.processing = (next.source === 'mic' ? "Microphone" : "System audio") + ' ' + timestamp(offset / RATE) + ' / ' + timestamp(total / RATE);
            this.emit('update');
            await this.infer(job);
            await atomicJson(chunkFile(this.session.id, job.source, job.offset, this.directory), job);
            this.jobs.push(job);
            this.cursors[next.source] += next.samples;
            await this.writeTranscript();
            this.processing = '';
            this.emit('update');
        }
    }

    private async infer(job: Chunk): Promise<void> {
        try {
            const start = Math.max(0, job.offset - OVERLAP);
            const file = path.join(this.directory, job.source + '.wav');
            const end = Math.min(sampleCount(file), job.offset + job.samples + OVERLAP);
            const wav = readWavSlice(file, start, end - start);
            if (job.samples < RATE / 4 || !hasSpeechEnergy(wav)) { job.state = 'done'; job.segments = []; return; }
            const url = await this.server.start();
            const form = new FormData();
            form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
            form.set('language', this.config.language);
            form.set('response_format', 'verbose_json');
            form.set('token_timestamps', 'false');
            form.set('no_language_probabilities', 'true');
            form.set('temperature', '0.0');
            const response = await fetch(url + '/inference', { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(1_800_000)]) });
            if (!response.ok) throw new Error('Whisper antwortet mit HTTP ' + response.status);
            const body = await response.json() as { text?: unknown; segments?: { start: number; end: number; text: string }[] };
            const previous = this.jobs.filter(item => item.source === job.source && item.offset < job.offset).at(-1)?.segments.map(item => item.text).join(' ') || '';
            job.segments = decodeSegments(body, job, start);
            if (job.segments[0]) {
                job.segments[0].text = removeOverlap(previous, job.segments[0].text);
                job.segments = job.segments.filter(segment => segment.text);
            }
            job.state = 'done'; delete job.error;
            this.error = '';
        } catch (error) {
            job.state = 'error'; job.error = errorMessage(error); job.segments = [];
            this.error = job.error;
        }
    }

    async retry(): Promise<void> {
        await this.running;
        const failed = this.jobs.filter(job => job.state === 'error');
        if (failed.length) {
            // Load once for the complete retry batch after model setup or recovery.
            await this.server.stop();
            this.server = new ModelServer(this.config.whisperBinary, this.config.whisperModel, 'whisper');
            this.ownsServer = true;
        }
        for (const job of failed) {
            await this.infer(job);
            await atomicJson(chunkFile(this.session.id, job.source, job.offset, this.directory), job);
            this.emit('update');
        }
        await this.writeTranscript();
    }

    async drain(): Promise<void> {
        if (this.session.state !== 'stopped') throw new Error("Stop the recording first.");
        await this.running;
        await this.tick();
        await this.writeTranscript();
        if (this.error || this.failures) throw new IncompleteTranscriptionError("Transcript incomplete. " + this.failures + " chunk(s) failed. " + this.error);
    }

    async writeTranscript(): Promise<void> {
        const root = this.directory;
        const header = '# ' + (this.session.name || "Untitled recording") + '\n\n' + this.session.startedAt + '\n\n';
        const status = this.failures ? "> Incomplete: " + this.failures + " chunk(s) could not be transcribed.\n\n" : '';
        await writeFile(path.join(root, 'transcript.md.tmp'), header + status + transcriptText(this.segments) + '\n', { mode: 0o600 });
        await rename(path.join(root, 'transcript.md.tmp'), path.join(root, 'transcript.md'));
    }

    async close(): Promise<void> {
        this.unregister();
        this.closed = true;
        this.controller.abort();
        if (this.ownsServer || this.running) await this.server.stop();
        await this.running;
    }
}
