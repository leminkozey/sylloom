import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeAppKit } from '../src/native/app-kit.js';

async function workerResult(code: string, module: URL): Promise<unknown> {
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
            const { tsImport } = await import('tsx/esm/api');
            const importModule = () => tsImport(workerData, workerData);
            ${code}
        })().catch(error => { throw error; });
    `, { eval: true, workerData: module.href });
    try {
        return await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error('Worker exited before reporting: ' + code)));
        });
    } finally { await worker.terminate(); }
}

test('AppKit initialization rejects worker threads before entering native GUI APIs', { timeout: 10000 }, async () => {
    const result = await workerResult(`
        const { initializeAppKit } = await importModule();
        try { initializeAppKit(); parentPort.postMessage('unexpected success'); }
        catch (error) { parentPort.postMessage(error.message); }
    `, new URL('../src/native/app-kit.ts', import.meta.url));
    assert.equal(result, 'AppKit must be initialized on the main thread.');
});

test('app observation never loads AppKit inside its worker', { skip: process.platform !== 'darwin', timeout: 10000 }, async () => {
    initializeAppKit();
    const result = await workerResult(`
        const { default: koffi } = await import('koffi');
        const load = koffi.load;
        koffi.load = (path, ...args) => {
            if (path.includes('/AppKit.framework/')) throw new Error('Worker entered AppKit');
            return load(path, ...args);
        };
        const { observeApps } = await importModule();
        const observation = await observeApps(false, []);
        parentPort.postMessage(typeof observation.trusted);
    `, new URL('../src/native/app-reader.ts', import.meta.url));
    assert.equal(result, 'boolean');
});

// Build first, then opt in: registers real shortcuts without recording audio.
test('native shortcuts and call observation start together in fresh processes', {
    skip: process.platform !== 'darwin' || process.env.SYLLOOM_TEST_NATIVE !== '1', timeout: 60000,
}, async () => {
    const run = promisify(execFile);
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    for (let i = 0; i < 10; i++) {
        const code = `
            import { once } from 'node:events';
            import { setTimeout as delay } from 'node:timers/promises';
            import assert from 'node:assert/strict';
            import { registerHotkeys } from './dist/hotkey.js';
            import { CallDetector } from './dist/calls.js';
            const calls = new CallDetector(); calls.enabledApps = ['apple']; calls.readOutlook = false;
            const observed = once(calls, 'update', { signal: AbortSignal.timeout(5000) });
            let stop = () => {};
            try {
                ${i % 2 ? 'calls.start(); stop = registerHotkeys(() => {}, () => {});' : 'stop = registerHotkeys(() => {}, () => {}); calls.start();'}
                await observed; await delay(150);
                assert.notEqual(calls.snapshot.message, 'App observation is unavailable.');
                console.log('ready');
            } finally { stop(); await calls.close(); }
        `;
        const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], { cwd, timeout: 10000 });
        assert.equal(stdout.trim(), 'ready', 'Startup attempt ' + (i + 1));
    }
});
