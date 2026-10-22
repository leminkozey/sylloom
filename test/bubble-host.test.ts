import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBubbleHost } from '../src/bubble-host.js';
import { bubbleNotice } from '../src/bubble-feedback.js';
import type { IndicatorView } from '../src/indicator.js';

test('one native panel expands for messages and returns to the latest capture without pausing or restarting', context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const frames: IndicatorView[] = []; let created = 0, hidden = 0, pauses = 0, pause!: () => void;
    const host = createBubbleHost(action => { created++; pause = action; return { render(view) { frames.push(view); }, hide() { hidden++; }, close() {} }; });
    const meeting = host.acquire({ onTogglePause: () => { pauses++; } });
    meeting.render({ phase: 'recording', level: .06, mode: 'meeting', elapsed: 10 });
    host.show(bubbleNotice('Copied'));
    meeting.render({ phase: 'recording', level: .09, mode: 'meeting', elapsed: 12 });
    assert.equal(frames.at(-1)?.notice?.title, 'Copied to clipboard');
    pause(); assert.equal(pauses, 0, 'A queued click must not pause capture through an expanded notice');
    context.mock.timers.tick(4000);
    assert.deepEqual(frames.at(-1), { phase: 'recording', level: .09, mode: 'meeting', elapsed: 12 });
    pause(); assert.equal(pauses, 1); assert.equal(created, 1); assert.equal(hidden, 0);
    meeting.close(); host.close();
});

test('the newest message owns its timeout; ending capture cannot dismiss it or create a new surface', context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let created = 0, hidden = 0, closed = 0;
    const host = createBubbleHost(() => { created++; return { render() {}, hide() { hidden++; }, close() { closed++; } }; });
    const capture = host.acquire(); capture.render({ phase: 'recording', level: .04 });
    host.show(bubbleNotice('Copied')); context.mock.timers.tick(3900);
    host.show(bubbleNotice('Shortcut unavailable (macOS -9878)'));
    capture.hide(); capture.close(); context.mock.timers.tick(100);
    assert.equal(hidden, 0); assert.equal(created, 1);
    context.mock.timers.tick(3900); assert.equal(hidden, 1);
    context.mock.timers.tick(350); assert.equal(closed, 1);
    host.close(); assert.equal(closed, 1);
});

test('a stale ready animation cannot take ownership from an active meeting capture', () => {
    const frames: IndicatorView[] = [];
    const host = createBubbleHost(() => ({ render(view) { frames.push(view); }, hide() {}, close() {} }));
    const dictation = host.acquire(), meeting = host.acquire();
    dictation.render({ phase: 'copied', level: 0 }); meeting.render({ phase: 'recording', level: .03, mode: 'meeting' });
    dictation.render({ phase: 'copied', level: 0 });
    assert.equal(frames.at(-1)?.mode, 'meeting');
    dictation.close(); meeting.close(); host.close();
});

test('technical codes, paths and arbitrary exception messages never become user-facing notice text', () => {
    for (const error of ['Global shortcut unavailable (macOS -9878)', 'EACCES /private/internal/secret: failed', 'Whisper failed status 503 at /private/model.bin']) {
        const notice = bubbleNotice(error), rendered = JSON.stringify(notice);
        assert.doesNotMatch(rendered, /9878|EACCES|\/private|503/);
        assert.ok(notice.title.length < 40); assert.ok(notice.detail.length < 100);
    }
});

for (const failure of ['hide', 'close'] as const) test('scheduled ' + failure + ' failure cannot crash capture and the next notice can recover', context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let created = 0;
    const errors: unknown[] = [];
    const host = createBubbleHost(() => {
        const broken = ++created === 1;
        return { render() {}, hide() { if (broken && failure === 'hide') throw new Error('Native hide failed'); }, close() { if (broken && failure === 'close') throw new Error('Native close failed'); } };
    }, error => errors.push(error));
    host.show(bubbleNotice('Copied'));
    assert.doesNotThrow(() => { context.mock.timers.tick(4000); context.mock.timers.tick(350); });
    assert.equal(errors.length, 1);
    host.show(bubbleNotice('Copied'));
    assert.equal(created, 2);
    assert.doesNotThrow(() => { context.mock.timers.tick(4000); context.mock.timers.tick(350); });
    assert.equal(errors.length, 1);
    host.close();
});
