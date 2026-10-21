import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { copyWindowsText } from './native/windows/clipboard.js';
import { notifyBubble } from './notification.js';

export async function copyText(text: string): Promise<void> {
    if (!text.trim()) throw new Error("No text to copy. Clipboard preserved.");
    if (process.platform === 'win32') {
        for (let attempt = 0; ; attempt++) {
            try { copyWindowsText(text); return; }
            catch (error) {
                if (attempt >= 5 || !(error instanceof Error) || !error.message.includes('clipboard is busy')) throw error;
                await delay(25 * (attempt + 1));
            }
        }
    }
    if (process.platform !== 'darwin') throw new Error("Clipboard support currently requires macOS.");
    await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
        const timer = setTimeout(() => { child.kill(); reject(new Error("Clipboard timed out.")); }, 5000);
        child.once('error', reject);
        child.stdin.on('error', reject);
        child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("Could not copy text.")); });
        child.stdin.end(text, 'utf8');
    });
}

export function notify(message: string): void {
    notifyBubble(message);
}
