import { windows } from './api.js';

export function registerWindowsHotkeys(toggle: () => void, cancel: () => void, copy?: () => void): () => void {
    const api = windows(), register = api.user.func('int __stdcall RegisterHotKey(void *, int, uint32, uint32)'),
        unregister = api.user.func('int __stdcall UnregisterHotKey(void *, int)');
    const callbacks = new Map<number, () => void>([[0x5310, toggle], [0x5311, cancel], ...(copy ? [[0x5312, copy] as [number, () => void]] : [])]);
    const registered: number[] = []; let timer: NodeJS.Timeout | undefined, closed = false;
    const close = () => { if (closed) return; closed = true; clearInterval(timer); registered.forEach(id => unregister(null, id)); };
    try {
        for (const [id] of callbacks) {
            const key = id === 0x5310 ? 0x20 : id === 0x5311 ? 0x1b : 0x43;
            if (!register(null, id, 0x4000 | 0x2 | 0x1, key)) throw new Error('Global shortcut is already in use or unavailable (Windows ' + api.error() + ').');
            registered.push(id);
        }
        timer = setInterval(() => {
            const event: { wParam?: number | bigint } = {};
            for (let count = 0; count < 8 && api.peek(event, null, 0x312, 0x312, 1); count++) callbacks.get(Number(event.wParam))?.();
        }, 30); timer.unref();
        return close;
    } catch (error) { close(); throw error; }
}
