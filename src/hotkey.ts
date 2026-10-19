import koffi from 'koffi';

export const DICTATION_SHORTCUT = 'Ctrl+Option+Space';
export const COPY_SHORTCUT = 'Ctrl+Option+C';

// Carbon registers specific shortcuts without monitoring unrelated keystrokes.
// All calls stay on Node's main thread, as required by HIToolbox.
export function registerHotkeys(toggle: () => void, cancel: () => void, copy?: () => void): () => void {
    if (process.platform !== 'darwin') throw new Error("Global shortcuts currently require macOS.");
    const carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
    const psn = koffi.struct({ highLongOfPSN: 'uint32', lowLongOfPSN: 'uint32' });
    const transform = carbon.func('TransformProcessType', 'int32', [koffi.pointer(psn), 'uint32']);
    if (transform({ highLongOfPSN: 0, lowLongOfPSN: 2 }, 4) !== 0) throw new Error("macOS could not register the shortcut process.");
    const type = koffi.struct({ eventClass: 'uint32', eventKind: 'uint32' });
    const idType = koffi.struct({ signature: 'uint32', id: 'uint32' });
    const target = carbon.func('void *GetApplicationEventTarget()')();
    const register = carbon.func('RegisterEventHotKey', 'int32', ['uint32', 'uint32', idType, 'void *', 'uint32', koffi.out(koffi.pointer('void *'))]);
    const unregister = carbon.func('int32 UnregisterEventHotKey(void *)');
    const receive = carbon.func('ReceiveNextEvent', 'int32', ['uint32', koffi.pointer(type), 'double', 'uint8', koffi.out(koffi.pointer('void *'))]);
    const parameter = carbon.func('GetEventParameter', 'int32', ['void *', 'uint32', 'uint32', 'void *', 'uint32', 'void *', koffi.out(koffi.pointer(idType))]);
    const release = carbon.func('void ReleaseEvent(void *)');
    const dispatch = carbon.func('int32 SendEventToEventTarget(void *, void *)');
    const handlerType = koffi.proto('int32', ['void *', 'void *', 'void *']);
    const callback = koffi.register((_next: unknown, event: unknown) => {
        const id = { signature: 0, id: 0 };
        if (parameter(event, 0x2d2d2d2d, 0x686b6964, null, 8, null, id) === 0 && id.signature === 0x6d656574) {
            if (id.id === 1) toggle(); else if (id.id === 2) cancel(); else if (id.id === 3) copy?.();
            return 0;
        }
        return -9874;
    }, koffi.pointer(handlerType));
    const handler: unknown[] = [null];
    const install = carbon.func('InstallEventHandler', 'int32', ['void *', koffi.pointer(handlerType), 'uint32', koffi.pointer(type), 'void *', koffi.out(koffi.pointer('void *'))]);
    const remove = carbon.func('int32 RemoveEventHandler(void *)');
    const refs: unknown[] = [];
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const close = () => { if (closed) return; closed = true; clearInterval(timer); for (const ref of refs) unregister(ref); if (handler[0]) remove(handler[0]); koffi.unregister(callback); };
    try {
        if (install(target, callback, 1, { eventClass: 0x6b657962, eventKind: 5 }, null, handler) !== 0) throw new Error("Could not install the macOS hotkey handler.");
        for (const [code, id] of [[49, 1], [53, 2], ...(copy ? [[8, 3]] : [])]) {
            const ref: unknown[] = [null];
            const status = register(code, 4096 | 2048, { signature: 0x6d656574, id }, target, 1, ref);
            if (status !== 0) throw new Error("Global shortcut is in use or unavailable (macOS " + status + ').');
            refs.push(ref[0]);
        }
        timer = setInterval(() => {
            // Pull only hotkey presses. No keyboard logger or event tap is installed.
            for (let count = 0; count < 8; count++) {
                const event: unknown[] = [null];
                if (receive(1, { eventClass: 0x6b657962, eventKind: 5 }, 0.001, 1, event) !== 0) break;
                try {
                    dispatch(event[0], target);
                } finally { release(event[0]); }
            }
        }, 30);
        timer.unref();
        return close;
    } catch (error) { close(); throw error; }
}
