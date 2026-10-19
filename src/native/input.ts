import koffi from 'koffi';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryClipboard } from './pasteboard.js';
import type { CapturedInput } from '../insertion.js';

function api() {
    // CLI processes need an AppKit connection before querying system-wide focus.
    // This does not activate a window or take focus away from the user's app.
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit').func('bool NSApplicationLoad(void)')();
    const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const trusted = ax.func('bool AXIsProcessTrusted(void)');
    const createSystem = ax.func('void *AXUIElementCreateSystemWide(void)');
    const timeout = ax.func('int32 AXUIElementSetMessagingTimeout(void *, float)');
    const system = () => { const value = createSystem(); timeout(value, 0.35); return value; };
    const copy = ax.func('int32 AXUIElementCopyAttributeValue(void *, void *, _Out_ void **)');
    const settable = ax.func('int32 AXUIElementIsAttributeSettable(void *, void *, _Out_ bool *)');
    const set = ax.func('int32 AXUIElementSetAttributeValue(void *, void *, void *)');
    const rangeValue = ax.func('bool AXValueGetValue(void *, int32, void *)');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const keyboard = cg.func('void *CGEventCreateKeyboardEvent(void *, uint16, bool)');
    const flags = cg.func('void CGEventSetFlags(void *, uint64)');
    const post = cg.func('void CGEventPost(int32, void *)');
    const modifiers = cg.func('uint64 CGEventSourceFlagsState(int32)');
    const string = cf.func('void *CFStringCreateWithCString(void *, str, uint32)');
    const length = cf.func('long CFStringGetLength(void *)');
    const getString = cf.func('bool CFStringGetCString(void *, void *, long, uint32)');
    const type = cf.func('ulong CFGetTypeID(void *)');
    const stringType = cf.func('ulong CFStringGetTypeID(void)');
    const release = cf.func('void CFRelease(void *)');
    const equal = cf.func('bool CFEqual(void *, void *)');
    const boolean = cf.func('bool CFBooleanGetValue(void *)');
    const encoding = 0x08000100;
    const withKey = <T>(key: string, work: (key: unknown) => T): T => {
        const value = string(null, key, encoding);
        try { return work(value); } finally { release(value); }
    };
    const attribute = (element: unknown, key: string): unknown => withKey(key, name => {
        const out = [null]; return copy(element, name, out) === 0 ? out[0] : null;
    });
    const text = (value: unknown): string | null => {
        if (!value || type(value) !== stringType()) return null;
        const count = Number(length(value));
        if (count > 1_000_000) return null;
        const buffer = Buffer.alloc(count * 4 + 1);
        return getString(value, buffer, buffer.length, encoding) ? buffer.toString('utf8').replace(/\0.*$/s, '') : null;
    };
    const readText = (element: unknown, key: string): string | null => {
        const value = attribute(element, key);
        try { return text(value); } finally { if (value) release(value); }
    };
    const readRange = (element: unknown): string | null => {
        const value = attribute(element, 'AXSelectedTextRange');
        try {
            if (!value) return null;
            const buffer = Buffer.alloc(16);
            return rangeValue(value, 4, buffer) ? buffer.toString('hex') : null;
        } finally { if (value) release(value); }
    };
    const paste = () => {
        const down = keyboard(null, 9, true); const up = keyboard(null, 9, false);
        try {
            if (!down || !up) throw new Error('Could not create the paste shortcut.');
            flags(down, 1 << 20); flags(up, 1 << 20); post(1, down); post(1, up);
        } finally { if (down) release(down); if (up) release(up); }
    };
    return { trusted, system, timeout, attribute, readText, readRange, withKey, settable, set, string, release, equal, boolean, encoding, paste, modifiers };
}
let loaded: ReturnType<typeof api> | undefined;
const native = () => loaded ||= api();

export function accessibilityStatus(): boolean {
    try { return process.platform === 'darwin' && native().trusted(); } catch { return false; }
}

export function captureInput(): CapturedInput {
    try { return inspectInput(); } catch { return { reason: 'The focused input could not be inspected.' }; }
}

function inspectInput(): CapturedInput {
    if (process.platform !== 'darwin') return { reason: 'Automatic insertion requires macOS.' };
    const ax = native();
    if (!ax.trusted()) return { reason: 'Enable Accessibility access for your terminal to insert automatically.' };
    const system = ax.system();
    const element = ax.attribute(system, 'AXFocusedUIElement');
    ax.release(system);
    if (!element) return { reason: 'No focused input detected.' };
    ax.timeout(element, 0.35);
    let retained = false;
    try {
        const role = ax.readText(element, 'AXRole');
        const subrole = ax.readText(element, 'AXSubrole');
        if (!['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'].includes(role || '') || /secure|password/i.test(subrole || '')) {
            return { reason: 'No editable text input detected.' };
        }
        const enabled = ax.attribute(element, 'AXEnabled');
        try { if (enabled && !ax.boolean(enabled)) return { reason: 'The input is disabled.' }; }
        finally { if (enabled) ax.release(enabled); }
        const writable = [false];
        ax.withKey('AXSelectedText', key => ax.settable(element, key, writable));
        const range = ax.readRange(element);
        if (!range) return { reason: 'The input selection could not be detected.' };
        // Read only this input, in memory, to avoid inserting after the user edits it.
        // Neither its existing contents nor the element reference are persisted.
        const before = ax.readText(element, 'AXValue');
        if (before === null) return { reason: 'The input contents could not be verified.' };
        let web = false; let parent = ax.attribute(element, 'AXParent');
        try {
            for (let depth = 0; parent && depth < 20; depth++) {
                if (ax.readText(parent, 'AXRole') === 'AXWebArea') { web = true; break; }
                const next = ax.attribute(parent, 'AXParent'); ax.release(parent); parent = next;
            }
        } finally { if (parent) ax.release(parent); }
        let closed = false; let running = false; let released = false;
        const releaseWhenIdle = () => { if (closed && !running && !released) { released = true; ax.release(element); } };
        retained = true;
        return { reason: '', target: {
            reason: '',
            async insert(value: string, signal?: AbortSignal): Promise<boolean> {
                const fail = (reason: string) => { this.reason = reason; return false; };
                if (closed || running || !ax.trusted()) return fail('Accessibility access is unavailable.');
                running = true;
                try {
                    const unchanged = () => {
                        const root = ax.system(); const focused = ax.attribute(root, 'AXFocusedUIElement'); ax.release(root);
                        try { if (!focused || !ax.equal(element, focused)) return fail('The focused input changed during processing.'); }
                        finally { if (focused) ax.release(focused); }
                        if (ax.readRange(element) !== range) return fail('The text selection changed during processing.');
                        if (ax.readText(element, 'AXValue') !== before) return fail('The input contents changed during processing.');
                        return true;
                    };
                    signal?.throwIfAborted();
                    if (!unchanged()) return false;
                    const selection = Buffer.from(range, 'hex');
                    const location = Number(selection.readBigInt64LE(0)); const length = Number(selection.readBigInt64LE(8));
                    if (!Number.isSafeInteger(location) || !Number.isSafeInteger(length) || location < 0 || length < 0 || location + length > before.length) {
                        return fail('The input selection could not be verified.');
                    }
                    const expected = before.slice(0, location) + value + before.slice(location + length);
                    const matches = () => ax.readText(element, 'AXValue')?.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n');
                    if (writable[0] && !web) {
                        const content = ax.string(null, value, ax.encoding);
                        try {
                            ax.withKey('AXSelectedText', key => ax.set(element, key, content));
                            if (matches()) return true;
                        } finally { ax.release(content); }
                        // WebKit can report success for AXSelectedText without editing.
                        // Paste only if the original value AND selection are still intact.
                        if (!unchanged()) return false;
                    }
                    for (let i = 0; i < 20 && (Number(ax.modifiers(1)) & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20))); i++) {
                        await delay(25, undefined, { signal });
                    }
                    if (Number(ax.modifiers(1)) & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20))) return fail('A keyboard modifier is still held. Text copied instead.');
                    if (!unchanged()) return false;
                    const clipboard = temporaryClipboard(value);
                    let posted = false; let inserted = false;
                    try {
                        signal?.throwIfAborted();
                        if (!clipboard.isCurrent() || !unchanged()) return false;
                        ax.paste(); posted = true;
                        for (let i = 0; i < 20; i++) {
                            await delay(25); // Once posted, confirm delivery even during shutdown.
                            if (matches()) { inserted = true; return true; }
                        }
                        return fail('The app did not confirm the pasted text.');
                    } finally {
                        // An unconfirmed paste keeps the dictated text available. A late
                        // browser event must never paste the previous clipboard instead.
                        try { if (!posted || inserted) clipboard.restore(); } catch { this.reason = 'The previous clipboard could not be restored.'; }
                        finally { clipboard.dispose(); }
                    }
                } finally { running = false; releaseWhenIdle(); }
            },
            // Shutdown may close this target while a posted paste is being confirmed.
            close(): void { closed = true; releaseWhenIdle(); },
        } };
    } catch { return { reason: 'The focused input could not be inspected.' }; }
    finally { if (!retained) ax.release(element); }
}
