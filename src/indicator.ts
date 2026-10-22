import { bubbleNotice } from './bubble-feedback.js';
import type { BubbleNotice } from './bubble-feedback.js';
import type { EventEmitter } from 'node:events';
import { createNativeHud } from './native/hud.js';
import type { WavePhase } from './waveform.js';

export type IndicatorView = { phase: WavePhase; level: number; mode?: 'meeting'; elapsed?: number; feedback?: 'microphone'; notice?: BubbleNotice };
export type HudOptions = { onTogglePause?: () => void; processingMorph?: boolean; clock?: () => number };
export type HudSurface = { render(view: IndicatorView): void; hide(): void; close(): void };
type Source = EventEmitter & { state: string; message?: string; config?: { dictationAutoInsert: boolean }; current?: { delivery?: { kind: string } }; recorder?: { levels: { mic: number } } };

export function indicatorView(source: Pick<Source, 'state' | 'recorder' | 'message' | 'current' | 'config'>): IndicatorView | null {
    switch (source.state) {
        case 'starting': return { phase: 'starting', level: 0 };
        case 'recording': return { phase: 'recording', level: Math.max(0, source.recorder?.levels.mic || 0) };
        case 'processing': return { phase: 'processing', level: 0 };
        case 'ready': return { phase: 'copied', level: 0, ...(source.current?.delivery?.kind === 'clipboard' && source.config?.dictationAutoInsert !== false ? { notice: bubbleNotice('Copied') } : {}) };
        case 'error': {
            const microphone = /microphone|audio device.*mic|mic[: ].*(error|permission|device|lost|stall)/i.test(source.message || '');
            return microphone ? { phase: 'error', level: 0, feedback: 'microphone' } : { phase: 'error', level: 0, notice: bubbleNotice(source.message || '') };
        }
        default: return null;
    }
}

export function attachIndicator(source: Source, warning: (message: string) => void, create: () => HudSurface = createNativeHud, availability: (available: boolean) => void = () => {}): () => void {
    let surface: HudSurface | undefined;
    let timer: NodeJS.Timeout | undefined;
    let hideTimer: NodeJS.Timeout | undefined;
    let feedbackPhase: WavePhase | undefined;
    let feedbackExpired = false;
    let failed = false;
    const unavailable = (error: unknown) => {
        if (failed) return;
        failed = true; availability(false); clearInterval(timer); clearTimeout(hideTimer);
        const current = surface; surface = undefined;
        try { current?.close(); } catch { /* A broken visual must not interrupt dictation. */ }
        warning("Dictation indicator unavailable: " + String(error));
    };
    const hide = () => {
        clearInterval(timer);
        try { surface?.hide(); } catch (error) { unavailable(error); }
    };
    const render = () => {
        if (failed) return;
        const view = indicatorView(source);
        if (!view) { hide(); return; }
        try { surface ||= create(); surface.render(view); availability(true); }
        catch (error) { unavailable(error); }
    };
    const update = () => {
        if (failed) return;
        clearInterval(timer);
        const view = indicatorView(source);
        if (!view) { clearTimeout(hideTimer); feedbackPhase = undefined; feedbackExpired = false; hide(); return; }
        const feedback = view.phase === 'copied' || view.phase === 'error';
        // Cleanup, persistence and notifications can update the same terminal
        // state repeatedly. They must never extend or resurrect its bubble.
        if (!feedback || feedbackPhase !== view.phase) {
            clearTimeout(hideTimer); feedbackExpired = false;
            feedbackPhase = feedback ? view.phase : undefined;
            if (feedback) {
                hideTimer = setTimeout(() => { feedbackExpired = true; hide(); }, view.notice ? 4000 : view.phase === 'error' ? 1800 : 1200);
                hideTimer.unref();
            }
        }
        if (feedbackExpired) return;
        render();
        if (failed) return;
        timer = setInterval(render, 50); timer.unref();
    };
    source.on('update', update);
    return () => {
        availability(false); source.off('update', update); clearInterval(timer); clearTimeout(hideTimer);
        const current = surface; surface = undefined;
        try { current?.close(); } catch (error) { unavailable(error); }
    };
}
