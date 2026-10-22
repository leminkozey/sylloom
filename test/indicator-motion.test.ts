import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndicatorMotion } from '../src/indicator-motion.js';

test('the actual waveform contours continue into gears and a check without resetting or adding shapes', () => {
    const motion = new IndicatorMotion();
    let frame = motion.frame('recording', .07, 0);
    for (let t = 16; t <= 1600; t += 16) frame = motion.frame('recording', .07, t);
    const wave = structuredClone(frame);
    assert.deepEqual(motion.frame('processing', 0, 1600), wave, 'Stopping must start from the exact last audio frame');
    for (let t = 1616; t <= 3200; t += 16) frame = motion.frame('processing', 0, t);
    assert.ok(Math.abs(frame.width - 74) < .01); assert.equal(frame.success, 0);
    const gears = structuredClone(frame);
    assert.deepEqual(motion.frame('copied', 0, 3200), gears, 'Success must start from the current rotating gear contours');
    for (let t = 3216; t <= 4000; t += 16) frame = motion.frame('copied', 0, t);
    assert.ok(Math.abs(frame.width - 52) < .01); assert.ok(frame.success > .99);
    assert.equal(frame.parts.length, 13); assert.ok(frame.parts.every(part => part.length === 48));
});

test('every morph frame stays a filled contour inside its resizing bubble', () => {
    const motion = new IndicatorMotion();
    let now = 0;
    for (const [phase, duration] of [['recording', 1800], ['processing', 2500], ['copied', 700]] as const) {
        for (let t = 0; t <= duration; t += 16) {
            const frame = motion.frame(phase, .11, now + t);
            assert.equal(frame.parts.length, 13);
            for (const part of frame.parts) {
                const area = part.reduce((area, p, i) => { const q = part[(i + 1) % part.length]!; return area + p.x * q.y - q.x * p.y; }, 0) / 2;
                assert.ok(area > 0, 'No collapsed or inverted shards');
                for (const p of part) {
                    assert.ok(Number.isFinite(p.x + p.y));
                    assert.ok(p.x >= (122 - frame.width) / 2 && p.x <= (122 + frame.width) / 2 && p.y >= 0 && p.y <= 38, 'A contour escaped its bubble');
                }
            }
        }
        now += duration;
    }
});

test('Reduce Motion presents static gears and a static success check', () => {
    const motion = new IndicatorMotion();
    const before = motion.frame('processing', 0, 0, false);
    assert.deepEqual(motion.frame('processing', 0, 10000, false), before);
    const check = motion.frame('copied', 0, 11000, false);
    assert.equal(check.width, 52); assert.equal(check.success, 1);
});

test('microphone failure turns the same bars red, gathers centrally and draws the slash without text or extra contours', () => {
    const motion = new IndicatorMotion();
    let wave = motion.frame('recording', .06, 0);
    for (let time = 16; time <= 1600; time += 16) wave = motion.frame('recording', .06, time);
    assert.deepEqual(motion.frame('error', 0, 1600, true, true, 'microphone'), wave);
    const red = motion.frame('error', 0, 1740, true, true, 'microphone');
    assert.equal(red.error, 1); assert.deepEqual(red.parts, wave.parts, 'Color first, before the bars move');
    let final;
    for (let t = 144; t <= 1056; t += 16) {
        const frame = motion.frame('error', 0, 1600 + t, true, true, 'microphone');
        assert.equal(frame.parts.length, 13); assert.equal(frame.error, 1);
        assert.ok(frame.width <= 122, 'A microphone error must never expand into a text banner');
        if (t === 304) { const x = frame.parts.flat().map(p => p.x); assert.ok(Math.max(...x) - Math.min(...x) > 20, 'The bars must not collapse into one solid block'); }
        for (const part of frame.parts) {
            assert.equal(part.length, 48);
            const area = part.reduce((sum, p, i) => { const q = part[(i + 1) % part.length]!; return sum + p.x*q.y-q.x*p.y; }, 0)/2;
            assert.ok(area > 0, 'Microphone pieces must not invert during interpolation');
            for (const p of part) assert.ok(p.x >= (122-frame.width)/2 && p.x <= (122+frame.width)/2 && p.y >= 0 && p.y <= 38);
        }
        final = frame;
    }
    assert.equal(final!.width, 52);
    const slash = final!.parts[8]!;
    assert.ok(Math.max(...slash.map(p => p.x)) - Math.min(...slash.map(p => p.x)) > 17);
    assert.ok(Math.max(...slash.map(p => p.y)) - Math.min(...slash.map(p => p.y)) > 19);
});
