import koffi from 'koffi';
import { setTimeout as delay } from 'node:timers/promises';
import { automation, com, outPointer, release } from './automation.js';
import type { ComPointer } from './automation.js';
import { windows } from './api.js';
import { temporaryWindowsClipboard } from './clipboard.js';
import type { CapturedInput } from '../../insertion.js';

export function windowsInsertionAvailable(): boolean { try { automation(); return true; } catch { return false; } }

function paste(): void {
    const api = windows();
    const keyboard = koffi.struct({ virtual: 'uint16', scan: 'uint16', flags: 'uint32', time: 'uint32', extra: 'uintptr_t' });
    // INPUT's union is sized by MOUSEINPUT (32 bytes on x64), not KEYBDINPUT.
    const size = process.arch === 'ia32' ? 28 : 40, bytes = Buffer.alloc(size * 4);
    for (const [index, key, flags] of [[0, 0x11, 0], [1, 0x56, 0], [2, 0x56, 2], [3, 0x11, 2]]) {
        bytes.writeUInt32LE(1, index! * size);
        const offset = index! * size + (process.arch === 'ia32' ? 4 : 8);
        koffi.encode(bytes.subarray(offset), keyboard, { virtual: key, scan: 0, flags, time: 0, extra: 0 });
    }
    const send = api.user.func('uint32 __stdcall SendInput(uint32, void *, int)');
    if (send(4, bytes, size) !== 4) {
        // A partial injection must not leave Ctrl or V held down.
        send(2, bytes.subarray(size * 2), size);
        throw new Error('Windows did not accept the paste shortcut.');
    }
}

export function captureWindowsInput(): CapturedInput {
    const retained: ComPointer[] = []; let own = true;
    const keep = (pointer: ComPointer | undefined) => { if (pointer) retained.push(pointer); return pointer; };
    try {
        const api = windows(), ax = automation(), window = api.foreground(), element = keep(ax.focused());
        if (!window || !element) return { reason: 'No focused input detected.' };
        if (ax.integer(element, 35) !== 0 || ax.integer(element, 28) !== 1 || ax.integer(element, 26) !== 1 || ![50004, 50030].includes(ax.integer(element, 21) || 0)) return { reason: 'No editable text input detected.' };
        const text = keep(ax.pattern(element, 10014)), value = keep(ax.pattern(element, 10002));
        if (!text) return { reason: 'The input selection could not be verified. Text will be copied.' };
        const range = keep(ax.selection(text)), document = keep(outPointer(text, 7));
        if (!range || !document || (value ? ax.integer(value, 5) !== 0 : !ax.rangeWritable(range))) return { reason: 'The input is read-only or its selection is unavailable.' };
        const before = ax.rangeText(document), selected = ax.rangeText(range), prefixRange = outPointer(document, 3);
        if (before === undefined || selected === undefined || !prefixRange) return { reason: 'The input contents could not be verified.' };
        let prefix: string | undefined;
        try { if (com(prefixRange, 15, ['int32', 'void *', 'int32'], 1, range, 0) >= 0) prefix = ax.rangeText(prefixRange); }
        finally { release(prefixRange); }
        if (prefix === undefined || !before.startsWith(prefix) || before.slice(prefix.length, prefix.length + selected.length) !== selected) return { reason: 'The input selection could not be verified.' };
        const location = prefix.length, length = selected.length;
        let closed = false, running = false, released = false;
        const releaseWhenIdle = () => { if (closed && !running && !released) { released = true; retained.forEach(release); } };
        own = false;
        return { reason: '', target: { reason: '',
            async insert(content, signal) {
                const fail = (reason: string) => { this.reason = reason; return false; };
                if (closed || running) return fail('The captured input is unavailable.');
                running = true;
                try {
                    const unchanged = () => {
                        if (api.foreground() !== window) return fail('The foreground app changed during processing.');
                        if (ax.integer(element, 35) !== 0 || ax.integer(element, 28) !== 1 || ax.integer(element, 26) !== 1 ||
                            ![50004, 50030].includes(ax.integer(element, 21) || 0) ||
                            (value ? ax.integer(value, 5) !== 0 : !ax.rangeWritable(range))) return fail('The input is no longer editable.');
                        const focused = ax.focused();
                        try { if (!focused || !ax.equal(element, focused)) return fail('The focused input changed during processing.'); }
                        finally { release(focused); }
                        const current = ax.selection(text);
                        try { if (!current || !ax.sameRange(range, current)) return fail('The text selection changed during processing.'); }
                        finally { release(current); }
                        if (ax.documentText(text) !== before) return fail('The input contents changed during processing.');
                        return true;
                    };
                    signal?.throwIfAborted(); if (!unchanged()) return false;
                    const held = () => [0x10, 0x11, 0x12, 0x5b, 0x5c].some(key => Boolean(api.keyState(key) & 0x8000));
                    for (let count = 0; count < 20 && held(); count++) await delay(25, undefined, { signal });
                    if (held()) return fail('A keyboard modifier is still held. Text copied instead.');
                    if (!unchanged()) return false;
                    const clipboard = temporaryWindowsClipboard(content);
                    let posted = false, inserted = false;
                    try {
                        signal?.throwIfAborted();
                        if (!clipboard.isCurrent()) return fail('The clipboard changed before pasting.');
                        if (!unchanged()) return false;
                        // Ctrl+V only. No Enter, Send or focus-changing command.
                        paste(); posted = true;
                        const expected = (before.slice(0, location) + content + before.slice(location + length)).replace(/\r\n/gu, '\n');
                        for (let count = 0; count < 24; count++) {
                            await delay(25);
                            if (ax.documentText(text)?.replace(/\r\n/gu, '\n') === expected) { inserted = true; return true; }
                        }
                        return fail('The app did not confirm the pasted text.');
                    } finally {
                        try { if (!posted || inserted) clipboard.restore(); }
                        catch { this.reason = 'The previous clipboard could not be restored.'; }
                        finally { clipboard.dispose(); }
                    }
                } finally { running = false; releaseWhenIdle(); }
            },
            close() { closed = true; releaseWhenIdle(); },
        } };
    } catch { return { reason: 'The focused input could not be inspected. Try a standard input at the same Windows privilege level.' }; }
    finally { if (own) retained.forEach(release); }
}
