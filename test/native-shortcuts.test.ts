import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { registerHotkeys } from '../src/hotkey.js';

// Own Carbon event target only. No keystrokes sent to other apps, no capture.
test('native shortcut registration handles press/release, repeat and single modifier cleanup', {
    skip: process.platform !== 'darwin' || process.env.SYLLOOM_TEST_SHORTCUTS !== '1',
}, async () => {
    const carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
    const target = carbon.func('void *GetApplicationEventTarget()');
    const create = carbon.func('CreateEvent', 'int32', ['void *', 'uint32', 'uint32', 'double', 'uint32', koffi.out(koffi.pointer('void *'))]);
    const id = koffi.struct({ signature: 'uint32', id: 'uint32' });
    const set = carbon.func('SetEventParameter', 'int32', ['void *', 'uint32', 'uint32', 'uint32', koffi.pointer(id)]);
    const send = carbon.func('int32 SendEventToEventTarget(void *, void *)');
    const release = carbon.func('void ReleaseEvent(void *)');
    let down = 0, up = 0;
    const stop = registerHotkeys(() => down++, () => {}, undefined, { shortcut: 'F19', mode: 'hold', auxiliary: false, release: () => up++ });
    try {
        for (const kind of [6, 5, 5, 6, 6]) {
            const event: unknown[] = [null]; assert.equal(create(null, 0x6b657962, kind, 0, 0, event), 0);
            try { assert.equal(set(event[0], 0x2d2d2d2d, 0x686b6964, 8, { signature: 0x6d656574, id: 1 }), 0); assert.equal(send(event[0], target()), 0); }
            finally { release(event[0]); }
        }
        assert.equal(down, 1); assert.equal(up, 1);
    } finally { stop(); stop(); }
    for (const shortcut of ['Fn', 'Right Option', 'F8']) {
        const close = registerHotkeys(() => {}, () => {}, undefined, { shortcut, mode: 'hold', auxiliary: false, release: () => {} }); close();
    }
});
