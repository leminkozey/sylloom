import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-meeting-start-'));
process.env.SYLLOOM_HOME = root;
const { defaults, createSession, saveSession, loadSession, sessionDirectory } = await import('../src/store.js');
const { Audio } = await import('../src/audio.js');
const { DictationService } = await import('../src/dictation.js');
const { MeetingBridge } = await import('../src/meeting-bridge.js');
const { CallDetector } = await import('../src/calls.js');
const config = { ...defaults, detectAppleCalls: false, detectWhatsAppCalls: false, calendarAutoRefresh: false, dictationNotifications: false };
const inventory = ['mic', 'system'].map(sourceKind => ({ id: sourceKind, name: 'Synthetic ' + sourceKind, sourceKind, isDefault: true, formatAvailable: true }));

test('a failed real recorder start preserves its cause, never announces success and can be retried with pending history', async context => {
    context.mock.method(Audio.prototype, 'devices', async () => inventory);
    let fail = true;
    context.mock.method(Audio.prototype, 'request', async (command: string, source?: string) => {
        if (command === 'start' && source === 'system' && fail) { fail = false; throw new Error('Synthetic system audio startup failure'); }
    });
    const previous = await createSession(); previous.state = 'stopped'; previous.stoppedAt = new Date().toISOString(); await saveSession(previous);
    const previousFile = path.join(sessionDirectory(previous.id), 'session.json'), preserved = await readFile(previousFile, 'utf8');
    const service = new DictationService(config), shown: string[] = [];
    const bridge = new MeetingBridge(config, service, undefined, { native: false, popup: { show(title) { shown.push(title); }, hide() {}, close() {} } });
    try {
        await bridge.start();
        await assert.rejects(bridge.startRecording(), /Synthetic system audio startup failure/);
        assert.equal(bridge.recording, false); assert.ok(shown.includes('Recording could not start'));
        assert.equal(shown.includes('Recording saved'), false);
        const { sessions } = await import('../src/store.js');
        const failed = (await sessions()).find(item => item.id !== previous.id)!;
        assert.equal(failed.decision, null); assert.equal(failed.name, null);
        assert.ok(failed.events.some(event => event.message.includes('Synthetic system audio startup failure')));
        const id = await bridge.startRecording();
        assert.equal(bridge.recording, true); assert.notEqual(id, failed.id);
        assert.equal(await readFile(previousFile, 'utf8'), preserved);
        await bridge.stopRecording(); assert.equal(shown.filter(title => title === 'Recording saved').length, 1);
    } finally { await bridge.close(); await service.close(); }
});

test('Record consent survives the transition to Teams preview and only a joined call may arm auto-stop', async context => {
    context.mock.method(Audio.prototype, 'devices', async () => inventory);
    context.mock.method(Audio.prototype, 'request', async () => {});
    const calls = new CallDetector(); calls.start = () => {};
    const service = new DictationService(config);
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls, popup: { show() {}, hide() {}, close() {} } });
    const api = (isInMeeting: boolean) => calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting } } }));
    try {
        await bridge.start();
        calls.setState('active', 'audio-activity', 'Synthetic preview audio'); const owner = calls.snapshot.callId;
        calls.observe({ trusted: true, teams: 'joining' });
        await (bridge as unknown as { popupAction(action: string): Promise<void> }).popupAction('record');
        assert.equal(bridge.recording, true); assert.equal(calls.snapshot.callId, owner);
        api(false); api(false); await delay(1600);
        assert.equal(bridge.recording, true); assert.equal(calls.canAutoStop(owner), false);
        api(true); api(false); await delay(1700);
        assert.equal(bridge.recording, false);
    } finally { await bridge.close(); await service.close(); }
});

test('call ownership is captured before model shutdown instead of following another app during startup', async context => {
    context.mock.method(Audio.prototype, 'devices', async () => inventory);
    context.mock.method(Audio.prototype, 'request', async () => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls = new CallDetector(); calls.start = () => {};
    const service = new DictationService(config); service.releaseModels = () => gate;
    const bridge = new MeetingBridge(config, service, undefined, { native: false, detector: calls });
    let starting: Promise<string> | undefined;
    try {
        await bridge.start(); calls.setState('active', 'accessibility', 'Synthetic Teams call');
        const owner = calls.snapshot.callId; starting = bridge.startRecording();
        calls.setState('ringing', 'accessibility', 'Synthetic other call', 'apple');
        release(); const id = await starting;
        assert.match(bridge.captureStatus[0]!, new RegExp('Teams · call ' + owner + '$'));
        calls.setState('idle', 'accessibility', 'Other call ended', 'apple'); await delay(1600);
        assert.equal(bridge.recording, true);
        await bridge.stopRecording(); assert.equal((await loadSession(id)).decision, null);
    } finally { release(); await starting?.catch(() => {}); await bridge.close(); await service.close(); }
});

after(async () => { await rm(root, { recursive: true, force: true }); });
