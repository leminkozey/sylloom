import assert from 'node:assert/strict';
import koffi from 'koffi';

export function preserveClipboard(): () => void {
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cls = objc.func('void *objc_getClass(str)');
    const sel = objc.func('void *sel_registerName(str)');
    const get = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const arg = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
    const index = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong']);
    const count = objc.func('objc_msgSend', 'ulong', ['void *', 'void *']);
    const utf8 = objc.func('objc_msgSend', 'str', ['void *', 'void *']);
    const string = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
    const data = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *', 'ulong']);
    const set = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *', 'void *']);
    const write = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *']);
    const pool = get(cls('NSAutoreleasePool'), sel('new'));
    const board = get(cls('NSPasteboard'), sel('generalPasteboard'));
    const original = get(board, sel('pasteboardItems'));
    const snapshot: { type: string; bytes: Buffer }[][] = [];
    for (let i = 0; i < Number(count(original, sel('count'))); i++) {
        const item = index(original, sel('objectAtIndex:'), i);
        const types = get(item, sel('types'));
        const values: { type: string; bytes: Buffer }[] = [];
        for (let j = 0; j < Number(count(types, sel('count'))); j++) {
            const type = index(types, sel('objectAtIndex:'), j);
            const value = arg(item, sel('dataForType:'), type);
            if (!value) throw new Error('Zwischenablage kann nicht vollständig gesichert werden. Prüfung abgebrochen.');
            values.push({ type: utf8(type, sel('UTF8String')), bytes: Buffer.from(koffi.decode(get(value, sel('bytes')), 'uint8', Number(count(value, sel('length'))))) });
        }
        snapshot.push(values);
    }
    return () => {
        const items = get(cls('NSMutableArray'), sel('new'));
        try {
            for (const values of snapshot) {
                const item = get(cls('NSPasteboardItem'), sel('new'));
                for (const value of values) {
                    const type = string(cls('NSString'), sel('stringWithUTF8String:'), value.type);
                    const bytes = data(cls('NSData'), sel('dataWithBytes:length:'), value.bytes, value.bytes.length);
                    assert.equal(set(item, sel('setData:forType:'), bytes, type), true);
                }
                arg(items, sel('addObject:'), item); get(item, sel('release'));
            }
            count(board, sel('clearContents'));
            if (snapshot.length) assert.equal(write(board, sel('writeObjects:'), items), true);
        } finally { get(items, sel('release')); get(pool, sel('drain')); }
    };
}
