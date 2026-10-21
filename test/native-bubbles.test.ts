import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import { attachIndicator } from '../src/indicator.js';
import { createCallPopup } from '../src/native/call-popup.js';
import { initializeAppKit } from '../src/native/app-kit.js';

// Own native windows only, no microphone, app observation or desktop capture.
test('native bubbles are translucent, use the cursor screen and hide after a failed start', {
    skip: process.platform !== 'darwin' || process.env.SYLLOOM_TEST_BUBBLES !== '1', timeout: 10000,
}, async () => {
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
    const source = Object.assign(new EventEmitter(), { state: 'starting' });
    const close = attachIndicator(source, assert.fail);
    let popup: ReturnType<typeof createCallPopup> | undefined;
    try {
        source.emit('update'); await delay(500);
        const hud = window('Sylloom · Dictation'); assert.ok(hud);
        assert.equal(flag(hud, sel('isVisible')), true);
        assert.equal(flag(hud, sel('isKeyWindow')), false);
        assert.equal(flag(hud, sel('ignoresMouseEvents')), true);
        const cursor = mouse(cls('NSEvent'), sel('mouseLocation'));
        const screens = values(get(cls('NSScreen'), sel('screens')));
        const target = screens.find(item => { const b = frame(item, sel('frame')); return cursor.x >= b.origin.x && cursor.x < b.origin.x + b.size.width && cursor.y >= b.origin.y && cursor.y < b.origin.y + b.size.height; });
        assert.ok(target);
        const work = frame(target, sel('visibleFrame')), hudFrame = frame(hud, sel('frame'));
        assert.ok(Math.abs(hudFrame.origin.x + hudFrame.size.width / 2 - work.origin.x - work.size.width / 2) <= 1);
        assert.ok(Math.abs(hudFrame.origin.y - work.origin.y + 30) <= 1);
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
        for (let i = 0; i < 6; i++) { await delay(300); source.emit('update'); }
        assert.equal(flag(hud, sel('isVisible')), false, 'No extra shortcut or event pump may be needed to hide');
        source.state = 'starting'; source.emit('update'); await delay(100);
        source.state = 'idle'; source.emit('update'); await delay(400);
        assert.equal(flag(hud, sel('isVisible')), false, 'Interrupted entry must finish its exit');
        popup = createCallPopup(() => {}, 'notification');
        popup.show('Sylloom', 'Transparent notification preview', [{ id: 'close', label: 'Close' }]); await delay(500);
        const hint = window('Sylloom · Call'); assert.ok(hint); assert.equal(flag(hint, sel('isKeyWindow')), false);
        const b = frame(hint, sel('frame'));
        assert.ok(Math.abs(b.origin.x + b.size.width - 48 - work.origin.x - work.size.width + 18) <= 1);
        popup.hide(); await delay(400); assert.equal(flag(hint, sel('isVisible')), false);
    } finally { close(); popup?.close(); send(pool, sel('drain')); }
});
