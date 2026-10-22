import koffi from 'koffi';
import { initializeAppKit } from './native/app-kit.js';
import { registerWindowsHotkeys } from './native/windows/hotkey.js';
import { DEFAULT_SHORTCUT, parseShortcut, shortcutEdges, polledShortcut } from './shortcut.js';
import type { ShortcutOptions } from './shortcut.js';
import { ALT_KEY } from './platform.js';

export const DICTATION_SHORTCUT = DEFAULT_SHORTCUT;
export const COPY_SHORTCUT = 'Ctrl+' + ALT_KEY + '+C';

// Carbon registers specific shortcuts without monitoring unrelated keystrokes.
// All calls stay on Node's main thread, as required by HIToolbox.
export function registerHotkeys(toggle: () => void, cancel: () => void, copy?: () => void, options: ShortcutOptions = {}): () => void {
    if (process.platform === 'win32') return registerWindowsHotkeys(toggle, cancel, copy, options);
    if (process.platform !== 'darwin') throw new Error("Global shortcuts currently require macOS.");
    const binding = parseShortcut(options.shortcut || DEFAULT_SHORTCUT);
    const edge = shortcutEdges(toggle, () => { if (options.mode === 'hold') options.release?.(); });
    initializeAppKit();
    const carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
    const type = koffi.struct({ eventClass: 'uint32', eventKind: 'uint32' });
    const idType = koffi.struct({ signature: 'uint32', id: 'uint32' });
    const target = carbon.func('void *GetApplicationEventTarget()')();
    const register = carbon.func('RegisterEventHotKey', 'int32', ['uint32', 'uint32', idType, 'void *', 'uint32', koffi.out(koffi.pointer('void *'))]);
    const unregister = carbon.func('int32 UnregisterEventHotKey(void *)');
    const receive = carbon.func('ReceiveNextEvent', 'int32', ['uint32', koffi.pointer(type), 'double', 'uint8', koffi.out(koffi.pointer('void *'))]);
    const parameter = carbon.func('GetEventParameter', 'int32', ['void *', 'uint32', 'uint32', 'void *', 'uint32', 'void *', koffi.out(koffi.pointer(idType))]);
    const kind = carbon.func('uint32 GetEventKind(void *)');
    const release = carbon.func('void ReleaseEvent(void *)');
    const dispatch = carbon.func('int32 SendEventToEventTarget(void *, void *)');
    const handlerType = koffi.proto('int32', ['void *', 'void *', 'void *']);
    const callback = koffi.register((_next: unknown, event: unknown) => {
        const id = { signature: 0, id: 0 };
        if (parameter(event, 0x2d2d2d2d, 0x686b6964, null, 8, null, id) === 0 && id.signature === 0x6d656574) {
            if (id.id === 1) edge(kind(event) === 5); else if (kind(event) === 5) { if (id.id === 2) cancel(); else if (id.id === 3) copy?.(); }
            return 0;
        }
        return -9874;
    }, koffi.pointer(handlerType));
    const handler: unknown[] = [null];
    const install = carbon.func('InstallEventHandler', 'int32', ['void *', koffi.pointer(handlerType), 'uint32', koffi.pointer(type), 'void *', koffi.out(koffi.pointer('void *'))]);
    const remove = carbon.func('int32 RemoveEventHandler(void *)');
    const keyState = binding.polled ? koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics').func('bool CGEventSourceKeyState(int, uint16)') : undefined;
    const poll = keyState ? polledShortcut(toggle, () => { if (options.mode === 'hold') options.release?.(); }, keyState(1, binding.code)) : undefined;
    const refs: unknown[] = [];
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const close = () => { if (closed) return; closed = true; clearInterval(timer); for (const ref of refs) unregister(ref); if (handler[0]) remove(handler[0]); koffi.unregister(callback); };
    try {
        if (install(target, callback, 2, [{ eventClass: 0x6b657962, eventKind: 5 }, { eventClass: 0x6b657962, eventKind: 6 }], null, handler) !== 0) throw new Error("Could not install the macOS hotkey handler.");
        for (const [code, id, modifiers] of [...(binding.polled ? [] : [[binding.code, 1, binding.modifiers]]), ...(options.auxiliary === false ? [] : [[53, 2, 4096 | 2048]]), ...(copy && options.auxiliary !== false ? [[8, 3, 4096 | 2048]] : [])]) {
            const ref: unknown[] = [null];
            const status = register(code, modifiers, { signature: 0x6d656574, id }, target, 1, ref);
            if (status !== 0) throw new Error("Global shortcut " + (id === 1 ? binding.label : id === 2 ? "Cancel" : "Copy latest") + " is in use or unavailable (macOS " + status + ').');
            refs.push(ref[0]);
        }
        timer = setInterval(() => {
            if (poll && keyState) poll(keyState(1, binding.code));
            // Pull only registered hotkey presses/releases; no unrelated keys.
            for (let count = 0; count < 8; count++) {
                const event: unknown[] = [null];
                if (receive(2, [{ eventClass: 0x6b657962, eventKind: 5 }, { eventClass: 0x6b657962, eventKind: 6 }], 0.001, 1, event) !== 0) break;
                try {
                    dispatch(event[0], target);
                } finally { release(event[0]); }
            }
        }, 12);
        timer.unref();
        return close;
    } catch (error) { close(); throw error; }
}
