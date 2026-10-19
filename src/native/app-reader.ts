import koffi from 'koffi';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audioActivity } from './audio-activity.js';
import type { AudioActivity } from './audio-activity.js';

export type ObservedCallState = 'ringing' | 'active' | 'idle' | 'unknown';
export type CallApp = 'teams' | 'apple' | 'whatsapp';
export type AppObservation = { trusted: boolean; teams: ObservedCallState; calls?: Partial<Record<CallApp, ObservedCallState>>; audio?: AudioActivity; appleCallUI?: boolean; outlook?: { title: string; date: string } };
export function callControls(labels: string[], app: CallApp, complete: boolean): ObservedCallState {
    const has = (pattern: RegExp) => labels.some(label => pattern.test(label));
    if (has(/\b(accept|answer|annehmen)\b/i) && has(/\b(decline|reject|ablehnen)\b/i)) return 'ringing';
    if (has(/\b(hang.?up|end.?call|leave|verlassen|auflegen|anruf beenden|beenden)\b/i) && has(/\b(mute|unmute|stumm|mikrofon)\b/i)) return 'active';
    const idle = app === 'teams' ? /\b(chat|calendar|activity|kalender|aktivität)\b/i : app === 'whatsapp' ? /\b(chats|calls|anrufe|new chat|neuer chat)\b/i : /\b(recents|recent calls|keypad|new facetime|new call|letzte|ziffernblock|neuer anruf)\b/i;
    return complete && has(idle) ? 'idle' : 'unknown';
}
export function appleNotificationCall(labels: string[], appleCallSurface: boolean): ObservedCallState {
    if (!appleCallSurface) return 'unknown';
    // Apple's banner can expose a single Answer button. A generic notification
    // action is only considered while an Apple call panel or output stream exists.
    const answer = /^(?:answer(?: (?:audio|video))?(?: call)?|accept (?:audio|video) call|(?:audio|video)?anruf annehmen|annehmen)$/i;
    return labels.some(label => answer.test(label.trim().replace(/\s+/g, ' '))) || callControls(labels, 'apple', false) === 'ringing' ? 'ringing' : 'unknown';
}
const exec = promisify(execFile);
export async function observeApps(readOutlook = true, enabled: CallApp[] = ['teams', 'apple', 'whatsapp']): Promise<AppObservation> {
    if (process.platform !== 'darwin') return { trusted: false, teams: 'unknown' };
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit').func('bool NSApplicationLoad(void)')();
    const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const audio = audioActivity(enabled);
    if (!ax.func('bool AXIsProcessTrusted(void)')()) return { trusted: false, teams: 'unknown', audio };
    const create = ax.func('void *AXUIElementCreateApplication(int32)');
    const timeout = ax.func('int32 AXUIElementSetMessagingTimeout(void *, float)');
    const copy = ax.func('int32 AXUIElementCopyAttributeValue(void *, void *, _Out_ void **)');
    const string = cf.func('void *CFStringCreateWithCString(void *, str, uint32)');
    const getString = cf.func('bool CFStringGetCString(void *, void *, long, uint32)');
    const type = cf.func('ulong CFGetTypeID(void *)');
    const stringType = cf.func('ulong CFStringGetTypeID(void)');
    const arrayType = cf.func('ulong CFArrayGetTypeID(void)');
    const booleanType = cf.func('ulong CFBooleanGetTypeID(void)');
    const boolean = cf.func('bool CFBooleanGetValue(void *)');
    const length = cf.func('long CFArrayGetCount(void *)');
    const at = cf.func('void *CFArrayGetValueAtIndex(void *, long)');
    const release = cf.func('void CFRelease(void *)');
    const keys = new Map<string, unknown>();
    const attr = (node: unknown, name: string): unknown => {
        if (!keys.has(name)) keys.set(name, string(null, name, 0x08000100));
        const out = [null]; return copy(node, keys.get(name), out) === 0 ? out[0] : null;
    };
    const text = (node: unknown, name: string): string => {
        const value = attr(node, name); if (!value) return '';
        try { const buffer = Buffer.alloc(4096); return type(value) === stringType() && getString(value, buffer, buffer.length, 0x08000100) ? buffer.toString('utf8').split('\0')[0]! : ''; }
        finally { release(value); }
    };
    const result: AppObservation = { trusted: true, teams: 'unknown', audio, appleCallUI: false, calls: { teams: 'unknown', apple: 'unknown', whatsapp: 'unknown' } };
    const priority = { unknown: 0, idle: 1, active: 2, ringing: 3 };
    try {
        const apps: { process: string; call?: CallApp; notification?: boolean }[] = [
            { process: 'FaceTimeNotificationExtension', call: 'apple' }, { process: 'FaceTimeNotificationViewBridgeService', call: 'apple' },
            { process: 'NotificationCenter', call: 'apple', notification: true },
            { process: 'Phone', call: 'apple' }, { process: 'FaceTime', call: 'apple' }, { process: 'WhatsApp', call: 'whatsapp' },
            { process: 'MSTeams', call: 'teams' }, { process: 'Microsoft Teams', call: 'teams' },
            ...(readOutlook ? [{ process: 'Microsoft Outlook' }] : []),
        ];
        for (const entry of apps) {
            if (entry.call && !enabled.includes(entry.call)) continue;
            if (entry.notification && !result.appleCallUI && !audio.apps.apple?.output) continue;
            const app = entry.process;
            let pids: number[];
            try { pids = (await exec('/usr/bin/pgrep', ['-x', app], { timeout: 1500 })).stdout.trim().split('\n').map(Number); } catch { continue; }
            for (const pid of pids) {
                if (!pid) continue;
                if (entry.call === 'apple' && app.startsWith('FaceTimeNotification')) result.appleCallUI = true;
                const root = create(pid); timeout(root, 0.35);
                const labels: string[] = []; let title = '', date = '', count = 0, complete = true;
                const deadline = performance.now() + 1200;
                const visit = (node: unknown, depth = 0) => {
                    if (depth > 35 || ++count > 1800 || performance.now() > deadline) { complete = false; return; }
                    const role = text(node, 'AXRole');
                    if (role === 'AXMenuBar') return;
                    const id = text(node, 'AXIdentifier');
                    if (app === 'Microsoft Outlook') {
                        if (id === 'subjectField') title = text(node, 'AXValue');
                        if (id === 'dateField') date = text(node, 'AXValue');
                        if (id === 'bodyField') return;
                    } else if (['AXButton', 'AXRadioButton', 'AXTab'].includes(role)) {
                        const value = attr(node, 'AXEnabled'); let enabled = true;
                        if (value) try { if (type(value) === booleanType()) enabled = boolean(value); } finally { release(value); }
                        if (enabled) labels.push(id, text(node, 'AXTitle'), text(node, 'AXDescription'), text(node, 'AXHelp'));
                    }
                    if (['AXTextArea', 'AXTextField', 'AXSecureTextField', 'AXOutline'].includes(role)) return;
                    const children = attr(node, 'AXChildren');
                    if (!children) return;
                    try { if (type(children) === arrayType()) for (let i = 0; i < length(children); i++) visit(at(children, i), depth + 1); }
                    finally { release(children); }
                };
                let windows = 0;
                let notification: ObservedCallState = 'unknown';
                const visitWindow = (node: unknown) => {
                    const start = labels.length;
                    visit(node);
                    if (entry.notification && appleNotificationCall(labels.slice(start), Boolean(result.appleCallUI || audio.apps.apple?.output)) === 'ringing') notification = 'ringing';
                };
                try {
                    const values = attr(root, 'AXWindows');
                    if (values) try {
                        if (type(values) === arrayType()) {
                            windows = length(values);
                            for (let i = 0; i < windows; i++) visitWindow(at(values, i));
                        }
                    } finally { release(values); }
                    // Some apps expose an empty AXWindows array while their actual
                    // window remains available through AXChildren or AXFocusedWindow.
                    if (!windows) {
                        const children = attr(root, 'AXChildren');
                        if (children) try { if (type(children) === arrayType()) for (let i = 0; i < length(children); i++) { const node = at(children, i); if (['AXWindow', 'AXPopover', 'AXDialog'].includes(text(node, 'AXRole'))) { windows++; visitWindow(node); } } } finally { release(children); }
                        if (!windows) { const focused = attr(root, 'AXFocusedWindow'); if (focused) try { windows++; visitWindow(focused); } finally { release(focused); } }
                    }
                }
                finally { release(root); }
                if (app === 'Microsoft Outlook' && title && date) result.outlook = { title, date };
                if (entry.call) {
                    const state = entry.notification ? notification : callControls(labels, entry.call, complete && windows > 0);
                    if (entry.notification && state === 'ringing') result.appleCallUI = true;
                    if (priority[state] > priority[result.calls![entry.call]!]) result.calls![entry.call] = state;
                }
            }
        }
        result.teams = result.calls!.teams!;
        return result;
    } finally { for (const value of keys.values()) release(value); }
}
