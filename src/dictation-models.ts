import { existsSync } from 'node:fs';
import path from 'node:path';
import { ModelServer } from './server.js';
import { modelDirectory } from './store.js';
import { models } from './models.js';
import type { Settings } from './types.js';

type Entry = { key: string; server: ModelServer; before: Promise<void> };

export function dictationConfig(config: Settings): Settings {
    const selected = config.dictationWhisperModel;
    const bundled = path.join(modelDirectory, models['dictation-whisper'].file);
    const model = !selected || (selected === bundled && !existsSync(selected)) ? config.whisperModel : selected;
    return { ...config, whisperModel: model };
}

// Two local servers belong to one running CLI. Audio is sent only after stop.
export class DictationModels {
    private entries = new Map<'whisper' | 'formatter', Entry>();
    private idle?: NodeJS.Timeout;
    private stopping = Promise.resolve();
    private closed = false;

    constructor(private create = (binary: string, model: string, kind: 'whisper' | 'llama', options: { contextSize?: number }) => new ModelServer(binary, model, kind, options)) {}

    async get(kind: 'whisper' | 'formatter', config: Settings, contextSize = 8192): Promise<ModelServer> {
        if (this.closed) throw new Error("Dictation models are closed.");
        clearTimeout(this.idle);
        const binary = kind === 'whisper' ? config.whisperBinary : config.llmBinary;
        const model = kind === 'whisper' ? dictationConfig(config).whisperModel : config.dictationModel;
        const options = kind === 'formatter' ? { contextSize } : {};
        const key = JSON.stringify({ binary, model, options });
        let entry = this.entries.get(kind);
        if (!entry || entry.key !== key || !entry.server.reusable) {
            const before = entry ? Promise.all([this.stopping, entry.server.stop()]).then(() => {}) : this.stopping;
            entry = { key, server: this.create(binary, model, kind === 'whisper' ? 'whisper' : 'llama', options), before };
            this.entries.set(kind, entry);
        }
        await entry.before;
        return entry.server;
    }

    async prewarm(config: Settings): Promise<void> {
        await Promise.allSettled((['whisper', 'formatter'] as const).map(async kind => {
            const server = await this.get(kind, config);
            await server.start();
        }));
    }

    release(seconds: number): void {
        clearTimeout(this.idle);
        this.idle = setTimeout(() => { void this.clear().catch(() => {}); }, Math.min(600, Math.max(0, seconds)) * 1000);
        this.idle.unref();
    }

    clear(): Promise<void> {
        clearTimeout(this.idle);
        const entries = [...this.entries.values()];
        this.entries.clear();
        this.stopping = Promise.all([this.stopping, ...entries.flatMap(entry => [entry.before, entry.server.stop()])]).then(() => {});
        return this.stopping;
    }

    async close(): Promise<void> { this.closed = true; await this.clear(); }
}
