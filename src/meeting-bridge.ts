import { EventEmitter } from 'node:events';
import { Recorder } from './recorder.js';
import { createSession, saveSettings } from './store.js';
import { startControl } from './control.js';
import { calendarRange, cachedCalendar, readLocalCalendar } from './calendar.js';
import type { CalendarSnapshot, CalendarEvent } from './calendar.js';
import { CallDetector, enabledCallApps } from './calls.js';
import { createCallPopup } from './native/call-popup.js';
import type { Popup } from './native/call-popup.js';
import { notify } from './clipboard.js';
import { onShutdown } from './lifecycle.js';
import { errorMessage } from './types.js';
import { MeetingReminders } from './reminders.js';
import { openExternal } from './insights-ui.js';
import type { Session, Settings } from './types.js';
import type { DictationService } from './dictation.js';
import type { Screen } from './terminal/screen.js';

export class MeetingBridge extends EventEmitter {
    revision = 0;
    finishRequested = false;
    private starting?: Promise<void>;
    private closeTask?: Promise<void>;
    private closed = false;
    private unregister = () => {};
    private capture?: { session: Session; recorder: Recorder; closeControl?: () => Promise<void>; callId?: number; detector?: CallDetector; origin: string };
    private startingCapture = false;
    private captureStart?: Promise<string>;
    private stoppingCapture?: Promise<string | undefined>;
    private refreshing?: Promise<void>;
    private calendarAbort = new AbortController();
    private calendar?: CalendarSnapshot;
    private visibleEvents = new Map<string, CalendarEvent>();
    private detector?: CallDetector;
    private popup?: Popup;
    private shownCalls = new Set<number>();
    private callEndTimer?: NodeJS.Timeout;
    private offeredCall?: number;
    private later?: NodeJS.Timeout;
    private calendarTimer?: NodeJS.Timeout;
    private reminderTimer?: NodeJS.Timeout;
    private reminders = new MeetingReminders();
    private offeredEvent?: CalendarEvent;
    private checkingReminder = false;
    private lastCall = '';
    progress = '';
    constructor(readonly config: Settings, readonly service: DictationService, private screen?: Screen,
        private options: { native?: boolean; detector?: CallDetector; popup?: Popup; recorder?: (session: Session) => Recorder } = {}) { super(); }
    private changed(): void { this.revision++; this.emit('update'); }
    get recording(): boolean { return Boolean(this.capture || this.startingCapture); }
    get working(): boolean { return Boolean(this.screen?.taskActive); }
    get call() { return this.detector?.snapshot || { state: 'unknown', source: 'none', message: 'Local bridge is disabled.', since: '', callId: 0, accessibility: false }; }
    get currentSession(): Session | undefined { return this.capture?.session; }
    get currentRecorder(): Recorder | undefined { return this.capture?.recorder; }
    get captureStatus(): string[] {
        const capture = this.capture;
        if (!capture) return [];
        const owner = capture.detector === this.detector && capture.callId ? this.detector?.stateFor(capture.callId) : undefined;
        return ['Started from: ' + capture.origin,
            !capture.callId || !this.config.callAutoStop ? 'Auto-stop Off. Stop this recording manually.' :
                !owner || owner.state === 'unknown' ? 'Auto-stop unavailable, recording continues. Stop manually.' :
                owner.state === 'idle' ? 'This call ended. Waiting for stable hangup before stopping.' : 'Auto-stop follows this call only. A new call cannot take over this recording.'];
    }
    start(): Promise<void> { return this.starting ||= this.initialize(); }
    private async initialize(): Promise<void> {
        this.calendar = await cachedCalendar();
        await this.reminders.load().catch(error => { this.progress = errorMessage(error); });
        this.unregister = onShutdown(() => this.close());
        if (this.closed) return;
        if (this.config.bridgeEnabled && (this.options.native !== false || this.options.detector)) this.listenCalls();
        this.configureCalendar();
    }
    configureCalendar(): void {
        clearInterval(this.calendarTimer); clearInterval(this.reminderTimer);
        if (!this.config.meetingReminders && this.offeredEvent) { this.offeredEvent = undefined; this.popup?.hide(); }
        if (this.detector) this.detector.readOutlook = this.config.calendarOutlook;
        this.changed();
        if (this.closed || this.options.native === false) return;
        if (this.config.calendarAutoRefresh) {
            void this.refreshCalendar().catch(() => {});
            this.calendarTimer = setInterval(() => { void this.refreshCalendar().catch(() => {}); }, 60000); this.calendarTimer.unref();
        }
        this.reminderTimer = setInterval(() => { void this.checkReminders().catch(error => { this.progress = errorMessage(error); this.changed(); }); }, 15000); this.reminderTimer.unref();
    }
    private reminderBlocked(): boolean {
        return this.closed || this.offeredCall !== undefined || !this.config.meetingReminders || this.recording || this.working || this.service.busy || Boolean(this.screen?.recordingActive) || ['active', 'ringing'].includes(this.call.state);
    }
    async checkReminders(now = Date.now()): Promise<void> {
        if (this.offeredEvent && (Date.parse(this.offeredEvent.start) <= now || this.reminderBlocked())) {
            this.offeredEvent = undefined; this.popup?.hide();
        }
        if (this.checkingReminder || this.offeredEvent || this.reminderBlocked()) return;
        if (!this.calendar || this.calendar.stale || now - Date.parse(this.calendar.updatedAt) > 10 * 60000) return;
        this.checkingReminder = true;
        try {
            const event = await this.reminders.next(this.allEvents(), this.config.reminderMinutes, now);
            if (!event || this.reminderBlocked()) return;
            const minutes = Math.max(1, Math.ceil((Date.parse(event.start) - now) / 60000));
            if (!this.showPopup('Teams meeting in ' + minutes + ' min', event.title,
                [...(event.joinUrl ? [{ id: 'join', label: 'Open Teams' }] : []), { id: 'dismiss', label: 'Dismiss' }], false)) return;
            this.offeredEvent = event;
            await this.reminders.markShown(event, now);
        } finally { this.checkingReminder = false; }
    }
    private listenCalls(): void {
        this.detector = this.options.detector || new CallDetector(this.config.teamsPort);
        this.detector.enabledApps = enabledCallApps(this.config);
        this.detector.readOutlook = this.config.calendarOutlook;
        this.detector.on('update', () => this.callChanged());
        this.detector.on('calendar', (event: CalendarEvent) => {
            if (this.visibleEvents.has(event.id)) return;
            this.visibleEvents.set(event.id, event);
            if (this.visibleEvents.size > 500) this.visibleEvents.delete(this.visibleEvents.keys().next().value!);
            this.changed();
        });
        this.detector.start();
    }
    async setBridge(enabled: boolean): Promise<void> {
        clearTimeout(this.callEndTimer); this.callEndTimer = undefined; this.offeredCall = undefined;
        this.config.bridgeEnabled = enabled; await saveSettings(this.config);
        await this.detector?.close(); this.detector = undefined; this.offeredEvent = undefined; this.popup?.hide();
        this.shownCalls.clear(); this.lastCall = '';
        if (enabled && this.options.native !== false) this.listenCalls();
    }
    private showPopup(title: string, detail: string, actions: { id: string; label: string }[], fallback = true): boolean {
        if (this.closed || (this.options.native === false && !this.options.popup)) return false;
        try {
            this.popup ||= this.options.popup || createCallPopup(id => { void this.popupAction(id).catch(error => { this.progress = errorMessage(error); notify(this.progress); }); });
            this.popup.show(title, detail, actions);
            this.offeredEvent = undefined;
            return true;
        } catch (error) {
            this.progress = 'Popup could not be displayed. ' + errorMessage(error); this.changed();
            if (fallback) notify(title + ' · ' + detail);
            return false;
        }
    }
    private callChanged(): void {
        const call = this.call;
        if (['ringing', 'active'].includes(call.state) && this.offeredEvent) { this.offeredEvent = undefined; this.popup?.hide(); }
        const owner = this.capture?.detector === this.detector && this.capture?.callId ? this.detector?.stateFor(this.capture.callId) : undefined;
        const key = JSON.stringify([call.state, call.source, call.callId, call.message, call.accessibility]);
        if (key !== this.lastCall) { this.lastCall = key; this.changed(); }
        if (owner?.state !== 'idle') { clearTimeout(this.callEndTimer); this.callEndTimer = undefined; }
        if (call.state === 'idle' && this.offeredCall !== undefined) { this.offeredCall = undefined; if (!this.capture) this.popup?.hide(); }
        if (this.config.callAutoStop && this.capture && owner?.state === 'idle' && !this.callEndTimer) {
            const id = this.capture.session.id;
            // A disconnected observer emits unknown. Only a stable, confirmed idle
            // state can stop the capture belonging to this particular call.
            this.callEndTimer = setTimeout(() => {
                this.callEndTimer = undefined;
                const owner = this.capture?.detector === this.detector && this.capture?.callId ? this.detector?.stateFor(this.capture.callId) : undefined;
                if (this.config.callAutoStop && owner?.state === 'idle' && this.capture?.session.id === id) {
                    void this.stopRecording().catch(error => { this.progress = errorMessage(error); this.changed(); });
                }
            }, 1500); this.callEndTimer.unref();
        }
        if (!['ringing', 'active'].includes(call.state) || this.shownCalls.has(call.callId) || this.recording || this.working || this.service.busy || this.screen?.taskActive || this.screen?.recordingActive) return;
        this.shownCalls.add(call.callId);
        this.offeredEvent = undefined;
        this.offeredCall = call.callId;
        const app = call.app === 'apple' ? 'FaceTime / iPhone' : call.app === 'whatsapp' ? 'WhatsApp' : 'Teams';
        this.showPopup(call.state === 'ringing' ? 'Incoming call' : call.source === 'audio-activity' ? 'Audio session detected' : 'Call detected', app + (this.config.callAutoStop ? ' · Record? Auto-stop on hangup.' : ' · Record this call?'),
            [{ id: 'record', label: 'Record' }, { id: 'dismiss', label: 'Dismiss' }]);
    }
    private async popupAction(action: string): Promise<void> {
        this.popup?.hide();
        const event = this.offeredEvent;
        this.offeredEvent = undefined;
        if (action === 'join' && event?.joinUrl && this.config.meetingReminders && Date.parse(event.start) > Date.now()) await openExternal(event.joinUrl);
        if (action === 'record') {
            if (!['active', 'ringing'].includes(this.call.state) || this.offeredCall !== this.call.callId) throw new Error('The call is no longer detected. Start a meeting from Sylloom if needed.');
            await this.startRecording();
        }
        this.offeredCall = undefined;
        if (action === 'stop') await this.stopRecording();
        if (action === 'finish') { this.finishRequested = true; this.changed(); notify('Open Sylloom to name the recording and choose what to keep.'); }
        if (action === 'later') {
            const id = this.call.callId; clearTimeout(this.later);
            this.later = setTimeout(() => { if (this.call.callId === id) { this.shownCalls.delete(id); this.callChanged(); } }, 60000); this.later.unref();
        }
    }
    async refreshCalendar(anchor = new Date(), requestAccess = false): Promise<void> {
        if (this.refreshing) await this.refreshing;
        if (this.closed) return;
        const range = calendarRange(anchor);
        this.refreshing = readLocalCalendar(this.config, range.from, range.to, requestAccess, this.calendarAbort.signal).then(async value => { this.calendar = value; this.changed(); await this.checkReminders(); }).finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }
    private allEvents(): CalendarEvent[] {
        const events = new Map((this.calendar?.events || []).map(event => [event.id, event]));
        for (const event of this.visibleEvents.values()) events.set(event.id, event);
        return [...events.values()].filter(event => event.source === 'outlook' || event.source === 'outlook-visible' ? this.config.calendarOutlook : event.source === 'system' ? this.config.calendarSystem : true).sort((a, b) => a.start.localeCompare(b.start));
    }
    startRecording(): Promise<string> {
        if (this.closed) return Promise.reject(new Error('The bridge is closing.'));
        if (this.recording || this.working || this.service.busy || this.screen?.taskActive || this.screen?.recordingActive) return Promise.reject(new Error('Another recording or processing task is active.'));
        return this.captureStart = this.beginRecording();
    }
    private async beginRecording(): Promise<string> {
        if (this.recording || this.working || this.service.busy || this.screen?.taskActive || this.screen?.recordingActive) throw new Error('Another recording or processing task is active.');
        this.startingCapture = true;
        if (this.screen) this.screen.recordingActive = true;
        try {
            await this.service.releaseModels();
            if (this.closed) throw new Error('The bridge is closing.');
            const session = await createSession();
            const recorder = this.options.recorder?.(session) || new Recorder(session, this.config);
            this.capture = { session, recorder, detector: this.detector, callId: ['active', 'ringing'].includes(this.call.state) ? this.call.callId : undefined,
                origin: ['active', 'ringing'].includes(this.call.state) ? (this.call.app === 'apple' ? 'FaceTime / iPhone' : this.call.app === 'whatsapp' ? 'WhatsApp' : 'Teams') + ' · call ' + this.call.callId : 'Manual recording' };
            if (this.closed) throw new Error('The bridge is closing.');
            recorder.on('stopRequested', () => { void this.stopRecording().catch(error => { this.progress = errorMessage(error); }); });
            recorder.on('failure', error => { this.progress = errorMessage(error); void this.stopRecording().catch(() => {}); });
            await recorder.start();
            if (!this.capture || this.capture.session.id !== session.id) throw new Error('Recording stopped during startup. Audio remains saved.');
            const closeControl = await startControl(recorder);
            if (this.closed || this.capture?.session.id !== session.id) { await closeControl(); throw new Error('Recording stopped during startup.'); }
            this.capture.closeControl = closeControl;
            this.progress = 'Recording microphone and system audio';
            this.changed();
            this.showPopup('Recording meeting', 'Microphone and system audio stay on this computer.', [{ id: 'stop', label: 'Stop' }, { id: 'dismiss', label: 'Hide' }]);
            return session.id;
        } catch (error) {
            await this.stopRecording();
            if (/still pending/i.test(errorMessage(error))) this.showPopup('Recording needs a decision', 'Finish the saved recording before starting another.', [{ id: 'finish', label: 'Finish' }, { id: 'dismiss', label: 'Dismiss' }]);
            throw error;
        }
        finally { this.startingCapture = false; if (!this.capture && this.screen) this.screen.recordingActive = false; }
    }
    stopRecording(): Promise<string | undefined> {
        if (this.stoppingCapture) return this.stoppingCapture;
        const current = this.capture; if (!current) return Promise.resolve(undefined);
        this.stoppingCapture = (async () => {
            try { await current.recorder.stop(); }
            finally {
                try { await current.closeControl?.(); }
                finally { clearTimeout(this.callEndTimer); this.callEndTimer = undefined; this.capture = undefined; if (this.screen) this.screen.recordingActive = false; this.stoppingCapture = undefined; this.changed(); }
            }
            this.progress = 'Recording saved. Name it and choose what to keep.';
            this.changed();
            this.showPopup('Recording saved', 'Name the recording and choose what happens to its transcript.', [{ id: 'finish', label: 'Finish' }, { id: 'dismiss', label: 'Later' }]);
            return current.session.id;
        })();
        return this.stoppingCapture;
    }
    async snapshot() {
        return { capture: this.capture?.session.id, processing: this.working || this.service.busy, progress: this.progress,
            call: this.call, bridgeEnabled: this.config.bridgeEnabled, calendar: this.calendar };
    }
    close(): Promise<void> { return this.closeTask ||= this.finishClose(); }
    private async finishClose(): Promise<void> {
        this.closed = true; this.calendarAbort.abort(); clearTimeout(this.callEndTimer); await this.starting?.catch(() => {}); this.unregister(); clearTimeout(this.later); clearInterval(this.calendarTimer); clearInterval(this.reminderTimer); this.popup?.close();
        await this.refreshing?.catch(() => {});
        await this.detector?.close(); await this.stopRecording(); await this.captureStart?.catch(() => {}); await this.stopRecording();
    }
}
