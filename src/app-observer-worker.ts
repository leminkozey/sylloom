import { parentPort } from 'node:worker_threads';
import { observeApps } from './native/app-reader.js';
import type { CallApp } from './native/app-reader.js';
let running = false;
parentPort!.on('message', async (options: { readOutlook?: boolean; apps?: CallApp[] }) => {
    if (running) return; running = true;
    try { parentPort!.postMessage(await observeApps(options.readOutlook !== false, options.apps)); }
    catch { parentPort!.postMessage({ trusted: false, teams: 'unknown' }); }
    finally { running = false; }
});
