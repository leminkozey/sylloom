import { createBubbleHost } from '../bubble-host.js';
import { recordBubbleDiagnostic } from '../notification.js';
import koffi from 'koffi';
import type { HudSurface, IndicatorView, HudOptions } from '../indicator.js';
import { createLiquidBubble } from './liquid-bubble.js';
import { IndicatorMotion, recordingTime } from '../indicator-motion.js';
import { initializeAppKit } from './app-kit.js';
import { createWindowsHud } from './windows/surface.js';

let hudSequence = 0;

// AppKit stays on Node's main thread. This transparent, nonactivating panel
// ignores mouse events, so focus and clicks stay in the user's application.
let shared: ReturnType<typeof createBubbleHost> | undefined;
function bubbleHost() { return shared ||= createBubbleHost(onTogglePause => createPlatformHud({ onTogglePause }), error => recordBubbleDiagnostic('Capture bubble cleanup failed: ' + String(error))); }
export function nativeBubbleNotices() { const host = bubbleHost(); return { show: host.show, hide: host.hide }; }
export function createNativeHud(options: HudOptions = {}): HudSurface {
    return options.clock ? createPlatformHud(options) : bubbleHost().acquire(options);
}
function createPlatformHud(options: HudOptions = {}): HudSurface {
    if (process.platform === 'win32') return createWindowsHud(options);
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
    const opacity = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'float']);
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
    const padding = 144;
    const window = objc.func('objc_msgSend', 'void *', ['void *', 'void *', rect, 'ulong', 'ulong', 'bool'])(
        get(cls('NSPanel'), sel('alloc')), sel('initWithContentRect:styleMask:backing:defer:'), box(0, 0, width + padding * 2, height + padding * 2), 1 << 7, 2, false);
    if (!window) throw new Error("macOS could not open the dictation indicator.");
    object(window, sel('setTitle:'), string(cls('NSString'), sel('stringWithUTF8String:'), options.onTogglePause ? 'Sylloom · Recording' : 'Sylloom · Dictation'));
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
    bool(surface, sel('setClipsToBounds:'), false); bool(get(surface, sel('layer')), sel('setMasksToBounds:'), false);
    const content = initRect(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(0, 0, width, height));
    bool(content, sel('setWantsLayer:'), true); object(surface, sel('addSubview:'), content); send(content, sel('release'));
    bool(content, sel('setClipsToBounds:'), false); bool(get(content, sel('layer')), sel('setMasksToBounds:'), false);
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const newPath = cg.func('void *CGPathCreateMutable(void)'), move = cg.func('void CGPathMoveToPoint(void *, void *, double, double)');
    const lines = cg.func('void CGPathAddLines(void *, void *, void *, ulong)'), closePath = cg.func('void CGPathCloseSubpath(void *)'), releasePath = cg.func('void CGPathRelease(void *)');
    const glyph = get(cls('CAShapeLayer'), sel('layer'));
    setRect(glyph, sel('setFrame:'), box(0, 0, width, height));
    object(get(content, sel('layer')), sel('addSublayer:'), glyph);
    const label = initRect(get(cls('NSTextField'), sel('alloc')), sel('initWithFrame:'), box(options.onTogglePause ? 27 : 5, 11, options.onTogglePause ? 37 : 148, 16));
    for (const method of ['setEditable:', 'setSelectable:', 'setBezeled:', 'setDrawsBackground:']) bool(label, sel(method), false);
    object(label, sel('setTextColor:'), get(cls('NSColor'), sel('whiteColor')));
    object(label, sel('setFont:'), objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double', 'double'])(cls('NSFont'), sel('monospacedDigitSystemFontOfSize:weight:'), options.onTogglePause ? 10 : 10.5, 0));
    object(content, sel('addSubview:'), label); send(label, sel('release')); bool(label, sel('setHidden:'), true);
    const infoLabel = (y: number, h: number, size: number, weight: number) => {
        const view = initRect(get(cls('NSTextField'), sel('alloc')), sel('initWithFrame:'), box(width / 2 - 132, y, 264, h));
        for (const method of ['setEditable:', 'setSelectable:', 'setBezeled:', 'setDrawsBackground:']) bool(view, sel(method), false);
        object(view, sel('setFont:'), objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double', 'double'])(cls('NSFont'), sel('systemFontOfSize:weight:'), size, weight));
        object(view, sel('setTextColor:'), get(cls('NSColor'), sel(weight ? 'whiteColor' : 'lightGrayColor')));
        bool(get(view, sel('cell')), sel('setWraps:'), true); bool(get(view, sel('cell')), sel('setScrollable:'), false);
        object(content, sel('addSubview:'), view); send(view, sel('release')); bool(view, sel('setHidden:'), true); return view;
    };
    const noticeTitle = infoLabel(51, 19, 13, .4), noticeDetail = infoLabel(13, 32, 11, 0);
    let lastLabel = '', lastNotice = '', currentTitle = '';
    let noticeProgress = 0, lastPaint = 0;
    let releaseActions = () => {};
    const dot = initRect(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(14, 15, 8, 8));
    bool(dot, sel('setWantsLayer:'), true); number(get(dot, sel('layer')), sel('setCornerRadius:'), 4);
    object(content, sel('addSubview:'), dot); send(dot, sel('release'));
    bool(dot, sel('setHidden:'), !options.onTogglePause);
    const pauseBars = [14, 20].map(x => {
        const view = initRect(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(x, 14, 2.5, 10));
        bool(view, sel('setWantsLayer:'), true); number(get(view, sel('layer')), sel('setCornerRadius:'), 1);
        object(get(view, sel('layer')), sel('setBackgroundColor:'), get(get(cls('NSColor'), sel('whiteColor')), sel('CGColor')));
        object(content, sel('addSubview:'), view); send(view, sel('release')); bool(view, sel('setHidden:'), true); return view;
    });
    const play = initRect(get(cls('NSImageView'), sel('alloc')), sel('initWithFrame:'), box(12, 12, 13, 14));
    const symbol = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *', 'void *'])(cls('NSImage'), sel('imageWithSystemSymbolName:accessibilityDescription:'), string(cls('NSString'), sel('stringWithUTF8String:'), 'play.fill'), null);
    object(play, sel('setImage:'), symbol); object(play, sel('setContentTintColor:'), get(cls('NSColor'), sel('whiteColor')));
    object(content, sel('addSubview:'), play); send(play, sel('release')); bool(play, sel('setHidden:'), true);
    if (options.onTogglePause) {
        const handler = koffi.register(() => options.onTogglePause?.(), koffi.pointer(koffi.proto('void', ['void *', 'void *', 'void *'])));
        const type = objc.func('void *objc_allocateClassPair(void *, str, ulong)')(cls('NSObject'), 'SylloomCaptureAction' + process.pid + '_' + ++hudSequence, 0);
        objc.func('bool class_addMethod(void *, void *, void *, str)')(type, sel('togglePause:'), handler, 'v@:@');
        objc.func('void objc_registerClassPair(void *)')(type);
        const target = get(type, sel('new'));
        const button = initRect(get(cls('NSButton'), sel('alloc')), sel('initWithFrame:'), box(0, 0, width, height));
        bool(button, sel('setTransparent:'), true); bool(button, sel('setBordered:'), false);
        object(button, sel('setAccessibilityLabel:'), string(cls('NSString'), sel('stringWithUTF8String:'), 'Pause or resume recording'));
        object(button, sel('setTarget:'), target); object(button, sel('setAction:'), sel('togglePause:'));
        object(content, sel('addSubview:'), button); send(button, sel('release'));
        releaseActions = () => { object(button, sel('setTarget:'), null); send(target, sel('release')); koffi.unregister(handler); };
    }
    const mode = get(string(cls('NSString'), sel('stringWithUTF8String:'), 'kCFRunLoopDefaultMode'), sel('retain'));
    const past = get(get(cls('NSDate'), sel('distantPast')), sel('retain'));
    const nextEvent = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong', 'void *', 'void *', 'bool']);
    const reducedMotion = objc.func('objc_msgSend', 'bool', ['void *', 'void *']);
    const workspace = get(cls('NSWorkspace'), sel('sharedWorkspace'));
    const bubble = createLiquidBubble({ layer: get(surface, sel('layer')), contentLayer: get(content, sel('layer')), width, height, radius: height / 2,
        onTransition: () => bool(window, sel('setIgnoresMouseEvents:'), true),
        onShown: () => bool(window, sel('setIgnoresMouseEvents:'), true),
        onHidden: () => object(window, sel('orderOut:'), null) });
    let closed = false;
    const geometry = new IndicatorMotion(width);
    send(scope, sel('drain'));

    let lastOrigin: { x: number; y: number } | undefined;
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
        const origin = { x: frame.origin.x + (frame.size.width - width - padding * 2) / 2, y: frame.origin.y + 18 - padding };
        if (!lastOrigin || lastOrigin.x !== origin.x || lastOrigin.y !== origin.y) { setPoint(window, sel('setFrameOrigin:'), origin); lastOrigin = origin; }
    };

    let displayed: IndicatorView | undefined;
    let paintTimer: NodeJS.Timeout | undefined;
    const paint = () => {
        const view = displayed; if (!view) return;
            if (closed) return;
            const scope = pool();
            try {
                // Follow screen changes throughout capture and processing.
                // Only move the existing panel; preserve its current animation.
                position();
                const meeting = view.mode === 'meeting';
                const now = options.clock?.() ?? performance.now(), dt = lastPaint ? Math.max(0, Math.min(40, now - lastPaint)) : 16; lastPaint = now;
                const expanded = view.notice ? 1 : 0;
                const reduce = reducedMotion(workspace, sel('accessibilityDisplayShouldReduceMotion'));
                noticeProgress = reduce ? expanded : bubble.phase === 'visible' ? noticeProgress + (expanded - noticeProgress) * (1 - Math.exp(-dt / 65)) : noticeProgress;
                if (Math.abs(expanded - noticeProgress) < .001) noticeProgress = expanded;
                const title = meeting ? 'Sylloom · Recording' : 'Sylloom · Dictation';
                if (title !== currentTitle) { currentTitle = title; object(window, sel('setTitle:'), string(cls('NSString'), sel('stringWithUTF8String:'), title)); }
                const waiting = view.phase === 'starting' || view.phase === 'processing';
                const motion = !reducedMotion(workspace, sel('accessibilityDisplayShouldReduceMotion'));
                const frame = geometry.frame(view.phase, view.level, options.clock?.() ?? performance.now(), motion, options.processingMorph !== false, view.feedback);
                const base = waiting && view.phase !== 'processing' ? [.53, .53, .56] : [.408, .42, .906];
                const green = [.22, .76, .43];
                const rgb = base.map((value, i) => { const white = value + (.96 - value) * frame.white; const success = white + (green[i]! - white) * frame.success; return success + ([.96, .27, .3][i]! - success) * frame.error; });
                bool(dot, sel('setHidden:'), !meeting || Boolean(view.notice));
                if (options.onTogglePause) {
                    const pointer = getPoint(cls('NSEvent'), sel('mouseLocation')), bounds = getRect(window, sel('frame'));
                    const px = pointer.x - bounds.origin.x - padding, py = pointer.y - bounds.origin.y - padding;
                    const edge = Math.max(height / 2, Math.min(width - height / 2, px));
                    const hovering = meeting && !view.notice && bubble.phase === 'visible' && (px - edge) ** 2 + (py - height / 2) ** 2 <= (height / 2) ** 2;
                    bool(window, sel('setIgnoresMouseEvents:'), !hovering);
                    bool(dot, sel('setHidden:'), !meeting || Boolean(view.notice) || hovering);
                    for (const bar of pauseBars) bool(bar, sel('setHidden:'), !hovering || view.phase === 'paused');
                    bool(play, sel('setHidden:'), !hovering || view.phase !== 'paused');
                    const tint = view.phase === 'paused' ? [.94, .94, .98] : [.408, .42, .906];
                    object(get(dot, sel('layer')), sel('setBackgroundColor:'), get(color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), ...tint, 1), sel('CGColor')));
                }
                const value = meeting && !view.notice ? recordingTime(view.elapsed) : '';
                bool(label, sel('setHidden:'), !value);
                number(label, sel('setAlphaValue:'), 1);
                if (value !== lastLabel) { lastLabel = value; object(label, sel('setStringValue:'), string(cls('NSString'), sel('stringWithUTF8String:'), value)); }
                const noticeAlpha = Math.max(0, Math.min(1, (noticeProgress - .9) / .1));
                for (const text of [noticeTitle, noticeDetail]) { bool(text, sel('setHidden:'), !view.notice); number(text, sel('setAlphaValue:'), noticeAlpha); }
                const noticeText = JSON.stringify(view.notice || null);
                if (noticeText !== lastNotice) { lastNotice = noticeText;
                    object(noticeTitle, sel('setStringValue:'), string(cls('NSString'), sel('stringWithUTF8String:'), view.notice?.title || ''));
                    object(noticeDetail, sel('setStringValue:'), string(cls('NSString'), sel('stringWithUTF8String:'), view.notice?.detail || ''));
                }
                opacity(glyph, sel('setOpacity:'), Math.max(0, 1 - noticeProgress * 2));
                const ink = color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), ...rgb, 1);
                send(cls('CATransaction'), sel('begin')); bool(cls('CATransaction'), sel('setDisableActions:'), true);
                try {
                    const path = newPath();
                    try {
                        for (const part of frame.parts) {
                            const x = (value: number) => meeting ? (value - width / 2) * .43 + 88 : value;
                            move(path, null, x(part[0]!.x), part[0]!.y);
                            const points = Buffer.alloc(part.length * 16);
                            part.forEach((point, i) => { points.writeDoubleLE(x(point.x), i * 16); points.writeDoubleLE(point.y, i * 16 + 8); });
                            lines(path, null, points, part.length); closePath(path);
                        }
                        object(glyph, sel('setPath:'), path); object(glyph, sel('setFillColor:'), get(ink, sel('CGColor')));
                    } finally { releasePath(path); }
                    bubble.resize(frame.width + (300 - frame.width) * noticeProgress, height + (84 - height) * noticeProgress);
                } finally { send(cls('CATransaction'), sel('commit')); }
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
        };
    return {
        render(view: IndicatorView) { displayed = view; if (!paintTimer && !options.clock) { paintTimer = setInterval(paint, 16); paintTimer.unref(); } paint(); },
        hide() { if (!closed) { clearInterval(paintTimer); paintTimer = undefined; displayed = undefined; noticeProgress = 0; lastPaint = 0; geometry.reset(); bubble.hide(); } },
        close() {
            if (closed) return;
            closed = true; clearInterval(paintTimer); releaseActions(); bubble.close(); object(window, sel('orderOut:'), null); send(window, sel('close')); send(window, sel('release'));
            send(mode, sel('release')); send(past, sel('release'));
        },
    };
}
