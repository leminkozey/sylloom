import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Audio } from './audio.js';
import { Recorder } from './recorder.js';
import { startControl } from './control.js';
import { Transcription, timestamp } from './transcription.js';
import { createSession, home, nameSession, saveSettings, sessionDirectory, sessions } from './store.js';
import { installModel, models } from './models.js';
import { finishSession, reopenSession } from './workflow.js';
import { documentPath, exportDocument, exportName, openDocument } from './documents.js';
import type { DocumentKind, ExportFormat } from './documents.js';
import { Screen } from './terminal/screen.js';
import type { Choice } from './terminal/screen.js';
import style from './terminal/style.js';
import type { Decision, Session, Settings, Source } from './types.js';
import { errorMessage } from './types.js';
import { createInterface, dictationMenu } from './dictation-ui.js';
import { formatLabels } from './formatter.js';
import { copyText } from './clipboard.js';
import { dictationConfig } from './dictation-models.js';
import type { DictationFormat } from './types.js';

const back = { value: 'back', name: "Back" };
const choices = (values: [string, string, string?][]): Choice[] => values.map(([value, name, hint]) => ({ value, name, hint }));

export async function deviceMenu(screen: Screen, config: Settings, source: Source, recorder?: Recorder): Promise<void> {
    const audio = recorder?.audio || new Audio();
    try {
        for (;;) {
            const devices = await screen.task("Audio devices", () => audio.devices());
            const current = source === 'mic' ? config.input : config.output;
            const list: Choice[] = [{ value: 'default', name: (current === 'default' ? '✓ ' : '') + "Follow system default", hint: "Follow the default device, including changes during recording." }];
            for (const device of devices.filter(device => device.sourceKind === source && device.formatAvailable)) {
                list.push({ value: device.id, name: (current === device.id ? '✓ ' : '') + device.name + (device.isDefault ? " · Default" : ''), hint: device.id });
            }
            list.push({ value: 'refresh', name: "Refresh devices" }, back);
            const selected = await screen.select(source === 'mic' ? "Choose microphone" : "Choose system audio", list, {
                detail: recorder ? "Switch devices while recording" : source === 'mic' ? "Microphone for your voice" : "Output device to capture", back: true,
            });
            if (['back', 'quit', 'settings'].includes(selected)) return;
            if (selected === 'refresh') continue;
            if (recorder) await screen.task("Switch audio device", () => recorder.switch(source, selected));
            if (source === 'mic') config.input = selected; else config.output = selected;
            await saveSettings(config);
            return;
        }
    } finally { if (!recorder) await audio.close(); }
}

export async function modelMenu(screen: Screen, config: Settings): Promise<void> {
    for (;;) {
        const selected = await screen.select("Local models", choices([
            ['whisper', "Install Whisper large-v3", "Full model, about 2.9 GiB. Transcribes after recording."],
            ['dictation-whisper', "Install fast dictation model", "Whisper large-v3-turbo, about 1.5 GiB. Dictation only."],
            ['llama', "Install note model", "Qwen3 4B Q4_K_M, about 2.33 GiB. Local meeting notes."],
            ['formatter', "Install dictation formatter", "Qwen3.5 4B, German and English. Formatting only, about 2.6 GiB."],
            ['formatter-path', "Choose custom dictation formatter", config.dictationModel],
            ['whisper-path', "Choose custom meeting Whisper model", config.whisperModel],
            ['dictation-whisper-path', "Choose dictation Whisper model", dictationConfig(config).whisperModel],
            ['llm-path', "Choose custom GGUF note model", config.llmModel],
            ['backend', "Note backend: " + (config.llm === 'llama' ? 'llama.cpp' : 'Ollama'), "Both backends run locally."],
            ['ollama-model', "Ollama model: " + config.ollamaModel],
            ['back', "Back"],
        ]), { back: true, detail: (existsSync(config.whisperModel) ? "Whisper ready" : "Whisper missing") + ' · ' + (existsSync(config.llmModel) ? "GGUF ready" : "GGUF missing") });
        if (['quit', 'back', 'settings'].includes(selected)) return;
        try {
            if (selected === 'whisper' || selected === 'llama' || selected === 'formatter' || selected === 'dictation-whisper') {
                const target = await screen.task(models[selected].label + ": installing", (update, signal) => installModel(selected, (received, total) => {
                    update(Math.round(received / total * 100) + '% · ' + Math.round(received / 1024 / 1024) + ' / ' + Math.round(total / 1024 / 1024) + ' MiB');
                }, signal));
                if (selected === 'whisper') config.whisperModel = target;
                else if (selected === 'dictation-whisper') config.dictationWhisperModel = target;
                else if (selected === 'formatter') config.dictationModel = target;
                else { config.llmModel = target; config.llm = 'llama'; }
            } else if (selected === 'backend') config.llm = config.llm === 'llama' ? 'ollama' : 'llama';
            else if (selected === 'ollama-model') {
                const value = await screen.input("Ollama model", "Name of an already installed local model", config.ollamaModel);
                if (value?.trim()) config.ollamaModel = value.trim();
            } else {
                const key = selected === 'whisper-path' ? 'whisperModel' : selected === 'dictation-whisper-path' ? 'dictationWhisperModel' : selected === 'formatter-path' ? 'dictationModel' : 'llmModel';
                const value = await screen.input("Local model file", "Absolute path to the model file", config[key]);
                if (value) {
                    if (!existsSync(value)) throw new Error("File not found: " + value);
                    config[key] = path.resolve(value);
                }
            }
            await saveSettings(config);
        } catch (error) { await screen.notice("Model setup failed", errorMessage(error)); }
    }
}

export async function settingsMenu(screen: Screen, config: Settings): Promise<void> {
    for (;;) {
        const selected = await screen.select("Settings", choices([
            ['input', "Microphone", config.input], ['output', "System audio", config.output],
            ['language', "Transcription language: " + config.language, "de, en or auto"],
            ['dictation-format', "Dictation format: " + formatLabels[config.dictationFormat], "Message, email or list. The original transcript stays available."],
            ['dictation-polish', "Dictation polish: " + (config.dictationPolish === 'always' ? "Always use model" : "Automatic"), "Automatic passes through clean messages. Corrections, lists and emails use the formatter."],
            ['dictation-warm', "Keep dictation models warm: " + config.dictationWarmSeconds + ' s', "Faster repeated dictation uses more RAM temporarily. 0 frees models after each dictation."],
            ['models', "Local models"], ['back', "Back"],
        ]), { back: true, detail: "Recording and processing stay on this device." });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
            if (selected === 'input' || selected === 'output') await deviceMenu(screen, config, selected === 'input' ? 'mic' : 'system');
            if (selected === 'models') await modelMenu(screen, config);
            if (selected === 'dictation-polish') config.dictationPolish = config.dictationPolish === 'always' ? 'auto' : 'always';
            if (selected === 'dictation-warm') {
                const value = await screen.input("Keep dictation models warm", "Idle seconds, from 0 to 600", String(config.dictationWarmSeconds));
                if (value !== null) {
                    const seconds = Number(value);
                    if (!value.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 600) throw new Error("Enter a whole number from 0 to 600 seconds.");
                    config.dictationWarmSeconds = seconds;
                }
            }
            if (selected === 'dictation-format') {
                const format = await screen.select("Dictation format", [...Object.entries(formatLabels).map(([value, name]) => ({ value, name })), back], { back: true });
                if (Object.hasOwn(formatLabels, format)) config.dictationFormat = format as DictationFormat;
            }
            if (selected === 'language') {
                const value = await screen.input("Transcription language", "Language code, such as de, en or auto", config.language);
                if (value && /^[a-z]{2,3}$/.test(value.trim())) config.language = value.trim();
            }
            await saveSettings(config);
        } catch (error) { await screen.notice("Setting not saved", errorMessage(error)); }
    }
}

export async function finishFlow(screen: Screen, session: Session, config: Settings, transcription?: Transcription): Promise<boolean> {
    try {
        while (!session.name) {
            const name = await screen.input("Name recording", "Then choose what happens to the transcript.");
            if (name === null) return false;
            try { await nameSession(session, name); }
            catch (error) { await screen.notice("Name required", errorMessage(error)); }
        }
        for (;;) {
            const selected = await screen.select(session.name, choices([
                ['summarize', "Keep structured note and transcript", "Local model: topics, decisions, open questions, actions, dates and risks. Audio is kept."],
                ['note-only', "Keep structured note only", "Delete transcript and text chunks after the note is saved. Audio is kept."],
                ['keep', "Keep transcript", "No note model. Failed transcription is clearly marked as incomplete."],
                ['delete', "Delete transcript, keep audio", "Delete this recording’s text. No summary."],
                ['view', "Read transcript"], ['rename', "Rename"], ['models', "Set up models"],
            ]), { detail: "Choose what to keep before continuing." });
            if (selected === 'quit') return false;
            if (selected === 'settings') { await settingsMenu(screen, config); continue; }
            if (selected === 'models') { await modelMenu(screen, config); continue; }
            if (selected === 'rename') {
                const name = await screen.input("Name recording", "Recording name", session.name);
                if (name !== null) await nameSession(session, name);
                continue;
            }
            if (selected === 'view') {
                const file = path.join(sessionDirectory(session.id), 'transcript.md');
                const text = existsSync(file) ? await readFile(file, 'utf8') : "No transcript yet. Choose how to process this recording first.";
                await screen.view(session.name, () => text);
                continue;
            }
            try {
                const result = await screen.task("Finish recording", (update, signal) => finishSession(session, selected as Decision, config, update, transcription, signal));
                if (selected === 'summarize' || selected === 'note-only') {
                    const note = await readFile(result, 'utf8');
                    await screen.view(session.name, () => note);
                    if (!screen.quitRequested) return await documentMenu(screen, session, config);
                } else await screen.notice("Recording finished", result);
                return true;
            } catch (error) {
                if (session.state === 'done') { await screen.notice("Recording saved; view failed", errorMessage(error)); return true; }
                transcription = undefined; await screen.notice("Recording remains open", errorMessage(error));
            }
        }
    } finally { await transcription?.close(); }
}

export async function documentMenu(screen: Screen, session: Session, config: Settings): Promise<boolean> {
    for (;;) {
        if (screen.quitRequested) return false;
        const hasNote = existsSync(documentPath(session, 'note'));
        const hasTranscript = existsSync(documentPath(session, 'transcript'));
        const kind: DocumentKind = hasNote ? 'note' : 'transcript';
        const items: Choice[] = [];
        if (hasNote || hasTranscript) items.push({ value: 'read', name: hasNote ? "Read note in terminal" : "Read transcript in terminal" },
            { value: 'open', name: "Open in browser" }, { value: 'copy', name: "Copy Markdown" }, { value: 'export', name: "Export" });
        if (hasNote && hasTranscript) items.push({ value: 'transcript', name: "Read transcript in terminal" });
        items.push({ value: 'reprocess', name: "Reprocess audio", hint: "Transcribe again and choose what to keep. Existing documents stay until processing." }, back);
        const selected = await screen.select(session.name || "Recording", items, { back: true, detail: "Read, open and export" });
        if (selected === 'quit') return false;
        if (selected === 'back') return true;
        try {
            if (selected === 'settings') { await settingsMenu(screen, config); continue; }
            if (selected === 'read' || selected === 'transcript') {
                const text = await readFile(documentPath(session, selected === 'transcript' ? 'transcript' : kind), 'utf8');
                await screen.view(session.name || "Recording", () => text);
            }
            if (selected === 'open') {
                await openDocument(session, kind);
                await screen.notice("Sent to browser", "The local reading view was sent to your default browser.");
            }
            if (selected === 'copy') {
                await copyText(await readFile(documentPath(session, kind), 'utf8'));
                await screen.notice("Copied", "Markdown copied. Paste with Cmd+V.");
            }
            if (selected === 'export') {
                const formats: Choice[] = [];
                for (const item of ['note', 'transcript'] as const) {
                    if (!existsSync(documentPath(session, item))) continue;
                    const label = item === 'note' ? "Note" : "Transcript";
                    formats.push({ value: item + ':md', name: label + " as Markdown" }, { value: item + ':html', name: label + " as HTML" });
                }
                const choice = await screen.select("Export", [...formats, back], { back: true, detail: "Read or print HTML in your browser." });
                if (!choice.includes(':')) continue;
                const [document, format] = choice.split(':') as [DocumentKind, ExportFormat];
                const suggested = path.join(home, 'exports', exportName(session, document, format));
                const output = await screen.input("Export path", "Destination file. Existing files will not be overwritten.", suggested);
                if (!output) continue;
                const target = await exportDocument(session, document, output, format);
                await screen.notice('Export gespeichert', target);
            }
            if (selected === 'reprocess') {
                await reopenSession(session);
                return finishFlow(screen, session, config);
            }
        } catch (error) { await screen.notice("Action not completed", errorMessage(error)); }
    }
}

function meter(rms: number): string {
    const db = rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
    const count = Math.round((db + 60) / 60 * 12);
    return style('▰'.repeat(count), 'accent') + style('▱'.repeat(12 - count), 'muted');
}

export async function recordFlow(screen: Screen, config: Settings): Promise<boolean> {
    if (screen.dictation?.busy) throw new Error("Stop or cancel dictation first.");
    screen.recordingActive = true;
    try { return await captureFlow(screen, config); }
    finally { screen.recordingActive = false; }
}

async function captureFlow(screen: Screen, config: Settings): Promise<boolean> {
    const session = await createSession();
    const recorder = new Recorder(session, config);
    let stopRequested = false;
    let failure = '';
    let closeControl: (() => Promise<void>) | undefined;
    recorder.on('stopRequested', () => { stopRequested = true; });
    recorder.on('failure', error => { failure = errorMessage(error); stopRequested = true; });
    try {
        await screen.task("Starting recording", () => recorder.start());
        closeControl = await startControl(recorder);
        while (!stopRequested) {
            if (screen.quitRequested) { screen.quitRequested = false; break; }
            const selected = await screen.select("Record meeting", () => choices([
                ['pause', session.state === 'paused' ? "Resume" : "Pause"],
                ['input', "Switch microphone"], ['output', "Switch system audio"],
                ['mute-mic', recorder.muted.mic ? "Unmute microphone" : "Mute microphone"],
                ['mute-system', recorder.muted.system ? "Unmute system audio" : "Mute system audio"],
                ['stop', "Stop recording"],
            ]), {
                detail: () => timestamp((Date.now() - Date.parse(session.startedAt)) / 1000) + ' · ' + (session.state === 'paused' ? "PAUSED" : "RECORDING"),
                before: () => [
                    "Microphone   " + meter(recorder.levels.mic) + '  ' + (recorder.muted.mic ? "Muted" : recorder.current.mic) + ' · ' + recorder.health.mic,
                    "System audio " + meter(recorder.levels.system) + '  ' + (recorder.muted.system ? "Muted" : recorder.current.system) + ' · ' + recorder.health.system,
                    '',
                    style("Transcription and notes follow after stopping and choosing what to keep.", 'muted'),
                    '',
                ],
                footer: "Space Pause · I/O Devices · M Microphone · S Stop",
                shortcuts: { ' ': 'pause', p: 'pause', i: 'input', o: 'output', s: 'stop', m: 'mute-mic' },
                complete: () => stopRequested ? 'stop' : undefined,
            });
            try {
                if (selected === 'stop' || selected === 'quit') { screen.quitRequested = false; break; }
                if (selected === 'pause') await recorder.pause();
                if (selected === 'input' || selected === 'output') await deviceMenu(screen, config, selected === 'input' ? 'mic' : 'system', recorder);
                if (selected === 'settings') await deviceMenu(screen, config, 'mic', recorder);
                if (selected === 'mute-mic') await recorder.toggleMute('mic');
                if (selected === 'mute-system') await recorder.toggleMute('system');
            } catch (error) { await screen.notice("Recording continues", errorMessage(error)); }
        }
        await screen.task("Stop recording", () => recorder.stop());
        await closeControl(); closeControl = undefined;
        if (failure) await screen.notice("Recording stopped with an error", failure);
        return await finishFlow(screen, session, config);
    } finally {
        await recorder.stop();
        await closeControl?.();
    }
}

export async function mainMenu(config: Settings): Promise<void> {
    const ui = createInterface(config);
    const { screen } = ui;
    try {
        for (;;) {
            if (screen.quitRequested) return;
            const all = await sessions();
            const pending = all.find(session => session.state !== 'done');
            const selected = await screen.select("Capture meetings locally", choices([
                [pending ? 'finish' : 'record', pending ? "Finish pending recording" : "Start recording", pending?.name || "Microphone and system audio, recorded separately."],
                ['dictation', "Dictation", "Ctrl+Option+Space starts and stops in any app. Text is formatted and copied locally."],
                ['recordings', "Recordings", all.length + " recording(s) saved"],
                ['settings', "Settings"], ['models', "Local models"], ['quit', "Quit"],
            ]), { detail: (existsSync(config.whisperModel) ? "Transcription model ready" : "Set up Whisper first") + " · Process after recording", shortcuts: { f8: 'dictation-toggle' } });
            try {
                if (selected === 'quit') return;
                if (selected === 'dictation') await dictationMenu(screen);
                if (selected === 'dictation-toggle') { void ui.service.toggle(); }
                if (selected === 'settings') await settingsMenu(screen, config);
                if (selected === 'models') await modelMenu(screen, config);
                if (selected === 'record' && !await recordFlow(screen, config)) return;
                if (selected === 'finish' && pending && !await finishFlow(screen, pending, config)) return;
                if (selected === 'recordings') {
                    const id = await screen.select("Recordings", [...all.map(session => ({ value: session.id,
                        name: (session.name || "Untitled") + ' · ' + new Date(session.startedAt).toLocaleString("en-GB") + (session.state !== 'done' ? " · OPEN" : ''),
                        hint: sessionDirectory(session.id),
                    })), back], { back: true });
                    const session = all.find(item => item.id === id);
                    if (session?.state === 'stopped') { if (!await finishFlow(screen, session, config)) return; }
                    else if (session && !await documentMenu(screen, session, config)) return;
                }
            } catch (error) { await screen.notice("Action not completed", errorMessage(error)); }
        }
    } finally { await ui.close(); }
}
