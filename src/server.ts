import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { onShutdown } from './lifecycle.js';
import { randomBytes } from 'node:crypto';
import { dictationRuntimeArguments, supportsLlamaAuthentication } from './model-runtime.js';
import type { ModelServerOptions } from './model-runtime.js';

async function freePort(): Promise<number> {
    const server = createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

export function localUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
        throw new Error("Models must use a local HTTP endpoint.");
    }
    return value.replace(/\/$/, '');
}

export class ModelServer {
    private child?: ChildProcess;
    private starting?: Promise<string>;
    private url = '';
    private diagnostic = '';
    private failure = '';
    private stopped = false;
    private exited?: Promise<void>;
    private stopping?: Promise<void>;
    private unregister = () => {};
    private apiKey?: string;
    constructor(private binary: string, private model: string, private kind: 'whisper' | 'llama', private options: ModelServerOptions = {}) {}

    get reusable(): boolean { return !this.stopped && !this.failure; }
    get headers(): Record<string, string> { return this.apiKey ? { Authorization: 'Bearer ' + this.apiKey } : {}; }

    start(): Promise<string> {
        if (this.stopped) return Promise.reject(new Error("Model startup canceled."));
        this.starting ||= this.launch().catch(error => { this.failure ||= error instanceof Error ? error.message : String(error); throw error; });
        return this.starting;
    }

    private async launch(): Promise<string> {
        if (!existsSync(this.model)) throw new Error("Model missing: " + this.model + ". Run \"sylloom models install " + this.kind + "\" to install it.");
        const port = await freePort();
        if (this.stopped) throw new Error("Model startup canceled.");
        const args = ['--model', this.model, '--host', '127.0.0.1', '--port', String(port)];
        if (this.kind === 'llama') args.push('--ctx-size', String(this.options.contextSize || 16384), '--parallel', '1', '--jinja');
        if (this.kind === 'llama' && this.options.profile === 'dictation') args.push(...await dictationRuntimeArguments(this.binary));
        const authenticated = this.kind === 'llama' && await supportsLlamaAuthentication(this.binary);
        if (this.stopped) throw new Error("Model startup canceled.");
        if (authenticated) this.apiKey = randomBytes(32).toString('base64url');
        this.child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'],
            ...(this.apiKey ? { env: { ...process.env, LLAMA_API_KEY: this.apiKey } } : {}) });
        this.exited = new Promise(resolve => this.child!.once('close', () => resolve()));
        this.unregister = onShutdown(() => this.stop());
        const parentExit = () => { this.child?.kill('SIGTERM'); };
        process.once('exit', parentExit);
        this.child.once('close', () => { process.off('exit', parentExit); this.unregister(); });
        const record = (data: Buffer) => {
            const diagnostic = this.diagnostic + data.toString();
            this.diagnostic = (this.apiKey ? diagnostic.replaceAll(this.apiKey, '[redacted]') : diagnostic).slice(-2500);
        };
        this.child.stdout?.on('data', record);
        this.child.stderr?.on('data', record);
        this.child.on('error', error => { this.failure = error.message; });
        this.child.on('exit', code => { this.failure ||= this.kind + " exited (code " + code + ').'; });
        this.url = 'http://127.0.0.1:' + port;
        try {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                if (this.stopped) throw new Error("Model startup canceled.");
                if (this.failure) throw new Error(this.failure);
                let ready = false;
                try {
                    const response = await fetch(this.url + '/health', { headers: this.headers, signal: AbortSignal.timeout(1000), redirect: 'error' });
                    ready = response.ok;
                    await response.body?.cancel();
                } catch { /* Wait for model loading. */ }
                if (this.stopped) throw new Error("Model startup canceled.");
                if (this.failure) throw new Error(this.failure);
                if (ready) return this.url;
                await delay(150);
            }
            throw new Error("Model startup took longer than two minutes.");
        } catch (error) {
            await this.stop();
            throw new Error((error instanceof Error ? error.message : String(error)) + '\n' + this.diagnostic);
        }
    }

    stop(): Promise<void> {
        this.stopped = true;
        this.stopping ||= this.finish();
        return this.stopping;
    }

    private async finish(): Promise<void> {
        this.unregister();
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        if (!child.pid) { await this.exited; return; }
        child.kill('SIGTERM');
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(timer); }
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await this.exited;
        }
    }
}
