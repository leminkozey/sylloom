import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import { attachIndicator } from '../src/indicator.js';
import { nativeBubbleNotices } from '../src/native/hud.js';
import { initializeAppKit } from '../src/native/app-kit.js';

// Own native windows only, no microphone, app observation or desktop capture.
test('native bubbles are translucent, use the cursor screen and hide after a failed start', {
    skip: process.platform !== 'darwin' || process.env.SYLLOOM_TEST_BUBBLES !== '1', timeout: 10000,
}, async context => {
    initializeAppKit();
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cls = objc.func('void *objc_getClass(str)'), sel = objc.func('void *sel_registerName(str)');
    const point = koffi.struct({ x: 'double', y: 'double' });
    const rect = koffi.struct({ origin: point, size: koffi.struct({ width: 'double', height: 'double' }) });
    const get = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const send = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
    const flag = objc.func('objc_msgSend', 'bool', ['void *', 'void *']);
    const count = objc.func('objc_msgSend', 'ulong', ['void *', 'void *']);
    const at = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong']);
    const utf8 = objc.func('objc_msgSend', 'str', ['void *', 'void *']);
    const frame = objc.func(process.arch === 'x64' ? 'objc_msgSend_stret' : 'objc_msgSend', rect, ['void *', 'void *']);
    const mouse = objc.func('objc_msgSend', point, ['void *', 'void *']);
    const values = (array: unknown) => Array.from({ length: Number(count(array, sel('count'))) }, (_, index) => at(array, sel('objectAtIndex:'), index));
    const app = get(cls('NSApplication'), sel('sharedApplication')), pool = get(cls('NSAutoreleasePool'), sel('new'));
    const window = (title: string) => values(get(app, sel('windows'))).find(item => utf8(get(item, sel('title')), sel('UTF8String')) === title);
    // Simulate the pointer's reported position, never move the user's mouse.
    let reportedCursor = mouse(cls('NSEvent'), sel('mouseLocation'));
    const load = koffi.load;
    context.mock.method(koffi, 'load', (...parameters: Parameters<typeof koffi.load>) => {
        const library = load(...parameters);
        if (parameters[0] !== '/usr/lib/libobjc.A.dylib') return library;
        return { ...library, func: ((...args: unknown[]) => {
            if (args[0] === 'objc_msgSend' && args[1] && typeof args[1] === 'object' && koffi.sizeof(args[1] as never) === 16) return () => ({ ...reportedCursor });
            return Reflect.apply(library.func, library, args);
        }) as typeof library.func };
    });
    const source = Object.assign(new EventEmitter(), { state: 'starting', message: 'No audio device available for mic.' });
    const close = attachIndicator(source, assert.fail);
    try {
        source.emit('update'); await delay(500);
        const hud = window('Sylloom · Dictation'); assert.ok(hud);
        assert.equal(flag(hud, sel('isVisible')), true);
        assert.equal(flag(hud, sel('isKeyWindow')), false);
        assert.equal(flag(hud, sel('ignoresMouseEvents')), true);
        const cursor = { ...reportedCursor };
        const screens = values(get(cls('NSScreen'), sel('screens')));
        const target = screens.find(item => { const b = frame(item, sel('frame')); return cursor.x >= b.origin.x && cursor.x < b.origin.x + b.size.width && cursor.y >= b.origin.y && cursor.y < b.origin.y + b.size.height; });
        assert.ok(target);
        const work = frame(target, sel('visibleFrame')), hudFrame = frame(hud, sel('frame'));
        assert.ok(Math.abs(hudFrame.origin.x + hudFrame.size.width / 2 - work.origin.x - work.size.width / 2) <= 1);
        assert.ok(Math.abs(hudFrame.origin.y - work.origin.y + 126) <= 1);
        const other = screens.find(item => item !== target);
        if (other) {
            source.state = 'recording'; source.emit('update');
            const area = frame(other, sel('frame')), otherWork = frame(other, sel('visibleFrame'));
            reportedCursor = { x: area.origin.x + area.size.width / 2, y: area.origin.y + area.size.height / 2 };
            await delay(100); // No phase change or service event triggers the move.
            const moved = frame(hud, sel('frame'));
            assert.ok(Math.abs(moved.origin.x + moved.size.width / 2 - otherWork.origin.x - otherWork.size.width / 2) <= 1);
            assert.ok(Math.abs(moved.origin.y - otherWork.origin.y + 126) <= 1);
            assert.equal(flag(hud, sel('isKeyWindow')), false);
            assert.equal(flag(hud, sel('ignoresMouseEvents')), true);
            reportedCursor = cursor; await delay(100);
            const returned = frame(hud, sel('frame'));
            assert.ok(Math.abs(returned.origin.x - hudFrame.origin.x) <= 1);
            context.diagnostic('Native panel followed a simulated pointer across two real screens and back during recording.');
        } else context.diagnostic('Single display: cross-monitor native assertion unavailable.');
        const root = get(hud, sel('contentView')), card = values(get(root, sel('subviews')))[0]!;
        const blob = values(get(get(card, sel('layer')), sel('sublayers')))[0]!;
        const alpha = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics').func('double CGColorGetAlpha(void *)')(get(blob, sel('fillColor')));
        const reduced = flag(get(cls('NSWorkspace'), sel('sharedWorkspace')), sel('accessibilityDisplayShouldReduceTransparency'));
        assert.ok(alpha > .5 && alpha < (reduced ? 1 : .9));
        if (process.env.SYLLOOM_BUBBLE_SNAPSHOT) {
            const image = objc.func('objc_msgSend', 'void *', ['void *', 'void *', rect])(root, sel('bitmapImageRepForCachingDisplayInRect:'), frame(root, sel('bounds')));
            objc.func('objc_msgSend', 'void', ['void *', 'void *', rect, 'void *'])(root, sel('cacheDisplayInRect:toBitmapImageRep:'), frame(root, sel('bounds')), image);
            const png = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong', 'void *'])(image, sel('representationUsingType:properties:'), 4, get(cls('NSDictionary'), sel('dictionary')));
            const file = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str'])(cls('NSString'), sel('stringWithUTF8String:'), process.env.SYLLOOM_BUBBLE_SNAPSHOT);
            assert.ok(objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *', 'bool'])(png, sel('writeToFile:atomically:'), file, true));
        }
        source.state = 'error'; source.emit('update');
        for (let i = 0; i < 8; i++) { await delay(300); source.emit('update'); }
        assert.equal(flag(hud, sel('isVisible')), false, 'No extra shortcut or event pump may be needed to hide');
        source.state = 'starting'; source.emit('update'); await delay(100);
        source.state = 'idle'; source.emit('update'); await delay(400);
        assert.equal(flag(hud, sel('isVisible')), false, 'Interrupted entry must finish its exit');
        source.state = 'recording'; source.emit('update'); await delay(500);
        const before = values(get(app, sel('windows'))).filter(item => flag(item, sel('isVisible'))).length;
        const notices = nativeBubbleNotices(); notices.show({ title: 'Copied to clipboard', detail: 'Press Cmd+V to paste your text.' });
        await delay(700);
        assert.equal(values(get(app, sel('windows'))).filter(item => flag(item, sel('isVisible'))).length, before, 'A notice must reuse the capture panel, never create a second notification window');
        const bounds = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics').func('CGPathGetBoundingBox', rect, ['void *']);
        const expanded = bounds(get(blob, sel('path')));
        assert.ok(expanded.size.width >= 299 && expanded.size.height >= 83, 'The actual outline must expand, not just its text');
        assert.equal(flag(hud, sel('isKeyWindow')), false); assert.equal(flag(hud, sel('ignoresMouseEvents')), true);
        notices.hide(); await delay(500);
        const compact = bounds(get(blob, sel('path')));
        assert.ok(compact.size.width <= 123 && compact.size.height <= 39, 'The same panel must return to the current recording');


    } finally { close(); send(pool, sel('drain')); }
});
