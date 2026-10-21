import type { Popup } from './native/call-popup.js';
import { onShutdown } from './lifecycle.js';

// One reusable, nonactivating surface. A newer message wins even if native
// loading or a previous exit transition is still in flight.
export function createNotifications(load: () => Promise<Popup>) {
    let surface: Popup | undefined;
    let pending: Promise<Popup> | undefined;
    let hideTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
    let revision = 0, closed = false;
    const hide = () => {
        clearTimeout(hideTimer); clearTimeout(closeTimer);
        const current = surface;
        try { current?.hide(); } catch { /* Notifications never interrupt dictation. */ }
        closeTimer = setTimeout(() => {
            if (surface !== current) return;
            surface = undefined; pending = undefined;
            try { current?.close(); } catch { /* Best-effort native cleanup. */ }
        }, 350); closeTimer.unref();
    };
    const close = () => {
        closed = true; revision++; clearTimeout(hideTimer); clearTimeout(closeTimer);
        const current = surface; surface = undefined;
        try { current?.close(); } catch { /* Best-effort native cleanup. */ }
    };
    return {
        async show(message: string) {
            if (closed) return;
            const own = ++revision;
            clearTimeout(hideTimer); clearTimeout(closeTimer);
            try {
                pending ||= load();
                const loaded = await pending;
                if (closed) { loaded.close(); return; }
                surface = loaded;
                if (own !== revision) return;
                surface.show('Sylloom', message, [{ id: 'close', label: 'Close' }]);
                hideTimer = setTimeout(hide, 4000); hideTimer.unref();
            } catch {
                pending = undefined;
                const current = surface; surface = undefined;
                try { current?.close(); } catch { /* A visual failure must not become an unhandled rejection. */ }
            }
        },
        hide, close,
    };
}

let notifications: ReturnType<typeof createNotifications> | undefined;
export function notifyBubble(message: string): void {
    if (!['darwin', 'win32'].includes(process.platform)) return;
    if (!notifications) {
        notifications = createNotifications(async () => {
            const { createCallPopup } = await import('./native/call-popup.js');
            return createCallPopup(() => notifications?.hide(), 'notification');
        });
        onShutdown(() => notifications?.close());
    }
    void notifications.show(message);
}
