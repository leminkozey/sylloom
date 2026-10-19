// Optional macOS integration check. --audio plays a synthetic German test meeting.
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-verify-'));
process.env.SYLLOOM_HOME = directory;
const { createSession, defaults, nameSession, sessionDirectory, loadSession } = await import('../src/store.js');
const { Recorder } = await import('../src/recorder.js');
const { startControl, control } = await import('../src/control.js');
const { Transcription, transcriptText } = await import('../src/transcription.js');
const { finishSession } = await import('../src/workflow.js');
const { RATE, readWavSlice, sampleCount, hasSpeechEnergy } = await import('../src/wav.js');
const config = { ...defaults, language: 'de',
    whisperModel: fileURLToPath(new URL('../data/models/ggml-large-v3.bin', import.meta.url)),
    llmModel: fileURLToPath(new URL('../data/models/Qwen3-4B-Q4_K_M.gguf', import.meta.url)),
};
const text = 'Wir haben heute den Importfehler besprochen. Die CSV-Datei enthält doppelte Rechnungen. Wir entscheiden, den Import bis zur Korrektur zu pausieren. Alex prüft bis Dienstag die Erkennung der Duplikate. Sam testet am Mittwoch den korrigierten Import. Offen ist, ob ältere Rechnungen ebenfalls betroffen sind. Es gibt noch keinen Termin für den nächsten produktiven Lauf.';
const aiff = path.join(directory, 'speech.aiff');
const providedInput = process.argv.indexOf('--input');
const wav = providedInput >= 0 ? path.resolve(process.argv[providedInput + 1]!) : path.join(directory, 'speech.wav');
console.log('Test directory: ' + directory);
if (providedInput < 0) for (const [command, args] of [
    ['say', ['-v', 'Anna (German (Germany))', '-r', '185', '-o', aiff, text]],
    ['ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1', wav]],
] as [string, string[]][]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(command + ': ' + (result.error?.message || result.stderr));
}

const session = await createSession();
const root = sessionDirectory(session.id);
const transcription = new Transcription(session, config);
let recorder: InstanceType<typeof Recorder> | undefined;
let closeControl: (() => Promise<void>) | undefined;
try {
    if (process.argv.includes('--audio')) {
        recorder = new Recorder(session, config);
        recorder.on('failure', error => { console.error(error); });
        await recorder.start();
        closeControl = await startControl(recorder);
        console.log('Native recording started. Testing pause, resume and hot-swap.');
        await delay(500);
        await control('pause'); await delay(250);
        const before = (await stat(path.join(root, 'mic.wav'))).size;
        await delay(500);
        assert.equal((await stat(path.join(root, 'mic.wav'))).size, before, 'Paused capture must not persist audio');
        await control('resume');
        await control('input', recorder.current.mic);
        const alternative = recorder.inventory.find(device => device.sourceKind === 'system' && device.id !== recorder!.current.system && device.formatAvailable);
        if (alternative) { await control('output', alternative.id); await delay(300); }
        await control('output', 'default');
        await control('mute-mic');
        console.log('Playing synthetic test speech.');
        const player = spawn('afplay', [aiff], { stdio: 'ignore' });
        const [code] = await once(player, 'exit'); assert.equal(code, 0);
        assert.equal(transcription.segments.length, 0, 'Recording must not run live transcription');
        await delay(400);
        await control('mute-mic');
        const result = await control('stop') as { state: string }; assert.equal(result.state, 'stopped');
        await closeControl(); closeControl = undefined;
        const count = sampleCount(path.join(root, 'system.wav'));
        assert.ok(count > RATE * 5, 'System track must contain actual samples');
        assert.equal(hasSpeechEnergy(readWavSlice(path.join(root, 'system.wav'), 0, count)), true, 'System capture must contain nonzero playback');
        assert.ok(sampleCount(path.join(root, 'mic.wav')) > RATE, 'Microphone track must contain actual samples');
        console.log('Native recording, pause/resume, control socket and device switching passed.');
    } else {
        await copyFile(wav, path.join(root, 'system.wav'));
        session.state = 'stopped'; session.stoppedAt = new Date().toISOString();
    }
    await transcription.initialize();
    await nameSession(session, 'Synthetic import test');
    console.log('Testing local Whisper and Qwen.');
    await transcription.drain();
    const transcript = transcriptText(transcription.segments);
    assert.match(transcript, /Import/i);
    assert.match(transcript, /Dienstag/i);
    const result = await finishSession(session, 'summarize', config, message => console.log(message), transcription);
    const note = await readFile(result, 'utf8');
    assert.match(note, /## Decisions/);
    assert.match(note, /Alex/);
    assert.match(note, /Dienstag/);
    assert.match(note, /## Open questions/);
    assert.doesNotMatch(note, /^- \[ \].*(Set|Schedule|Define).*(date|production run)/mi, 'An unspecified date must not become an invented assignment');
    assert.equal((await loadSession(session.id)).decision, 'summarize');
    const { exportDocument } = await import('../src/documents.js');
    const { renderMarkdown } = await import('../src/terminal/markdown.js');
    const exported = await exportDocument(session, 'note', path.join(directory, 'Import-Test.html'), 'html');
    assert.match(await readFile(exported, 'utf8'), /<h2>Next steps<\/h2>/);
    const rendered = renderMarkdown(note, 72).join('\n');
    assert.match(rendered, /☐/);
    assert.doesNotMatch(rendered, /^## /m);
    await writeFile(path.join(directory, 'verification.json'), JSON.stringify({ passed: true, nativeAudio: process.argv.includes('--audio'), session: session.id, note: result }, null, 2));
    console.log('PASSED. Results: ' + directory);
} finally {
    await recorder?.stop();
    await closeControl?.();
    await transcription.close();
}
