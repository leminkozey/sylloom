import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { atomicJson, home } from './store.js';
import { Recorder } from './recorder.js';
import { Transcription, timestamp } from './transcription.js';
import { formatDictation, needsDictationFormatting } from './formatter.js';
import { DictationModels, dictationConfig } from './dictation-models.js';
import { copyText, notify } from './clipboard.js';
import { registerHotkeys, DICTATION_SHORTCUT } from './hotkey.js';
import { onShutdown } from './lifecycle.js';
import { repairWav } from './wav.js';
import { attachIndicator } from './indicator.js';
import { errorMessage } from './types.js';
import type { DictationFormat, Session, Settings } from './types.js';

export type Dictation = Session & { format: DictationFormat; raw?: string; text?: string; copiedAt?: string; error?: string;
    timings?: { transcriptionMs: number; formattingMs: number; totalMs: number; usedFormatter: boolean } };
export function dictationDirectory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid dictation ID.");
    return path.join(home, 'dictations', id);
}
const save = (item: Dictation) => atomicJson(path.join(dictationDirectory(item.id), 'session.json'), item);

export async function dictations(): Promise<Dictation[]> {
    const root = path.join(home, 'dictations');
    if (!existsSync(root)) return [];
    const result: Dictation[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const item = JSON.parse(await readFile(path.join(root, entry.name, 'session.json'), 'utf8')) as Dictation;
        if (item.id !== entry.name) throw new Error("Dictation ID does not match its metadata.");
        result.push(item);
    }
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export class DictationService extends EventEmitter {
    state: 'idle' | 'starting' | 'recording' | 'processing' | 'ready' | 'error' = 'idle';
    message = "Ready to dictate";
    current?: Dictation;
    recorder?: Recorder;
    private operation?: Promise<void>;
    private controller?: AbortController;
    private closeHotkeys = () => {};
    private closeIndicator = () => {};
    private unregister = () => {};
    private closing = false;
    private stopRequested = false;
    private canceled = false;
    private discardOnCancel = false;
    private committing = false;
    private previous?: Dictation;
    private models = new DictationModels();
    hotkeyError = '';

    constructor(readonly config: Settings, private blocked: () => boolean = () => false) {
        super();
        this.unregister = onShutdown(() => this.close());
    }
    get busy(): boolean { return ['starting', 'recording', 'processing'].includes(this.state); }
    get status(): string {
        const elapsed = this.current ? timestamp((Date.now() - Date.parse(this.current.startedAt)) / 1000) : '';
        if (this.state === 'recording') return "● DICTATION " + elapsed + ' · ' + DICTATION_SHORTCUT + " Stop · Ctrl+Option+Esc Cancel";
        if (this.busy) return this.message + ' · Ctrl+Option+Esc Cancel';
        return this.message + ' · ' + (this.hotkeyError ? "Shortcut unavailable" : DICTATION_SHORTCUT);
    }
    listen(): void {
        try { this.closeHotkeys = registerHotkeys(() => { void this.toggle().catch(error => this.reportError(error)); }, () => { void this.cancel().catch(error => this.reportError(error)); }); }
        catch (error) { this.hotkeyError = errorMessage(error); this.update('error', this.hotkeyError, true); }
        if (process.platform === 'darwin') this.closeIndicator = attachIndicator(this, message => notify(message));
    }
    private update(state: typeof this.state, message: string, notification = false): void {
        this.state = state; this.message = message; this.emit('update');
        if (notification) notify(message);
    }
    private reportError(error: unknown): void { this.update('error', errorMessage(error), true); }
    async toggle(): Promise<void> {
        if (this.closing) return;
        if (this.state === 'starting') { this.stopRequested = true; return; }
        if (this.state === 'processing') { notify("Dictation is still processing."); return; }
        if (this.state !== 'recording' && this.blocked()) { notify("Recording or processing is active. Dictation will be available afterwards."); return; }
        this.operation = (this.state === 'recording' ? this.stopAndProcess() : this.start()).catch(error => this.failed(error));
        await this.operation;
    }
    private async start(): Promise<void> {
        this.canceled = false; this.stopRequested = false;
        this.discardOnCancel = true;
        this.previous = undefined;
        this.update('starting', "Starting microphone…");
        this.controller = new AbortController();
        const item: Dictation = { id: randomUUID(), name: "Dictation", startedAt: new Date().toISOString(), stoppedAt: null,
            state: 'recording', decision: null, recovered: false, events: [], format: this.config.dictationFormat };
        this.current = item;
        const directory = dictationDirectory(item.id);
        await mkdir(path.join(directory, 'chunks'), { recursive: true, mode: 0o700 });
        await save(item);
        this.controller.signal.throwIfAborted();
        void this.models.prewarm(this.config);
        const recorder = new Recorder(item, this.config, { sources: ['mic'], directory, save: () => save(item) });
        this.recorder = recorder;
        recorder.on('failure', error => { void this.cancelWithError(error).catch(cause => this.reportError(cause)); });
        await recorder.start();
        this.controller.signal.throwIfAborted();
        this.update('recording', "Microphone recording. Press the shortcut again to stop.", true);
        if (this.stopRequested) await this.stopAndProcess();
    }
    private async stopAndProcess(): Promise<void> {
        this.update('processing', "Transcribing dictation…", true);
        await this.recorder?.stop(); this.recorder = undefined;
        await this.process(this.current!, this.controller!.signal);
    }
    private async process(item: Dictation, signal: AbortSignal): Promise<void> {
        const directory = dictationDirectory(item.id);
        const start = performance.now();
        let transcriptionMs = 0;
        signal.throwIfAborted();
        if (item.state === 'recording' || item.state === 'paused') {
            const file = path.join(directory, 'mic.wav');
            if (!existsSync(file)) throw new Error("No audio file found.");
            repairWav(file); item.state = 'stopped'; item.recovered = true;
            item.stoppedAt = new Date().toISOString(); await save(item);
        }
        if (!item.raw) {
            const config = dictationConfig(this.config);
            const server = await this.models.get('whisper', this.config);
            const transcription = new Transcription(item, config, directory, server);
            const cancel = () => { void transcription.close(); };
            signal.addEventListener('abort', cancel, { once: true });
            try {
                await transcription.initialize();
                if (transcription.failures) await transcription.retry();
                await transcription.drain();
                item.raw = transcription.segments.map(segment => segment.text).join(' ').trim();
                if (!item.raw) throw new Error("No speech detected. Clipboard preserved.");
                await save(item);
            } finally { signal.removeEventListener('abort', cancel); await transcription.close(); }
            transcriptionMs = Math.round(performance.now() - start);
        }
        signal.throwIfAborted();
        this.update('processing', "Formatting dictation locally…");
        const formattingStart = performance.now();
        const usedFormatter = this.config.dictationPolish === 'always' || needsDictationFormatting(item.raw, item.format);
        const server = usedFormatter ? await this.models.get('formatter', this.config, item.raw.length > 6000 ? 16384 : 8192) : undefined;
        signal.throwIfAborted();
        const text = await formatDictation(item.raw, item.format, this.config, signal, server);
        const formattingMs = Math.round(performance.now() - formattingStart);
        signal.throwIfAborted();
        item.text = text; item.state = 'done'; delete item.error;
        await save(item);
        signal.throwIfAborted();
        this.committing = true;
        try {
            await copyText(text);
            item.copiedAt = new Date().toISOString();
            item.timings = { transcriptionMs, formattingMs, totalMs: Math.round(performance.now() - start), usedFormatter };
            await save(item);
        } finally { this.committing = false; }
        this.update('ready', "Copied · " + text.length + " characters · Paste with Cmd+V", true);
        this.models.release(this.config.dictationWarmSeconds);
    }
    async retry(item: Dictation, format = item.format): Promise<void> {
        if (this.busy || this.blocked()) throw new Error("Recording or processing is already active.");
        this.previous = { ...item };
        this.current = { ...item, format }; this.canceled = false;
        this.discardOnCancel = false;
        this.controller = new AbortController();
        this.update('processing', "Reprocessing dictation…");
        this.operation = this.process(this.current, this.controller.signal).catch(error => this.failed(error));
        await this.operation;
    }
    async copy(item: Dictation, raw = false): Promise<void> {
        if (this.busy) throw new Error("Stop or cancel dictation first.");
        await copyText((raw ? item.raw : item.text) || '');
        item.copiedAt = new Date().toISOString(); await save(item);
        this.update('ready', "Copied · Paste with Cmd+V", true);
    }
    async remove(item: Dictation): Promise<void> {
        if (this.busy && item.id === this.current?.id) throw new Error("Cancel the active dictation first.");
        await rm(dictationDirectory(item.id), { recursive: true, force: true });
        if (item.id === this.current?.id) { this.current = undefined; this.update('idle', "Dictation deleted"); }
    }
    private async failed(error: unknown): Promise<void> {
        await this.recorder?.stop().catch(() => {}); this.recorder = undefined;
        await this.models.clear();
        if (this.closing) return;
        if (this.canceled) {
            this.state = 'idle';
            try {
                if (this.current && this.discardOnCancel) await this.remove(this.current);
                else if (this.previous) { this.current = this.previous; await save(this.previous); }
            } catch (cause) { this.reportError(cause); return; }
            this.update('idle', "Dictation canceled · Clipboard preserved", true);
            return;
        }
        const message = errorMessage(error);
        if (this.current) { this.current.error = message; await save(this.current).catch(() => {}); }
        this.update('error', message, true);
    }
    private async cancelWithError(error: unknown): Promise<void> {
        this.controller?.abort(error);
        if (this.state === 'recording') {
            this.update('processing', "Stopping microphone…");
            this.operation = this.failed(error); await this.operation;
        }
    }
    async cancel(): Promise<void> {
        if (!this.busy) return;
        if (this.committing) { notify("Copying text…"); return; }
        this.canceled = true; this.controller?.abort(new Error("Dictation canceled."));
        if (this.state === 'recording') {
            this.update('processing', "Canceling dictation…");
            this.operation = this.failed(new Error("Dictation canceled."));
        }
        await this.operation;
    }
    async close(): Promise<void> {
        this.closing = true; this.unregister(); this.closeIndicator(); this.closeHotkeys();
        this.controller?.abort();
        await Promise.all([this.models.close(), this.recorder?.stop().catch(() => {})]);
        await this.operation;
        this.recorder = undefined;
    }
    async releaseModels(): Promise<void> { await this.models.clear(); }
}
