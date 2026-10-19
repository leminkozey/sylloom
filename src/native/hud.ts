import koffi from 'koffi';
import type { HudSurface, IndicatorView } from '../indicator.js';

// AppKit stays on Node's main thread. This transparent, nonactivating panel
// ignores mouse events, so focus and clicks stay in the user's application.
export function createNativeHud(): HudSurface {
    if (process.platform !== 'darwin') throw new Error("The dictation indicator requires macOS.");
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
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
    const window = objc.func('objc_msgSend', 'void *', ['void *', 'void *', rect, 'ulong', 'ulong', 'bool'])(
        get(cls('NSPanel'), sel('alloc')), sel('initWithContentRect:styleMask:backing:defer:'), box(0, 0, width, height), 1 << 7, 2, false);
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
    const content = get(window, sel('contentView'));
    const bars = Array.from({ length: 13 }, (_, i) => {
        const bar = initRect(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(16 + i * 7, 18, 3, 2));
        bool(bar, sel('setWantsLayer:'), true); number(get(bar, sel('layer')), sel('setCornerRadius:'), 1.5);
        object(content, sel('addSubview:'), bar); send(bar, sel('release'));
        return bar;
    });
    const mode = get(string(cls('NSString'), sel('stringWithUTF8String:'), 'kCFRunLoopDefaultMode'), sel('retain'));
    const past = get(get(cls('NSDate'), sel('distantPast')), sel('retain'));
    const nextEvent = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong', 'void *', 'void *', 'bool']);
    const reducedMotion = objc.func('objc_msgSend', 'bool', ['void *', 'void *']);
    const workspace = get(cls('NSWorkspace'), sel('sharedWorkspace'));
    let visible = false;
    let closed = false;
    let previousPhase = '';
    let envelope = Array<number>(13).fill(0);
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
        setPoint(window, sel('setFrameOrigin:'), { x: frame.origin.x + (frame.size.width - width) / 2, y: frame.origin.y + 18 });
    };

    return {
        render(view: IndicatorView) {
            if (closed) return;
            const scope = pool();
            try {
                if (view.phase !== previousPhase) { envelope.fill(0); previousPhase = view.phase; }
                const level = view.level > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(view.level) + 55) / 45)) : 0;
                envelope.shift(); envelope.push(level);
                const waiting = view.phase === 'starting' || view.phase === 'processing';
                const motion = !reducedMotion(workspace, sel('accessibilityDisplayShouldReduceMotion'));
                const rgb = view.phase === 'copied' ? [0.16, 0.59, 0.31] : view.phase === 'error' ? [0.77, 0.45, 0.14] : waiting ? [0.53, 0.53, 0.56] : [0.408, 0.42, 0.906];
                const ink = color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), ...rgb, 1);
                for (let i = 0; i < bars.length; i++) {
                    const value = waiting ? (motion ? 0.15 + (Math.sin(Date.now() / 240 - i * 0.6) + 1) * 0.15 : 0.25) : view.phase === 'recording' ? envelope[i]! : 0.15;
                    const h = 2 + value * 24;
                    setRect(bars[i], sel('setFrame:'), box(16 + i * 7, (height - h) / 2, 3, h));
                    object(get(bars[i], sel('layer')), sel('setBackgroundColor:'), get(ink, sel('CGColor')));
                }
                if (!visible) { position(); send(window, sel('orderFrontRegardless')); visible = true; }
                for (let i = 0; i < 8; i++) {
                    const event = nextEvent(app, sel('nextEventMatchingMask:untilDate:inMode:dequeue:'), 0xffffffffffffffffn, past, mode, true);
                    if (!event) break;
                    object(app, sel('sendEvent:'), event);
                }
                send(app, sel('updateWindows'));
            } finally { send(scope, sel('drain')); }
        },
        hide() { if (!closed) { object(window, sel('orderOut:'), null); visible = false; } },
        close() {
            if (closed) return;
            closed = true; object(window, sel('orderOut:'), null); send(window, sel('close')); send(window, sel('release'));
            send(mode, sel('release')); send(past, sel('release'));
        },
    };
}
