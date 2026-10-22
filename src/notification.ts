import { mkdir, appendFile, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import type { BubbleNotice } from './bubble-feedback.js';
import { bubbleNotice } from './bubble-feedback.js';
import { onShutdown } from './lifecycle.js';

type NoticeSink = { show(notice: BubbleNotice): void; hide(): void };

// Lazy native loading keeps Windows APIs isolated. Only the latest pending
// message is shown, and it always goes to the shared center-bottom bubble.
export function createNotifications(load: () => Promise<NoticeSink>) {
    let pending: Promise<NoticeSink> | undefined, surface: NoticeSink | undefined;
    let revision = 0, closed = false;
    return {
        async show(message: string) {
            if (closed) return;
            const own = ++revision;
            try {
                pending ||= load();
                const loaded = await pending;
                if (closed || own !== revision) return;
                surface = loaded; surface.show(bubbleNotice(message));
            } catch (error) { pending = undefined; recordBubbleDiagnostic('Capture bubble renderer failed: ' + String(error)); }
        },
        hide() { revision++; surface?.hide(); },
        close() { closed = true; revision++; surface?.hide(); },
    };
}

let diagnosticQueue = Promise.resolve();
export function recordBubbleDiagnostic(message: string): void {
    diagnosticQueue = diagnosticQueue.catch(() => {}).then(async () => {
        const { home } = await import('./store.js');
        const directory = path.join(home, 'diagnostics'), file = path.join(directory, 'bubble.jsonl');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (await stat(file).then(info => info.size > 1_000_000, () => false)) await rename(file, file + '.previous');
        const safe = message.replace(/(Bearer\s+|(?:token|password|api[_-]?key)[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
        await appendFile(file, JSON.stringify({ at: new Date().toISOString(), message: safe }) + '\n', { mode: 0o600 });
    }).catch(() => {});
}

let notifications: ReturnType<typeof createNotifications> | undefined;
export function notifyBubble(message: string): void {
    recordBubbleDiagnostic(message);
    if (!['darwin', 'win32'].includes(process.platform)) return;
    if (!notifications) {
        notifications = createNotifications(async () => (await import('./native/hud.js')).nativeBubbleNotices());
        onShutdown(() => notifications?.close());
    }
    void notifications.show(message);
}
