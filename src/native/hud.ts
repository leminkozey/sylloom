import koffi from 'koffi';
import type { HudSurface, IndicatorView } from '../indicator.js';
import { createLiquidBubble } from './liquid-bubble.js';
import { Waveform } from '../waveform.js';
import { initializeAppKit } from './app-kit.js';

// AppKit stays on Node's main thread. This transparent, nonactivating panel
// ignores mouse events, so focus and clicks stay in the user's application.
export function createNativeHud(): HudSurface {
    if (process.platform !== 'darwin') throw new Error("The dictation indicator requires macOS.");
    initializeAppKit();
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cls = objc.func('void *objc_getClass(str)');
    const sel = objc.func('void *sel_registerName(str)');
    const point = koffi.struct({ x: 'double', y: 'double' });
    const rect = koffi.struct({ origin: point, size: koffi.struct({ width: 'double', height: 'double' }) });
    const get = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const send = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
    const object = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']);
    const bool = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']);
    const integer = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long']);
    const number = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'double']);
    const string = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
    const getRect = objc.func(process.arch === 'x64' ? 'objc_msgSend_stret' : 'objc_msgSend', rect, ['void *', 'void *']);
    const getPoint = objc.func('objc_msgSend', point, ['void *', 'void *']);
    const setRect = objc.func('objc_msgSend', 'void', ['void *', 'void *', rect]);
    const setPoint = objc.func('objc_msgSend', 'void', ['void *', 'void *', point]);
    const initRect = objc.func('objc_msgSend', 'void *', ['void *', 'void *', rect]);
    const color = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double', 'double', 'double', 'double']);
    const count = objc.func('objc_msgSend', 'ulong', ['void *', 'void *']);
    const index = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong']);
    const box = (x: number, y: number, width: number, height: number) => ({ origin: { x, y }, size: { width, height } });
    const pool = () => get(cls('NSAutoreleasePool'), sel('new'));
    const scope = pool();
    const app = get(cls('NSApplication'), sel('sharedApplication'));
    integer(app, sel('setActivationPolicy:'), 1);
    const width = 122;
    const height = 38;
    const padding = 48;
    const barCount = 13, barWidth = 3, barStep = 7;
    const barLeft = (width - (barCount - 1) * barStep - barWidth) / 2;
    const window = objc.func('objc_msgSend', 'void *', ['void *', 'void *', rect, 'ulong', 'ulong', 'bool'])(
        get(cls('NSPanel'), sel('alloc')), sel('initWithContentRect:styleMask:backing:defer:'), box(0, 0, width + padding * 2, height + padding * 2), 1 << 7, 2, false);
    if (!window) throw new Error("macOS could not open the dictation indicator.");
    object(window, sel('setTitle:'), string(cls('NSString'), sel('stringWithUTF8String:'), "Sylloom · Dictation"));
    integer(window, sel('setLevel:'), 3);
    integer(window, sel('setCollectionBehavior:'), (1 << 0) | (1 << 8) | (1 << 18));
    bool(window, sel('setHidesOnDeactivate:'), false);
    bool(window, sel('setReleasedWhenClosed:'), false);
    bool(window, sel('setFloatingPanel:'), true);
    bool(window, sel('setOpaque:'), false);
    bool(window, sel('setHasShadow:'), false);
    bool(window, sel('setIgnoresMouseEvents:'), true);
    object(window, sel('setBackgroundColor:'), get(cls('NSColor'), sel('clearColor')));
    const root = get(window, sel('contentView'));
    const surface = initRect(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(padding, padding, width, height));
    bool(surface, sel('setWantsLayer:'), true); object(root, sel('addSubview:'), surface); send(surface, sel('release'));
    const content = initRect(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(0, 0, width, height));
    bool(content, sel('setWantsLayer:'), true); object(surface, sel('addSubview:'), content); send(content, sel('release'));
    const bars = Array.from({ length: barCount }, (_, i) => {
        const bar = initRect(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(barLeft + i * barStep, (height - 2) / 2, barWidth, 2));
        bool(bar, sel('setWantsLayer:'), true); number(get(bar, sel('layer')), sel('setCornerRadius:'), 1.5);
        object(content, sel('addSubview:'), bar); send(bar, sel('release'));
        return bar;
    });
    const mode = get(string(cls('NSString'), sel('stringWithUTF8String:'), 'kCFRunLoopDefaultMode'), sel('retain'));
    const past = get(get(cls('NSDate'), sel('distantPast')), sel('retain'));
    const nextEvent = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong', 'void *', 'void *', 'bool']);
    const reducedMotion = objc.func('objc_msgSend', 'bool', ['void *', 'void *']);
    const workspace = get(cls('NSWorkspace'), sel('sharedWorkspace'));
    const bubble = createLiquidBubble({ layer: get(surface, sel('layer')), contentLayer: get(content, sel('layer')), width, height, radius: height / 2,
        onHidden: () => object(window, sel('orderOut:'), null) });
    let closed = false;
    const waveform = new Waveform(barCount);
    send(scope, sel('drain'));

    const position = () => {
        const mouse = getPoint(cls('NSEvent'), sel('mouseLocation'));
        const screens = get(cls('NSScreen'), sel('screens'));
        let screen = get(cls('NSScreen'), sel('mainScreen'));
        for (let i = 0; i < Number(count(screens, sel('count'))); i++) {
            const candidate = index(screens, sel('objectAtIndex:'), i);
            const frame = getRect(candidate, sel('frame'));
            if (mouse.x >= frame.origin.x && mouse.x < frame.origin.x + frame.size.width && mouse.y >= frame.origin.y && mouse.y < frame.origin.y + frame.size.height) { screen = candidate; break; }
        }
        const frame = getRect(screen, sel('visibleFrame'));
        setPoint(window, sel('setFrameOrigin:'), { x: frame.origin.x + (frame.size.width - width - padding * 2) / 2, y: frame.origin.y + 18 - padding });
    };

    return {
        render(view: IndicatorView) {
            if (closed) return;
            const scope = pool();
            try {
                const waiting = view.phase === 'starting' || view.phase === 'processing';
                const motion = !reducedMotion(workspace, sel('accessibilityDisplayShouldReduceMotion'));
                const heights = waveform.update(view.phase, view.level, performance.now(), motion);
                const rgb = view.phase === 'copied' ? [0.16, 0.59, 0.31] : view.phase === 'error' ? [0.77, 0.45, 0.14] : waiting ? [0.53, 0.53, 0.56] : [0.408, 0.42, 0.906];
                const ink = color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), ...rgb, 1);
                send(cls('NSAnimationContext'), sel('beginGrouping'));
                try {
                    // AppKit interpolates between audio samples at the display's
                    // refresh rate. New samples retarget the existing animation.
                    number(get(cls('NSAnimationContext'), sel('currentContext')), sel('setDuration:'), motion ? .09 : 0);
                    for (let i = 0; i < bars.length; i++) {
                        const h = heights[i]!;
                        setRect(get(bars[i], sel('animator')), sel('setFrame:'), box(barLeft + i * barStep, (height - h) / 2, barWidth, h));
                        object(get(bars[i], sel('layer')), sel('setBackgroundColor:'), get(ink, sel('CGColor')));
                    }
                } finally { send(cls('NSAnimationContext'), sel('endGrouping')); }
                if (bubble.phase === 'hidden' || bubble.phase === 'hiding') {
                    if (bubble.phase === 'hidden') { position(); number(window, sel('setAlphaValue:'), 0); }
                    send(window, sel('orderFrontRegardless'));
                    send(root, sel('layoutSubtreeIfNeeded')); send(window, sel('displayIfNeeded'));
                    bubble.show(); number(window, sel('setAlphaValue:'), 1); send(cls('CATransaction'), sel('flush'));
                }
                for (let i = 0; i < 8; i++) {
                    const event = nextEvent(app, sel('nextEventMatchingMask:untilDate:inMode:dequeue:'), 0xffffffffffffffffn, past, mode, true);
                    if (!event) break;
                    object(app, sel('sendEvent:'), event);
                }
                send(app, sel('updateWindows'));
            } finally { send(scope, sel('drain')); }
        },
        hide() { if (!closed) { waveform.reset(); bubble.hide(); } },
        close() {
            if (closed) return;
            closed = true; bubble.close(); object(window, sel('orderOut:'), null); send(window, sel('close')); send(window, sel('release'));
            send(mode, sel('release')); send(past, sel('release'));
        },
    };
}
