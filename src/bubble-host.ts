import type { HudOptions, HudSurface, IndicatorView } from './indicator.js';
import type { BubbleNotice } from './bubble-feedback.js';

type Channel = { view?: IndicatorView; options: HudOptions; sequence: number };

// All capture channels and information share one native panel. A notice never
// creates a second toast, changes capture state or takes over the pause action.
export function createBubbleHost(create: (pause: () => void) => HudSurface, report: (error: unknown) => void = () => {}) {
    const channels = new Set<Channel>();
    let surface: HudSurface | undefined, notice: BubbleNotice | undefined;
    let sequence = 0, noticeTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
    // Timer callbacks have no caller to catch native failures. Drop the broken
    // surface and report privately, without letting feedback crash capture.
    const scheduled = (action: () => void) => () => {
        try { action(); }
        catch (error) {
            const broken = surface; surface = undefined;
            try { broken?.close(); } catch {}
            try { report(error); } catch {}
        }
    };
    const priority = (channel: Channel) => ['starting', 'recording', 'paused', 'processing'].includes(channel.view!.phase) ? 1 : 0;
    const owner = () => [...channels].filter(channel => channel.view).sort((a, b) => priority(b) - priority(a) || b.sequence - a.sequence)[0];
    const paint = () => {
        const current = owner();
        if (!current && !notice) {
            surface?.hide();
            clearTimeout(closeTimer);
            if (!channels.size) { closeTimer = setTimeout(scheduled(() => { const old = surface; surface = undefined; old?.close(); }), 350); closeTimer.unref(); }
            return;
        }
        clearTimeout(closeTimer);
        try {
            surface ||= create(() => { const active = owner(); if (!notice && !active?.view?.notice) active?.options.onTogglePause?.(); });
            surface.render(notice ? { ...(current?.view || { phase: 'starting', level: 0 }), notice } : current!.view!);
        } catch (error) { const broken = surface; surface = undefined; try { broken?.close(); } catch {} throw error; }
    };
    const dismiss = () => { clearTimeout(noticeTimer); notice = undefined; paint(); };
    return {
        acquire(options: HudOptions = {}): HudSurface {
            const channel: Channel = { options, sequence: 0 }; channels.add(channel);
            let closed = false;
            return {
                render(view) { if (closed) return; channel.view = view; channel.sequence = ++sequence; paint(); },
                hide() { if (closed) return; channel.view = undefined; paint(); },
                close() { if (closed) return; closed = true; channels.delete(channel); paint(); },
            };
        },
        show(value: BubbleNotice) {
            notice = value; clearTimeout(noticeTimer); paint();
            noticeTimer = setTimeout(scheduled(dismiss), 4000); noticeTimer.unref();
        },
        hide: dismiss,
        close() { clearTimeout(noticeTimer); clearTimeout(closeTimer); notice = undefined; channels.clear(); surface?.close(); surface = undefined; },
    };
}
