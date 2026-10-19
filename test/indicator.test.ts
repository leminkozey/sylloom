import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachIndicator, indicatorView } from '../src/indicator.js';

test('waveform uses microphone levels only while recording', () => {
    const source = { state: 'recording', recorder: { levels: { mic: 0.075 } } };
    assert.deepEqual(indicatorView(source), { phase: 'recording', level: 0.075 });
    source.state = 'processing';
    assert.deepEqual(indicatorView(source), { phase: 'processing', level: 0 });
    source.state = 'idle'; assert.equal(indicatorView(source), null);
});

test('waveform survives quick consecutive dictations and closes on cancel or shutdown', context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const source = Object.assign(new EventEmitter(), { state: 'idle', recorder: { levels: { mic: 0 } } });
    let created = 0; let hidden = 0; let closed = 0; let level = 0;
    const close = attachIndicator(source, assert.fail, () => {
        created++;
        return { render(view) { level = view.level; }, hide() { hidden++; }, close() { closed++; } };
    });
    assert.equal(created, 0);
    source.state = 'recording'; source.emit('update');
    source.recorder.levels.mic = 0.05; context.mock.timers.tick(50);
    assert.equal(created, 1); assert.equal(level, 0.05);
    source.state = 'ready'; source.emit('update'); context.mock.timers.tick(1100);
    source.state = 'recording'; source.emit('update'); context.mock.timers.tick(200);
    assert.equal(hidden, 0, 'Previous success timeout must not hide a new recording');
    source.state = 'idle'; source.emit('update'); assert.equal(hidden, 1);
    source.state = 'ready'; source.emit('update'); context.mock.timers.tick(1200); assert.equal(hidden, 2);
    close(); close(); assert.equal(closed, 1);
    source.state = 'recording'; source.emit('update'); context.mock.timers.tick(500);
    assert.equal(created, 1); assert.equal(source.listenerCount('update'), 0);
});

test('native indicator failure leaves dictation running and reports once', context => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const source = Object.assign(new EventEmitter(), { state: 'recording' });
    const warnings: string[] = [];
    const close = attachIndicator(source, text => warnings.push(text), () => { throw new Error('AppKit unavailable'); });
    source.emit('update'); context.mock.timers.tick(1000); source.emit('update');
    assert.equal(source.state, 'recording'); assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /AppKit unavailable/);
    close();
});
