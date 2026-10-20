import koffi from 'koffi';
import { isMainThread } from 'node:worker_threads';
import { initializeAppKit } from './app-kit.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audioActivity } from './audio-activity.js';
import type { AudioActivity } from './audio-activity.js';

export type ObservedCallState = 'ringing' | 'joining' | 'active' | 'idle' | 'unknown';
export type CallApp = 'teams' | 'apple' | 'whatsapp';
export type AppObservation = { trusted: boolean; teams: ObservedCallState; calls?: Partial<Record<CallApp, ObservedCallState>>; audio?: AudioActivity; appleCallUI?: boolean; outlook?: { title: string; date: string } };
export function callControls(labels: string[], app: CallApp, complete: boolean): ObservedCallState {
    const has = (pattern: RegExp) => labels.some(label => pattern.test(controlLabel(label)));
    if (!has(/\b(invitation|invite|einladung)\b/i) && has(/\b(accept|answer|annehmen)\b/i) && has(/\b(decline|reject|ablehnen)\b/i)) return 'ringing';
    if (has(/\b(hang.?up|end.?call|leave|verlassen|auflegen|anruf beenden|beenden)\b/i) && has(/\b(mute|unmute|stumm|mikrofon)\b/i)) return 'active';
    if (app === 'teams' && has(/\b(microphone|mic|mikrofon|camera|kamera)\b/i) && has(/\b(pre ?join|join now|jetzt teilnehmen|jetzt beitreten)\b|^(join|teilnehmen|beitreten)( button)?$/i)) return 'joining';
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
function controlLabel(value: string): string {
    return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.:/-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
export function notificationCallApp(identifier: string, appLabel = ''): CallApp | undefined {
    // Only stable bundle IDs or exact app-header labels establish provenance.
    // A message body mentioning Teams is not an app identity.
    if (/^com\.microsoft\.teams2?(?:[.:/_-]|$)/i.test(identifier) || /^(?:Microsoft )?Teams(?: \(work or school\))?$/i.test(appLabel.trim())) return 'teams';
    if (/^com\.apple\.(?:FaceTime|Phone)(?:[.:/_-]|$)/i.test(identifier) || /^(?:FaceTime|Phone)$/i.test(appLabel.trim())) return 'apple';
    if (/^(?:net|com)\.whatsapp(?:[.:/_-]|$)/i.test(identifier) || /^WhatsApp$/i.test(appLabel.trim())) return 'whatsapp';
    return undefined;
}
export function notificationCall(labels: string[], source: CallApp | undefined): ObservedCallState {
    if (!source) return 'unknown';
    if (callControls(labels, source, false) === 'ringing') return 'ringing';
    // Some native banners expose only the audio/video Answer action. Never
    // interpret invitation acceptance, callback or meeting reminders as ringing.
    const answer = /^(?:answer(?: (?:audio|video))?(?: call)?|accept (?:audio|video) call|(?:audio|video)?anruf annehmen|annehmen)$/i;
    return labels.some(label => answer.test(controlLabel(label))) ? 'ringing' : 'unknown';
}
export type NotificationNode = { role: string; identifier?: string; appHeader?: string; labels?: string[]; children?: NotificationNode[] };
export function notificationCallTree(root: NotificationNode): { calls: Partial<Record<CallApp, ObservedCallState>>; identified: boolean } {
    const calls: Partial<Record<CallApp, ObservedCallState>> = {};
    let identified = false;
    const visit = (node: NotificationNode): { sources: Set<CallApp>; unknownHeader: boolean; labels: string[] } => {
        const source = notificationCallApp(node.identifier || '', node.appHeader);
        if (source || node.appHeader !== undefined) identified = true;
        const branch = { sources: new Set<CallApp>(source ? [source] : []), unknownHeader: node.appHeader !== undefined && !source, labels: [...node.labels || []] };
        for (const child of node.children || []) {
            const value = visit(child);
            for (const app of value.sources) branch.sources.add(app);
            branch.unknownHeader ||= value.unknownHeader;
            branch.labels.push(...value.labels);
        }
        if (['AXGroup', 'AXPopover', 'AXDialog'].includes(node.role) && (branch.sources.size || branch.unknownHeader)) {
            const headerOnly = /^(?:notification[-_.])?(?:app|source)[-_.]?(?:name|title|label|header)$/i.test(node.identifier || '') && !branch.labels.length;
            if (headerOnly) return branch;
            if (branch.labels.length && branch.sources.size === 1 && !branch.unknownHeader) {
                const app = [...branch.sources][0]!;
                if (notificationCall(branch.labels, app) === 'ringing') calls[app] = 'ringing';
            }
            // App-header containers may pass metadata to their own card. Other
            // identified groups own it even without actions, so ancestors cannot
            // lend a message card's identity to actions in a sibling card.
            return { sources: new Set(), unknownHeader: false, labels: [] };
        }
        return branch;
    };
    visit(root);
    return { calls, identified };
}
const exec = promisify(execFile);
export async function observeApps(readOutlook = true, enabled: CallApp[] = ['teams', 'apple', 'whatsapp']): Promise<AppObservation> {
    if (process.platform !== 'darwin') return { trusted: false, teams: 'unknown' };
    // CallDetector initializes AppKit in the parent before creating this worker.
    // Direct diagnostic calls on the main thread still need that connection.
    if (isMainThread) initializeAppKit();
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
    const priority = { unknown: 0, idle: 1, joining: 2, active: 3, ringing: 4 };
    try {
        const apps: { process: string; call?: CallApp; notification?: boolean }[] = [
            { process: 'FaceTimeNotificationExtension', call: 'apple' }, { process: 'FaceTimeNotificationViewBridgeService', call: 'apple' },
            { process: 'com.microsoft.teams2.notificationcenter', call: 'teams' },
            { process: 'NotificationCenter', notification: true },
            { process: 'Phone', call: 'apple' }, { process: 'FaceTime', call: 'apple' }, { process: 'WhatsApp', call: 'whatsapp' },
            { process: 'MSTeams', call: 'teams' }, { process: 'Microsoft Teams', call: 'teams' },
            ...(readOutlook ? [{ process: 'Microsoft Outlook' }] : []),
        ];
        for (const entry of apps) {
            if (entry.call && !enabled.includes(entry.call)) continue;
            if (entry.notification && !enabled.length) continue;
            const app = entry.process;
            let pids: number[];
            try { pids = (await exec('/usr/bin/pgrep', ['-x', app], { timeout: 1500 })).stdout.trim().split('\n').map(Number); } catch { continue; }
            for (const pid of pids) {
                if (!pid) continue;
                if (entry.call === 'apple' && app.startsWith('FaceTimeNotification')) result.appleCallUI = true;
                const root = create(pid); timeout(root, 0.35);
                const labels: string[] = []; let title = '', date = '', count = 0, complete = true;
                const deadline = performance.now() + 1200;
                const notificationStates = new Map<CallApp, ObservedCallState>();
                const visit = (node: unknown, depth = 0): NotificationNode => {
                    const branch: NotificationNode = { role: '', children: [] };
                    if (depth > 35 || ++count > 1800 || performance.now() > deadline) { complete = false; return branch; }
                    const role = text(node, 'AXRole');
                    branch.role = role;
                    if (role === 'AXMenuBar') return branch;
                    const id = text(node, 'AXIdentifier');
                    if (entry.notification) {
                        const appHeader = role === 'AXStaticText' && /(?:app|source)[._-]?(?:name|title|label|header)/i.test(id);
                        branch.identifier = id;
                        if (appHeader) branch.appHeader = text(node, 'AXValue') || text(node, 'AXTitle');
                    }
                    if (app === 'Microsoft Outlook') {
                        if (id === 'subjectField') title = text(node, 'AXValue');
                        if (id === 'dateField') date = text(node, 'AXValue');
                        if (id === 'bodyField') return branch;
                    } else if (['AXButton', 'AXRadioButton', 'AXTab'].includes(role)) {
                        const value = attr(node, 'AXEnabled'); let enabled = true;
                        if (value) try { if (type(value) === booleanType()) enabled = boolean(value); } finally { release(value); }
                        if (enabled) {
                            const actions = [id, text(node, 'AXTitle'), text(node, 'AXDescription'), text(node, 'AXHelp')].filter(Boolean);
                            labels.push(...actions); if (entry.notification) branch.labels = actions;
                        }
                    }
                    if (['AXTextArea', 'AXTextField', 'AXSecureTextField', 'AXOutline'].includes(role)) return branch;
                    const children = attr(node, 'AXChildren');
                    if (!children) return branch;
                    try { if (type(children) === arrayType()) for (let i = 0; i < length(children); i++) branch.children!.push(visit(at(children, i), depth + 1)); }
                    finally { release(children); }
                    return branch;
                };
                let windows = 0;
                const notification: { state: ObservedCallState } = { state: 'unknown' };
                const visitWindow = (node: unknown) => {
                    const start = labels.length;
                    const tree = visit(node);
                    if (entry.notification) {
                        const classified = notificationCallTree(tree);
                        for (const [app, state] of Object.entries(classified.calls)) if (enabled.includes(app as CallApp)) notificationStates.set(app as CallApp, state);
                        if (!classified.identified && enabled.includes('apple') && appleNotificationCall(labels.slice(start), Boolean(result.appleCallUI || audio.apps.apple?.output)) === 'ringing') notification.state = 'ringing';
                    }
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
                if (entry.notification) {
                    if (notification.state === 'ringing') notificationStates.set('apple', 'ringing');
                    for (const [source, state] of notificationStates) {
                        if (priority[state] > priority[result.calls![source]!]) result.calls![source] = state;
                        if (source === 'apple' && state === 'ringing') result.appleCallUI = true;
                    }
                }
                if (app === 'Microsoft Outlook' && title && date) result.outlook = { title, date };
                if (entry.call) {
                    const state = app === 'com.microsoft.teams2.notificationcenter' ? notificationCall(labels, 'teams') : callControls(labels, entry.call, complete && windows > 0);
                    if (priority[state] > priority[result.calls![entry.call]!]) result.calls![entry.call] = state;
                }
            }
        }
        result.teams = result.calls!.teams!;
        return result;
    } finally { for (const value of keys.values()) release(value); }
}
