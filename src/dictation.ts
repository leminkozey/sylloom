import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
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
import { repairWav, sampleCount, RATE } from './wav.js';
import { attachIndicator } from './indicator.js';
import { errorMessage } from './types.js';
import { captureInput, deliverText } from './insertion.js';
import type { CapturedInput, Delivery } from './insertion.js';
import { recordUsage } from './insights.js';
import { loadLibrary } from './library.js';
import type { DictationFormat, Session, Settings } from './types.js';

export type Dictation = Session & { format: DictationFormat; raw?: string; text?: string; copiedAt?: string; error?: string;
    outcome?: 'completed' | 'failed' | 'canceled' | 'interrupted'; delivery?: Delivery;
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

export async function recoverDictations(): Promise<void> {
    const root = path.join(home, 'dictations');
    if (!existsSync(root)) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const directory = dictationDirectory(entry.name);
        let item: Dictation;
        try { item = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')); }
        catch { continue; } // Library reports unreadable items without deleting them.
        if (!item || item.id !== entry.name || item.outcome || item.state === 'done' ||
            !Number.isFinite(Date.parse(item.startedAt)) || !Array.isArray(item.events)) continue;
        const audio = path.join(directory, 'mic.wav');
        if (existsSync(audio)) {
            try {
                repairWav(audio);
                item.stoppedAt ||= new Date(Date.parse(item.startedAt) + sampleCount(audio) / RATE * 1000).toISOString();
            } catch (error) {
                item.error = 'Audio recovery failed. Original file preserved. ' + errorMessage(error);
                item.events.push({ at: new Date().toISOString(), message: item.error });
            }
        }
        item.stoppedAt ||= item.startedAt;
        item.state = 'stopped'; item.outcome = 'interrupted'; item.recovered = true;
        item.events.push({ at: new Date().toISOString(), message: 'Interrupted dictation retained. Reprocess from Library.' });
        await save(item);
    }
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
    private committing = false;
    private previous?: Dictation;
    private input?: CapturedInput;
    private closingTask?: Promise<void>;
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
        return this.message + ' · ' + (!this.config.globalShortcuts ? 'Global shortcuts Off' : this.hotkeyError ? "Shortcut unavailable" : DICTATION_SHORTCUT);
    }
    listen(): void {
        this.closeHotkeys(); this.closeIndicator(); this.hotkeyError = '';
        this.closeHotkeys = () => {}; this.closeIndicator = () => {};
        try { if (this.config.globalShortcuts) this.closeHotkeys = registerHotkeys(() => { void this.toggle().catch(error => this.reportError(error)); },
            () => { void this.cancel().catch(error => this.reportError(error)); },
            this.config.copyLatestShortcut ? () => { void this.copyLatest().catch(error => notify(errorMessage(error))); } : undefined); }
        catch (error) { this.hotkeyError = errorMessage(error); this.update('error', this.hotkeyError, true); }
        if (process.platform === 'darwin' && this.config.dictationIndicator) this.closeIndicator = attachIndicator(this, message => notify(message));
    }
    private update(state: typeof this.state, message: string, notification = false): void {
        this.state = state; this.message = message; this.emit('update');
        if (notification && this.config.dictationNotifications) notify(message);
    }
    private reportError(error: unknown): void { this.update('error', errorMessage(error), true); }
    async toggle(): Promise<void> {
        if (this.closing) return;
        if (this.state === 'starting') { this.stopRequested = true; return; }
        if (this.state === 'processing') { notify("Dictation is still processing."); return; }
        if (this.state !== 'recording' && this.blocked()) { notify("Recording or processing is active. Dictation will be available afterwards."); return; }
        this.operation = (this.state === 'recording' ? this.stopAndProcess() : this.start()).catch(error => this.handleFailure(error));
        await this.operation;
    }
    private async start(): Promise<void> {
        this.canceled = false; this.stopRequested = false;
        this.input?.target?.close(); this.input = undefined;
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
        this.input = this.config.dictationAutoInsert ? captureInput() : { reason: 'Automatic insertion is turned off.' };
        this.update('processing', "Transcribing dictation…", true);
        await this.recorder?.stop(); this.recorder = undefined;
        await this.process(this.current!, this.controller!.signal);
    }
    private async process(item: Dictation, signal: AbortSignal, directory = dictationDirectory(item.id), persist = save): Promise<void> {
        const start = performance.now();
        let transcriptionMs = 0;
        signal.throwIfAborted();
        if (item.state === 'recording' || item.state === 'paused') {
            const file = path.join(directory, 'mic.wav');
            if (!existsSync(file)) throw new Error("No audio file found.");
            repairWav(file); item.state = 'stopped'; item.recovered = true;
            item.stoppedAt = new Date().toISOString(); await persist(item);
        }
        if (!item.raw) {
            const config = dictationConfig(this.config);
            const server = await this.models.get('whisper', this.config);
            const transcription = new Transcription(item, config, directory, server);
            const cancel = () => { void transcription.close().catch(() => {}); };
            signal.addEventListener('abort', cancel, { once: true });
            try {
                await transcription.initialize();
                if (transcription.failures) await transcription.retry();
                await transcription.drain();
                item.raw = transcription.segments.map(segment => segment.text).join(' ').trim();
                if (!item.raw) throw new Error("No speech detected. Clipboard preserved.");
                await persist(item);
            } finally { signal.removeEventListener('abort', cancel); await transcription.close(); }
            transcriptionMs = Math.round(performance.now() - start);
        }
        signal.throwIfAborted();
        this.update('processing', "Formatting dictation locally…");
        const formattingStart = performance.now();
        const usedFormatter = this.config.dictationPolish !== 'off' && (this.config.dictationPolish === 'always' || needsDictationFormatting(item.raw, item.format));
        const server = usedFormatter ? await this.models.get('formatter', this.config, item.raw.length > 6000 ? 16384 : 8192) : undefined;
        signal.throwIfAborted();
        const text = await formatDictation(item.raw, item.format, this.config, signal, server);
        const formattingMs = Math.round(performance.now() - formattingStart);
        signal.throwIfAborted();
        item.text = text; item.state = 'done'; item.outcome = 'completed'; delete item.error;
        await persist(item);
        if (!this.previous) await recordUsage(item, directory).catch(error => item.events.push({ at: new Date().toISOString(), message: 'Usage update failed: ' + errorMessage(error) }));
        signal.throwIfAborted();
        item.timings = { transcriptionMs, formattingMs, totalMs: Math.round(performance.now() - start), usedFormatter };
        if (this.previous) { await persist(item); this.models.release(this.config.dictationWarmSeconds); return; }
        this.committing = true;
        try {
            item.delivery = await deliverText(text, this.input || { reason: 'History retries copy without inserting.' }, signal);
            this.input = undefined;
            if (item.delivery.kind === 'clipboard') item.copiedAt = item.delivery.at;
            item.timings = { transcriptionMs, formattingMs, totalMs: Math.round(performance.now() - start), usedFormatter };
            await persist(item);
        } finally { this.committing = false; }
        if (!this.previous) this.deliveryReady(item);
        this.models.release(this.config.dictationWarmSeconds);
    }
    private deliveryReady(item: Dictation): void {
        this.update('ready', item.delivery?.kind === 'inserted' ? 'Inserted · ' + item.text!.length + ' characters · Saved in Library' :
            'Copied · Paste with Cmd+V · Saved in Library', true);
    }
    async retry(item: Dictation, format = item.format, retranscribe = false): Promise<void> {
        if (this.closing) throw new Error("The dictation service is closing.");
        if (this.busy || this.blocked()) throw new Error("Recording or processing is already active.");
        this.previous = structuredClone(item);
        this.current = { ...structuredClone(item), format }; this.canceled = false;
        if (retranscribe) { delete this.current.raw; this.current.transcriptionRevision = (item.transcriptionRevision || 0) + 1; }
        this.input?.target?.close(); this.input = undefined;
        this.controller = new AbortController();
        this.update('processing', "Reprocessing dictation…");
        const next = this.current; const signal = this.controller.signal;
        this.operation = (async () => {
            let attempt: string | undefined;
            try {
                const directory = dictationDirectory(item.id);
                attempt = await mkdtemp(path.join(directory, 'retry-'));
                if (!next.raw) await copyFile(path.join(directory, 'mic.wav'), path.join(attempt, 'mic.wav'));
                signal.throwIfAborted();
                await this.process(next, signal, attempt, value => atomicJson(path.join(attempt!, 'session.json'), value));
                signal.throwIfAborted();
                this.committing = true;
                try {
                    // Metadata is the authoritative text. An unsuccessful attempt
                    // never replaces the original transcript or clipboard.
                    await save(next);
                    this.previous = undefined;
                    if (existsSync(path.join(attempt, 'transcript.md'))) await rename(path.join(attempt, 'transcript.md'), path.join(directory, 'transcript.md')).catch(() => {});
                    await recordUsage(next, directory).catch(() => {});
                    await copyText(next.text!);
                    next.copiedAt = new Date().toISOString(); next.delivery = { kind: 'clipboard', at: next.copiedAt, reason: 'History retries copy without inserting.' };
                    await save(next); this.deliveryReady(next);
                } finally { this.committing = false; }
            } catch (error) { await this.handleFailure(error); }
            finally { if (attempt) await rm(attempt, { recursive: true, force: true }); }
        })();
        await this.operation;
    }
    async copyLatest(): Promise<void> {
        if (this.busy) { notify('Finish the active dictation before copying saved text.'); return; }
        const latest = (await loadLibrary()).items.find(item => item.kind === 'dictation' && ((item.data as Dictation).text || (item.data as Dictation).raw));
        if (this.busy || this.closing) return;
        if (!latest) { notify('No saved dictation text yet.'); return; }
        const item = latest.data as Dictation;
        await this.copy(item, !item.text);
    }
    async copy(item: Dictation, raw = false): Promise<void> {
        if (this.busy) throw new Error("Stop or cancel dictation first.");
        await copyText((raw ? item.raw : item.text) || '');
        item.copiedAt = new Date().toISOString(); await save(item);
        if (!this.busy && !this.closing) this.update('ready', "Copied · Paste with Cmd+V", true);
    }
    async remove(item: Dictation): Promise<void> {
        if (this.busy && item.id === this.current?.id) throw new Error("Cancel the active dictation first.");
        await recordUsage(item, dictationDirectory(item.id));
        await rm(dictationDirectory(item.id), { recursive: true, force: true });
        if (item.id === this.current?.id) { this.current = undefined; this.update('idle', "Dictation deleted"); }
    }
    private async handleFailure(error: unknown): Promise<void> {
        try { await this.failed(error); }
        catch (cause) {
            // Storage can also fail while recording the original error. Keep the
            // in-memory result and leave the service usable instead of rejecting
            // an operation started by a shortcut or terminal action.
            this.reportError(new Error(errorMessage(error) + ' · Recovery could not be saved: ' + errorMessage(cause) + ' · Local files were preserved.'));
        }
    }
    private async failed(error: unknown): Promise<void> {
        this.input?.target?.close(); this.input = undefined;
        await this.recorder?.stop().catch(() => {}); this.recorder = undefined;
        await this.models.clear();
        if (this.closing || this.canceled) {
            await this.retain(this.closing ? 'interrupted' : 'canceled');
            if (this.closing) return;
            this.update('idle', 'Canceled · Saved in Library · Clipboard preserved', true);
            return;
        }
        const message = errorMessage(error);
        if (this.previous) {
            this.current = this.previous;
            this.current.events.push({ at: new Date().toISOString(), message: 'Retry failed; previous result preserved. ' + message });
            await save(this.current); this.previous = undefined;
            this.update('error', 'Retry failed · Previous result preserved · ' + message, true); return;
        }
        if (this.current) {
            const item = this.current;
            item.error = message; item.outcome = 'failed'; item.state = 'stopped'; item.stoppedAt ||= new Date().toISOString();
            await save(item);
            await recordUsage(item, dictationDirectory(item.id)).catch(() => {});
            const fallback = item.raw || item.text;
            if (fallback) {
                try {
                    await copyText(fallback); item.copiedAt = new Date().toISOString();
                    item.delivery = { kind: 'clipboard', at: item.copiedAt, raw: Boolean(item.raw), reason: 'Processing failed; recovered text copied.' };
                    await save(item);
                    this.update('error', 'Processing failed · Original text copied · Saved in Library', true); return;
                } catch { /* The error and original text are already saved for recovery. */ }
            }
        }
        this.update('error', message, true);
    }
    private async retain(outcome: 'canceled' | 'interrupted'): Promise<void> {
        if (this.previous) this.current = this.previous;
        else if (this.current) {
            this.current.outcome = outcome; this.current.state = 'stopped'; this.current.stoppedAt ||= new Date().toISOString();
        }
        if (this.current) await save(this.current);
    }
    private async cancelWithError(error: unknown): Promise<void> {
        this.controller?.abort(error);
        if (this.state === 'recording') {
            this.update('processing', "Stopping microphone…");
            this.operation = this.handleFailure(error); await this.operation;
        }
    }
    async cancel(): Promise<void> {
        if (!this.busy) return;
        if (this.committing) { notify('Delivering text…'); return; }
        this.canceled = true; this.controller?.abort(new Error("Dictation canceled."));
        if (this.state === 'recording') {
            this.update('processing', "Canceling dictation…");
            this.operation = this.handleFailure(new Error("Dictation canceled."));
        }
        await this.operation;
    }
    close(): Promise<void> { return this.closingTask ||= this.finishClose(); }
    private async finishClose(): Promise<void> {
        const wasBusy = this.busy;
        this.closing = true; this.unregister(); this.closeIndicator(); this.closeHotkeys();
        this.input?.target?.close(); this.input = undefined;
        this.controller?.abort();
        await Promise.all([this.models.close(), this.recorder?.stop().catch(() => {})]);
        await this.operation;
        this.recorder = undefined;
        if (wasBusy && this.state !== 'ready') await this.retain('interrupted');
    }
    async releaseModels(): Promise<void> { await this.models.clear(); }
}
