import { setTimeout as delay } from 'node:timers/promises';
import { createNativeHud } from './native/hud.js';
import { onShutdown } from './lifecycle.js';
import type { IndicatorView } from './indicator.js';

export async function previewIndicator(): Promise<void> {
    const controller = new AbortController();
    const surface = createNativeHud();
    let view: IndicatorView | undefined;
    let failure: unknown;
    const started = Date.now();
    const render = () => {
        if (!view) return;
        const t = Date.now() - started;
        const level = view.phase === 'recording' ? 0.015 + 0.12 * Math.abs(Math.sin(t / 260)) ** 2 : 0;
        surface.render({ ...view, level });
    };
    const timer = setInterval(() => { try { render(); } catch (error) { failure = error; controller.abort(); } }, 50);
    const unregister = onShutdown(() => { controller.abort(); clearInterval(timer); surface.close(); });
    try {
        for (const [phase, duration] of [['starting', 450], ['recording', 2600], ['processing', 750], ['copied', 700]] as const) {
            view = { phase, level: 0 }; render();
            await delay(duration, undefined, { signal: controller.signal });
        }
        view = undefined; surface.hide();
        await delay(600, undefined, { signal: controller.signal });
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { unregister(); clearInterval(timer); surface.close(); }
    if (failure) throw failure;
}
