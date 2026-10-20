import koffi from 'koffi';
import { windows, pumpWindow } from './api.js';
import type { Pointer } from './api.js';
import { Waveform } from '../../waveform.js';
import type { IndicatorView, HudSurface } from '../../indicator.js';
import type { Popup } from '../call-popup.js';
import { onShutdown } from '../../lifecycle.js';
import { cleanText } from '../../types.js';

type Action = { id: string; label: string };
let sequence = 0;
let drawing: ReturnType<typeof loadDrawing> | undefined;
function loadDrawing() {
    const api = windows(), gdi = koffi.load('gdi32.dll'), plus = koffi.load('gdiplus.dll');
    const startup = koffi.struct({ version: 'uint32', callback: 'void *', background: 'int32', codecs: 'int32' });
    const token = [0n];
    if (plus.func('GdiplusStartup', 'int32', [koffi.out(koffi.pointer('uintptr_t')), koffi.pointer(startup), 'void *'])(token,
        { version: 1, callback: null, background: 0, codecs: 0 }, null)) throw new Error('Windows graphics could not initialize.');
    onShutdown(() => { plus.func('void __stdcall GdiplusShutdown(uintptr_t)')(token[0]); });
    const rect = koffi.struct({ x: 'float', y: 'float', width: 'float', height: 'float' });
    return { api, gdi, plus, rect,
        getDC: api.user.func('void * __stdcall GetDC(void *)'), releaseDC: api.user.func('int __stdcall ReleaseDC(void *, void *)'),
        compatible: gdi.func('void * __stdcall CreateCompatibleDC(void *)'), deleteDC: gdi.func('int __stdcall DeleteDC(void *)'),
        bitmap: gdi.func('void * __stdcall CreateDIBSection(void *, void *, uint32, _Out_ void **, void *, uint32)'),
        select: gdi.func('void * __stdcall SelectObject(void *, void *)'), deleteObject: gdi.func('int __stdcall DeleteObject(void *)'),
        image: plus.func('int __stdcall GdipCreateBitmapFromScan0(int, int, int, int, void *, _Out_ void **)'),
        graphics: plus.func('int __stdcall GdipGetImageGraphicsContext(void *, _Out_ void **)'),
        disposeImage: plus.func('int __stdcall GdipDisposeImage(void *)'), deleteGraphics: plus.func('int __stdcall GdipDeleteGraphics(void *)'),
        clear: plus.func('int __stdcall GdipGraphicsClear(void *, uint32)'), smoothing: plus.func('int __stdcall GdipSetSmoothingMode(void *, int)'),
        path: plus.func('int __stdcall GdipCreatePath(int, _Out_ void **)'), arc: plus.func('int __stdcall GdipAddPathArc(void *, float, float, float, float, float, float)'),
        closePath: plus.func('int __stdcall GdipClosePathFigure(void *)'), deletePath: plus.func('int __stdcall GdipDeletePath(void *)'),
        brush: plus.func('int __stdcall GdipCreateSolidFill(uint32, _Out_ void **)'), deleteBrush: plus.func('int __stdcall GdipDeleteBrush(void *)'),
        fill: plus.func('int __stdcall GdipFillPath(void *, void *, void *)'),
        family: plus.func('int __stdcall GdipCreateFontFamilyFromName(str16, void *, _Out_ void **)'), deleteFamily: plus.func('int __stdcall GdipDeleteFontFamily(void *)'),
        font: plus.func('int __stdcall GdipCreateFont(void *, float, int, int, _Out_ void **)'), deleteFont: plus.func('int __stdcall GdipDeleteFont(void *)'),
        format: plus.func('int __stdcall GdipCreateStringFormat(int, uint16, _Out_ void **)'),
        alignment: plus.func('int __stdcall GdipSetStringFormatAlign(void *, int)'), lineAlignment: plus.func('int __stdcall GdipSetStringFormatLineAlign(void *, int)'),
        trimming: plus.func('int __stdcall GdipSetStringFormatTrimming(void *, int)'), deleteFormat: plus.func('int __stdcall GdipDeleteStringFormat(void *)'),
        text: plus.func('GdipDrawString', 'int32', ['void *', 'str16', 'int', 'void *', koffi.pointer(rect), 'void *', 'void *']),
        textQuality: plus.func('int __stdcall GdipSetTextRenderingHint(void *, int)'),
    };
}

// Off-screen premultiplied BGRA goes to a nonactivating layered window. Unlike
// color-key transparency this preserves smooth, translucent rounded edges.
function createSurface(indicator: boolean, onAction: (id: string) => void, right = false) {
    const draw = drawing ||= loadDrawing(), { api } = draw;
    const resources: (() => void)[] = [];
    const dispose = () => { for (const free of resources.splice(0).reverse()) try { free(); } catch { /* Finish releasing independent native resources. */ } };
    const requireResource = <T>(value: T): NonNullable<T> => { if (!value) { dispose(); throw new Error('Could not allocate the Sylloom popup surface.'); } return value as NonNullable<T>; };
    const definition = koffi.struct({ size: 'uint32', style: 'uint32', procedure: 'void *', classExtra: 'int32', windowExtra: 'int32',
        instance: 'void *', icon: 'void *', cursor: 'void *', background: 'void *', menu: 'str16', name: 'str16', smallIcon: 'void *' });
    const monitorType = koffi.struct({ size: 'uint32', monitor: api.rect, work: api.rect, flags: 'uint32' });
    const cursor = { x: 0, y: 0 }; api.user.func('GetCursorPos', 'int', [koffi.out(koffi.pointer(api.point))])(cursor);
    const monitor = api.user.func('MonitorFromPoint', 'void *', [api.point, 'uint32'])(cursor, 2);
    const screen = { size: koffi.sizeof(monitorType), monitor: { left: 0, top: 0, right: 1920, bottom: 1080 }, work: { left: 0, top: 0, right: 1920, bottom: 1040 }, flags: 0 };
    api.user.func('GetMonitorInfoW', 'int', ['void *', koffi.inout(koffi.pointer(monitorType))])(monitor, screen);
    let scale = 1;
    try { const x = [96], y = [96]; if (!koffi.load('shcore.dll').func('int __stdcall GetDpiForMonitor(void *, int, _Out_ uint32 *, _Out_ uint32 *)')(monitor, 0, x, y)) scale = x[0]! / 96; } catch { /* Standard DPI remains usable. */ }
    const width = indicator ? 122 : 330, height = indicator ? 38 : 104, padding = 24;
    const pixel = (value: number) => value * scale;
    const outerWidth = Math.ceil(pixel(width + padding * 2)), outerHeight = Math.ceil(pixel(height + padding * 2));
    let title = '', detail = '', actions: Action[] = [], view: IndicatorView = { phase: 'starting', level: 0 };
    let phase: 'hidden' | 'showing' | 'visible' | 'hiding' = 'hidden', since = 0, closed = false;
    let timer: NodeJS.Timeout | undefined;
    const waveform = new Waveform(13);
    const supportsMotion = () => { const enabled = [1]; return !api.user.func('int __stdcall SystemParametersInfoW(uint32, uint32, _Out_ int32 *, uint32)')(0x1042, 0, enabled, 0) || Boolean(enabled[0]); };
    let motion = supportsMotion();
    const buttonWidth = () => Math.min(110, (width - 32 - Math.max(0, actions.length - 1) * 8) / Math.max(1, actions.length));
    const buttonLeft = (index: number) => (width - (buttonWidth() * actions.length + Math.max(0, actions.length - 1) * 8)) / 2 + index * (buttonWidth() + 8);
    const procedure = koffi.register((_window: unknown, message: number, _wparam: unknown, lparam: number | bigint) => {
        if (message === 0x21) return 3; // MA_NOACTIVATE, including button clicks.
        if (message === 0x84 && indicator) return -1; // HTTRANSPARENT.
        if (message === 0xf) { api.user.func('int __stdcall ValidateRect(void *, void *)')(_window, null); return 0; }
        if (message === 0x202 && !indicator && phase === 'visible') {
            const x = (Number(lparam) & 0xffff) / scale - padding, y = ((Number(lparam) >>> 16) & 0xffff) / scale - padding;
            const index = actions.findIndex((_action, index) => x >= buttonLeft(index) && x <= buttonLeft(index) + buttonWidth() && y >= height - 38 && y <= height - 10);
            if (index >= 0) { const id = actions[index]!.id; setImmediate(() => { if (!closed) onAction(id); }); }
            return 0;
        }
        return api.user.func('intptr_t __stdcall DefWindowProcW(void *, uint32, uintptr_t, intptr_t)')(_window, message, _wparam, lparam);
    }, koffi.pointer(koffi.proto('intptr_t', ['void *', 'uint32', 'uintptr_t', 'intptr_t'])));
    const name = 'SylloomSurface' + process.pid + '_' + ++sequence, instance = api.instance(null);
    const registration = { size: koffi.sizeof(definition), style: 0, procedure, classExtra: 0, windowExtra: 0, instance,
        icon: null, cursor: api.user.func('void * __stdcall LoadCursorW(void *, void *)')(null, 32512n), background: null, menu: null, name, smallIcon: null };
    if (!api.user.func('RegisterClassExW', 'uint16', [koffi.pointer(definition)])(registration)) { koffi.unregister(procedure); throw new Error('Could not register the Sylloom popup.'); }
    resources.push(() => { api.user.func('int __stdcall UnregisterClassW(str16, void *)')(name, instance); koffi.unregister(procedure); });
    const window = api.createWindow(0x80000 | 0x08000000 | 0x80 | 8 | (indicator ? 0x20 : 0), name, 'Sylloom', 0x80000000,
        0, 0, outerWidth, outerHeight, null, null, instance, null) as Pointer;
    requireResource(window); resources.push(() => { api.destroyWindow(window); });
    const dc = requireResource(draw.getDC(null)); resources.push(() => { draw.releaseDC(null, dc); });
    const memory = requireResource(draw.compatible(dc)); resources.push(() => { draw.deleteDC(memory); });
    const info = Buffer.alloc(40); info.writeUInt32LE(40); info.writeInt32LE(outerWidth, 4); info.writeInt32LE(-outerHeight, 8); info.writeUInt16LE(1, 12); info.writeUInt16LE(32, 14);
    const data: unknown[] = [null], bitmap = requireResource(draw.bitmap(dc, info, 0, data, null, 0));
    resources.push(() => { draw.deleteObject(bitmap); });
    const old = draw.select(memory, bitmap); resources.push(() => { draw.select(memory, old); });
    const image: unknown[] = [null], graphics: unknown[] = [null], family: unknown[] = [null], format: unknown[] = [null];
    requireResource(data[0]);
    draw.image(outerWidth, outerHeight, outerWidth * 4, 0xe200b, data[0], image); requireResource(image[0]); resources.push(() => { draw.disposeImage(image[0]); });
    draw.graphics(image[0], graphics); requireResource(graphics[0]); resources.push(() => { draw.deleteGraphics(graphics[0]); });
    draw.smoothing(graphics[0], 4); draw.textQuality(graphics[0], 4);
    draw.family('Segoe UI', null, family); requireResource(family[0]); resources.push(() => { draw.deleteFamily(family[0]); });
    draw.format(0x1000, 0, format); requireResource(format[0]); resources.push(() => { draw.deleteFormat(format[0]); });
    draw.lineAlignment(format[0], 1); draw.trimming(format[0], 3);
    const fonts = [11, 12, 14].map((size, index) => {
        const font: unknown[] = [null]; draw.font(family[0], pixel(size), index === 2 ? 1 : 0, 2, font);
        requireResource(font[0]); resources.push(() => { draw.deleteFont(font[0]); }); return font[0];
    });
    const horizontal = () => Math.round(right ? screen.work.right - outerWidth - pixel(12) : (screen.work.left + screen.work.right - outerWidth) / 2);
    const position = { x: horizontal(), y: Math.round(screen.work.bottom - pixel(18 + height + padding)) };
    const size = koffi.struct({ width: 'int32', height: 'int32' });
    const blend = koffi.struct({ operation: 'uint8', flags: 'uint8', alpha: 'uint8', format: 'uint8' });
    const update = api.user.func('UpdateLayeredWindow', 'int', ['void *', 'void *', koffi.pointer(api.point), koffi.pointer(size), 'void *', koffi.pointer(api.point), 'uint32', koffi.pointer(blend), 'uint32']);
    const rounded = (x: number, y: number, w: number, h: number, radius: number, color: number) => {
        const path: unknown[] = [null], brush: unknown[] = [null], diameter = Math.min(radius * 2, w, h);
        draw.path(0, path); draw.brush(color >>> 0, brush);
        try {
            for (const [left, top, angle] of [[x, y, 180], [x + w - diameter, y, 270], [x + w - diameter, y + h - diameter, 0], [x, y + h - diameter, 90]]) draw.arc(path[0], pixel(left!), pixel(top!), pixel(diameter), pixel(diameter), angle, 90);
            draw.closePath(path[0]); draw.fill(graphics[0], brush[0], path[0]);
        } finally { draw.deleteBrush(brush[0]); draw.deletePath(path[0]); }
    };
    const text = (value: string, x: number, y: number, w: number, h: number, font: number, color: number, centered = false) => {
        const brush: unknown[] = [null]; draw.brush(color >>> 0, brush); draw.alignment(format[0], centered ? 1 : 0);
        try { draw.text(graphics[0], cleanText(value).replace(/\s+/gu, ' '), -1, fonts[font], { x: pixel(x), y: pixel(y), width: pixel(w), height: pixel(h) }, format[0], brush[0]); }
        finally { draw.deleteBrush(brush[0]); }
    };
    const paint = () => {
        if (closed || phase === 'hidden') return;
        const elapsed = performance.now() - since, duration = phase === 'showing' ? 190 : 140;
        const t = motion ? Math.min(1, elapsed / duration) : 1;
        let progress = phase === 'visible' ? 1 : phase === 'showing' ? 1 - Math.exp(-7 * t) * (Math.cos(9 * t) + .1 * Math.sin(9 * t)) : (1 - t) ** 1.8;
        if (t === 1 && phase === 'hiding') {
            phase = 'hidden'; clearInterval(timer); timer = undefined;
            api.user.func('int __stdcall ShowWindow(void *, int)')(window, 0); return;
        }
        if (t === 1 && phase === 'showing') { phase = 'visible'; progress = 1; }
        progress = Math.max(.02, Math.min(1.08, progress));
        const w = width * (.72 + .28 * Math.min(1.05, progress)), h = height * progress;
        const x = padding + (width - w) / 2, y = padding + height - h;
        draw.clear(graphics[0], 0);
        rounded(x, y, w, h, Math.min(indicator ? 19 : 20, h / 2), 0xee4b4b50);
        rounded(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2), Math.min(indicator ? 18 : 19, Math.max(1, h / 2 - 1)), 0xfa151518);
        if (phase === 'visible' || progress > .9) {
            if (indicator) {
                const heights = waveform.update(view.phase, view.level, performance.now(), motion);
                const ink = view.phase === 'recording' ? 0xff686be7 : view.phase === 'error' ? 0xffc57524 : view.phase === 'copied' ? 0xff46a873 : 0xffa4a4ac;
                heights.forEach((height, index) => rounded(padding + 17 + index * 7, padding + (38 - height) / 2, 3, Math.max(2, height), 1.5, ink));
            } else {
                // Same seven-bar geometry as assets/logo.svg, rendered as vectors.
                for (const [left, top, w, h] of [[18,78,7,10],[29,32,7,56],[40,55,7,33],[51,13,10,75],[65,55,7,33],[76,32,7,56],[87,78,7,10]]) rounded(padding + 16 + left! * .36, padding + 10 + top! * .36, w! * .36, h! * .36, .8, 0xffffffff);
                text(title, padding + 62, padding + 11, width - 80, 25, 2, 0xfff4f4f6);
                text(detail, padding + 62, padding + 36, width - 80, 20, 0, 0xffb3b4bd);
                actions.forEach((action, index) => {
                    rounded(padding + buttonLeft(index), padding + height - 38, buttonWidth(), 28, 8, 0xff2c2c31);
                    text(action.label, padding + buttonLeft(index) + 3, padding + height - 38, buttonWidth() - 6, 28, 1, 0xffeeeeef, true);
                });
            }
        }
        draw.plus.func('int __stdcall GdipFlush(void *, int)')(graphics[0], 1);
        update(window, dc, position, { width: outerWidth, height: outerHeight }, memory, { x: 0, y: 0 }, 0, { operation: 0, flags: 0, alpha: 255, format: 1 }, 2);
        api.user.func('int __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32)')(window, -1n, position.x, position.y, outerWidth, outerHeight, 0x10 | 0x40);
    };
    let unregister = () => {};
    const close = () => {
        if (closed) return; closed = true; clearInterval(timer); unregister();
        dispose();
    };
    unregister = onShutdown(close);
    const show = () => {
        if (closed) return;
        if (!timer) { timer = setInterval(() => { pumpWindow(window); paint(); }, 16); timer.unref(); }
        motion = supportsMotion();
        if (phase === 'hidden') {
            // A later call/dictation can start on a different monitor. Re-anchor
            // before its first frame rather than sliding across the desktop.
            api.user.func('GetCursorPos', 'int', [koffi.out(koffi.pointer(api.point))])(cursor);
            const monitor = api.user.func('MonitorFromPoint', 'void *', [api.point, 'uint32'])(cursor, 2);
            api.user.func('GetMonitorInfoW', 'int', ['void *', koffi.inout(koffi.pointer(monitorType))])(monitor, screen);
            position.x = horizontal();
            position.y = Math.round(screen.work.bottom - pixel(18 + height + padding));
        }
        if (phase === 'hidden' || phase === 'hiding') { phase = 'showing'; since = performance.now(); }
        paint();
    };
    return {
        show(titleValue: string, detailValue: string, options: Action[]) { title = titleValue; detail = detailValue; actions = options.slice(0, 3); show(); },
        render(value: IndicatorView) { view = value; show(); },
        hide() { if (!closed && phase !== 'hidden' && phase !== 'hiding') { phase = 'hiding'; since = performance.now(); waveform.reset(); paint(); } },
        close,
    };
}

export const createWindowsPopup = (action: (id: string) => void): Popup => createSurface(false, action);
export const createWindowsNotification = (action: (id: string) => void): Popup => createSurface(false, action, true);
export const createWindowsHud = (): HudSurface => createSurface(true, () => {});
