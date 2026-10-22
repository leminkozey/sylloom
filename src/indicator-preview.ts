import { bubbleNotice } from './bubble-feedback.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeHud, nativeBubbleNotices } from './native/hud.js';
import { onShutdown } from './lifecycle.js';
import type { IndicatorView } from './indicator.js';

export async function previewIndicator(options: { repeat?: number; meeting?: boolean; microphoneError?: boolean; clipboard?: boolean } = {}): Promise<void> {
    const controller = new AbortController();
    let paused = false, pausedAt = 0, pausedTotal = 0;
    const surface = createNativeHud({ processingMorph: true, ...(options.meeting ? { onTogglePause: () => { paused = !paused; if (paused) pausedAt = Date.now(); else pausedTotal += Date.now() - pausedAt; } } : {}) });
    let view: IndicatorView | undefined;
    let failure: unknown;
    let recordingStarted = 0;
    const render = () => {
        if (!view) return;
        const t = Date.now() - recordingStarted;
        const cycle = t % 4200;
        const quiet = (cycle >= 1100 && cycle < 1900) || cycle >= 3500;
        const level = !quiet && view.phase === 'recording' ? 0.015 + 0.12 * Math.abs(Math.sin(t / 260)) ** 2 : 0;
        surface.render({ ...view, phase: options.meeting && paused ? 'paused' : view.phase, level, ...(options.meeting ? { mode: 'meeting' as const, elapsed: ((paused ? pausedAt : Date.now()) - recordingStarted - pausedTotal) / 1000 } : {}) });
    };
    const timer = setInterval(() => { try { render(); } catch (error) { failure = error; controller.abort(); } }, 50);
    const unregister = onShutdown(() => { controller.abort(); clearInterval(timer); surface.close(); });
    try {
        for (let cycle = 0; cycle < (options.repeat || 1); cycle++) {
        const phases: [IndicatorView['phase'], number][] = options.meeting ? [['recording', 20000]] : options.microphoneError ? [['starting', 650], ['error', 2600]] : [['starting', 450], ['recording', 4500], ['processing', 2400], ['copied', options.clipboard ? 2200 : 900]];
        for (const [phase, duration] of phases) {
            if (phase === 'recording') { recordingStarted = Date.now(); paused = false; pausedTotal = 0; }
            view = { phase, level: 0, ...(phase === 'error' ? { feedback: 'microphone' as const } : phase === 'copied' && options.clipboard ? { notice: bubbleNotice('Copied') } : {}) }; render();
            await delay(duration, undefined, { signal: controller.signal });
        }
        view = undefined; surface.hide();
        await delay(1000, undefined, { signal: controller.signal });
        }
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { unregister(); clearInterval(timer); surface.close(); }
    if (failure) throw failure;
}

export async function previewBubbleNotice(): Promise<void> {
    const hud = createNativeHud();
    const start = Date.now();
    const draw = () => hud.render({ phase: 'recording', level: .02 + .06 * Math.abs(Math.sin((Date.now() - start) / 300)) });
    const timer = setInterval(draw, 50); const unregister = onShutdown(() => { clearInterval(timer); hud.close(); });
    try {
        draw(); await delay(1600);
        nativeBubbleNotices().show(bubbleNotice('Copied'));
        await delay(5200);
        clearInterval(timer); hud.hide(); await delay(350);
    } finally { unregister(); clearInterval(timer); hud.close(); }
}
