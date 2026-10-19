import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import type { AppObservation, CallApp } from './native/app-reader.js';
import { teamsToken } from './native/keychain.js';
import { version } from './brand.js';
import { normalizeEvent } from './calendar.js';
import type { CalendarEvent } from './calendar.js';
import type { Settings } from './types.js';

export type CallState = 'unknown' | 'idle' | 'ringing' | 'active';
export type CallSnapshot = { state: CallState; source: string; message: string; since: string; callId: number; accessibility: boolean; app?: CallApp };
const labels: Record<CallApp, string> = { teams: 'Teams', apple: 'FaceTime / iPhone', whatsapp: 'WhatsApp' };
export function enabledCallApps(config: Settings): CallApp[] {
    return (['apple', 'whatsapp', 'teams'] as const).filter(app => config[app === 'apple' ? 'detectAppleCalls' : app === 'whatsapp' ? 'detectWhatsAppCalls' : 'detectTeamsCalls']);
}
export class CallDetector extends EventEmitter {
    snapshot: CallSnapshot = { state: 'unknown', source: 'none', message: 'Starting local call detection', since: '', callId: 0, accessibility: false };
    visibleEvent?: CalendarEvent;
    readOutlook = true;
    enabledApps: CallApp[] = ['teams', 'apple', 'whatsapp'];
    private socket?: WebSocket;
    private observer?: Worker;
    private polling?: NodeJS.Timeout;
    private reconnect?: NodeJS.Timeout;
    private timeout?: NodeJS.Timeout;
    private closed = false;
    private trusted = false;
    private apiState: CallState = 'unknown';
    private axState: CallState = 'unknown';
    private apiEndedCall = false;
    private sequence = 0;
    private states = new Map<CallApp, CallSnapshot>();
    private idleSamples = new Map<CallApp, number>();
    private appleCallUISeen?: number;
    constructor(private port = 8124) { super(); }
    stateFor(callId: number): CallSnapshot | undefined { return [...this.states.values()].find(call => call.callId === callId); }
    start(): void {
        if (process.platform !== 'darwin') { this.setState('unknown', 'none', 'Local call detection currently requires macOS.'); return; }
        let url = new URL('./app-observer-worker.js', import.meta.url);
        if (!existsSync(url)) url = new URL('./app-observer-worker.ts', import.meta.url);
        this.observer = new Worker(url, { stdout: true, stderr: true, execArgv: process.execArgv.filter(value => !value.startsWith('--input-type')) });
        this.observer.stdout.resume(); this.observer.stderr.resume();
        this.observer.on('message', (data: AppObservation) => this.observe(data));
        this.observer.on('error', () => {
            this.trusted = false;
            for (const app of this.enabledApps) if (app !== 'teams' || this.apiState === 'unknown') this.setState('unknown', 'accessibility', 'App observation is unavailable.', app);
        });
        this.observer.postMessage({ readOutlook: this.readOutlook, apps: this.enabledApps });
        this.polling = setInterval(() => this.observer?.postMessage({ readOutlook: this.readOutlook, apps: this.enabledApps }), 1500); this.polling.unref();
        if (this.enabledApps.includes('teams')) this.connect();
    }
    private connect(): void {
        if (this.closed) return;
        if (!Number.isInteger(this.port) || this.port < 1024 || this.port > 65535) { this.setState('unknown', 'local-api', 'Invalid Teams local API port.'); return; }
        const url = new URL('ws://127.0.0.1:' + this.port);
        const params = { 'protocol-version': '2.0.0', manufacturer: 'Sylloom', device: 'CLI', app: 'Sylloom', 'app-version': version };
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        try { const token = teamsToken(); if (token) url.searchParams.set('token', token); } catch { /* Local app and audio observation remain available. */ }
        const socket = new WebSocket(url); this.socket = socket;
        this.timeout = setTimeout(() => socket.close(), 3000); this.timeout.unref();
        socket.onopen = () => { clearTimeout(this.timeout); };
        socket.onmessage = event => { if (typeof event.data === 'string' && event.data.length < 65536) this.apiMessage(event.data); };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
            clearTimeout(this.timeout); this.apiState = 'unknown'; this.apiEndedCall = false;
            if (this.closed) return;
            this.setState(['active', 'ringing'].includes(this.axState) ? this.axState : 'unknown', 'accessibility', 'Teams local API unavailable. Local call detection remains enabled.');
            this.reconnect = setTimeout(() => this.connect(), 10000); this.reconnect.unref();
        };
    }
    apiMessage(text: string): void {
        if (this.closed || !this.enabledApps.includes('teams')) return;
        try {
            const data = JSON.parse(text);
            if (typeof data.tokenRefresh === 'string') { try { teamsToken(data.tokenRefresh); } catch {} }
            const update = data.meetingUpdate;
            if (typeof update?.meetingState?.isInMeeting === 'boolean') {
                this.apiEndedCall = !update.meetingState.isInMeeting && (this.apiState === 'active' || this.states.get('teams')?.state === 'active');
                this.apiState = update.meetingState.isInMeeting ? 'active' : 'idle';
                this.setState(this.apiState === 'idle' && this.axState === 'ringing' ? 'ringing' : this.apiState, 'local-api', 'Teams local API connected.');
            } else if (update?.meetingPermissions?.canPair === true) {
                this.apiState = 'active'; this.setState('active', 'local-api', 'Teams call detected from local meeting permissions.');
            }
        } catch { /* Ignore unknown protocol messages; never log tokens or call content. */ }
    }
    observe(data: AppObservation): void {
        if (this.closed) return;
        this.trusted = data.trusted;
        this.axState = data.trusted ? data.calls?.teams || data.teams : 'unknown';
        if (data.outlook) {
            const event = visibleOutlookEvent(data.outlook.title, data.outlook.date);
            if (event) { this.visibleEvent = event; this.emit('calendar', event); }
        }
        for (const app of ['apple', 'whatsapp', 'teams'] as const) {
            if (!this.enabledApps.includes(app)) continue;
            const ax = data.trusted ? (data.calls?.[app] || (app === 'teams' ? data.teams : 'unknown')) : 'unknown';
            const audio = data.audio?.supported ? data.audio.apps[app] : undefined;
            const duplex = Boolean(audio?.input && audio.output);
            const appleId = this.states.get('apple')?.callId;
            const endedApple = app === 'apple' && appleId && this.appleCallUISeen === appleId && data.appleCallUI === false && audio && !audio.input && !audio.output;
            // The Phone/FaceTime main window may show navigation while a separate
            // call panel is active. Its navigation is not proof of hangup.
            const idle = (ax === 'idle' && !duplex && (app !== 'apple' || data.appleCallUI === false)) || endedApple;
            const samples = idle ? (this.idleSamples.get(app) || 0) + 1 : 0;
            this.idleSamples.set(app, samples);
            if (ax === 'ringing') {
                if (app === 'teams') this.apiEndedCall = false;
                this.setState('ringing', 'accessibility', labels[app] + ' incoming-call controls detected.', app);
            } else if (app === 'teams' && (this.apiState === 'active' || this.apiEndedCall)) this.setState(this.apiState, 'local-api', 'Teams local API connected.', app);
            else if (ax === 'active') this.setState('active', 'accessibility', labels[app] + ' call controls detected.', app);
            else if (duplex) this.setState('active', 'audio-activity', labels[app] + ' has an active microphone and output stream. Incoming/ringing is not confirmed.', app);
            else if (idle && samples >= 3) this.setState('idle', 'accessibility', labels[app] + ' call ended: app controls and audio are inactive.', app);
            else if (app === 'teams' && this.apiState === 'idle' && !this.states.get(app)?.callId) this.setState('idle', 'local-api', 'Teams local API connected.', app);
            else this.setState('unknown', 'accessibility', data.trusted ? 'Waiting for reliable ' + labels[app] + ' call signals.' : 'Enable Accessibility for the terminal running Sylloom.', app);
            if (app === 'apple' && data.appleCallUI && this.states.get('apple')?.callId) this.appleCallUISeen = this.states.get('apple')!.callId;
        }
    }
    setState(state: CallState, source: string, message: string, app: CallApp = 'teams'): void {
        if (this.closed) return;
        const previous = this.states.get(app);
        const active = state === 'ringing' || state === 'active';
        const existing = Boolean(previous?.callId && previous.state !== 'idle');
        const callId = active && !existing ? ++this.sequence : previous?.callId || 0;
        const next: CallSnapshot = { state, source, message, since: state === previous?.state ? previous.since : new Date().toISOString(), callId, accessibility: this.trusted, app };
        this.states.set(app, next);
        const calls = [...this.states.values()];
        const ringing = calls.filter(call => call.state === 'ringing').sort((a, b) => b.callId - a.callId)[0];
        const current = this.snapshot.app ? this.states.get(this.snapshot.app) : undefined;
        this.snapshot = ringing || (current?.state === 'active' ? current : calls.find(call => call.state === 'active')) ||
            (current || next);
        this.emit('update', this.snapshot);
    }
    async close(): Promise<void> {
        this.closed = true; clearInterval(this.polling); clearTimeout(this.reconnect); clearTimeout(this.timeout);
        this.socket?.close(); await this.observer?.terminate(); this.observer = undefined;
    }
}
export function visibleOutlookEvent(title: string, label: string): CalendarEvent | undefined {
    const match = label.match(/(\d{1,2})\.?\s+(\p{L}+)\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(?:to|bis|–|-)\s+(\d{1,2}):(\d{2})/u);
    if (!match) return undefined;
    const months = ['en', 'de'].flatMap(locale => Array.from({ length: 12 }, (_, month) => ({ month, name: new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, month, 1)).toLowerCase() })));
    const month = months.find(value => value.name === match[2]!.toLowerCase())?.month;
    if (month === undefined) return undefined;
    const start = new Date(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]));
    if (start.getFullYear() !== Number(match[3]) || start.getMonth() !== month || start.getDate() !== Number(match[1]) ||
        Number(match[4]) > 23 || Number(match[6]) > 23 || Number(match[5]) > 59 || Number(match[7]) > 59) return undefined;
    const end = new Date(Number(match[3]), month, Number(match[1]), Number(match[6]), Number(match[7]));
    if (end <= start) end.setDate(end.getDate() + 1);
    return normalizeEvent({ source: 'outlook-visible', calendarId: 'visible-calendar', uid: title, occurrence: start.toISOString(), title,
        start: start.toISOString(), end: end.toISOString(), allDay: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}
