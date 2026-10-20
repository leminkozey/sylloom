import koffi from 'koffi';

export type Pointer = bigint | null;
let loaded: ReturnType<typeof load> | undefined;
export const windows = () => loaded ||= load();

function load() {
    if (process.platform !== 'win32') throw new Error('Windows native APIs are unavailable on this platform.');
    const user = koffi.load('user32.dll'), kernel = koffi.load('kernel32.dll');
    // This Node process owns only Sylloom's windows. Establish physical pixel
    // coordinates before creating any clipboard owner or layered surface.
    user.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t)')(-4);
    const point = koffi.struct({ x: 'int32', y: 'int32' });
    const rect = koffi.struct({ left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const message = koffi.struct({ hwnd: 'void *', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: point, private: 'uint32' });
    return { user, kernel, point, rect, message,
        error: kernel.func('uint32 __stdcall GetLastError()'),
        foreground: user.func('void * __stdcall GetForegroundWindow()'),
        keyState: user.func('int16 __stdcall GetAsyncKeyState(int)'),
        peek: user.func('PeekMessageW', 'int', [koffi.out(koffi.pointer(message)), 'void *', 'uint32', 'uint32', 'uint32']),
        dispatch: user.func('intptr_t __stdcall DispatchMessageW(void *)'),
        translate: user.func('int __stdcall TranslateMessage(void *)'),
        createWindow: user.func('void * __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, void *, void *, void *, void *)'),
        destroyWindow: user.func('int __stdcall DestroyWindow(void *)'),
        instance: kernel.func('void * __stdcall GetModuleHandleW(str16)'),
    };
}

export function pumpWindow(window: Pointer): void {
    const api = windows(), event = {};
    for (let count = 0; count < 32 && api.peek(event, window, 0, 0, 1); count++) {
        const buffer = Buffer.alloc(koffi.sizeof(api.message)); koffi.encode(buffer, api.message, event);
        api.translate(buffer); api.dispatch(buffer);
    }
}
