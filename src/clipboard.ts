import { setTimeout as delay } from 'node:timers/promises';
import { execFile, spawn } from 'node:child_process';
import { copyWindowsText } from './native/windows/clipboard.js';
import type { Popup } from './native/call-popup.js';

let notification: Popup | undefined;
let notificationTimer: NodeJS.Timeout | undefined;
let notificationClose: NodeJS.Timeout | undefined;

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
    if (process.platform === 'win32') {
        void import('./native/windows/surface.js').then(({ createWindowsNotification }) => {
            const hide = () => {
                notification?.hide(); clearTimeout(notificationClose);
                notificationClose = setTimeout(() => { notification?.close(); notification = undefined; }, 200); notificationClose.unref();
            };
            clearTimeout(notificationTimer); clearTimeout(notificationClose);
            notification ||= createWindowsNotification(hide);
            notification.show('Sylloom', message, [{ id: 'close', label: 'Close' }]);
            notificationTimer = setTimeout(hide, 4000); notificationTimer.unref();
        }).catch(() => {});
        return;
    }
    if (process.platform !== 'darwin') return;
    execFile('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "Sylloom · Dictation"\nend run', message], { timeout: 5000 }, () => {});
}
