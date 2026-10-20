import koffi from 'koffi';
import { onShutdown } from '../../lifecycle.js';

export type ComPointer = bigint;
const prototypes = new Map<string, ReturnType<typeof koffi.proto>>();
// Vtable slots follow Microsoft's UIAutomationClient.h, not implementation
// addresses. COM is initialized separately on each Node worker/main thread.
export function com(pointer: ComPointer, index: number, parameters: string[] = [], ...args: unknown[]): number {
    const signature = parameters.join(';');
    let prototype = prototypes.get(signature);
    if (!prototype) { prototype = koffi.proto('int32', ['void *', ...parameters]); prototypes.set(signature, prototype); }
    const table = koffi.decode(pointer, 'void *');
    const method = koffi.decode(table, index * koffi.sizeof('void *'), 'void *');
    return koffi.call(method, prototype, pointer, ...args);
}
export function release(pointer: ComPointer | null | undefined): void { if (pointer) com(pointer, 2); }
export function outPointer(pointer: ComPointer, index: number, parameters: string[] = [], ...args: unknown[]): ComPointer | undefined {
    const result: unknown[] = [null];
    if (com(pointer, index, [...parameters, '_Out_ void **'], ...args, result) < 0) return undefined;
    return result[0] ? result[0] as ComPointer : undefined;
}

export class WindowsAutomation {
    private ole = koffi.load('ole32.dll');
    private strings = koffi.load('oleaut32.dll');
    readonly client: ComPointer;
    readonly walker: ComPointer;
    private closed = false;
    private initialized = false;
    private guid(value: string): Buffer {
        const buffer = Buffer.alloc(16);
        if (this.ole.func('int32 __stdcall CLSIDFromString(str16, void *)')(value, buffer) < 0) throw new Error('Invalid native interface identifier.');
        return buffer;
    }
    constructor() {
        const initialized = this.ole.func('int32 __stdcall CoInitializeEx(void *, uint32)')(null, 0);
        if (initialized < 0 && initialized !== -2147417850) throw new Error('Windows UI Automation could not initialize.');
        this.initialized = initialized >= 0;
        const result: unknown[] = [null];
        if (this.ole.func('int32 __stdcall CoCreateInstance(void *, void *, uint32, void *, _Out_ void **)')(
            this.guid('{e22ad333-b25f-460c-83d0-0581107395c9}'), null, 1, this.guid('{34723aff-0c9d-49d0-9896-7ab52df8cd8a}'), result) < 0 || !result[0]) {
            this.uninitialize(); throw new Error('Windows UI Automation is unavailable.');
        }
        this.client = result[0] as ComPointer;
        // CUIAutomation8 explicitly supports bounded calls to hung providers.
        com(this.client, 61, ['uint32'], 300); com(this.client, 63, ['uint32'], 300);
        const walker = outPointer(this.client, 14);
        if (!walker) { release(this.client); this.uninitialize(); throw new Error('Windows control tree is unavailable.'); }
        this.walker = walker;
    }
    integer(pointer: ComPointer, slot: number): number | undefined {
        const result = [0]; return com(pointer, slot, ['_Out_ int32 *'], result) >= 0 ? result[0] : undefined;
    }
    string(pointer: ComPointer, slot: number, maximum = 100_000, parameters: string[] = [], ...args: unknown[]): string | undefined {
        const result = outPointer(pointer, slot, parameters, ...args);
        if (!result) return undefined;
        try {
            const length = this.strings.func('uint32 __stdcall SysStringLen(void *)')(result);
            if (length > maximum) return undefined;
            return length ? Buffer.from(koffi.view(result, length * 2)).toString('utf16le') : '';
        } finally { this.strings.func('void __stdcall SysFreeString(void *)')(result); }
    }
    focused(): ComPointer | undefined { return outPointer(this.client, 8); }
    root(): ComPointer | undefined { return outPointer(this.client, 5); }
    child(element: ComPointer): ComPointer | undefined { return outPointer(this.walker, 4, ['void *'], element); }
    sibling(element: ComPointer): ComPointer | undefined { return outPointer(this.walker, 6, ['void *'], element); }
    pattern(element: ComPointer, id: number): ComPointer | undefined {
        const iid = id === 10014 ? '{32eba289-3583-42c9-9c59-3b6d9a1e9b6a}' : id === 10002 ? '{a94cd8b1-0844-4cd6-9d2d-640537ab39e9}' : undefined;
        return iid ? outPointer(element, 14, ['int32', 'void *'], id, this.guid(iid)) : undefined;
    }
    equal(first: ComPointer, second: ComPointer): boolean {
        const result = [0]; return com(this.client, 3, ['void *', 'void *', '_Out_ int32 *'], first, second, result) >= 0 && Boolean(result[0]);
    }
    selection(pattern: ComPointer): ComPointer | undefined {
        const ranges = outPointer(pattern, 5); if (!ranges) return undefined;
        try { return this.integer(ranges, 3) === 1 ? outPointer(ranges, 4, ['int32'], 0) : undefined; } finally { release(ranges); }
    }
    rangeText(range: ComPointer): string | undefined { return this.string(range, 12, 100_000, ['int32'], 100_001); }
    documentText(pattern: ComPointer): string | undefined {
        const range = outPointer(pattern, 7); if (!range) return undefined;
        try { return this.rangeText(range); } finally { release(range); }
    }
    sameRange(first: ComPointer, second: ComPointer): boolean {
        for (const endpoint of [0, 1]) {
            const result = [0];
            if (com(first, 5, ['int32', 'void *', 'int32', '_Out_ int32 *'], endpoint, second, endpoint, result) < 0 || result[0] !== 0) return false;
        }
        return true;
    }
    rangeWritable(range: ComPointer): boolean {
        const variant = Buffer.alloc(24);
        if (com(range, 9, ['int32', 'void *'], 40015, variant) < 0) return false;
        try { return variant.readUInt16LE(0) === 11 && variant.readInt16LE(8) === 0; }
        finally { this.strings.func('int32 __stdcall VariantClear(void *)')(variant); }
    }
    private uninitialize(): void { if (this.initialized) { this.initialized = false; this.ole.func('void __stdcall CoUninitialize()')(); } }
    close(): void { if (!this.closed) { this.closed = true; release(this.walker); release(this.client); this.uninitialize(); } }
}
let loaded: WindowsAutomation | undefined;
export const automation = () => { if (!loaded) { loaded = new WindowsAutomation(); onShutdown(() => { loaded?.close(); loaded = undefined; }); } return loaded; };
