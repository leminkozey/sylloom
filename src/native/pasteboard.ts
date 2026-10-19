import koffi from 'koffi';

function api() {
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cls = objc.func('void *objc_getClass(str)'); const sel = objc.func('void *sel_registerName(str)');
    const get = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const arg = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
    const index = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong']);
    const count = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
    const utf8 = objc.func('objc_msgSend', 'str', ['void *', 'void *']);
    const string = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
    const data = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *', 'ulong']);
    const set = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *', 'void *']);
    const write = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *']);
    const text = (value: string) => string(cls('NSString'), sel('stringWithUTF8String:'), value);
    const scope = <T>(work: (board: unknown) => T): T => {
        const pool = get(cls('NSAutoreleasePool'), sel('new'));
        try { return work(get(cls('NSPasteboard'), sel('generalPasteboard'))); }
        finally { get(pool, sel('drain')); }
    };
    return { cls, sel, get, arg, index, count, utf8, data, set, write, text, scope };
}
let loaded: ReturnType<typeof api> | undefined;

export function temporaryClipboard(value: string): { isCurrent(): boolean; restore(): void; dispose(): void } {
    const a = loaded ||= api();
    const snapshot: { type: string; bytes: Buffer }[][] = [];
    let size = 0; let staged = -1;
    a.scope(board => {
        const version = a.count(board, a.sel('changeCount'));
        const original = a.get(board, a.sel('pasteboardItems'));
        for (let i = 0; i < Number(a.count(original, a.sel('count'))); i++) {
            const item = a.index(original, a.sel('objectAtIndex:'), i); const types = a.get(item, a.sel('types'));
            const values: { type: string; bytes: Buffer }[] = [];
            for (let j = 0; j < Number(a.count(types, a.sel('count'))); j++) {
                const type = a.index(types, a.sel('objectAtIndex:'), j); const data = a.arg(item, a.sel('dataForType:'), type);
                if (!data) throw new Error('The clipboard could not be preserved.');
                const length = Number(a.count(data, a.sel('length'))); size += length;
                if (size > 32 * 1024 * 1024) throw new Error('The clipboard is too large to preserve for automatic insertion.');
                values.push({ type: a.utf8(type, a.sel('UTF8String')), bytes: length ? Buffer.from(koffi.decode(a.get(data, a.sel('bytes')), 'uint8', length)) : Buffer.alloc(0) });
            }
            snapshot.push(values);
        }
        if (a.count(board, a.sel('changeCount')) !== version) throw new Error('The clipboard changed during insertion preparation.');
        a.count(board, a.sel('clearContents'));
        if (!a.set(board, a.sel('setString:forType:'), a.text(value), a.text('public.utf8-plain-text'))) throw new Error('Could not prepare text for pasting.');
        staged = a.count(board, a.sel('changeCount'));
    });
    let disposed = false;
    return {
        isCurrent: () => !disposed && a.scope(board => a.count(board, a.sel('changeCount')) === staged),
        restore(): void {
            if (disposed) return;
            a.scope(board => {
                if (a.count(board, a.sel('changeCount')) !== staged) return;
                const items = a.get(a.cls('NSMutableArray'), a.sel('new'));
                try {
                    for (const values of snapshot) {
                        const item = a.get(a.cls('NSPasteboardItem'), a.sel('new'));
                        try {
                            for (const value of values) {
                                const data = a.data(a.cls('NSData'), a.sel('dataWithBytes:length:'), value.bytes, value.bytes.length);
                                if (!a.set(item, a.sel('setData:forType:'), data, a.text(value.type))) throw new Error('Could not restore a clipboard item.');
                            }
                            a.arg(items, a.sel('addObject:'), item);
                        } finally { a.get(item, a.sel('release')); }
                    }
                    a.count(board, a.sel('clearContents'));
                    if (snapshot.length && !a.write(board, a.sel('writeObjects:'), items)) throw new Error('Could not restore the clipboard.');
                } finally { a.get(items, a.sel('release')); }
            });
        },
        dispose(): void { if (!disposed) { disposed = true; for (const item of snapshot) for (const value of item) value.bytes.fill(0); snapshot.length = 0; } },
    };
}
