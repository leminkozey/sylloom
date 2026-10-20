import koffi from 'koffi';
import { windows } from './api.js';
import type { Pointer } from './api.js';
import { onShutdown } from '../../lifecycle.js';

let loaded: ReturnType<typeof load> | undefined;
function load() {
    const api = windows(), ole = koffi.load('ole32.dll'), gdi = koffi.load('gdi32.dll');
    // A real, hidden owner is required by SetClipboardData after EmptyClipboard.
    const owner = api.createWindow(0x80, 'STATIC', 'Sylloom clipboard', 0, 0, 0, 0, 0, null, null, api.instance(null), null) as Pointer;
    if (!owner) throw new Error('Could not create the clipboard owner.');
    onShutdown(() => { api.destroyWindow(owner); });
    return { owner,
        open: api.user.func('int __stdcall OpenClipboard(void *)'), close: api.user.func('int __stdcall CloseClipboard()'),
        empty: api.user.func('int __stdcall EmptyClipboard()'), get: api.user.func('void * __stdcall GetClipboardData(uint32)'),
        set: api.user.func('void * __stdcall SetClipboardData(uint32, void *)'), formats: api.user.func('uint32 __stdcall EnumClipboardFormats(uint32)'),
        sequence: api.user.func('uint32 __stdcall GetClipboardSequenceNumber()'),
        clipboardOwner: api.user.func('void * __stdcall GetClipboardOwner()'),
        alloc: api.kernel.func('void * __stdcall GlobalAlloc(uint32, size_t)'), lock: api.kernel.func('void * __stdcall GlobalLock(void *)'),
        unlock: api.kernel.func('int __stdcall GlobalUnlock(void *)'), free: api.kernel.func('void * __stdcall GlobalFree(void *)'),
        duplicate: ole.func('void * __stdcall OleDuplicateData(void *, uint16, uint32)'),
        deleteObject: gdi.func('int __stdcall DeleteObject(void *)'), deleteEnh: gdi.func('int __stdcall DeleteEnhMetaFile(void *)'),
        deleteMeta: gdi.func('int __stdcall DeleteMetaFile(void *)'),
    };
}
const native = () => loaded ||= load();
function within<T>(work: (api: ReturnType<typeof load>) => T): T {
    const api = native();
    if (!api.open(api.owner)) throw new Error('The clipboard is busy. Try again.');
    try { return work(api); } finally { api.close(); }
}
function put(text: string, api: ReturnType<typeof load>): void {
    const content = Buffer.from(text + '\0', 'utf16le'), memory = api.alloc(2, content.length);
    if (!memory) throw new Error('Could not allocate clipboard memory.');
    let transferred = false;
    try {
        const pointer = api.lock(memory); if (!pointer) throw new Error('Could not access clipboard memory.');
        try { Buffer.from(koffi.view(pointer, content.length)).set(content); } finally { api.unlock(memory); }
        if (!api.empty() || !api.set(13, memory)) throw new Error('Could not copy text.');
        transferred = true;
    } finally { if (!transferred) api.free(memory); }
}
export function copyWindowsText(text: string): void { within(api => put(text, api)); }

type Entry = { format: number; handle: Pointer };
function freeEntry(entry: Entry): void {
    const api = native(); if (!entry.handle) return;
    if ([2, 9, 0x82].includes(entry.format)) api.deleteObject(entry.handle);
    else if ([14, 0x8e].includes(entry.format)) api.deleteEnh(entry.handle);
    else if ([3, 0x83].includes(entry.format)) {
        const pointer = api.lock(entry.handle);
        if (pointer) try { api.deleteMeta(koffi.decode(pointer, process.arch === 'x64' || process.arch === 'arm64' ? 16 : 12, 'void *')); } finally { api.unlock(entry.handle); }
        api.free(entry.handle);
    } else api.free(entry.handle);
    entry.handle = null;
}

// Duplicate the actual formats, including HTML, files and images. Never restore
// over a new clipboard item copied by the user or another application.
export function temporaryWindowsClipboard(text: string) {
    const previous: Entry[] = []; let sequence = 0, disposed = false;
    try {
        within(api => {
            for (let format = api.formats(0); format; format = api.formats(format)) {
                if (previous.length >= 128) throw new Error('Too many clipboard formats to preserve safely.');
                const source = api.get(format), handle = source && api.duplicate(source, format, 2) as Pointer;
                if (!handle) throw new Error('A clipboard format could not be preserved.');
                previous.push({ format, handle });
            }
            put(text, api);
        });
        // Closing publishes the completed set of formats. Capture the revision
        // afterwards; a revision read while still writing can already be stale
        // by the first paste/restore check on Windows.
        sequence = native().sequence();
    } catch (error) { previous.forEach(freeEntry); throw error; }
    return {
        isCurrent: () => {
            if (disposed || native().sequence() !== sequence) return false;
            return within(api => api.sequence() === sequence && api.clipboardOwner() === api.owner);
        },
        restore() {
            if (disposed || native().sequence() !== sequence) return;
            within(api => {
                if (api.sequence() !== sequence || api.clipboardOwner() !== api.owner) return;
                if (!api.empty()) throw new Error('Could not restore the previous clipboard.');
                for (const entry of previous) {
                    if (!api.set(entry.format, entry.handle)) throw new Error('Could not restore a clipboard format.');
                    entry.handle = null;
                }
            });
        },
        dispose() { if (!disposed) { disposed = true; previous.forEach(freeEntry); } },
    };
}
