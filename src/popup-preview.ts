import { setTimeout as delay } from 'node:timers/promises';
import { createCallPopup } from './native/call-popup.js';
import { onShutdown } from './lifecycle.js';

export async function previewPopups(): Promise<void> {
    const controller = new AbortController();
    const popup = createCallPopup(() => { popup.hide(); controller.abort(); });
    const unregister = onShutdown(() => { controller.abort(); popup.close(); });
    try {
        for (const title of ['Incoming call', 'Teams meeting in 5 min', 'Recording saved']) {
            popup.show(title, 'Animation preview · No audio is recorded.', [{ id: 'close', label: 'Close preview' }]);
            await delay(3200, undefined, { signal: controller.signal });
            popup.hide();
            await delay(900, undefined, { signal: controller.signal });
        }
    } catch (error) {
        if (!controller.signal.aborted) throw error;
        await delay(350);
    } finally { unregister(); popup.close(); }
}
