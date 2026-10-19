import { execFile, spawn } from 'node:child_process';

export async function copyText(text: string): Promise<void> {
    if (!text.trim()) throw new Error("No text to copy. Clipboard preserved.");
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
    if (process.platform !== 'darwin') return;
    execFile('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "Sylloom · Dictation"\nend run', message], { timeout: 5000 }, () => {});
}
