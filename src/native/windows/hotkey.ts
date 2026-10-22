import { DEFAULT_SHORTCUT, parseShortcut, shortcutEdges, polledShortcut } from '../../shortcut.js';
import type { ShortcutOptions } from '../../shortcut.js';
import { windows } from './api.js';

export function registerWindowsHotkeys(toggle: () => void, cancel: () => void, copy?: () => void, options: ShortcutOptions = {}): () => void {
    const binding = parseShortcut(options.shortcut || DEFAULT_SHORTCUT, 'win32');
    const edge = shortcutEdges(toggle, () => { if (options.mode === 'hold') options.release?.(); });
    const api = windows(), register = api.user.func('int __stdcall RegisterHotKey(void *, int, uint32, uint32)'),
        unregister = api.user.func('int __stdcall UnregisterHotKey(void *, int)');
    const callbacks = new Map<number, () => void>([[0x5310, () => edge(true)], [0x5311, cancel], ...(copy ? [[0x5312, copy] as [number, () => void]] : [])]);
    const keyState = api.user.func('short __stdcall GetAsyncKeyState(int)');
    const poll = binding.polled ? polledShortcut(toggle, () => { if (options.mode === 'hold') options.release?.(); }, Boolean(keyState(binding.code) & 0x8000)) : undefined;
    const registered: number[] = []; let timer: NodeJS.Timeout | undefined, closed = false;
    const close = () => { if (closed) return; closed = true; clearInterval(timer); registered.forEach(id => unregister(null, id)); };
    try {
        for (const [id] of callbacks) {
            if (id === 0x5310 && binding.polled || id !== 0x5310 && options.auxiliary === false) continue;
            const key = id === 0x5310 ? binding.code : id === 0x5311 ? 0x1b : 0x43;
            if (!register(null, id, 0x4000 | (id === 0x5310 ? binding.modifiers : 0x2 | 0x1), key)) throw new Error('Global shortcut is already in use or unavailable (Windows ' + api.error() + ').');
            registered.push(id);
        }
        timer = setInterval(() => {
            const event: { wParam?: number | bigint } = {};
            for (let count = 0; count < 8 && api.peek(event, null, 0x312, 0x312, 1); count++) callbacks.get(Number(event.wParam))?.();
            // Query only the configured key. Windows sends WM_HOTKEY on press.
            if (poll) poll(Boolean(keyState(binding.code) & 0x8000));
            else if (!(keyState(binding.code) & 0x8000)) edge(false);
        }, 12); timer.unref();
        return close;
    } catch (error) { close(); throw error; }
}
