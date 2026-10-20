import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallDetector, enabledCallApps } from '../src/calls.js';
import { callControls, appleNotificationCall, notificationCallTree } from '../src/native/app-reader.js';
import type { NotificationNode } from '../src/native/app-reader.js';
import { defaults } from '../src/store.js';
import type { AppObservation, ObservedCallState } from '../src/native/app-reader.js';

const apple = (input: boolean, output: boolean, callUI?: boolean, controls: ObservedCallState = 'unknown'): AppObservation => ({
    trusted: true, teams: 'unknown', calls: { apple: controls }, appleCallUI: callUI,
    audio: { supported: true, apps: { apple: { input, output } } },
});
const teams = (controls: ObservedCallState, input = false, output = false): AppObservation => ({
    trusted: true, teams: controls, calls: { teams: controls },
    audio: { supported: true, apps: { teams: { input, output } } },
});
const meetingState = (isInMeeting: boolean) => JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting } } });

test('Teams preview audio and an initial not-in-meeting packet cannot prove hangup', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['teams'];
    try {
        calls.observe(teams('idle', true, true)); const id = calls.snapshot.callId;
        assert.equal(calls.snapshot.source, 'audio-activity');
        calls.apiMessage(meetingState(false));
        assert.notEqual(calls.stateFor(id)?.state, 'idle', 'Not joined is not the end of a previously joined meeting');
        for (let i = 0; i < 5; i++) { calls.observe(teams('idle')); calls.apiMessage(meetingState(false)); }
        assert.notEqual(calls.stateFor(id)?.state, 'idle', 'Audio preview disappearing must not arm auto-stop');
        calls.observe(teams('active', true, true));
        assert.equal(calls.snapshot.callId, id);
        calls.apiMessage(meetingState(false));
        assert.equal(calls.snapshot.state, 'active', 'An API that never saw this meeting cannot end its native call');
        for (let i = 0; i < 3; i++) calls.observe(teams('idle'));
        assert.equal(calls.stateFor(id)?.state, 'idle', 'Confirmed native controls still support hangup without the API');
    } finally { await calls.close(); }
});

test('Teams pairing permissions alone never establish an API join-to-hangup transition', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['teams'];
    try {
        calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingPermissions: { canPair: true } } }));
        const id = calls.snapshot.callId;
        calls.apiMessage(meetingState(false));
        assert.notEqual(calls.stateFor(id)?.state, 'idle');
    } finally { await calls.close(); }
});

test('a confirmed Teams API hangup survives repeated idle packets and missing app controls', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['teams'];
    try {
        calls.apiMessage(meetingState(true)); const id = calls.snapshot.callId;
        calls.apiMessage(meetingState(false)); calls.apiMessage(meetingState(false));
        calls.observe(teams('unknown'));
        assert.equal(calls.stateFor(id)?.state, 'idle');
        calls.observe(teams('joining'));
        assert.equal(calls.stateFor(id)?.state, 'idle', 'An open preview cannot erase a confirmed hangup');
        calls.observe(teams('unknown'));
        calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingPermissions: { canPair: true } } }));
        assert.equal(calls.stateFor(id)?.state, 'idle', 'A delayed permissions packet cannot resurrect the ended call');
        calls.observe(teams('ringing'));
        const next = calls.snapshot.callId;
        assert.notEqual(next, id);
        calls.apiMessage(meetingState(false)); calls.observe(teams('unknown', true, true));
        assert.equal(calls.snapshot.callId, next);
        assert.equal(calls.snapshot.state, 'active', 'The old API hangup cannot end a new call');
    } finally { await calls.close(); }
});

test('Teams Join now preview controls suppress microphone-test call prompts', async () => {
    assert.equal(callControls(['Join now', 'Microphone', 'Calendar'], 'teams', true), 'joining');
    assert.equal(callControls(['prejoin-join-button', 'Microphone'], 'teams', true), 'joining');
    assert.equal(callControls(['Jetzt teilnehmen', 'Mikrofon'], 'teams', true), 'joining');
    const calls = new CallDetector(); calls.enabledApps = ['teams'];
    try {
        calls.observe(teams('joining', true, true));
        assert.equal(calls.snapshot.state, 'joining'); assert.equal(calls.snapshot.callId, 0);
        calls.apiMessage(meetingState(false)); assert.equal(calls.snapshot.state, 'joining');
        calls.observe(teams('active', true, true));
        assert.equal(calls.snapshot.state, 'active'); assert.ok(calls.snapshot.callId > 0);
    } finally { await calls.close(); }
});

test('a new native Teams join replaces an API-ended call without reviving lingering controls', async () => {
    for (const between of ['joining', 'idle'] as const) {
        const calls = new CallDetector(); calls.enabledApps = ['teams'];
        try {
            calls.apiMessage(meetingState(true)); const first = calls.snapshot.callId;
            calls.apiMessage(meetingState(false));
            calls.observe(teams('active', true, true));
            assert.equal(calls.snapshot.state, 'idle', 'Lingering old controls cannot resurrect a confirmed hangup');
            calls.observe(teams(between));
            assert.equal(calls.snapshot.state, 'idle', 'Preview alone cannot start another call');
            calls.observe(teams('active', true, true));
            const next = calls.snapshot.callId;
            assert.notEqual(next, first); assert.equal(calls.snapshot.state, 'active');
            assert.equal(calls.stateFor(first)?.state, 'idle');
            assert.equal(calls.canAutoStop(first), true); assert.equal(calls.canAutoStop(next), true);
            calls.apiMessage(meetingState(false));
            assert.equal(calls.snapshot.state, 'active', 'A late API idle packet cannot end a call it never saw joined');
            for (let i = 0; i < 3; i++) calls.observe(teams('idle'));
            assert.equal(calls.stateFor(next)?.state, 'idle');
        } finally { await calls.close(); }
    }
});

test('a confirmed API join gets a new identity after an ended call loses observation', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['teams'];
    try {
        calls.apiMessage(meetingState(true)); const first = calls.snapshot.callId;
        calls.apiMessage(meetingState(false));
        calls.setState('unknown', 'accessibility', 'Observer unavailable');
        calls.apiMessage(meetingState(true));
        assert.notEqual(calls.snapshot.callId, first); assert.equal(calls.snapshot.state, 'active');
    } finally { await calls.close(); }
});

test('retired call identities retain their confirmed end with bounded history', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['teams'];
    try {
        calls.apiMessage(meetingState(true)); const first = calls.snapshot.callId;
        calls.apiMessage(meetingState(false)); calls.apiMessage(meetingState(true));
        assert.equal(calls.stateFor(first)?.state, 'idle'); assert.equal(calls.canAutoStop(first), true);
        for (let i = 0; i < 130; i++) { calls.apiMessage(meetingState(false)); calls.apiMessage(meetingState(true)); }
        assert.equal(calls.stateFor(first), undefined); assert.equal(calls.canAutoStop(first), false);
    } finally { await calls.close(); }
});

test('call controls need a matching pair; navigation cannot prove idle after an incomplete traversal', () => {
    assert.equal(callControls(['Answer call', 'Decline call'], 'apple', true), 'ringing');
    assert.equal(callControls(['Anruf annehmen', 'Ablehnen'], 'whatsapp', true), 'ringing');
    assert.equal(callControls(['End call', 'Unmute'], 'whatsapp', false), 'active');
    assert.equal(callControls(['Auflegen', 'Mikrofon stumm'], 'apple', true), 'active');
    assert.equal(callControls(['Leave meeting', 'Mute'], 'teams', true), 'active');
    assert.equal(callControls(['Close', 'Mute'], 'apple', true), 'unknown');
    assert.equal(callControls(['Answer call'], 'apple', true), 'unknown');
    assert.equal(callControls(['Chats'], 'whatsapp', false), 'unknown');
    assert.equal(callControls(['Chats'], 'whatsapp', true), 'idle');
});

test('Apple banners accept a single Answer; non-call actions and missing Apple context stay unknown', () => {
    assert.equal(appleNotificationCall(['Answer'], true), 'ringing');
    assert.equal(appleNotificationCall(['Annehmen'], true), 'ringing');
    assert.equal(appleNotificationCall(['Accept Audio Call'], true), 'ringing');
    assert.equal(appleNotificationCall(['Accept', 'Decline'], true), 'ringing');
    assert.equal(appleNotificationCall(['Answer'], false), 'unknown', 'another app can have an Answer action');
    assert.equal(appleNotificationCall(['Accept invitation'], true), 'unknown');
    assert.equal(appleNotificationCall(['Accept'], true), 'unknown', 'a generic Accept action without call context is ambiguous');
    assert.equal(appleNotificationCall(['Call back'], true), 'unknown', 'a missed-call notification is not ringing');
    assert.equal(appleNotificationCall(['Reply', 'Close'], true), 'unknown');
});

test('ringing controls prompt before microphone activity, preserve the call after answering and recognize a declined call', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['apple'];
    try {
        calls.observe(apple(false, true, true, 'ringing')); const id = calls.snapshot.callId;
        assert.equal(calls.snapshot.state, 'ringing'); assert.equal(calls.snapshot.source, 'accessibility');
        calls.observe(apple(true, true, true));
        assert.equal(calls.snapshot.state, 'active'); assert.equal(calls.snapshot.callId, id);
        for (let i = 0; i < 3; i++) calls.observe(apple(false, false, false));
        assert.equal(calls.snapshot.state, 'idle');
        calls.observe(apple(false, true, true, 'ringing')); const declinedId = calls.snapshot.callId;
        assert.notEqual(declinedId, id);
        for (let i = 0; i < 3; i++) calls.observe(apple(false, false, false));
        assert.equal(calls.stateFor(declinedId)?.state, 'idle', 'declining never activates the microphone');
    } finally { await calls.close(); }
});

test('output alone does not invent a call; duplex audio works without Accessibility and keeps its identity through outages', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['apple'];
    try {
        calls.observe(apple(false, true, true)); assert.equal(calls.snapshot.callId, 0);
        calls.observe({ ...apple(true, true), trusted: false });
        assert.equal(calls.snapshot.state, 'active'); assert.equal(calls.snapshot.source, 'audio-activity');
        const id = calls.snapshot.callId;
        calls.observe({ trusted: false, teams: 'unknown', audio: { supported: false, apps: {} } });
        assert.equal(calls.stateFor(id)?.state, 'unknown');
        calls.observe(apple(true, true)); assert.equal(calls.snapshot.callId, id);
        for (let i = 0; i < 4; i++) calls.observe(apple(false, false, false));
        assert.equal(calls.stateFor(id)?.state, 'unknown', 'audio ending alone cannot prove a hangup');
    } finally { await calls.close(); }
});

test('Apple hangup requires the observed call panel to disappear and both streams to stay inactive', async () => {
    const calls = new CallDetector(); calls.enabledApps = ['apple'];
    try {
        calls.observe(apple(true, true, true)); const id = calls.snapshot.callId;
        for (let i = 0; i < 4; i++) calls.observe(apple(false, false, true, 'idle'));
        assert.equal(calls.stateFor(id)?.state, 'unknown', 'main-window navigation is not hangup while the call panel exists');
        calls.observe(apple(false, false, false)); calls.observe(apple(false, false, false));
        assert.equal(calls.stateFor(id)?.state, 'unknown');
        calls.observe(apple(false, true, false));
        assert.equal(calls.stateFor(id)?.state, 'unknown', 'remaining audio resets the hangup samples');
        for (let i = 0; i < 3; i++) calls.observe(apple(false, false, false));
        assert.equal(calls.stateFor(id)?.state, 'idle');
        calls.observe(apple(true, true, true)); assert.notEqual(calls.snapshot.callId, id);
    } finally { await calls.close(); }
});

test('each app owns its call identity and Teams idle cannot replace an active Apple call', async () => {
    const calls = new CallDetector();
    try {
        calls.observe({ trusted: true, teams: 'unknown', calls: { apple: 'unknown' } });
        assert.equal(calls.canAutoStop(0), false, 'No detected call is never an auto-stop owner');
        calls.observe(apple(true, true, true)); const appleId = calls.snapshot.callId;
        calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting: false } } }));
        assert.equal(calls.snapshot.app, 'apple'); assert.equal(calls.snapshot.state, 'active');
        calls.observe({ trusted: true, teams: 'idle', calls: { apple: 'active', whatsapp: 'ringing' } });
        const whatsappId = calls.snapshot.callId;
        assert.equal(calls.snapshot.app, 'whatsapp'); assert.notEqual(whatsappId, appleId);
        calls.setState('idle', 'accessibility', 'WhatsApp ended', 'whatsapp');
        assert.equal(calls.snapshot.app, 'apple'); assert.equal(calls.stateFor(appleId)?.state, 'active');
        assert.equal(calls.stateFor(whatsappId)?.state, 'idle');
    } finally { await calls.close(); }
});

test('disabled apps cannot create calls through either observation or Teams API', async () => {
    assert.deepEqual(enabledCallApps({ ...defaults, detectWhatsAppCalls: false, detectTeamsCalls: false }), ['apple']);
    const calls = new CallDetector(); calls.enabledApps = ['apple'];
    try {
        calls.observe({ trusted: true, teams: 'active', calls: { whatsapp: 'ringing' }, audio: { supported: true, apps: { teams: { input: true, output: true } } } });
        calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting: true } } }));
        assert.equal(calls.snapshot.callId, 0);
        assert.equal(calls.snapshot.app, 'apple');
        const snapshot = calls.snapshot; await calls.close();
        calls.observe(apple(true, true, true)); assert.deepEqual(calls.snapshot, snapshot);
    } finally { await calls.close(); }
});

test('Teams ringing recognizes native action identifiers and only attributes banners to their actual app', async () => {
    const { notificationCall, notificationCallApp } = await import('../src/native/app-reader.js');
    assert.equal(callControls(['acceptAudioCallButton', 'declineCallButton'], 'teams', false), 'ringing');
    assert.equal(callControls(['Anruf_annehmen', 'Anruf_ablehnen'], 'teams', false), 'ringing');
    assert.equal(notificationCallApp('com.microsoft.teams2.notificationcenter'), 'teams');
    assert.equal(notificationCallApp('', 'Microsoft Teams'), 'teams');
    assert.equal(notificationCallApp('', 'A message about Microsoft Teams'), undefined);
    assert.equal(notificationCallApp('com.microsoft.teams2evil'), undefined);
    assert.equal(notificationCall(['Answer audio call'], 'teams'), 'ringing');
    assert.equal(notificationCall(['Answer'], undefined), 'unknown');
    assert.equal(notificationCall(['Accept invitation', 'Decline invitation'], 'teams'), 'unknown');
    assert.equal(notificationCall(['Call back', 'Close'], 'teams'), 'unknown');
    const calls = new CallDetector(); calls.enabledApps = ['teams'];
    try {
        calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting: false } } }));
        calls.observe({ trusted: true, teams: 'ringing', calls: { teams: 'ringing' }, audio: { supported: true, apps: { teams: { input: false, output: true } } } });
        const id = calls.snapshot.callId;
        assert.equal(calls.snapshot.state, 'ringing');
        calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting: false } } }));
        assert.equal(calls.snapshot.state, 'ringing', 'An idle API packet cannot erase the incoming banner');
        calls.apiMessage(JSON.stringify({ meetingUpdate: { meetingState: { isInMeeting: true } } }));
        assert.equal(calls.snapshot.state, 'active'); assert.equal(calls.snapshot.callId, id);
    } finally { await calls.close(); }
});

test('notification cards cannot borrow app provenance from their siblings or the whole window', () => {
    const header = (appHeader: string): NotificationNode => ({ role: 'AXStaticText', appHeader });
    const action = (label: string): NotificationNode => ({ role: 'AXButton', labels: [label] });
    const card = (...children: NotificationNode[]): NotificationNode => ({ role: 'AXGroup', children });
    const teamsMessage = card(header('Microsoft Teams'), action('Close'));
    const unknownCall = card(action('Answer'), action('Decline'));
    const window: NotificationNode = { role: 'AXWindow', children: [card(teamsMessage, unknownCall)] };
    assert.deepEqual(notificationCallTree(window), { calls: {}, identified: true });
    assert.deepEqual(notificationCallTree(card(card(header('Microsoft Teams')), unknownCall)).calls, {}, 'A message card without buttons cannot lend its identity either');
    assert.deepEqual(notificationCallTree({ role: 'AXWindow', children: [header('Microsoft Teams'), action('Answer')] }).calls, {}, 'Window-wide identity is never sufficient');
    const unknownHeader = card(header('Other app'), action('Answer'), action('Decline'));
    assert.deepEqual(notificationCallTree(card(header('Microsoft Teams'), unknownHeader)).calls, {});
    const invitation = card(header('Microsoft Teams'), action('Accept invitation'), action('Decline invitation'));
    assert.deepEqual(notificationCallTree(card(invitation, unknownCall)).calls, {});
});

test('notification cards retain nested header attribution, multiple call apps and unowned Apple fallback', () => {
    const tree: NotificationNode = { role: 'AXWindow', children: [
        { role: 'AXGroup', children: [
            { role: 'AXGroup', identifier: 'app-header', children: [{ role: 'AXStaticText', appHeader: 'Microsoft Teams' }] },
            { role: 'AXGroup', children: [{ role: 'AXButton', labels: ['Answer audio call'] }] },
        ] },
        { role: 'AXGroup', identifier: 'net.whatsapp.WhatsApp', children: [{ role: 'AXButton', labels: ['Answer'] }] },
    ] };
    assert.deepEqual(notificationCallTree(tree), { calls: { teams: 'ringing', whatsapp: 'ringing' }, identified: true });
    assert.deepEqual(notificationCallTree({ role: 'AXWindow', children: [{ role: 'AXButton', labels: ['Answer'] }] }), { calls: {}, identified: false });
    assert.equal(appleNotificationCall(['Answer'], true), 'ringing', 'Unidentified Apple call surfaces still use the existing constrained fallback');
});
