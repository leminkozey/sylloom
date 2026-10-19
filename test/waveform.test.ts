import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Waveform } from '../src/waveform.js';

test('speech decays into silence without jumping to the baseline, then settles completely', () => {
    const waveform = new Waveform();
    for (let t = 0; t <= 1200; t += 50) waveform.update('recording', .1, t);
    const loud = [...waveform.update('recording', .1, 1250)];
    const quiet = [...waveform.update('recording', 0, 1300)];
    assert.ok(loud.at(-1)! > 18);
    assert.ok(quiet.at(-1)! < loud.at(-1)! && quiet.at(-1)! > 10, 'Silence releases over time, not in one sample');
    for (let t = 1350; t <= 3500; t += 50) waveform.update('recording', 0, t);
    const settled = waveform.update('recording', 0, 3550);
    assert.ok(settled.every(height => height >= 2 && height < 2.01));
});

test('phase changes preserve geometry; reset and Reduce Motion are explicit', () => {
    const waveform = new Waveform();
    for (let t = 0; t <= 1200; t += 50) waveform.update('recording', .1, t);
    const before = [...waveform.update('recording', .1, 1250)];
    const processing = [...waveform.update('processing', 0, 1250)];
    assert.deepEqual(processing, before, 'Changing phase at the same time cannot reset the trace');
    const next = waveform.update('processing', 0, 1300);
    assert.ok(next.every((height, i) => Math.abs(height - before[i]!) < 5));
    assert.deepEqual([...waveform.update('copied', 0, 1350, false)], Array(13).fill(5.6));
    waveform.reset();
    assert.ok(waveform.update('recording', Number.NaN, 1400).every(height => height === 2));
});

test('display refresh rate does not change the sampled audio history or release timing', () => {
    const a = new Waveform(), b = new Waveform();
    for (let t = 0; t <= 3000; t += 50) a.update('recording', t < 1200 ? .1 : 0, t);
    for (let t = 0; t <= 3000; t += 10) b.update('recording', t < 1200 ? .1 : 0, t);
    const slow = a.update('recording', 0, 3050), fast = b.update('recording', 0, 3050);
    assert.ok(slow.every((height, i) => Math.abs(height - fast[i]!) < .02));
});
