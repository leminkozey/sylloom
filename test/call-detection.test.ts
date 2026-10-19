import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallDetector, enabledCallApps } from '../src/calls.js';
import { callControls, appleNotificationCall } from '../src/native/app-reader.js';
import { defaults } from '../src/store.js';
import type { AppObservation, ObservedCallState } from '../src/native/app-reader.js';

const apple = (input: boolean, output: boolean, callUI?: boolean, controls: ObservedCallState = 'unknown'): AppObservation => ({
    trusted: true, teams: 'unknown', calls: { apple: controls }, appleCallUI: callUI,
    audio: { supported: true, apps: { apple: { input, output } } },
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
