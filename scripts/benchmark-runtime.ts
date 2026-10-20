// Same selected weights, prompt and sampling on both runtimes. No microphone or clipboard.
import assert from 'node:assert/strict';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { settings, home } from '../src/store.js';
import { ModelServer } from '../src/server.js';
import { dictationRuntimeArguments, usesCleanupModel } from '../src/model-runtime.js';
import { dictationParagraphs, formatDictation, needsDictationFormatting } from '../src/formatter.js';
import { dictationConfig } from '../src/dictation-models.js';
import { Transcription } from '../src/transcription.js';
import type { DictationFormat } from '../src/types.js';

const config = { ...await settings(), dictationPolish: 'always' as const };
const output = path.join(home, 'runtime-qa', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true, mode: 0o700 });

const cases: { name: string; raw: string; format: DictationFormat; check: (text: string) => void }[] = [
    { name: 'Short correction', format: 'message',
        raw: 'Ähm, ich ich prüfe den Import AB-482 morgen um vierzehn Uhr dreißig. Bitte nicht freigeben.',
        check: text => { assert.match(text, /AB-482/); assert.match(text, /14[:.]30/); assert.match(text, /nicht freigeben/i); assert.doesNotMatch(text, /ich ich|ähm/i); } },
    { name: 'Amounts and negation', format: 'message',
        raw: 'Der Betrag ist zwölf Euro fünfzig, nicht dreizehn Euro. Der Steuersatz bleibt bei neunzehn Prozent.',
        check: text => { assert.match(text, /12[,.]50/); assert.match(text, /nicht\s+13/); assert.match(text, /19\s*(?:%|Prozent)/i); } },
    { name: 'Correction and paragraphs', format: 'message',
        raw: 'Hallo Lea, ich schicke dir den Export morgen, nein, am Donnerstag. Neuer Absatz. Bitte prüfe die doppelten Rechnungen und die fehlenden Kundennummern. Der Produktivlauf bleibt pausiert.',
        check: text => { assert.match(text, /Donnerstag/); assert.doesNotMatch(text, /morgen|neuer Absatz/i); assert.match(text, /\n\n/); assert.match(text, /pausiert/); } },
    { name: 'List', format: 'list',
        raw: 'Bitte erstens den Import prüfen, zweitens die Logs sichern und drittens Lea informieren.',
        check: text => { for (const word of ['Import', 'Logs', 'Lea']) assert.match(text, new RegExp('(?:^|\\n)(?:-|\\d+[.)])\\s+.*' + word, 'i')); } },
    { name: 'Long message', format: 'message',
        raw: 'Hallo Lea, ich habe mir die offenen Punkte für unser Projekt angesehen. Der Import AB-482 läuft noch nicht in der Produktion. Wir müssen zuerst die doppelten Rechnungen prüfen und die fehlenden Kundennummern ergänzen. Der Betrag lautet zwölf Euro fünfzig, nicht dreizehn Euro. Bitte schicke den Export morgen, nein, am Donnerstag um vierzehn Uhr dreißig an unser Team. Die Datei config.json darf nicht gelöscht werden und der Endpoint bleibt /api/v2/invoices. Die Freigabe ist weiterhin gesperrt, bis die Prüfung abgeschlossen ist. Es wurden keine Rechnungen gelöscht. Für den nächsten Test brauchen wir die Protokolle vom Dienstag und einen neuen Export aus der Testumgebung. Bitte dokumentiere alle Änderungen in der gemeinsamen Notiz und informiere Lea nach dem Test. Wir wollen den Fehler zuerst reproduzieren und erst danach eine neue Version bereitstellen. Die Kundennummer lautet AB-007. Für das nächste Meeting planen wir dreißig Minuten ein. Dabei besprechen wir die offenen Fragen, den nächsten Termin und die Reihenfolge der weiteren Schritte. Vielen Dank für deine Unterstützung.',
        check: text => {
            for (const fact of ['AB-482', 'AB-007', 'config.json', '/api/v2/invoices', 'Donnerstag', 'Testumgebung']) assert.ok(text.includes(fact), 'Missing fact: ' + fact);
            assert.match(text, /12[,.]50/); assert.match(text, /14[:.]30/); assert.match(text, /30 Minuten/);
            assert.match(text, /keine Rechnungen gelöscht/); assert.match(text, /nicht gelöscht werden/); assert.doesNotMatch(text, /morgen/i);
        } },
];
const originalFetch = globalThis.fetch;
const results: { variant: string; pass: number; sample: string; ms: number; text: string; timings: unknown }[] = [];
const loads: { variant: string; ms: number }[] = [];
let timings: unknown;

async function benchmarkAudio(): Promise<void> {
    const audio = path.join(output, 'speech.wav'), aiff = path.join(output, 'speech.aiff');
    const spoken = cases[2]!.raw;
    for (const [binary, args] of [
        ['say', ['-v', 'Anna (German (Germany))', '-r', '180', '-o', aiff, spoken]],
        ['ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', audio]],
    ] as [string, string[]][]) {
        const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000 });
        if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Synthetic speech generation failed.');
    }
    const selected = { ...dictationConfig(config), dictationPolish: 'auto' as const };
    const whisper = new ModelServer(selected.whisperBinary, selected.whisperModel, 'whisper');
    const pipeline: { variant: string; pass: number; transcriptionMs: number; formattingMs: number; totalMs: number; raw: string; text: string }[] = [];
    try {
        await whisper.start();
        for (const variant of ['baseline', 'optimized'] as const) {
            const server = new ModelServer(config.llmBinary, config.dictationModel, 'llama',
                variant === 'baseline' ? { contextSize: usesCleanupModel(config.dictationModel) ? 4096 : 8192 } : { contextSize: usesCleanupModel(config.dictationModel) ? 4096 : 16384, profile: 'dictation' });
            try {
                await server.start();
                for (let pass = 0; pass < 3; pass++) {
                    const directory = path.join(output, variant + '-' + pass);
                    await mkdir(path.join(directory, 'chunks'), { recursive: true, mode: 0o700 });
                    await copyFile(audio, path.join(directory, 'mic.wav'));
                    const session = { id: randomUUID(), name: 'Synthetic runtime benchmark', startedAt: new Date().toISOString(),
                        stoppedAt: new Date().toISOString(), state: 'stopped' as const, decision: null, recovered: false, events: [] };
                    const transcription = new Transcription(session, selected, directory, whisper);
                    const start = performance.now(); let raw = '';
                    try {
                        await transcription.initialize(); await transcription.drain();
                        raw = transcription.segments.map(segment => segment.text).join(' ');
                    } finally { await transcription.close(); }
                    const transcriptionMs = Math.round(performance.now() - start), formattingStart = performance.now();
                    let text: string;
                    if (variant === 'baseline' && needsDictationFormatting(raw, 'message')) {
                        // Reproduce the previous Auto routing: one edited section
                        // sent every paragraph through the same formatter prompt.
                        const parts: string[] = [];
                        for (const paragraph of dictationParagraphs(raw)) parts.push(await formatDictation(paragraph, 'message', config, undefined, server));
                        text = parts.join('\n\n');
                    } else text = await formatDictation(raw, 'message', selected, undefined, server);
                    const result = { variant, pass, transcriptionMs, formattingMs: Math.round(performance.now() - formattingStart),
                        totalMs: Math.round(performance.now() - start), raw, text };
                    pipeline.push(result);
                    await writeFile(path.join(output, 'pipeline.json'), JSON.stringify(pipeline, null, 2), { mode: 0o600 });
                    cases[2]!.check(text);
                    console.log(variant + ' · Audio to formatted text · pass ' + (pass + 1) + ': ' + result.totalMs + ' ms');
                }
            } finally { await server.stop(); }
        }
        assert.equal(new Set(pipeline.map(item => item.text)).size, 1, 'The fixed audio must keep the same final text');
        console.table(pipeline.map(({ raw: _raw, text: _text, ...result }) => result));
    } finally { await whisper.stop(); }
}
// Greedy decoding makes quality comparisons meaningful. Production sampling is unchanged.
globalThis.fetch = async (input, init) => {
    if (/\/(?:v1\/chat\/completions|completion)$/.test(String(input)) && typeof init?.body === 'string') {
        const body = JSON.parse(init.body); body.temperature = 0; body.seed = 42;
        const response = await originalFetch(input, { ...init, body: JSON.stringify(body) });
        timings = (await response.clone().json() as { timings?: unknown }).timings;
        return response;
    }
    return originalFetch(input, init);
};
try {
    if (!process.argv.includes('--audio-only')) {
        for (const variant of ['baseline', 'optimized'] as const) {
            const server = new ModelServer(config.llmBinary, config.dictationModel, 'llama',
                variant === 'baseline' ? { contextSize: usesCleanupModel(config.dictationModel) ? 4096 : 8192 } : { contextSize: usesCleanupModel(config.dictationModel) ? 4096 : 16384, profile: 'dictation' });
            try {
                const start = performance.now(); await server.start();
                loads.push({ variant, ms: Math.round(performance.now() - start) });
                for (let pass = 0; pass < 3; pass++) for (const sample of cases) {
                    const before = performance.now();
                    const text = await formatDictation(sample.raw, sample.format, config, undefined, server);
                    const result = { variant, pass, sample: sample.name, ms: Math.round(performance.now() - before), text, timings };
                    results.push(result);
                    await writeFile(path.join(output, 'results.json'), JSON.stringify({ loads, results }, null, 2), { mode: 0o600 });
                    console.log(variant + ' · ' + sample.name + ' · pass ' + (pass + 1) + ': ' + result.ms + ' ms');
                    sample.check(text);
                }
            } finally { await server.stop(); }
        }
        const model = await stat(config.dictationModel);
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
        const summary = cases.map(sample => {
            const baseline = results.filter(item => item.variant === 'baseline' && item.sample === sample.name);
            const optimized = results.filter(item => item.variant === 'optimized' && item.sample === sample.name);
            const before = median(baseline.map(item => item.ms)), after = median(optimized.map(item => item.ms));
            return { sample: sample.name, before, after, percentFaster: Math.round((1 - after / before) * 100),
                identicalText: optimized.every(item => baseline.some(old => old.text === item.text)) };
        });
        await writeFile(path.join(output, 'summary.json'), JSON.stringify({
            model: path.basename(config.dictationModel), size: model.size, modified: model.mtime.toISOString(),
            runtimeArguments: await dictationRuntimeArguments(config.llmBinary), loads, summary,
            quality: 'All semantic checks passed; inspect results.json for full synthetic outputs. Timings exclude ASR and delivery.',
        }, null, 2), { mode: 0o600 });
        console.table(summary);
    }
    if (process.argv.includes('--audio') || process.argv.includes('--audio-only')) await benchmarkAudio();
    console.log('Local benchmark saved to ' + output);
} finally { globalThis.fetch = originalFetch; }
