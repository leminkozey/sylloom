import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { JsDeviceInfo, JsStreamEvent } from '@studio-sadola/flexaudio';
import { Audio, resolveDevice } from './audio.js';
import type { PcmMessage } from './audio.js';
import { WavWriter, RATE } from './wav.js';
import { errorMessage } from './types.js';
import type { Session, Settings, Source } from './types.js';
import { saveSession, sessionDirectory } from './store.js';
import { onShutdown } from './lifecycle.js';

export class Recorder extends EventEmitter {
    readonly audio = new Audio();
    readonly levels = { mic: 0, system: 0 };
    readonly muted = { mic: false, system: false };
    readonly current: Record<Source, string> = { mic: '', system: '' };
    readonly health: Record<Source, string> = { mic: "Starting", system: "Starting" };
    private writers = new Map<Source, WavWriter>();
    private origins = new Map<Source, { frame: number; sample: number }>();
    private timer?: NodeJS.Timeout;
    private polling = false;
    private stopping = false;
    private stopPromise?: Promise<void>;
    private saveQueue = Promise.resolve();
    private commands = Promise.resolve();
    readonly sources: readonly Source[];
    private directory: string;
    private persist: (session: Session) => Promise<void>;
    private lastChunk = { mic: 0, system: 0 };
    inventory: JsDeviceInfo[] = [];
    private unregister = () => {};

    constructor(readonly session: Session, readonly config: Settings, options: { sources?: readonly Source[]; directory?: string; save?: (session: Session) => Promise<void> } = {}) {
        super();
        this.sources = options.sources || ['mic', 'system'];
        this.directory = options.directory || sessionDirectory(session.id);
        this.persist = options.save || saveSession;
        this.unregister = onShutdown(() => this.stop());
        this.audio.on('pcm', (message: PcmMessage) => {
            try { this.onPcm(message); }
            catch (error) { this.emit('failure', error); }
        });
        this.audio.on('event', (source: Source, event: JsStreamEvent) => {
            if (event.type === 'recovered') this.health[source] = "Receiving";
            else if (['error', 'permissionDenied', 'deviceLost', 'stalled', 'chunkDropped', 'audioLoss', 'recoverableError', 'silenceWhileSourceActive'].includes(event.type)) {
                this.health[source] = event.type;
                this.event(source + ': ' + event.type + ('message' in event ? ' ' + event.message : ''));
                if (event.type === 'error' || event.type === 'permissionDenied') this.emit('failure', new Error(source + ': ' + event.type));
            }
        });
        this.audio.on('failure', error => this.emit('failure', error));
    }

    private onPcm(message: PcmMessage): void {
        const writer = this.writers.get(message.source);
        if (!writer || this.session.state === 'paused') return;
        const samples = message.pcm.byteLength / 2;
        const wallSample = Math.max(0, Math.round((message.at - Date.parse(this.session.startedAt)) / 1000 * RATE) - samples);
        let origin = this.origins.get(message.source);
        // Native positions use a 48 kHz clock even for the 16 kHz output.
        if (!origin || (message.flags & 3) !== 0) {
            origin = { frame: message.frame, sample: Math.max(writer.samples, wallSample) };
            this.origins.set(message.source, origin);
        }
        const target = origin.sample + Math.round((message.frame - origin.frame) / 3);
        if (target > writer.samples) writer.padTo(target);
        const overlap = Math.max(0, writer.samples - target);
        if (overlap < samples) writer.append(Buffer.from(message.pcm).subarray(overlap * 2));
        this.levels[message.source] = this.muted[message.source] ? 0 : message.rms;
        this.lastChunk[message.source] = Date.now();
        this.health[message.source] = "Receiving";
        if (message.dropped) this.event(message.source + ': ' + message.dropped + " audio blocks lost; gap padded with silence.");
    }

    async start(): Promise<void> {
        if (this.stopping) return;
        try {
            // Discovery cannot ask for microphone permission; opening a stream can.
            try { this.inventory = await this.audio.devices(); } catch { this.inventory = []; }
            if (this.stopping) return;
            for (const source of this.sources) {
                const file = path.join(this.directory, source + '.wav');
                this.writers.set(source, new WavWriter(file));
                const requested = source === 'mic' ? this.config.input : this.config.output;
                const selected = this.inventory.length ? resolveDevice(this.inventory, source, requested)?.id : requested;
                if (!selected) throw new Error("No audio device available for " + source + '.');
                await this.audio.request('start', source, selected);
                if (this.stopping) return;
                this.current[source] = selected;
                if (requested !== 'default' && selected !== requested) this.event(source + ': Fallback auf ' + selected + "; preferred device missing.");
            }
            this.inventory = await this.audio.devices();
            if (this.stopping) return;
            for (const source of this.sources) {
                const requested = source === 'mic' ? this.config.input : this.config.output;
                if (this.current[source] === 'default') this.current[source] = resolveDevice(this.inventory, source, requested)?.id || requested;
            }
            this.timer = setInterval(() => { void this.poll(); }, 2000);
            this.event(this.sources.length === 1 ? "Dictation started. Microphone only." : "Recording started. Microphone and system audio are separate.");
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    private async poll(): Promise<void> {
        if (this.polling || this.stopping) return;
        this.polling = true;
        try {
            this.inventory = await this.audio.devices();
            if (this.stopping) return;
            for (const source of this.sources) {
                const requested = source === 'mic' ? this.config.input : this.config.output;
                const target = resolveDevice(this.inventory, source, requested);
                if (!target) {
                    this.health[source] = "No device";
                    continue;
                }
                if (target.id !== this.current[source]) await this.switch(source, requested, this.inventory, true);
                if (this.session.state === 'recording' && Date.now() - this.lastChunk[source] > 4000) {
                    this.health[source] = "No audio data";
                    this.levels[source] = 0;
                }
            }
        } catch (error) { this.event("Device check: " + errorMessage(error)); }
        finally { this.polling = false; }
    }

    async switch(source: Source, requested: string, inventory?: JsDeviceInfo[], automatic = false): Promise<void> {
        return this.command(async () => {
            if (automatic && requested !== (source === 'mic' ? this.config.input : this.config.output)) return;
            if (!this.sources.includes(source)) throw new Error("This audio track is not active.");
            const target = resolveDevice(inventory || await this.audio.devices(), source, requested);
            if (!target) throw new Error("No available " + (source === 'mic' ? "input device." : "output device."));
            await this.audio.request('switch', source, target.id);
            this.current[source] = target.id;
            if (source === 'mic') this.config.input = requested;
            else this.config.output = requested;
            this.health[source] = 'Wartet auf Audio';
            this.event(source + ': Wechsel auf ' + target.name + (requested !== 'default' && target.id !== requested ? " (fallback; preferred device missing)" : ''));
        });
    }

    async toggleMute(source: Source): Promise<void> {
        return this.command(async () => {
            if (!this.sources.includes(source)) throw new Error("This audio track is not active.");
            await this.audio.request('gain', source, undefined, this.muted[source] ? 1 : 0);
            this.muted[source] = !this.muted[source];
            this.event(source + (this.muted[source] ? ': Muted' : ': Active'));
        });
    }

    async pause(paused?: boolean): Promise<void> {
        return this.command(async () => {
            const resume = paused === undefined ? this.session.state === 'paused' : !paused;
            if ((this.session.state === 'paused') === !resume) return;
            await this.audio.request(resume ? 'resume' : 'pause');
            this.session.state = resume ? 'recording' : 'paused';
            this.levels.mic = 0; this.levels.system = 0;
            this.event(resume ? "Recording resumed." : "Paused. Audio is not being saved.");
            await this.saveQueue;
        });
    }

    private command(work: () => Promise<void>): Promise<void> {
        const result = this.commands.then(() => {
            if (this.stopping) throw new Error("Recording is already stopping.");
            return work();
        });
        this.commands = result.catch(() => {});
        return result;
    }

    event(message: string): void {
        const previous = this.session.events.at(-1);
        if (previous?.message === message && Date.now() - Date.parse(previous.at) < 10_000) return;
        this.session.events.push({ at: new Date().toISOString(), message });
        this.saveQueue = this.saveQueue.then(() => this.persist(this.session)).catch(error => { this.emit('failure', error); });
        this.emit('update');
    }

    stop(): Promise<void> {
        this.stopPromise ||= this.finish();
        return this.stopPromise;
    }

    private async finish(): Promise<void> {
        this.unregister();
        this.stopping = true;
        clearInterval(this.timer);
        await this.commands;
        try { await this.audio.close(); }
        catch (error) { this.event("While stopping: " + errorMessage(error)); }
        finally {
            const failures: unknown[] = [];
            for (const writer of this.writers.values()) {
                try { writer.close(); } catch (error) { failures.push(error); }
            }
            this.session.state = 'stopped';
            this.session.stoppedAt = new Date().toISOString();
            await this.saveQueue;
            await this.persist(this.session);
            if (failures.length) throw new AggregateError(failures, "Could not completely close the audio file.");
        }
    }
}
