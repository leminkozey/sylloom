import { ALT_KEY } from './platform.js';

export type TalkMode = 'toggle' | 'hold';
export type ShortcutOptions = { shortcut?: string; mode?: TalkMode; release?: () => void; auxiliary?: boolean };
export const DEFAULT_SHORTCUT = 'Ctrl+' + ALT_KEY + '+Space';
const macKeys: Record<string, number> = { Space: 49, Escape: 53, C: 8, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F13: 105, F14: 107, F15: 113, F16: 106, F17: 64, F18: 79, F19: 80 };
export const SINGLE_KEYS = Object.keys(macKeys).filter(key => key.startsWith('F'));
export function parseShortcut(value: string, platform = process.platform): { label: string; code: number; modifiers: number; polled?: boolean } {
    if (typeof value !== 'string') throw new Error('Choose a valid shortcut.');
    const special = value.trim().toLowerCase();
    if (platform === 'darwin' && ['fn', 'globe', 'rightoption', 'right option'].includes(special)) return { label: ['fn', 'globe'].includes(special) ? 'Fn' : 'Right Option', code: ['fn', 'globe'].includes(special) ? 63 : 61, modifiers: 0, polled: true };
    if (platform === 'win32' && ['rightctrl', 'right ctrl'].includes(special)) return { label: 'Right Ctrl', code: 0xa3, modifiers: 0, polled: true };
    const parts = value.trim().split('+').map(part => part.trim().toLowerCase());
    const raw = parts.pop() || '';
    const key = Object.keys(macKeys).find(key => key.toLowerCase() === raw) || (raw === 'esc' ? 'Escape' : '');
    if (!key || parts.some(part => !['ctrl', 'control', 'alt', 'option', 'shift', 'cmd', 'command', 'win'].includes(part))) throw new Error('Use a function key (F6–F11 or F13–F19), or modifiers + Space, Escape or C.');
    const flags = new Set<string>(parts.map(part => ['ctrl', 'control'].includes(part) ? 'Ctrl' : ['alt', 'option'].includes(part) ? platform === 'darwin' ? 'Option' : 'Alt' : part === 'shift' ? 'Shift' : platform === 'darwin' ? 'Cmd' : 'Win'));
    if (!flags.size && !SINGLE_KEYS.includes(key)) throw new Error('Use a function key for a single-key shortcut. Ordinary typing keys need a modifier.');
    const ordered = ['Ctrl', platform === 'darwin' ? 'Option' : 'Alt', 'Shift', platform === 'darwin' ? 'Cmd' : 'Win'].filter(flag => flags.has(flag));
    const bits = platform === 'darwin' ? [4096, 2048, 512, 256] : [2, 1, 4, 8];
    const code = platform === 'darwin' ? macKeys[key]! : key === 'Space' ? 0x20 : key === 'Escape' ? 0x1b : key === 'C' ? 0x43 : 0x70 + Number(key.slice(1)) - 1;
    return { label: [...ordered, key].join('+'), code, modifiers: ['Ctrl', platform === 'darwin' ? 'Option' : 'Alt', 'Shift', platform === 'darwin' ? 'Cmd' : 'Win'].reduce((mask, name, i) => mask | (flags.has(name) ? bits[i]! : 0), 0) };
}

// Ignore key-repeat and stale key-up events. Release belongs only to a press
// that this registration observed, never to a key held before registration.
export function shortcutEdges(press: () => void, release: () => void): (down: boolean) => void {
    let held = false;
    return down => { if (down === held) return; held = down; if (down) press(); else release(); };
}

export function polledShortcut(press: () => void, release: () => void, initiallyDown: boolean): (down: boolean) => void {
    const edge = shortcutEdges(press, release);
    let armed = !initiallyDown;
    return down => { if (!armed) { if (!down) armed = true; return; } edge(down); };
}
