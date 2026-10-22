import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Session } from '../src/types.js';
import type { CalendarEvent } from '../src/calendar.js';
import type { Recorder } from '../src/recorder.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-recovery-control-'));
process.env.SYLLOOM_HOME = root;
const store = await import('../src/store.js');
const { recoverSessions, reopenSession, finishSession } = await import('../src/workflow.js');
const { Transcription, transcriptionProfile } = await import('../src/transcription.js');
const { WavWriter, RATE } = await import('../src/wav.js');
const { storageOverview } = await import('../src/storage.js');
const { loadLibrary } = await import('../src/library.js');
const { MeetingBridge } = await import('../src/meeting-bridge.js');
const { CallDetector } = await import('../src/calls.js');
const { DictationService } = await import('../src/dictation.js');
const { normalizeEvent } = await import('../src/calendar.js');

const session = (changes: Partial<Session> = {}): Session => ({ id: randomUUID(), name: 'Recovery fixture',
    startedAt: '2026-10-19T10:00:00Z', stoppedAt: '2026-10-19T10:00:01Z', state: 'done',
    decision: 'keep', recovered: false, events: [], ...changes });

test('duplicate and concurrent shutdown releases cannot remove a successor controller lock', async () => {
    const first = await store.acquireLock();
    await Promise.all([first(), first()]);
    const second = await store.acquireLock();
    try {
        await first();
        await assert.rejects(store.acquireLock(), /already running/);
    } finally { await second(); }
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => store.acquireLock()));
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    for (const item of attempts) if (item.status === 'fulfilled') await item.value();
});

test('legacy live controllers stay protected across repeated attempts; orphan PID directories recover', async () => {
    const directory = path.join(root, 'control.lock');
    await rm(path.join(root, 'controller.lock'));
    await writeFile(path.join(directory, 'pid'), String(process.pid));
    await assert.rejects(store.acquireLock(), /already running/);
    await assert.rejects(store.acquireLock(), /already running/);
    await rm(path.join(directory, 'pid'));
    const release = await store.acquireLock(); await release();
    await writeFile(path.join(directory, 'pid'), 'invalid stale diagnostic');
    const recovered = await store.acquireLock(); await recovered();
});

test('legacy directory cleanup cannot unlink the active kernel lock', async () => {
    const release = await store.acquireLock();
    try {
        await rm(path.join(root, 'control.lock'), { recursive: true });
        await assert.rejects(store.acquireLock(), /already running/);
    } finally { await release(); }
});

test('a killed controller releases its kernel lock without deleting another process lock', async () => {
    const module = new URL('../src/store.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `import { acquireLock } from ${JSON.stringify(module)}; await acquireLock(); process.stdout.write('ready'); setInterval(() => {}, 1000);`],
        { env: { ...process.env, SYLLOOM_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Controller fixture did not start')), 5000);
            child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', () => { clearTimeout(timer); reject(new Error('Controller fixture exited before ready')); });
        });
        await assert.rejects(store.acquireLock(), /already running/);
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        const recovered = await store.acquireLock(); await recovered();
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }
});

test('unreadable metadata cannot block recovery but still blocks new meetings and reprocessing', async () => {
    const damaged = session(); const healthy = session({ name: null, state: 'recording', decision: null, stoppedAt: null });
    const directory = store.sessionDirectory(damaged.id); await mkdir(directory, { recursive: true });
    const bytes = '{broken meeting metadata'; await writeFile(path.join(directory, 'session.json'), bytes);
    await store.saveSession(healthy);
    try {
        await recoverSessions();
        const catalog = await store.scanSessions();
        assert.equal(catalog.issues[0]?.id, damaged.id);
        assert.equal((await store.loadSession(healthy.id)).state, 'stopped');
        assert.equal((await store.loadSession(healthy.id)).decision, null);
        assert.equal(await readFile(path.join(directory, 'session.json'), 'utf8'), bytes);
        await assert.rejects(store.createSession(), /metadata needs attention/);
        await assert.rejects(reopenSession(session()), /metadata needs attention/);
        assert.match((await storageOverview(store.defaults)).join('\n'), new RegExp(damaged.id));
        assert.ok((await loadLibrary()).warnings.some(warning => warning.includes(damaged.id)));
    } finally { await rm(directory, { recursive: true }); await rm(store.sessionDirectory(healthy.id), { recursive: true }); }
});

test('structurally invalid metadata is isolated before sorting or recovery can crash', async () => {
    const item = session();
    for (const changes of [{ startedAt: null }, { events: [null] }, { state: 'invalid' }, { decision: null }, { transcriptionRevision: -1 }]) {
        assert.throws(() => store.validateSession({ ...item, ...changes }, item.id), /invalid or incomplete/);
    }
});

test('explicit retranscription rebuilds corrupt checkpoints and preserves their original bytes', async () => {
    const item = session(); await store.saveSession(item);
    const directory = store.sessionDirectory(item.id);
    const wav = new WavWriter(path.join(directory, 'mic.wav')); wav.append(Buffer.alloc(RATE * 2)); wav.close();
    const file = store.chunkFile(item.id, 'mic', 0); await mkdir(path.dirname(file));
    const bytes = '{broken previous checkpoint'; await writeFile(file, bytes);
    const progress: string[] = [];
    await reopenSession(item);
    await finishSession(item, 'keep', store.defaults, message => progress.push(message));
    assert.equal((await store.loadSession(item.id)).state, 'done');
    assert.ok(progress.some(message => /Rebuilding from saved audio/.test(message)));
    const rejected = path.join(directory, 'chunks', 'rejected');
    assert.equal(await readFile(path.join(rejected, (await readdir(rejected))[0]!), 'utf8'), bytes);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'done');
});

test('malformed checkpoint fields and impossible sample ranges cannot advance transcription cursors', async () => {
    const item = session({ state: 'stopped', decision: null }); await store.saveSession(item);
    const directory = store.sessionDirectory(item.id);
    const wav = new WavWriter(path.join(directory, 'mic.wav')); wav.append(Buffer.alloc(RATE * 2)); wav.close();
    const file = store.chunkFile(item.id, 'mic', 0);
    const base = { profile: transcriptionProfile(store.defaults), source: 'mic', offset: 0, samples: RATE, state: 'done', segments: [] };
    for (const change of [{ source: 'other' }, { samples: 0 }, { segments: [null] }, { samples: RATE * 2 }]) {
        await store.atomicJson(file, { ...base, ...change });
        const transcription = new Transcription(item, store.defaults);
        try { await transcription.initialize(); assert.equal(transcription.jobs.length, 0); await transcription.drain(); assert.equal(transcription.jobs[0]?.samples, RATE); }
        finally { await transcription.close(); }
    }
    await rm(directory, { recursive: true });
});

async function reminderFixture(options: { failShow?: boolean; recorder?: (item: Session) => Recorder } = {}) {
    await rm(path.join(root, 'meeting-reminders.json'), { force: true });
    const now = Date.now();
    const event = (offset: number) => normalizeEvent({ source: 'outlook', calendarId: 'fixture', uid: 'reminder-' + offset,
        occurrence: new Date(now + offset * 60000).toISOString(), title: 'Reminder ' + offset,
        start: new Date(now + offset * 60000).toISOString(), end: new Date(now + (offset + 30) * 60000).toISOString(),
        timezone: 'UTC', allDay: false, joinUrl: 'https://teams.microsoft.com/l/meetup-join/fixture' });
    const events = [event(3), event(4)];
    await store.atomicJson(path.join(root, 'calendar-cache.json'), { events, statuses: [], updatedAt: new Date(now).toISOString(), from: new Date(now).toISOString(), to: events[1]!.end });
    const config = { ...store.defaults, calendarOutlook: true, calendarAutoRefresh: false };
    const service = new DictationService(config), calls = new CallDetector(); calls.start = () => {};
    const titles: string[] = []; let hides = 0;
    const popup = { show(_title: string, detail: string) { if (options.failShow) throw Error('Fixture display failure'); titles.push(detail); }, hide() { hides++; }, close() {} };
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, popup, recorder: options.recorder });
    await bridge.start();
    const internals = bridge as unknown as { reminders: { next: (...args: unknown[]) => Promise<CalendarEvent | undefined> }; popupAction(action: string): Promise<void> };
    return { now, config, events, service, calls, titles, bridge, internals, hides: () => hides, async close() { await bridge.close(); await service.close(); } };
}

test('calls or Off during candidate selection defer a reminder without consuming it', async () => {
    for (const interruptedBy of ['call', 'off'] as const) {
        const fixture = await reminderFixture();
        const { bridge, internals, calls, config, now, titles } = fixture;
        const select = internals.reminders.next.bind(internals.reminders);
        internals.reminders.next = async (...args) => {
            const candidate = await select(...args);
            if (interruptedBy === 'call') calls.setState('active', 'local-api', 'Fixture call');
            else config.meetingReminders = false;
            return candidate;
        };
        try {
            await bridge.checkReminders(now);
            assert.ok(!titles.some(title => title.startsWith('Reminder')));
            assert.equal(existsSync(path.join(root, 'meeting-reminders.json')), false);
            internals.reminders.next = select; calls.setState('idle', 'local-api', 'Fixture ended'); config.meetingReminders = true;
            await bridge.checkReminders(now + 15000);
            assert.equal(titles.filter(title => title.startsWith('Reminder')).length, 1);
        } finally { await fixture.close(); }
    }
});

test('one visible reminder stays stable, queues the next, and closes when disabled', async () => {
    const fixture = await reminderFixture();
    try {
        await fixture.bridge.checkReminders(fixture.now);
        await fixture.bridge.checkReminders(fixture.now + 15000);
        assert.deepEqual(fixture.titles, ['Reminder 3']);
        await fixture.internals.popupAction('dismiss');
        await fixture.bridge.checkReminders(fixture.now + 30000);
        assert.deepEqual(fixture.titles, ['Reminder 3', 'Reminder 4']);
        fixture.config.meetingReminders = false; fixture.bridge.configureCalendar();
        assert.equal(fixture.hides(), 2);
    } finally { await fixture.close(); }
});

test('a popup display failure leaves the reminder retryable and reports a useful status', async () => {
    const options = { failShow: true }, fixture = await reminderFixture(options);
    try {
        await fixture.bridge.checkReminders(fixture.now);
        assert.equal(existsSync(path.join(root, 'meeting-reminders.json')), false);
        assert.match(fixture.bridge.progress, /Popup could not be displayed/);
        options.failShow = false;
        await fixture.bridge.checkReminders(fixture.now + 15000);
        assert.deepEqual(fixture.titles, ['Reminder 3']);
    } finally { await fixture.close(); }
});

test('an expired reminder cannot stop a recording after its prompt is dismissed', async () => {
    const fixture = await reminderFixture({ recorder: item => Object.assign(new EventEmitter(), {
        start: async () => {}, stop: async () => { item.state = 'stopped'; item.stoppedAt = new Date().toISOString(); await store.saveSession(item); },
    }) as unknown as Recorder });
    let id: string | undefined;
    try {
        await fixture.bridge.checkReminders(fixture.now);
        id = await fixture.bridge.startRecording();
        assert.equal(fixture.titles.length, 1, 'Recording state belongs in the capture bubble, not another popup');
        const hiddenAtStart = fixture.hides(); assert.equal(hiddenAtStart, 1, 'Starting capture dismisses the previous reminder');
        await fixture.bridge.checkReminders(fixture.now + 4 * 60000);
        assert.equal(fixture.hides(), hiddenAtStart);
        assert.equal(fixture.bridge.recording, true);
    } finally { await fixture.close(); if (id) await rm(store.sessionDirectory(id), { recursive: true }); }
});

after(async () => { await rm(root, { recursive: true, force: true }); });
