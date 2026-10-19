import koffi from 'koffi';

type BubblePhase = 'hidden' | 'showing' | 'visible' | 'hiding';
export type LiquidBubble = { readonly phase: BubblePhase; show(): void; hide(): void; close(): void };

// Own only the outline and transitions; callers retain their native views,
// event loop, focus policy and window lifetime.
export function createLiquidBubble(options: { layer: unknown; contentLayer: unknown; width: number; height: number; radius: number;
    onTransition?: () => void; onShown?: () => void; onHidden: () => void }): LiquidBubble {
    const { layer, contentLayer, width, height, radius } = options;
    koffi.load('/System/Library/Frameworks/QuartzCore.framework/QuartzCore');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cls = objc.func('void *objc_getClass(str)'), sel = objc.func('void *sel_registerName(str)');
    const point = koffi.struct({ x: 'double', y: 'double' });
    const rect = koffi.struct({ origin: point, size: koffi.struct({ width: 'double', height: 'double' }) });
    const get = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const call = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
    const send = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
    const object = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']);
    const bool = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool']);
    const string = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
    const number = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'double']);
    const decimal = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double']);
    const opacity = objc.func('objc_msgSend', 'float', ['void *', 'void *']);
    const flag = objc.func('objc_msgSend', 'bool', ['void *', 'void *']);
    const attach = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *', 'void *']);
    const setFrame = objc.func('objc_msgSend', 'void', ['void *', 'void *', rect]);
    const color = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'double', 'double', 'double', 'double']);
    const box = (x: number, y: number, width: number, height: number) => ({ origin: { x, y }, size: { width, height } });
    const text = (value: string) => string(cls('NSString'), sel('stringWithUTF8String:'), value);
    const setupPool = get(cls('NSAutoreleasePool'), sel('new'));
    let closed = false;
    let visibility: BubblePhase = 'hidden';
    let transition: NodeJS.Timeout | undefined;
    const blob = get(cls('CAShapeLayer'), sel('layer'));
    setFrame(blob, sel('setFrame:'), box(0, 0, width, height));
    object(blob, sel('setFillColor:'), get(color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), 0.075, 0.078, 0.09, 0.98), sel('CGColor')));
    const edge = get(color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), 1, 1, 1, 0.14), sel('CGColor'));
    const highlight = get(color(cls('NSColor'), sel('colorWithSRGBRed:green:blue:alpha:'), 1, 1, 1, 0.5), sel('CGColor'));
    // Animation values below retain these colors beyond this autorelease pool.
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const retain = cf.func('void *CFRetain(void *)'), release = cf.func('void CFRelease(void *)');
    retain(edge); retain(highlight);
    object(blob, sel('setStrokeColor:'), edge); number(blob, sel('setLineWidth:'), 1);
    object(blob, sel('setShadowColor:'), get(get(cls('NSColor'), sel('blackColor')), sel('CGColor')));
    objc.func('objc_msgSend', 'void', ['void *', 'void *', 'float'])(blob, sel('setShadowOpacity:'), 0.25);
    number(blob, sel('setShadowRadius:'), 10);
    objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *', 'uint32'])(layer, sel('insertSublayer:atIndex:'), blob, 0);
    const newPath = cg.func('void *CGPathCreateMutable(void)');
    const movePath = cg.func('void CGPathMoveToPoint(void *, void *, double, double)');
    const curvePath = cg.func('void CGPathAddCurveToPoint(void *, void *, double, double, double, double, double, double)');
    const closePath = cg.func('void CGPathCloseSubpath(void *)');
    const releasePath = cg.func('void CGPathRelease(void *)');
    const path = (x: number, y: number, curves: number[][]) => {
        const value = newPath(); movePath(value, null, x, y);
        for (const points of curves) curvePath(value, null, ...points);
        closePath(value); return value;
    };
    // Every silhouette uses the same eight cubic segments, allowing an actual
    // liquid path morph while the native controls keep their original bounds.
    const rounded = (w: number, h: number, r: number, cy = height / 2) => {
        const l = (width - w) / 2, right = l + w, b = cy - h / 2, top = b + h, k = r * 0.55228475;
        return path(l + r, top, [
            [l + r, top, right - r, top, right - r, top], [right - r + k, top, right, top - r + k, right, top - r],
            [right, top - r, right, b + r, right, b + r], [right, b + r - k, right - r + k, b, right - r, b],
            [right - r, b, l + r, b, l + r, b], [l + r - k, b, l, b + r - k, l, b + r],
            [l, b + r, l, top - r, l, top - r], [l, top - r + k, l + r - k, top, l + r, top],
        ]);
    };
    const cx = width / 2, w = Math.min(38, height * 0.7), h = Math.min(78, height * 1.3), cy = h / 2 - 15, top = cy + h / 2, bottom = cy - h / 2;
    const drop = path(cx, top, [
        [cx, top, cx, top, cx, top], [cx, top - h * 0.24, cx + w / 2, cy + h * 0.2, cx + w / 2, cy - h * 0.1],
        [cx + w / 2, cy - h * 0.1, cx + w / 2, cy - h * 0.17, cx + w / 2, cy - h * 0.17],
        [cx + w / 2, cy - h * 0.4, cx + w * 0.28, bottom, cx, bottom], [cx, bottom, cx, bottom, cx, bottom],
        [cx - w * 0.28, bottom, cx - w / 2, cy - h * 0.4, cx - w / 2, cy - h * 0.17],
        [cx - w / 2, cy - h * 0.17, cx - w / 2, cy - h * 0.1, cx - w / 2, cy - h * 0.1],
        [cx - w / 2, cy + h * 0.2, cx, top - h * 0.24, cx, top],
    ]);
    const shapes = { seed: rounded(20, 20, 10, -8), drop, spread: rounded(width * 230 / 330, height * 112 / 104, height * 56 / 104, height * 54 / 104),
        overshoot: rounded(width * 352 / 330, height * 100 / 104, Math.min(radius * 1.5, height * 50 / 104)), squash: rounded(width * 322 / 330, height * 110 / 104, Math.min(radius * 1.2, height * 55 / 104)), full: rounded(width, height, radius), gone: rounded(4, 4, 2, -16) };
    object(blob, sel('setPath:'), shapes.full);
    const workspace = get(cls('NSWorkspace'), sel('sharedWorkspace'));
    const array = (items: unknown[]) => {
        const value = get(cls('NSMutableArray'), sel('array'));
        for (const item of items) object(value, sel('addObject:'), item);
        return value;
    };
    const animation = (key: string, from: unknown, to: unknown, duration: number) => {
        const value = call(cls('CABasicAnimation'), sel('animationWithKeyPath:'), text(key));
        object(value, sel('setFromValue:'), typeof from === 'number' ? decimal(cls('NSNumber'), sel('numberWithDouble:'), from) : from);
        object(value, sel('setToValue:'), typeof to === 'number' ? decimal(cls('NSNumber'), sel('numberWithDouble:'), to) : to);
        number(value, sel('setDuration:'), duration);
        object(value, sel('setFillMode:'), text('both'));
        object(value, sel('setTimingFunction:'), call(cls('CAMediaTimingFunction'), sel('functionWithName:'), text('easeInEaseOut')));
        return value;
    };
    const animate = (target: unknown, items: unknown[], duration: number) => {
        const group = get(cls('CAAnimationGroup'), sel('animation'));
        object(group, sel('setAnimations:'), array(items)); number(group, sel('setDuration:'), duration);
        object(group, sel('setFillMode:'), text('forwards')); bool(group, sel('setRemovedOnCompletion:'), false);
        attach(target, sel('addAnimation:forKey:'), group, text('sylloom.liquid'));
    };
    const keyframes = (key: string, values: unknown[], times: number[], duration: number, timing?: string[]) => {
        const value = call(cls('CAKeyframeAnimation'), sel('animationWithKeyPath:'), text(key));
        const boxed = (items: unknown[]) => array(items.map(item => typeof item === 'number' ? decimal(cls('NSNumber'), sel('numberWithDouble:'), item) : item));
        object(value, sel('setValues:'), boxed(values)); object(value, sel('setKeyTimes:'), boxed(times));
        number(value, sel('setDuration:'), duration); object(value, sel('setFillMode:'), text('both'));
        if (timing) object(value, sel('setTimingFunctions:'), array(timing.map(name => call(cls('CAMediaTimingFunction'), sel('functionWithName:'), text(name)))));
        return value;
    };
    const clearAnimation = () => { for (const target of [layer, blob, contentLayer]) send(target, sel('removeAllAnimations')); };
    const move = (appearing: boolean) => {
        const hidden = visibility === 'hidden';
        const surface = get(layer, sel('presentationLayer')) || layer;
        const silhouette = get(blob, sel('presentationLayer')) || blob;
        const ink = get(contentLayer, sel('presentationLayer')) || contentLayer;
        const reduced = flag(workspace, sel('accessibilityDisplayShouldReduceMotion'));
        const reversing = appearing && visibility === 'hiding';
        const interrupted = !appearing && visibility === 'showing';
        const duration = reduced ? 0.15 : appearing ? reversing ? 0.32 : 0.42 : interrupted ? 0.24 : 0.28;
        const alpha = hidden ? 0 : opacity(surface, sel('opacity'));
        const current = hidden ? shapes.seed : get(silhouette, sel('path')) || shapes.full;
        const contentAlpha = hidden ? 0 : opacity(ink, sel('opacity'));
        const blobAlpha = hidden ? 0 : opacity(silhouette, sel('opacity'));
        // Retain the presentation path before replacing the animations that own it.
        retain(current);
        clearTimeout(transition); clearAnimation();
        visibility = appearing ? 'showing' : 'hiding';
        options.onTransition?.();
        if (reduced) animate(layer, [animation('opacity', alpha, appearing ? 1 : 0, duration)], duration);
        else {
            const values = appearing ? reversing ? [current, shapes.overshoot, shapes.squash, shapes.full] : [current, shapes.drop, shapes.spread, shapes.overshoot, shapes.squash, shapes.full] :
                interrupted ? [current, shapes.drop, shapes.seed, shapes.gone] : [current, shapes.squash, shapes.spread, shapes.drop, shapes.seed, shapes.gone];
            const times = values.length === 4 ? [0, 0.65, 0.84, 1] : appearing ? [0, 0.2, 0.48, 0.7, 0.86, 1] : [0, 0.12, 0.38, 0.7, 0.92, 1];
            animate(blob, [keyframes('path', values, times, duration, values.slice(1).map((_, i) => i === 0 ? 'easeIn' : 'easeInEaseOut')),
                keyframes('opacity', appearing ? [blobAlpha, 1, 1] : [blobAlpha, 1, 1, 0], appearing ? [0, 0.1, 1] : [0, 0.15, 0.9, 1], duration),
                animation('strokeColor', appearing ? highlight : edge, appearing ? edge : highlight, duration)], duration);
            animate(contentLayer, [keyframes('opacity', appearing ? [contentAlpha, contentAlpha, 1, 1] : [contentAlpha, 0, 0],
                appearing ? [0, 0.64, 0.9, 1] : [0, 0.18, 1], duration)], duration);
        }
        release(current);
        send(cls('CATransaction'), sel('flush'));
        transition = setTimeout(() => {
            if (closed) return;
            const pool = get(cls('NSAutoreleasePool'), sel('new'));
            try {
                visibility = appearing ? 'visible' : 'hidden';
                if (appearing) options.onShown?.();
                else options.onHidden();
                clearAnimation();
            } finally { send(pool, sel('drain')); }
        }, duration * 1000); transition.unref();
    };
    send(setupPool, sel('drain'));
    return {
        get phase() { return visibility; },
        show() {
            if (closed || visibility === 'visible' || visibility === 'showing') return;
            const pool = get(cls('NSAutoreleasePool'), sel('new'));
            try { move(true); } finally { send(pool, sel('drain')); }
        },
        hide() {
            if (closed || visibility === 'hidden' || visibility === 'hiding') return;
            const pool = get(cls('NSAutoreleasePool'), sel('new'));
            try { move(false); } finally { send(pool, sel('drain')); }
        },
        close() {
            if (closed) return;
            closed = true; visibility = 'hidden'; clearTimeout(transition); clearAnimation();
            for (const shape of Object.values(shapes)) releasePath(shape);
            release(edge); release(highlight);
        },
    };
}
