import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaults } from '../src/store.js';
import { speechParagraphs, listBlocks, dictationBlocks, renderDictationBlocks, layoutEmail, layoutProse, preserveAnswerPrefixes } from '../src/dictation-layout.js';
import { formatDictation, needsDictationFormatting } from '../src/formatter.js';
import type { ModelServer } from '../src/server.js';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-cleanup-'));
const model = path.join(root, 'cleanup-1-q8_0.gguf'); await writeFile(model, 'Synthetic fixture');
const config = { ...defaults, dictationModel: model, dictationPolish: 'auto' as const };
const server = { start: async () => 'http://localhost', stop: async () => {} } as unknown as ModelServer;
after(async () => { await rm(root, { recursive: true, force: true }); });

test('repaired and alternative paragraph commands work while quotations stay literal', () => {
    assert.deepEqual(speechParagraphs('Hallo. Nächster Ansatz, nächster Absatz meine ich, bitte prüfen. Neuer Absatz, danke.'), ['Hallo.', 'bitte prüfen.', 'danke.']);
    assert.deepEqual(speechParagraphs('„Nächster Absatz“ ist ein Beispiel. New paragraph. Danach geht es weiter.'), ['„Nächster Absatz“ ist ein Beispiel.', 'Danach geht es weiter.']);
});

test('paragraph mentions and requests to another person stay ordinary prose', () => {
    for (const text of ['Bitte prüfe, ob ein neuer Absatz hier sinnvoll wäre.', 'Ich sage neuer Absatz nur als Beispiel.',
        'Der Befehl lautet: neuer Absatz.', 'New paragraph means starting a separate block.', 'The command is: new paragraph.',
        'Ich spreche über den Ausdruck neuer Absatz, nicht über eine Mail.']) assert.deepEqual(speechParagraphs(text), [text]);
    for (const phrase of ['Neuer Absatz', 'New paragraph', 'Nouveau paragraphe', 'Párrafo siguiente', 'Новый абзац', '新しい段落', '新段落']) {
        assert.deepEqual(speechParagraphs('Hallo. ' + phrase + '. Danach geht es weiter.'), ['Hallo.', 'Danach geht es weiter.']);
    }
});

test('task endings discard only empty uncertainty while compound objects remain one task', async () => {
    const text = 'Meine To-do-Liste für heute ist: Die Pflanzen gießen, das Paket abholen und Nora zurückrufen. Und naja... keine Ahnung...';
    const result = await formatDictation(text, 'message', { ...config, dictationModel: '/missing' });
    assert.equal(result.match(/^- \[ \]/gm)?.length, 3); assert.doesNotMatch(result, /naja|keine Ahnung/i);
    const compound = await formatDictation('Meine To-do-Liste: Milch und Brot einkaufen, das Paket abholen und Nora zurückrufen.', 'message', config);
    assert.match(compound, /- \[ \] Milch und Brot einkaufen/); assert.equal(compound.match(/^- \[ \]/gm)?.length, 3);
    const comma = await formatDictation('Meine To-Do-Liste für heute, die Pflanzen gießen, das Paket abholen und Nora zurückrufen. Und naja, keine Ahnung.', 'message', config);
    assert.equal(comma.match(/^- \[ \]/gm)?.length, 3); assert.doesNotMatch(comma, /- \[ \] Meine/);
    assert.equal((await formatDictation('Meine To-do-Liste. Milch kaufen. Nora anrufen.', 'message', config)).match(/^- \[ \]/gm)?.length, 2);
    const english = await formatDictation('My to-do list: buy bread and butter, pay the invoice and call Nora. And well... I don’t know...', 'message', config);
    assert.match(english, /- \[ \] buy bread and butter/); assert.equal(english.match(/^- \[ \]/gm)?.length, 3); assert.doesNotMatch(english, /well|don.t know/iu);
    const uncertain = 'Ja, ich komme morgen. Nein, das Paket ist noch nicht angekommen. Ich bin mir nicht sicher, ob die Adresse stimmt.';
    assert.equal(layoutProse(uncertain), uncertain);
    assert.match(listBlocks('Meine Liste: „Naja, keine Ahnung“ notieren.', ['Meine Liste: „Naja, keine Ahnung“ notieren.'], true)[1]?.text || '', /keine Ahnung/);
});

test('long prose gets readable topic paragraphs without changing words or embedded command examples', () => {
    const first = 'Wir haben die offenen Fragen zu dem Entwurf besprochen. Die Dokumente bleiben im lokalen Ordner und werden noch nicht veröffentlicht. Bitte prüfe die Dateien und dokumentiere den aktuellen Stand.';
    const second = 'One more thing, please review whether a new paragraph makes sense in the explanatory text. The command new paragraph is being discussed here, not executed.';
    const text = first + ' ' + second, result = layoutProse(text);
    assert.equal(result, first + '\n\n' + second);
    assert.equal(result.replace(/\s+/g, ' '), text);
});

test('task conditions stay attached to their action instead of becoming independent checkboxes', async () => {
    for (const [raw, expected] of [
        ['Meine To-do-Liste: Die Datei löschen, aber nur wenn Nora zugestimmt hat, die Logs sichern. Danach fahren wir los.',
            'Meine To-do-Liste:\n- [ ] Die Datei löschen, aber nur wenn Nora zugestimmt hat\n- [ ] die Logs sichern.\n\nDanach fahren wir los.'],
        ['My to-do list: delete the file, but only after approval, archive the logs. After that we will leave.',
            'My to-do list:\n- [ ] delete the file, but only after approval\n- [ ] archive the logs.\n\nAfter that we will leave.'],
        ['Meine To-do-Liste: Die Rechnung bezahlen, sofern die Freigabe da ist. Danach fahren wir los.',
            'Meine To-do-Liste:\n- [ ] Die Rechnung bezahlen, sofern die Freigabe da ist.\n\nDanach fahren wir los.'],
    ]) {
        assert.equal(await formatDictation(raw!, 'message', { ...config, dictationModel: '/missing' }), expected);
    }
});

test('implicit packing clauses form a local list between intact prose sections', async () => {
    const intro = 'Ich teste die neue Funktion. Für die Reise überlege ich, was ich alles einpacken muss.';
    const outro = 'Danach fahren wir gemeinsam zum Bahnhof. Bitte denk an die Kamera.';
    const raw = intro + ' Also ich brauche eine Taschenlampe, ich brauche eine neue Jacke, ich muss die Tickets holen. ' + outro;
    const expected = intro + '\n\n- eine Taschenlampe\n- eine neue Jacke\n- die Tickets holen.\n\n' + outro;
    assert.equal(needsDictationFormatting(raw, 'message'), false);
    assert.equal(await formatDictation(raw, 'message', { ...config, dictationModel: '/missing' }), expected);
    const sentences = 'Für die Fahrt muss ich alles einpacken. Ich brauche eine Jacke. Ich brauche Brot und Butter. Ich muss die Tickets holen. Danach fahren wir los.';
    const result = await formatDictation(sentences, 'message', config);
    assert.match(result, /- Brot und Butter\./); assert.equal(result.match(/^- /gm)?.length, 3);
    assert.match(result, /holen\.\n\nDanach fahren wir los\.$/);
});

test('explicit tasks and packing lists can occur in the same message with prose between them', async () => {
    const raw = 'Wir fahren morgen los. Meine To-do-Liste: Milch und Brot einkaufen, das Paket abholen und Nora zurückrufen. Danach fahren wir zum See. Meine Packliste: Jacke, Kamera und Tickets. Ich bin mir nicht sicher, ob es regnet.';
    const result = await formatDictation(raw, 'message', config);
    assert.equal(result.match(/^- \[ \] /gm)?.length, 3); assert.equal(result.match(/^- (?!\[)/gm)?.length, 3);
    assert.match(result, /^Wir fahren morgen los\.\n\nMeine To-do-Liste:\n/);
    assert.match(result, /Nora zurückrufen\.\n\nDanach fahren wir zum See\.\n\nMeine Packliste:/);
    assert.match(result, /Tickets\.\n\nIch bin mir nicht sicher, ob es regnet\.$/);
});

test('list closings return to prose without consuming continuation or splitting another action', async () => {
    const raw = 'Meine To-do-Liste: Milch kaufen, Nora anrufen. Danach das Paket abholen. Danach fahren wir nach Hause. Ich schicke den Bericht später.';
    const result = await formatDictation(raw, 'message', config);
    assert.equal(result.match(/^- \[ \] /gm)?.length, 3);
    assert.match(result, /- \[ \] Danach das Paket abholen\.\n\nDanach fahren wir nach Hause\./);
    const closing = 'Meine Packliste: Jacke, Kamera und Tickets. Ja genau, das war’s. Wir treffen uns um 10 Uhr.';
    assert.equal(await formatDictation(closing, 'message', config), 'Meine Packliste:\n- Jacke\n- Kamera\n- Tickets.\n\nWir treffen uns um 10 Uhr.');
    const implicit = 'Ich muss alles einpacken. Ich brauche Brot, ich brauche Wasser. Ja genau, das war’s und danach treffen wir uns.';
    const blocks = dictationBlocks(speechParagraphs(implicit));
    assert.equal(blocks.filter(block => block.item).length, 2);
    assert.match(blocks.at(-1)!.text, /^und danach treffen wir uns\.$/);
    assert.equal(needsDictationFormatting(implicit, 'message'), true, 'The lowercase continuation needs cleanup while retaining list layout');
});

test('English mixed lists retain their intro, compound items and following narrative', async () => {
    const raw = 'We leave tomorrow. My to-do list: buy bread and butter, pay the invoice and call Nora. After that we will meet near the station.';
    const result = await formatDictation(raw, 'message', config);
    assert.match(result, /^We leave tomorrow\.\n\nMy to-do list:\n- \[ \] buy bread and butter/);
    assert.equal(result.match(/^- \[ \] /gm)?.length, 3);
    assert.match(result, /call Nora\.\n\nAfter that we will meet near the station\.$/);
    const implicit = 'I am checking what to pack. I need a jacket, I need bread and butter, I have to collect the tickets. We will leave in the morning.';
    const packed = await formatDictation(implicit, 'message', config);
    assert.equal(packed.match(/^- /gm)?.length, 3); assert.match(packed, /- bread and butter/);
    assert.match(packed, /tickets\.\n\nWe will leave/);
});

test('list mentions, quoted cues and unrelated needs do not invent list sections', () => {
    for (const raw of ['Ich brauche eine Jacke, weil es regnet. Ich muss später los. Wir brauchen keine Liste.',
        'Ich muss alles einpacken. Ich brauche eine Jacke. Morgen wird es kalt. Ich muss die Tickets holen.',
        'Das Beispiel lautet „Meine Packliste: Brot, Wasser und Jacke“. Ich brauche keine neue Liste.',
        'Bitte prüfe die Packliste: Sie ist noch nicht freigegeben. Ich muss später los.',
        'Das ist keine Packliste: Wir fahren morgen los.']) {
        assert.equal(renderDictationBlocks(dictationBlocks(speechParagraphs(raw))), raw);
    }
});

test('semantic cleanup keeps the mixed layout and sends only sections that need editing', async context => {
    const seen: string[] = [];
    context.mock.method(globalThis, 'fetch', async (url, init) => {
        if (String(url).endsWith('/tokenize')) return Response.json({ tokens: Array(30).fill(1) });
        const prompt = JSON.parse(String(init?.body)).prompt as string;
        seen.push(prompt);
        assert.equal(prompt, 'text: und danach treffen wir uns.\nout:');
        return Response.json({ stop: true, content: 'Danach treffen wir uns.' });
    });
    const raw = 'Ich muss alles einpacken. Ich brauche Brot, ich brauche Wasser. Ja genau, das war’s und danach treffen wir uns.';
    assert.equal(await formatDictation(raw, 'message', config, undefined, server), 'Ich muss alles einpacken.\n\n- Brot\n- Wasser.\n\nDanach treffen wir uns.');
    assert.equal(seen.length, 1, 'Clean introduction and list items do not need generation');
});

test('unsupported cleanup languages keep their original text instead of using an untrained model', async () => {
    const raw = 'Ehm, domani non inviare il documento.';
    assert.equal(await formatDictation(raw, 'message', { ...config, language: 'italian', dictationPolish: 'always' }), raw);
});

test('clear list layout and a withdrawn final item need no model', async () => {
    const text = 'Für die Übergabe brauche ich erstens den Export, zweitens die Protokolle und drittens die Kundennummern und viertens außerdem deine... wobei, nee, egal, passt schon.';
    assert.equal(needsDictationFormatting(text, 'list'), false);
    assert.equal(await formatDictation(text, 'list', { ...config, dictationModel: '/missing' }), 'Für die Übergabe brauche ich:\n- den Export\n- die Protokolle\n- die Kundennummern');
    const todo = 'Meine To-do-Liste: Milch kaufen, die Rechnung bezahlen und Lea zurückrufen. Und ja auch die Einkaufsliste an... ne doch nicht, egal.';
    assert.equal((await formatDictation(todo, 'message', config)).match(/^- \[ \]/gm)?.length, 3);
    const literal = 'Für die Übergabe brauche ich erstens „wobei, nee, egal, passt schon“ und zweitens die Protokolle.';
    assert.equal(listBlocks(literal, [literal]).filter(block => block.item).length, 2);
});

test('list separators preserve quoted commas, decimals and meaningful item wording', async () => {
    const text = 'Meine Liste: „Brot, Butter und Milch“, Rechnung über 12,50 Euro prüfen und Lea anrufen.';
    assert.equal(await formatDictation(text, 'list', config), 'Meine Liste:\n- „Brot, Butter und Milch“\n- Rechnung über 12,50 Euro prüfen\n- Lea anrufen.');
    const item = 'Meine Liste: „Egal, passt schon“ notieren und Lea anrufen.';
    assert.match(await formatDictation(item, 'list', config), /„Egal, passt schon“ notieren/);
});

test('email layout preserves the dictated thanks, greeting and sender without generation', async () => {
    const email = 'Hallo Frau Müller, die Unterlagen sind da. Nächster Absatz. Bitte noch nicht freigeben. Neuer Absatz. Vielen Dank und viele Grüße, Sam.';
    const expected = 'Hallo Frau Müller,\n\ndie Unterlagen sind da.\n\nBitte noch nicht freigeben.\n\nVielen Dank und viele Grüße\nSam.';
    assert.equal(needsDictationFormatting(email, 'message'), false);
    assert.equal(await formatDictation(email, 'message', { ...config, dictationModel: '/missing' }), expected);
    assert.equal(layoutEmail(expected), expected);
});

test('explicit yes and no answers are retained without duplicating prefixes elsewhere', () => {
    const source = 'Ja, ich komme morgen. Nein, die Rechnung ist noch nicht freigegeben. Ich bin mir nicht sicher.';
    assert.equal(preserveAnswerPrefixes(source, source), source);
    assert.equal(preserveAnswerPrefixes(source, 'Ja, ich komme morgen. Die Rechnung ist noch nicht freigegeben. Ich bin mir nicht sicher.'), source);
    assert.equal(preserveAnswerPrefixes('Es sind 87, nein, 88 Euro.', 'Es sind 88 Euro.'), 'Es sind 88 Euro.');
});

test('fast formatter uses the trained plain completion protocol and rejects incomplete output', async context => {
    let output = { stop: true, stopped_limit: false, content: 'Bitte am Freitag senden.' };
    let completions = 0;
    context.mock.method(globalThis, 'fetch', async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith('/tokenize')) return Response.json({ tokens: Array(30).fill(1) });
        assert.match(String(url), /\/completion$/); assert.equal(body.temperature, 0); assert.equal(body.messages, undefined);
        assert.match(body.prompt, /^text: Bitte morgen, nein, am Freitag senden\.\nout:$/);
        assert.equal(body.n_predict, 158); completions++;
        return Response.json(output);
    });
    const raw = 'Bitte morgen, nein, am Freitag senden.';
    assert.equal(await formatDictation(raw, 'message', config, undefined, server), output.content);
    output = { ...output, stopped_limit: true };
    await assert.rejects(formatDictation(raw, 'message', config, undefined, server), /did not finish/);
    assert.equal(completions, 2);
});

test('oversize specialist context fails before generation and cancel remains effective', async context => {
    let tokenize = 0;
    const controller = new AbortController();
    context.mock.method(globalThis, 'fetch', async url => {
        assert.match(String(url), /\/tokenize$/); tokenize++;
        return Response.json({ tokens: Array(2100).fill(1) });
    });
    await assert.rejects(formatDictation('Ähm, bitte prüfen.', 'message', config, undefined, server), /context/);
    controller.abort();
    await assert.rejects(formatDictation('Ähm, bitte prüfen.', 'message', config, controller.signal, server), /abort/i);
    assert.equal(tokenize, 1);
});
