import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationModels } from '../src/dictation-models.js';
import { defaults } from '../src/store.js';
import { cleanDictationTail, dictationNumbers, dictationParagraphs, dictationStructure, formatDictation, formatTaskMarkers, needsDictationFormatting } from '../src/formatter.js';
import type { ModelServer } from '../src/server.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('clean messages preserve names, numbers and paragraphs without loading a model', async () => {
    const config = { ...defaults, dictationModel: '/missing/formatter.gguf', dictationPolish: 'auto' as const };
    const text = 'Hallo Sam, der Import ITX-482 bleibt pausiert. Neuer Absatz. Ich prüfe das morgen um 14:30 Uhr.';
    assert.equal(needsDictationFormatting(text, 'message'), false);
    assert.equal(await formatDictation(text, 'message', config), 'Hallo Sam, der Import ITX-482 bleibt pausiert.\n\nIch prüfe das morgen um 14:30 Uhr.');
    for (const raw of ['Hallo Sam, ähm, bitte prüfen.', 'Ähm, das stimmt.', 'Bitte am Dienstag, nein, Donnerstag senden.', 'Der Betrag ist zwölf Euro fünfzig.', 'Ich ich prüfe das.', 'hallo lea', 'Hallo Sam ohne Punkt']) {
        assert.equal(needsDictationFormatting(raw, 'message'), true, raw);
    }
    assert.equal(needsDictationFormatting('Hallo Sam.', 'email'), true);
    assert.equal(needsDictationFormatting('Import prüfen.', 'list'), false);
    assert.equal(await formatDictation('Prüfe erstens den Import und zweitens die Logs.', 'message', config), 'Prüfe:\n- den Import\n- die Logs.');
    assert.equal(await formatDictation('Import prüfen.', 'list', config), '- Import prüfen.');
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

test('capture prewarms the full formatter context and retains it for long dictations', async () => {
    const created: { kind: string; options: unknown; starts: number; stopped: boolean }[] = [];
    const cache = new DictationModels((_binary, _model, kind, options) => {
        const item = { kind, options, starts: 0, stopped: false }; created.push(item);
        return { get reusable() { return !item.stopped; }, start: async () => { item.starts++; return 'http://localhost'; },
            stop: async () => { item.stopped = true; } } as ModelServer;
    });
    try {
        await cache.prewarm(defaults);
        const formatter = await cache.get('formatter', defaults);
        assert.equal(await cache.get('formatter', { ...defaults, dictationFormat: 'email' }), formatter);
        assert.equal(created.length, 2);
        assert.deepEqual(created.find(item => item.kind === 'llama')?.options, { contextSize: 4096, profile: 'dictation' });
        assert.ok(created.every(item => item.starts === 1 && !item.stopped));
        const quality = { ...defaults, dictationModel: '/models/Qwen3.5-4B-dictation-v3-MTP-Q4_K_M.gguf' };
        await cache.get('formatter', quality);
        assert.deepEqual(created.at(-1)?.options, { contextSize: 16384, profile: 'dictation' });
    } finally { await cache.close(); }
});

test('auto formatting cleans the edited paragraph and preserves clean sections verbatim', async context => {
    const root = await mkdtemp(path.join(tmpdir(), 'sylloom-paragraphs-'));
    const model = path.join(root, 'formatter.gguf'); await writeFile(model, 'Synthetic fixture');
    const original = 'Hallo Lea, bitte morgen, nein, am Donnerstag senden.';
    const clean = 'Die Datei config.json darf nicht gelöscht werden. AB-007 bleibt gesperrt.';
    const seen: string[] = [];
    let cancel: AbortController | undefined;
    context.mock.method(globalThis, 'fetch', async (_input, init) => {
        const body = JSON.parse(String(init?.body)); const content = body.messages[0].content as string; seen.push(content);
        const cleaned = content.includes(original) ? 'Hallo Lea, bitte am Donnerstag senden.' : clean;
        if (cancel) queueMicrotask(() => cancel!.abort());
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cleaned_text: cleaned }) } }] });
    });
    const server = { start: async () => 'http://localhost', stop: async () => {} } as unknown as ModelServer;
    const config = { ...defaults, dictationModel: model, dictationPolish: 'auto' as const };
    try {
        const expected = 'Hallo Lea, bitte am Donnerstag senden.\n\n' + clean;
        assert.equal(await formatDictation(original + '\n\n' + clean, 'message', config, undefined, server), expected);
        assert.equal(seen.length, 1); assert.ok(seen[0]!.includes(original)); assert.ok(!seen[0]!.includes(clean));
        seen.length = 0;
        assert.equal(await formatDictation(original + '\n\n' + clean, 'message', { ...config, dictationPolish: 'always' }, undefined, server), expected);
        assert.equal(seen.length, 2, 'Always mode must still format every paragraph');
        seen.length = 0;
        await formatDictation(original + '\n\n' + clean, 'email', config, undefined, server);
        assert.equal(seen.length, 1, 'Email structure needs the whole dictation in one request');
        assert.ok(seen[0]!.includes(original) && seen[0]!.includes(clean));
        cancel = new AbortController();
        await assert.rejects(formatDictation(original + '\n\n' + clean, 'message', config, cancel.signal, server), /abort/i);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Auto recognizes speech tails, natural lists and longer prose while preserving literal terms', () => {
    for (const text of ['Ich sende den Entwurf, und eh ja.', 'Der Import bleibt pausiert, und ja, naja.', 'Ich melde mich, und ja.']) {
        assert.equal(needsDictationFormatting(text, 'message'), true, text);
    }
    for (const text of ['Meine To-do-Liste: Milch kaufen, die Rechnung bezahlen und Lea anrufen.', 'Schreib mir eine Liste: Import prüfen und Logs sichern.']) {
        assert.equal(needsDictationFormatting(text, 'message'), false, 'Deterministic layout does not need model generation');
    }
    const prose = 'Heute haben wir den aktuellen Stand des Projekts besprochen. Der Import läuft weiterhin in der Testumgebung. Die fehlenden Kundennummern sind inzwischen ergänzt und die doppelten Rechnungen wurden gesondert abgelegt. Lea prüft den Export am Donnerstag mit dem Team. Die Freigabe bleibt gesperrt, bis die Prüfung abgeschlossen ist. Anschließend besprechen wir den nächsten Termin und halten den Ablauf in der gemeinsamen Notiz fest.';
    assert.equal(needsDictationFormatting(prose, 'message'), true);
    for (const text of ['Ja, ich komme morgen.', 'Die Berichte sind ähnlich.', 'Das Wort „ähm“ bleibt im Zitat.', 'Die Datei `todo-list.json` bleibt erhalten.']) {
        assert.equal(needsDictationFormatting(text, 'message'), false, text);
    }
    assert.deepEqual(dictationParagraphs('Die Phrase „neuer Absatz“ ist ein Beispiel. Neuer Absatz. Danach geht es weiter.'),
        ['Die Phrase „neuer Absatz“ ist ein Beispiel.', 'Danach geht es weiter.']);
});

test('task intent produces checklists without converting list mentions or literal code', () => {
    for (const text of ['Meine To-do-Liste: Milch kaufen und Lea anrufen.', 'Aufgaben für heute: Export prüfen und Logs sichern.', 'Schreib auf meine To-do-Liste, die Rechnung zu bezahlen.']) {
        assert.equal(dictationStructure(text, 'message'), 'tasks', text);
    }
    for (const text of ['Die To-do-Liste ist noch nicht freigegeben.', 'Bitte prüfe die To-do-Liste.', 'Das ist keine Liste.', 'In der Datei steht `todo-list`.', 'Der Ausdruck „To-do-Liste“ bleibt so.']) {
        assert.equal(dictationStructure(text, 'message'), 'prose', text);
    }
    assert.equal(dictationStructure('Schreib mir eine Liste: Export prüfen und Logs sichern.', 'message'), 'list');
    assert.equal(dictationStructure('Prüfe erstens den Import und zweitens die Logs.', 'message'), 'list');
    assert.equal(formatTaskMarkers('1. Export prüfen\n- Logs sichern\n- [x] Lea informiert\n```text\n1. Literal\n```'),
        '- [ ] Export prüfen\n- [ ] Logs sichern\n- [x] Lea informiert\n```text\n1. Literal\n```');
});

test('German compound-number hints distinguish reversed units and preserve literals', () => {
    assert.deepEqual(dictationNumbers('Siebenundachtzig Euro, achtundsiebzig Prozent und einunddreißig Minuten.'),
        { siebenundachtzig: 87, achtundsiebzig: 78, einunddreißig: 31 });
    assert.deepEqual(dictationNumbers('Zwölf Euro fünfzig, hundert Euro und `siebenundachtzig` als Literal.'), {});
});

test('empty speech tails are removed even when the model repeats them, preserving literal phrases and meaningful yes', () => {
    assert.equal(cleanDictationTail('Ich sende den Entwurf, und eh ja.'), 'Ich sende den Entwurf.');
    assert.equal(cleanDictationTail('Der Export dauerte 42 Sekunden und ja, naja.'), 'Der Export dauerte 42 Sekunden.');
    assert.equal(cleanDictationTail('Kannst du den Import prüfen, und ähm ja?'), 'Kannst du den Import prüfen?');
    assert.equal(cleanDictationTail('Und eh ja.'), '');
    for (const literal of ['Ja, ich komme morgen.', 'Die Antwort lautet ja.', 'Die Antwort war „und eh ja“.', 'Der Ausdruck lautet und eh ja.', 'Der Ausdruck ist und eh ja.',
        'Er sagte: und eh ja.', '```text\nund eh ja.']) assert.equal(cleanDictationTail(literal), literal);
});

test('formatter refuses a corrupted compound number but allows a spoken self-correction', async context => {
    const root = await mkdtemp(path.join(tmpdir(), 'sylloom-numbers-'));
    const model = path.join(root, 'formatter.gguf'); await writeFile(model, 'Synthetic fixture');
    const config = { ...defaults, dictationModel: model, dictationPolish: 'always' as const };
    const server = { start: async () => 'http://localhost', stop: async () => {} } as unknown as ModelServer;
    let output = 'Die Rechnung über 88 Euro bleibt gesperrt.';
    context.mock.method(globalThis, 'fetch', async (_input, init) => {
        assert.match(String(init?.body), /siebenundachtzig/);
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cleaned_text: output }) } }] });
    });
    try {
        await assert.rejects(formatDictation('Die Rechnung über siebenundachtzig Euro bleibt gesperrt.', 'message', config, undefined, server), /changed a dictated number/);
        output = 'Die Rechnung über 87 Euro bleibt gesperrt.';
        assert.equal(await formatDictation('Die Rechnung über siebenundachtzig Euro bleibt gesperrt.', 'message', config, undefined, server), output);
        output = 'Es sind 88 Euro.';
        assert.equal(await formatDictation('Es sind siebenundachtzig, nein, achtundachtzig Euro.', 'message', config, undefined, server), output);
        output = 'Die Rechnung über 87 Euro bleibt gesperrt, und eh ja.';
        assert.equal(await formatDictation('Die Rechnung über siebenundachtzig Euro bleibt gesperrt, und eh ja.', 'message', config, undefined, server),
            'Die Rechnung über 87 Euro bleibt gesperrt.');
    } finally { await rm(root, { recursive: true, force: true }); }
});
