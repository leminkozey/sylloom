import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationModels } from '../src/dictation-models.js';
import { defaults } from '../src/store.js';
import { formatDictation, needsDictationFormatting } from '../src/formatter.js';
import type { ModelServer } from '../src/server.js';

test('clean messages preserve names, numbers and paragraphs without loading a model', async () => {
    const config = { ...defaults, dictationModel: '/missing/formatter.gguf', dictationPolish: 'auto' as const };
    const text = 'Hallo Sam, der Import ITX-482 bleibt pausiert. Neuer Absatz. Ich prüfe das morgen um 14:30 Uhr.';
    assert.equal(needsDictationFormatting(text, 'message'), false);
    assert.equal(await formatDictation(text, 'message', config), 'Hallo Sam, der Import ITX-482 bleibt pausiert.\n\nIch prüfe das morgen um 14:30 Uhr.');
    for (const raw of ['Hallo Sam, ähm, bitte prüfen.', 'Ähm, das stimmt.', 'Bitte am Dienstag, nein, Donnerstag senden.', 'Prüfe erstens den Import und zweitens die Logs.', 'Der Betrag ist zwölf Euro fünfzig.', 'Ich ich prüfe das.', 'hallo lea', 'Hallo Sam ohne Punkt']) {
        assert.equal(needsDictationFormatting(raw, 'message'), true, raw);
    }
    assert.equal(needsDictationFormatting('Hallo Sam.', 'email'), true);
    assert.equal(needsDictationFormatting('Import prüfen.', 'list'), true);
    await assert.rejects(formatDictation('Hallo Sam.', 'message', { ...config, dictationPolish: 'always' }), /formatter missing/);
    await assert.rejects(formatDictation(text, 'message', config, AbortSignal.abort()), /abort/i);
});

test('dictation servers are reused and freed after idle, settings changes and shutdown', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const created: { stopped: boolean; starts: number }[] = [];
    const cache = new DictationModels(() => {
        const item = { stopped: false, starts: 0 }; created.push(item);
        return { get reusable() { return !item.stopped; }, start: async () => { item.starts++; return 'http://localhost'; }, stop: async () => { item.stopped = true; } } as ModelServer;
    });
    try {
        await cache.prewarm(defaults);
        const whisper = await cache.get('whisper', defaults);
        assert.equal(await cache.get('whisper', defaults), whisper);
        assert.equal(created.length, 2);
        assert.ok(created.every(item => item.starts === 1));
        cache.release(2); context.mock.timers.tick(1000);
        await cache.get('whisper', defaults); context.mock.timers.tick(2000);
        assert.ok(created.every(item => !item.stopped), 'Starting a new dictation cancels the old idle timer');
        cache.release(1); context.mock.timers.tick(1000); await cache.clear();
        assert.ok(created.every(item => item.stopped));
        const next = await cache.get('formatter', defaults);
        assert.equal(created.length, 3);
        await cache.get('formatter', { ...defaults, dictationModel: '/other.gguf' });
        assert.equal(next.reusable, false);
        await cache.close(); assert.ok(created.every(item => item.stopped));
        await assert.rejects(cache.get('whisper', defaults), /closed/);
    } finally { await cache.close(); }
});

test('failed or canceled servers are replaced before the next dictation', async () => {
    const created: { failed: boolean; stopped: boolean }[] = [];
    const cache = new DictationModels(() => {
        const item = { failed: false, stopped: false }; created.push(item);
        return { get reusable() { return !item.failed && !item.stopped; }, start: async () => { item.failed = true; throw new Error('load failed'); }, stop: async () => { item.stopped = true; } } as ModelServer;
    });
    try {
        await cache.prewarm(defaults);
        assert.equal(created.length, 2);
        await cache.get('whisper', defaults);
        assert.equal(created.length, 3); assert.equal(created[0]?.stopped, true);
    } finally { await cache.close(); }
});
