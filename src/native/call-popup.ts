import koffi from 'koffi';
import { fileURLToPath } from 'node:url';
import { createLiquidBubble } from './liquid-bubble.js';
export type Popup = { show(title: string, detail: string, actions: { id: string; label: string }[]): void; hide(): void; close(): void };

export function createCallPopup(action: (id: string) => void): Popup {
    if (process.platform !== 'darwin') throw new Error('Call popups require macOS.');
    const carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
    const psn = koffi.struct({ highLongOfPSN: 'uint32', lowLongOfPSN: 'uint32' });
    carbon.func('TransformProcessType', 'int32', [koffi.pointer(psn), 'uint32'])({ highLongOfPSN: 0, lowLongOfPSN: 2 }, 4);
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit').func('bool NSApplicationLoad(void)')();
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cls = objc.func('void *objc_getClass(str)'), sel = objc.func('void *sel_registerName(str)');
    const point = koffi.struct({ x: 'double', y: 'double' });
    const rect = koffi.struct({ origin: point, size: koffi.struct({ width: 'double', height: 'double' }) });
    const get = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const send = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
    const object = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']);
    const integer = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long']);
    const bool = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']);
    const string = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
    const number = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'double']);
    const getPoint = objc.func('objc_msgSend', point, ['void *', 'void *']);
    const color = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double', 'double', 'double', 'double']);
    const font = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double', 'double']);
    const setFrame = objc.func('objc_msgSend', 'void', ['void *', 'void *', rect]);
    const frame = objc.func(process.arch === 'x64' ? 'objc_msgSend_stret' : 'objc_msgSend', rect, ['void *', 'void *']);
    const init = objc.func('objc_msgSend', 'void *', ['void *', 'void *', rect]);
    const box = (x: number, y: number, width: number, height: number) => ({ origin: { x, y }, size: { width, height } });
    const text = (value: string) => string(cls('NSString'), sel('stringWithUTF8String:'), value);
    const app = get(cls('NSApplication'), sel('sharedApplication')); integer(app, sel('setActivationPolicy:'), 1);
    const pool = get(cls('NSAutoreleasePool'), sel('new'));
    const width = 330, height = 104, padding = 48;
    const window = objc.func('objc_msgSend', 'void *', ['void *', 'void *', rect, 'ulong', 'ulong', 'bool'])(get(cls('NSPanel'), sel('alloc')), sel('initWithContentRect:styleMask:backing:defer:'), box(0, 0, width + padding * 2, height + padding * 2), 128, 2, false);
    if (!window) throw new Error('Could not create the recording popup.');
    object(window, sel('setTitle:'), text('Sylloom · Call'));
    integer(window, sel('setLevel:'), 3); integer(window, sel('setCollectionBehavior:'), (1 << 0) | (1 << 8) | (1 << 18));
    bool(window, sel('setHidesOnDeactivate:'), false); bool(window, sel('setReleasedWhenClosed:'), false); bool(window, sel('setFloatingPanel:'), true);
    bool(window, sel('setOpaque:'), false); bool(window, sel('setHasShadow:'), false);
    object(window, sel('setBackgroundColor:'), get(cls('NSColor'), sel('clearColor')));
    const root = get(window, sel('contentView'));
    const card = init(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(padding, padding, width, height));
    bool(card, sel('setWantsLayer:'), true); object(root, sel('addSubview:'), card); send(card, sel('release'));
    const layer = get(card, sel('layer'));
    bool(layer, sel('setMasksToBounds:'), false);
    const content = init(get(cls('NSView'), sel('alloc')), sel('initWithFrame:'), box(0, 0, width, height));
    bool(content, sel('setWantsLayer:'), true); object(card, sel('addSubview:'), content); send(content, sel('release'));
    const contentLayer = get(content, sel('layer'));
    const label = (y: number, height: number) => {
        const view = init(get(cls('NSTextField'), sel('alloc')), sel('initWithFrame:'), box(62, y, width - 80, height));
        for (const key of ['setEditable:', 'setSelectable:', 'setBezeled:', 'setDrawsBackground:']) bool(view, sel(key), false);
        object(content, sel('addSubview:'), view); send(view, sel('release')); return view;
    };
    const titleLabel = label(68, 22), detailLabel = label(43, 22);
    object(titleLabel, sel('setFont:'), font(cls('NSFont'), sel('systemFontOfSize:weight:'), 14, 0.4));
    object(detailLabel, sel('setFont:'), font(cls('NSFont'), sel('systemFontOfSize:weight:'), 11, 0));
    object(titleLabel, sel('setTextColor:'), get(cls('NSColor'), sel('whiteColor')));
    object(detailLabel, sel('setTextColor:'), color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), 0.7, 0.71, 0.75, 1));
    integer(get(detailLabel, sel('cell')), sel('setLineBreakMode:'), 4);
    const image = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *'])(get(cls('NSImage'), sel('alloc')), sel('initWithContentsOfFile:'), text(fileURLToPath(new URL('../../assets/logo.svg', import.meta.url))));
    if (!image) throw new Error('Could not load the Sylloom logo.');
    const logo = init(get(cls('NSImageView'), sel('alloc')), sel('initWithFrame:'), box(18, 52, 36, 36));
    object(logo, sel('setImage:'), image); send(image, sel('release')); object(content, sel('addSubview:'), logo); send(logo, sel('release'));
    const getTag = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
    const handlerType = koffi.proto('void', ['void *', 'void *', 'void *']);
    let actions: { id: string; label: string }[] = []; let closed = false;
    const handler = koffi.register((_self: unknown, _cmd: unknown, sender: unknown) => {
        const selected = actions[getTag(sender, sel('tag'))]; if (selected) action(selected.id);
    }, koffi.pointer(handlerType));
    const type = objc.func('void *objc_allocateClassPair(void *, str, ulong)')(cls('NSObject'), 'SylloomCallActions' + Date.now(), 0);
    if (!objc.func('bool class_addMethod(void *, void *, void *, str)')(type, sel('sylloomAction:'), handler, 'v@:@')) throw new Error('Could not register recording actions.');
    objc.func('void objc_registerClassPair(void *)')(type);
    const target = get(type, sel('new'));
    const buttons = Array.from({ length: 3 }, (_, index) => {
        const button = init(get(cls('NSButton'), sel('alloc')), sel('initWithFrame:'), box(0, 12, 110, 30));
        integer(button, sel('setBezelStyle:'), 1); integer(button, sel('setTag:'), index);
        object(button, sel('setFont:'), font(cls('NSFont'), sel('systemFontOfSize:weight:'), 12, 0.2));
        object(button, sel('setTarget:'), target); object(button, sel('setAction:'), sel('sylloomAction:'));
        object(content, sel('addSubview:'), button); send(button, sel('release')); return button;
    });
    const mode = get(text('kCFRunLoopDefaultMode'), sel('retain')), past = get(get(cls('NSDate'), sel('distantPast')), sel('retain'));
    const next = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong', 'void *', 'void *', 'bool']);
    const bubble = createLiquidBubble({ layer, contentLayer, width, height, radius: 20,
        onTransition: () => bool(window, sel('setIgnoresMouseEvents:'), true),
        onShown: () => bool(window, sel('setIgnoresMouseEvents:'), false),
        onHidden: () => object(window, sel('orderOut:'), null) });
    send(pool, sel('drain'));
    const timer = setInterval(() => {
        if (closed) return;
        const pool = get(cls('NSAutoreleasePool'), sel('new'));
        try {
            for (let i = 0; i < 8; i++) { const event = next(app, sel('nextEventMatchingMask:untilDate:inMode:dequeue:'), 0xffffffffffffffffn, past, mode, true); if (!event) break; object(app, sel('sendEvent:'), event); }
            send(app, sel('updateWindows'));
        } finally { send(pool, sel('drain')); }
    }, 40); timer.unref();
    return {
        show(title, detail, options) {
            if (closed) return;
            const pool = get(cls('NSAutoreleasePool'), sel('new'));
            try {
                actions = options.slice(0, 3);
                object(titleLabel, sel('setStringValue:'), text(title)); object(detailLabel, sel('setStringValue:'), text(detail));
                for (let i = 0; i < buttons.length; i++) {
                    object(buttons[i], sel('setTitle:'), text(actions[i]?.label || '')); bool(buttons[i], sel('setHidden:'), !actions[i]);
                    setFrame(buttons[i], sel('setFrame:'), box((width - actions.length * 116 + 6) / 2 + i * 116, 10, 110, 30));
                }
                if (bubble.phase === 'visible' || bubble.phase === 'showing') return;
                const mouse = getPoint(cls('NSEvent'), sel('mouseLocation'));
                const screens = get(cls('NSScreen'), sel('screens'));
                const count = objc.func('objc_msgSend', 'ulong', ['void *', 'void *']);
                const at = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong']);
                let screen = get(cls('NSScreen'), sel('mainScreen'));
                for (let i = 0; i < Number(count(screens, sel('count'))); i++) {
                    const candidate = at(screens, sel('objectAtIndex:'), i), bounds = frame(candidate, sel('frame'));
                    if (mouse.x >= bounds.origin.x && mouse.x < bounds.origin.x + bounds.size.width && mouse.y >= bounds.origin.y && mouse.y < bounds.origin.y + bounds.size.height) { screen = candidate; break; }
                }
                const bounds = frame(screen, sel('visibleFrame'));
                if (bubble.phase === 'hidden') objc.func('objc_msgSend', 'void', ['void *', 'void *', point])(window, sel('setFrameOrigin:'), { x: bounds.origin.x + (bounds.size.width - width - padding * 2) / 2, y: bounds.origin.y + 18 - padding });
                if (bubble.phase === 'hidden') number(window, sel('setAlphaValue:'), 0);
                send(window, sel('orderFrontRegardless'));
                send(root, sel('layoutSubtreeIfNeeded')); send(window, sel('displayIfNeeded'));
                bubble.show();
                number(window, sel('setAlphaValue:'), 1);
                send(cls('CATransaction'), sel('flush'));
            } finally { send(pool, sel('drain')); }
        },
        hide() { if (!closed) bubble.hide(); },
        close() { if (closed) return; closed = true; clearInterval(timer); bubble.close(); object(window, sel('orderOut:'), null); send(window, sel('close')); send(window, sel('release')); send(target, sel('release')); send(mode, sel('release')); send(past, sel('release')); koffi.unregister(handler); },
    };
}
