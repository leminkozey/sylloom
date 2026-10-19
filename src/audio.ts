import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Capabilities, JsDeviceInfo, JsStreamEvent } from '@studio-sadola/flexaudio';
import type { Source } from './types.js';

export type PcmMessage = { source: Source; pcm: Uint8Array; frame: number; flags: number; rms: number; at: number; dropped: number };

export class Audio extends EventEmitter {
    private worker: Worker;
    private sequence = 0;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private closed = false;
    private failed?: Error;
    private closing?: Promise<void>;
    constructor() {
        super();
        let url = new URL('./audio-worker.js', import.meta.url);
        if (!existsSync(url)) url = new URL('./audio-worker.ts', import.meta.url);
        this.worker = new Worker(url, { stdout: true, stderr: true });
        this.worker.stdout.resume();
        this.worker.stderr.resume();
        this.worker.on('message', message => {
            if (message.type === 'response') {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve(message.result);
            } else if (message.type === 'pcm') this.emit('pcm', message as PcmMessage);
            else if (message.type === 'event') this.emit('event', message.source as Source, message.event as JsStreamEvent);
        });
        this.worker.on('error', error => this.fail(error));
        this.worker.on('exit', code => {
            if (!this.closed) this.fail(new Error("Audio worker exited (code " + code + ').'));
        });
    }
    private fail(error: Error): void {
        this.failed = error;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        this.emit('failure', error);
    }
    request<T = void>(command: string, source?: Source, device?: string, value?: number): Promise<T> {
        if (this.failed) return Promise.reject(this.failed);
        if (this.closed) return Promise.reject(new Error("Audio worker is closed."));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.fail(new Error("Audio command timed out: " + command));
            }, 45_000);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ id, command, source, device, value });
        });
    }
    devices(): Promise<JsDeviceInfo[]> { return this.request('devices'); }
    capabilities(): Promise<Capabilities> { return this.request('capabilities'); }
    close(): Promise<void> {
        this.closing ||= this.finish();
        return this.closing;
    }
    private async finish(): Promise<void> {
        if (this.closed) return;
        try { await this.request('stop'); }
        finally {
            this.closed = true;
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Audio worker closed."));
            }
            this.pending.clear();
            await this.worker.terminate();
        }
    }
}

export function resolveDevice(inventory: JsDeviceInfo[], source: Source, requested: string): JsDeviceInfo | undefined {
    const available = inventory.filter(device => device.sourceKind === source && device.formatAvailable);
    if (requested !== 'default') {
        const pinned = available.find(device => device.id === requested);
        if (pinned) return pinned;
    }
    return available.find(device => device.isDefault);
}
