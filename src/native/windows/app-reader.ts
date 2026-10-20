import koffi from 'koffi';
import path from 'node:path';
import { automation, release } from './automation.js';
import type { ComPointer } from './automation.js';
import { callControls, notificationCallTree } from '../app-reader.js';
import type { AppObservation, CallApp, NotificationNode, ObservedCallState } from '../app-reader.js';

export function windowsCallProcess(executable: string): CallApp | 'notification' | undefined {
    const file = path.win32.basename(executable).toLowerCase();
    if (['ms-teams.exe', 'msteams.exe', 'teams.exe'].includes(file)) return 'teams';
    if (['whatsapp.exe', 'whatsapp.root.exe'].includes(file)) return 'whatsapp';
    if (['phoneexperiencehost.exe', 'yourphone.exe'].includes(file)) return 'apple';
    if (['shellexperiencehost.exe', 'sihost.exe'].includes(file)) return 'notification';
    return undefined;
}

export function observeWindowsApps(enabled: CallApp[]): AppObservation {
    const result: AppObservation = { trusted: false, teams: 'unknown', calls: {}, audio: { supported: false, apps: {} } };
    const ax = automation(), kernel = koffi.load('kernel32.dll');
    const open = kernel.func('void * __stdcall OpenProcess(uint32, int, uint32)'), close = kernel.func('int __stdcall CloseHandle(void *)');
    const image = kernel.func('int __stdcall QueryFullProcessImageNameW(void *, uint32, void *, _Inout_ uint32 *)');
    const processNames = new Map<number, ReturnType<typeof windowsCallProcess>>();
    const sourceFor = (pid: number) => {
        if (processNames.has(pid)) return processNames.get(pid);
        const handle = open(0x1000, 0, pid); let source: ReturnType<typeof windowsCallProcess>;
        if (handle) try {
            const buffer = Buffer.alloc(2048), size = [1024];
            if (image(handle, 0, buffer, size)) source = windowsCallProcess(buffer.subarray(0, size[0]! * 2).toString('utf16le'));
        } finally { close(handle); }
        processNames.set(pid, source); return source;
    };
    const priority = { unknown: 0, idle: 1, joining: 2, active: 3, ringing: 4 };
    const set = (app: CallApp, state: ObservedCallState) => { if (priority[state] > priority[result.calls![app] || 'unknown']) result.calls![app] = state; };
    const uncertain = new Set<CallApp>();
    let enumerationComplete = true;
    let count = 0, complete = true;
    const deadline = performance.now() + 1200;
    const visit = (element: ComPointer, notification: boolean, labels: string[], depth = 0): NotificationNode => {
        if (depth > 30 || ++count > 1200 || performance.now() > deadline) { complete = false; return { role: '' }; }
        const type = ax.integer(element, 21), offscreen = ax.integer(element, 38);
        if (type === undefined || offscreen === undefined) complete = false;
        if (offscreen === 1) return { role: '' };
        const node: NotificationNode = { role: type === 50032 ? 'AXWindow' : type === 50020 ? 'AXStaticText' : type === 50000 ? 'AXButton' : 'AXGroup', children: [] };
        if ([50004, 50030].includes(type || 0)) return node; // Never read message/editor contents.
        const id = ax.string(element, 29, 512) || '';
        if (notification) {
            node.identifier = id;
            if (type === 50020 && /^(?:(?:app|application|source)[._-]?(?:name|title|label|header)|attribution(?:text|label|header)?)$/iu.test(id)) node.appHeader = ax.string(element, 23, 128) || '';
        }
        if ([50000, 50003, 50013, 50019].includes(type || 0) && ax.integer(element, 28) === 1) {
            const value = ax.string(element, 23, 512);
            if (value === undefined) complete = false;
            const name = value || '';
            const actions = [id, name].filter(Boolean); labels.push(...actions); if (notification) node.labels = actions;
        }
        let child = ax.child(element);
        while (child) {
            let next: ComPointer | undefined;
            try { node.children!.push(visit(child, notification, labels, depth + 1)); if (complete) next = ax.sibling(child); }
            finally { release(child); }
            child = next;
        }
        return node;
    };
    const root = ax.root(); if (!root) return result;
    try {
        let window = ax.child(root), windows = 0;
        try { while (window) {
            if (++windows > 200 || performance.now() >= deadline) { enumerationComplete = false; break; }
            let next: ComPointer | undefined;
            const current = window; window = undefined;
            try {
                const pid = ax.integer(current, 20), source = pid ? sourceFor(pid) : undefined;
                if (source && (source === 'notification' || enabled.includes(source))) {
                    const labels: string[] = []; complete = true;
                    const tree = visit(current, source === 'notification', labels);
                    if (source === 'notification') {
                        for (const [app, state] of Object.entries(notificationCallTree(tree).calls)) if (enabled.includes(app as CallApp)) set(app as CallApp, state);
                    } else {
                        const state = callControls(labels, source, complete);
                        if (!complete || state === 'unknown') uncertain.add(source);
                        set(source, state);
                    }
                }
                if (performance.now() < deadline) next = ax.sibling(current);
                else enumerationComplete = false;
            } finally { release(current); }
            window = next;
        } } finally { release(window); }
        // An idle navigation window cannot prove hangup if another window of
        // that app was unreadable or the desktop scan was cut short.
        for (const app of enabled) if (result.calls![app] === 'idle' && (!enumerationComplete || uncertain.has(app))) result.calls![app] = 'unknown';
        // UIA needs no global Accessibility grant. Elevated and unavailable
        // app providers remain unknown, which must never be treated as hangup.
        result.trusted = true; result.teams = result.calls!.teams || 'unknown'; return result;
    } finally { release(root); }
}
