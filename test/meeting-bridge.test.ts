import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { Session } from '../src/types.js';
import type { Recorder } from '../src/recorder.js';
import type { Dictation } from '../src/dictation.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-bridge-'));
process.env.SYLLOOM_HOME = root;
const { defaults, saveSession, loadSession, sessionDirectory } = await import('../src/store.js');
const { parseCalendarFile, normalizeEvent } = await import('../src/calendar.js');
const { CallDetector, visibleOutlookEvent } = await import('../src/calls.js');
const { MeetingBridge } = await import('../src/meeting-bridge.js');
const { DictationService } = await import('../src/dictation.js');
const { searchLibrary, loadLibrary, validDay } = await import('../src/library.js');
const { formatDictation } = await import('../src/formatter.js');
const { manageSettings } = await import('../src/settings-ui.js');
const { upcomingTeamsMeetings, MeetingReminders } = await import('../src/reminders.js');
const calendar = (events: string) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + events.trim().replace(/\n/g, '\r\n') + '\r\nEND:VCALENDAR';

test('calendar expands exclusions and moved/canceled exceptions with stable occurrence identities', () => {
    const events = parseCalendarFile(calendar(`BEGIN:VEVENT
UID:weekly-test
DTSTART:20261019T090000Z
DTEND:20261019T100000Z
SUMMARY:Planning
RRULE:FREQ=DAILY;COUNT=5
EXDATE:20261020T090000Z
END:VEVENT
BEGIN:VEVENT
UID:weekly-test
RECURRENCE-ID:20261021T090000Z
DTSTART:20261022T140000Z
DTEND:20261022T150000Z
SUMMARY:Moved planning
END:VEVENT
BEGIN:VEVENT
UID:weekly-test
RECURRENCE-ID:20261023T090000Z
DTSTART:20261023T090000Z
DTEND:20261023T100000Z
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:weekly-test
RECURRENCE-ID:20261101T090000Z
DTSTART:20261021T160000Z
DTEND:20261021T170000Z
SUMMARY:Moved from next month
END:VEVENT`), '2026-10-19T00:00:00Z', '2026-10-24T00:00:00Z');
    assert.deepEqual(events.map(e => e.start), ['2026-10-19T09:00:00.000Z', '2026-10-21T16:00:00.000Z', '2026-10-22T09:00:00.000Z', '2026-10-22T14:00:00.000Z']);
    assert.equal(events.find(e => e.title === 'Moved planning')?.occurrence, '2026-10-21T09:00:00Z');
    assert.notEqual(events[2]!.id, events[3]!.id);
});

test('calendar keeps wall time across daylight saving and does not borrow timezone definitions from another file', () => {
    const zones = `BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE`;
    const event = `BEGIN:VEVENT
UID:dst-test
DTSTART;TZID=Europe/Berlin:20261024T090000
DTEND;TZID=Europe/Berlin:20261024T100000
SUMMARY:DST meeting
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT`;
    const from = '2026-10-23T00:00:00Z', to = '2026-10-28T00:00:00Z';
    assert.deepEqual(parseCalendarFile(calendar(zones + '\n' + event), from, to).map(e => e.start), ['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
    assert.throws(() => parseCalendarFile(calendar(event), from, to), /VTIMEZONE/);
    assert.equal(visibleOutlookEvent('Invalid', '31. February 2026 10:00 to 11:00'), undefined);
});

test('call detection separates lost observation from hangup and deduplicates reconnects', async () => {
    const calls = new CallDetector(); const observe = (teams: 'idle' | 'ringing' | 'active' | 'unknown') => calls.observe({ trusted: true, teams });
    const api = (isInMeeting: boolean) => calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting } } }));
    api(false); observe('ringing'); assert.equal(calls.snapshot.callId, 1);
    observe('active'); assert.equal(calls.snapshot.state, 'active', 'a stale initial idle snapshot cannot override new app controls');
    observe('unknown'); assert.equal(calls.snapshot.state, 'unknown');
    observe('active'); assert.equal(calls.snapshot.callId, 1);
    observe('idle'); observe('idle'); assert.equal(calls.snapshot.state, 'unknown');
    observe('idle'); assert.equal(calls.snapshot.state, 'idle');
    observe('active'); assert.equal(calls.snapshot.callId, 2);
    api(true); observe('unknown'); assert.equal(calls.snapshot.state, 'active');
    api(false); assert.equal(calls.snapshot.state, 'idle');
    await calls.close(); api(true); assert.equal(calls.snapshot.state, 'idle');
});

class FakeRecorder extends EventEmitter {
    stops = 0;
    current = { mic: 'fixture', system: 'fixture' };
    muted = { mic: false, system: false };
    health = { mic: 'Ready', system: 'Ready' };
    constructor(readonly session: Session) { super(); }
    async start() { await writeFile(path.join(sessionDirectory(this.session.id), 'mic.wav'), Buffer.from('RIFF fixture audio')); }
    async stop() { if (this.stops) return; this.stops++; this.session.state = 'stopped'; this.session.stoppedAt = new Date().toISOString(); await saveSession(this.session); }
}

test('recording begun during Teams preview survives not joined and stops only after a real meeting ends', async () => {
    const calls = new CallDetector(); calls.start = () => {};
    const config = { ...defaults, detectAppleCalls: false, detectWhatsAppCalls: false, calendarOutlook: false, calendarSystem: false, calendarAutoRefresh: false };
    const service = new DictationService(config); let recorder!: FakeRecorder;
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, recorder: session => (recorder = new FakeRecorder(session)) as unknown as Recorder });
    const api = (isInMeeting: boolean) => calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting } } }));
    try {
        await bridge.start();
        calls.observe({ trusted: true, teams: 'idle', audio: { supported: true, apps: { teams: { input: true, output: true } } } });
        const callId = calls.snapshot.callId;
        const id = await bridge.startRecording();
        api(false); calls.observe({ trusted: true, teams: 'joining' }); api(false);
        await delay(1650);
        assert.equal(bridge.recording, true, 'Preview must not stop the recording or open the naming flow');
        assert.equal(recorder.stops, 0); assert.equal(bridge.finishRequested, false);
        api(true); assert.equal(calls.snapshot.callId, callId);
        api(false); api(false); calls.observe({ trusted: true, teams: 'unknown' });
        await delay(1650);
        assert.equal(bridge.recording, false); assert.equal(recorder.stops, 1);
        const session = await loadSession(id);
        assert.equal(session.name, null); assert.equal(session.decision, null);
        session.name = 'Finished preview fixture'; session.decision = 'delete'; session.state = 'done'; await saveSession(session);
    } finally { await bridge.close(); await service.close(); }
});

test('a Teams preview withdraws its provisional popup and joining the meeting offers recording again', async () => {
    const calls = new CallDetector(); calls.start = () => {};
    const config = { ...defaults, detectAppleCalls: false, detectWhatsAppCalls: false, calendarOutlook: false, calendarSystem: false, calendarAutoRefresh: false };
    const service = new DictationService(config); const shown: string[] = []; let hidden = 0;
    const popup = { show(title: string) { shown.push(title); }, hide() { hidden++; }, close() {} };
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, popup });
    try {
        await bridge.start();
        calls.observe({ trusted: true, teams: 'joining', audio: { supported: true, apps: { teams: { input: true, output: true } } } });
        assert.equal(shown.length, 0, 'Preview audio is not an incoming call');
        calls.observe({ trusted: true, teams: 'unknown', audio: { supported: true, apps: { teams: { input: true, output: true } } } });
        assert.equal(shown.length, 1); const id = calls.snapshot.callId;
        calls.observe({ trusted: true, teams: 'joining' });
        assert.equal(hidden, 1);
        calls.observe({ trusted: true, teams: 'active' });
        assert.equal(calls.snapshot.callId, id); assert.equal(shown.length, 2);
        assert.equal(shown.at(-1), 'Call detected'); assert.equal(bridge.recording, false);
    } finally { await bridge.close(); await service.close(); }
});

test('call-linked capture stops on confirmed hangup and preserves mandatory decisions', async () => {
    const calls = new CallDetector(); calls.start = () => {};
    const config = { ...defaults, calendarOutlook: false, calendarSystem: false, calendarAutoRefresh: false };
    const service = new DictationService(config); let recorder!: FakeRecorder;
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, recorder: session => (recorder = new FakeRecorder(session)) as unknown as Recorder });
    try {
        await bridge.start(); calls.setState('active', 'local-api', 'Fixture call');
        const start = bridge.startRecording(); await assert.rejects(bridge.startRecording(), /active/); const id = await start;
        calls.setState('idle', 'local-api', 'Ended'); calls.setState('unknown', 'local-api', 'Disconnected');
        await delay(1600); assert.equal(bridge.recording, true, 'a detector outage must cancel automatic stop');
        calls.setState('idle', 'local-api', 'Confirmed ended'); await delay(1650);
        assert.equal(bridge.recording, false); assert.equal(recorder.stops, 1);
        const session = await loadSession(id); assert.equal(session.state, 'stopped'); assert.equal(session.name, null); assert.equal(session.decision, null);
        const nextId = await bridge.startRecording();
        assert.notEqual(nextId, id, 'A stopped pending decision must not block the next call');
        assert.equal((await loadSession(id)).decision, null);
        await bridge.stopRecording();
        session.state = 'done'; session.name = 'Finished fixture'; session.decision = 'delete'; await saveSession(session);
    } finally { await bridge.close(); await service.close(); }
});

test('only the call that started capture may stop it, even when another app owns the popup', async () => {
    const calls = new CallDetector(); calls.start = () => {};
    const config = { ...defaults, calendarOutlook: false, calendarSystem: false, calendarAutoRefresh: false };
    const service = new DictationService(config); let recorder!: FakeRecorder;
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, recorder: session => (recorder = new FakeRecorder(session)) as unknown as Recorder });
    try {
        await bridge.start(); calls.setState('active', 'audio-activity', 'Apple call', 'apple');
        const id = await bridge.startRecording();
        calls.setState('idle', 'local-api', 'Teams idle', 'teams'); await delay(1600);
        assert.equal(bridge.recording, true, 'idle Teams must not stop the Apple capture');
        calls.setState('ringing', 'accessibility', 'WhatsApp incoming', 'whatsapp');
        calls.setState('idle', 'accessibility', 'Apple hangup', 'apple');
        assert.equal(calls.snapshot.app, 'whatsapp', 'another app still owns the displayed state');
        await delay(1650); assert.equal(bridge.recording, false); assert.equal(recorder.stops, 1);
        const session = await loadSession(id);
        assert.equal(session.name, null); assert.equal(session.decision, null);
        session.name = 'Finished ownership fixture'; session.decision = 'delete'; session.state = 'done'; await saveSession(session);
    } finally { await bridge.close(); await service.close(); }
});

test('a new call and its preview in the same app cannot erase the captured call hangup during auto-stop debounce', async () => {
    const calls = new CallDetector(); calls.start = () => {};
    const config = { ...defaults, calendarOutlook: false, calendarSystem: false, calendarAutoRefresh: false };
    const service = new DictationService(config); let recorder!: FakeRecorder;
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, recorder: session => (recorder = new FakeRecorder(session)) as unknown as Recorder });
    const api = (isInMeeting: boolean) => calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting } } }));
    try {
        await bridge.start(); api(true); const owner = calls.snapshot.callId;
        const id = await bridge.startRecording();
        api(false);
        calls.setState('ringing', 'accessibility', 'Next Teams call');
        calls.setState('joining', 'accessibility', 'Next Teams preview');
        api(true);
        assert.notEqual(calls.snapshot.callId, owner); assert.equal(calls.snapshot.state, 'active');
        assert.equal(calls.stateFor(owner)?.state, 'idle');
        await delay(1650);
        assert.equal(bridge.recording, false); assert.equal(recorder.stops, 1);
        const session = await loadSession(id);
        assert.equal(session.name, null); assert.equal(session.decision, null);
        session.name = 'Finished consecutive call fixture'; session.decision = 'delete'; session.state = 'done'; await saveSession(session);
    } finally { await bridge.close(); await service.close(); }
});

test('CLI stop receives its acknowledgement before the bridge closes the control socket', async () => {
    const service = new DictationService({ ...defaults });
    const bridge = new MeetingBridge({ ...defaults }, service, undefined, { native: false, recorder: session => new FakeRecorder(session) as unknown as Recorder });
    try {
        await bridge.start(); const id = await bridge.startRecording();
        const { control } = await import('../src/control.js');
        const result = await control('stop') as { ok: boolean; id: string; state: string };
        assert.equal(result.ok, true); assert.equal(result.id, id); assert.equal(result.state, 'stopped');
        const deadline = Date.now() + 1000; while (bridge.recording && Date.now() < deadline) await delay(5);
        assert.equal(bridge.recording, false);
    } finally { await bridge.close(); await service.close(); }
});

test('date and status filters handle inclusive local dates and malformed dates', async () => {
    const item: Dictation = { id: randomUUID(), name: 'Date fixture', startedAt: new Date(2026, 9, 18, 23, 59).toISOString(), stoppedAt: null, state: 'stopped', outcome: 'failed', decision: null, recovered: false, events: [], format: 'message', raw: 'Example text' };
    const folder = path.join(root, 'dictations', item.id); await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'session.json'), JSON.stringify(item));
    const library = (await loadLibrary()).items;
    assert.equal(searchLibrary(library, '', { kind: 'dictation', from: '2026-10-18', to: '2026-10-18', status: 'failed' })[0]?.id, item.id);
    assert.equal(searchLibrary(library, '', { kind: 'dictation', from: '2026-10-19' }).length, 0);
    assert.equal(validDay('2026-02-31'), false); assert.equal(validDay('2028-02-29'), true);
    const text = 'äh bitte genau SO lassen'; assert.equal(await formatDictation(text, 'email', { ...defaults, dictationPolish: 'off' }), text);
});

test('settings discard drafts, save switches and preserve unrelated live settings', async () => {
    const config = { ...defaults }; let actions = ['dictation', 'dictationAutoInsert', 'back', 'dictation', 'dictationAutoInsert', 'save', 'back'];
    const screen = { quitRequested: false, select: async (title: string, rows: { value: string; toggle?: boolean }[]) => {
        if (title === 'Settings' && actions.length === 4) assert.equal(config.dictationAutoInsert, true, 'Esc must discard the first edit');
        if (title === 'Settings / Dictation') assert.equal(typeof rows[0]!.toggle, 'boolean');
        return actions.shift()!;
    } } as unknown as import('../src/terminal/screen.js').Screen;
    await manageSettings(screen, config, async () => {});
    assert.equal(config.dictationAutoInsert, false); assert.equal(config.callAutoStop, true);
    assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).dictationAutoInsert, false);
});

test('failed recognition retries preserve the original text, metadata and transcript file', async () => {
    const item: Dictation = { id: randomUUID(), name: 'Retry fixture', startedAt: '2026-10-18T10:00:00Z', stoppedAt: '2026-10-18T10:00:20Z', state: 'done', outcome: 'completed', decision: null, recovered: false, events: [], format: 'message', raw: 'Previous original.', text: 'Previous formatted.' };
    const directory = path.join(root, 'dictations', item.id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'session.json'), JSON.stringify(item)); await writeFile(path.join(directory, 'transcript.md'), 'Previous transcript file');
    const service = new DictationService({ ...defaults, dictationNotifications: false });
    try {
        await service.retry(item, 'email', true);
        const result = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
        assert.equal(result.raw, item.raw); assert.equal(result.text, item.text); assert.equal(result.format, 'message');
        assert.equal(await readFile(path.join(directory, 'transcript.md'), 'utf8'), 'Previous transcript file');
        assert.match(service.message, /Previous result preserved/);
    } finally { await service.close(); }
});

test('terminal switches preserve selection and respond to Space, while secret fields never render their value', async () => {
    const { Screen } = await import('../src/terminal/screen.js');
    const screen = Object.create(Screen.prototype); let output = '';
    screen.frame = (_title: string, _detail: string, lines: string[]) => { output = lines.join('\n'); };
    const selected = screen.select('Settings', [{ value: 'a', name: 'First', toggle: false }, { value: 'b', name: 'Second', toggle: true }], { initialValue: 'b' });
    assert.match(output, /First[^\n]*│ Off/); assert.match(output, /Second[^\n]*│ On/);
    screen.keyHandler(' ', { name: 'space' }); assert.equal(await selected, 'b');
    const input = screen.input('Token', 'Hidden input', '', { secret: true });
    screen.keyHandler('fixture-secret', {}); assert.ok(!output.includes('fixture-secret')); assert.match(output, /•/);
    screen.keyHandler('', { name: 'return' }); assert.equal(await input, 'fixture-secret');
});

test('closing during model release cannot start an orphan recording after shutdown', async () => {
    let released!: () => void;
    const gate = new Promise<void>(resolve => { released = resolve; });
    const service = new DictationService({ ...defaults }); service.releaseModels = () => gate;
    let created = false;
    const bridge = new MeetingBridge({ ...defaults }, service, undefined, { native: false, recorder: () => { created = true; throw Error('Must not create recorder'); } });
    const starting = bridge.startRecording(); const closed = bridge.close(); released();
    await assert.rejects(starting, /closing/); await closed; assert.equal(created, false); await service.close();
});

test('meeting reminders use the configured lead time, require Teams and survive restart without repeating', async () => {
    const now = Date.parse('2026-10-19T10:00:00Z');
    const event = (offset: number, changes = {}) => normalizeEvent({ source: 'ics', calendarId: 'reminders', uid: 'fixture-' + offset,
        occurrence: new Date(now + offset * 60000).toISOString(), title: 'Reminder fixture', start: new Date(now + offset * 60000).toISOString(),
        end: new Date(now + (offset + 30) * 60000).toISOString(), timezone: 'UTC', allDay: false, joinUrl: 'https://teams.microsoft.com/l/meetup-join/fictional', ...changes });
    const soon = event(4), later = event(6), other = event(3, { joinUrl: undefined }), past = event(-1), allDay = event(2, { allDay: true });
    assert.deepEqual(upcomingTeamsMeetings([later, past, other, allDay, soon], 5, now).map(e => e.id), [soon.id]);
    assert.equal(upcomingTeamsMeetings([soon], 3, now).length, 0);
    const ledger = new MeetingReminders(); await ledger.load(); assert.equal((await ledger.next([soon], 5, now))?.id, soon.id);
    assert.equal((await ledger.next([soon], 5, now))?.id, soon.id, 'selection alone does not consume the reminder');
    await ledger.markShown(soon, now);
    const restarted = new MeetingReminders(); await restarted.load(); assert.equal(await restarted.next([soon], 5, now + 1000), undefined);
    assert.equal((await restarted.next([{ ...soon, start: new Date(now + 3 * 60000).toISOString() }], 5, now))?.id, soon.id, 'a rescheduled occurrence can remind again');
    const file = await readFile(path.join(root, 'meeting-reminders.json'), 'utf8'); assert.ok(!file.includes('Reminder fixture')); assert.ok(!file.includes('teams.microsoft.com'));
    const parsed = parseCalendarFile(calendar(`BEGIN:VEVENT
UID:teams-from-description
DTSTART:20261019T100400Z
DTEND:20261019T103000Z
SUMMARY:Teams fixture
DESCRIPTION:Join https://teams.microsoft.com/l/meetup-join/fictional
END:VEVENT`), '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z');
    assert.equal(parsed[0]?.isTeams, true);
});

test('local reminder popup respects Off and active calls, deduplicates, and never starts audio', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    const event = normalizeEvent({ source: 'outlook', calendarId: 'local-fixture', uid: 'popup-reminder', occurrence: new Date(now + 240000).toISOString(),
        title: 'Popup fixture', start: new Date(now + 240000).toISOString(), end: new Date(now + 2040000).toISOString(), timezone: 'UTC', allDay: false, joinUrl: 'https://teams.microsoft.com/l/meetup-join/fictional' });
    await writeFile(path.join(root, 'calendar-cache.json'), JSON.stringify({ events: [event], statuses: [], updatedAt: new Date(now).toISOString(), from: new Date(now).toISOString(), to: event.end }));
    const config = { ...defaults, calendarOutlook: true, meetingReminders: false };
    const service = new DictationService(config), calls = new CallDetector(); calls.start = () => {};
    const titles: string[] = [];
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, popup: { show: title => { titles.push(title); }, hide() {}, close() {} }, recorder: () => { throw Error('A reminder must never create an audio recorder'); } });
    try {
        await bridge.start(); await bridge.checkReminders(now); assert.equal(titles.length, 0);
        config.meetingReminders = true; calls.setState('active', 'local-api', 'Fixture'); titles.length = 0;
        await bridge.checkReminders(now); assert.equal(titles.length, 0);
        calls.setState('idle', 'local-api', 'Fixture ended');
        await bridge.checkReminders(now); assert.deepEqual(titles, ['Teams meeting in 4 min']);
        await bridge.checkReminders(now + 1000); assert.equal(titles.length, 1); assert.equal(bridge.recording, false);
    } finally { await bridge.close(); await service.close(); }
    await writeFile(path.join(root, 'meeting-reminders.json'), '{broken');
    const corrupt = new MeetingReminders(); await assert.rejects(corrupt.load(), /preserved/); await assert.rejects(corrupt.next([event], 5, now), /preserved/);
    assert.equal(await readFile(path.join(root, 'meeting-reminders.json'), 'utf8'), '{broken');
});

after(async () => { await rm(root, { recursive: true, force: true }); });
