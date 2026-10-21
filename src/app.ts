import { DICTATION_SHORTCUT } from './hotkey.js';
import { PASTE_SHORTCUT } from './platform.js';
import { existsSync } from 'node:fs';
import { manageSettings } from './settings-ui.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Audio } from './audio.js';
import { Recorder } from './recorder.js';
import { startControl } from './control.js';
import { Transcription, timestamp } from './transcription.js';
import { createSession, home, nameSession, saveSettings, sessionDirectory, scanSessions } from './store.js';
import { modelMenu } from './model-ui.js';
import { finishSession, reopenSession } from './workflow.js';
import { documentPath, exportDocument, exportName, openDocument } from './documents.js';
import type { DocumentKind, ExportFormat } from './documents.js';
import { Screen } from './terminal/screen.js';
import type { Choice } from './terminal/screen.js';
import style from './terminal/style.js';
import type { Decision, Session, Settings, Source } from './types.js';
import { errorMessage } from './types.js';
import { createInterface, dictationMenu, dictationItemMenu } from './dictation-ui.js';
import type { Dictation } from './dictation.js';
import { libraryMenu, editLibraryMetadata } from './library-ui.js';
import { loadLibrary } from './library.js';
import { insightsMenu } from './insights-ui.js';
import { recordingControls, recoveryMenu } from './bridge-ui.js';
import { copyText, notify } from './clipboard.js';

const back = { value: 'back', name: "Back" };
const choices = (values: [string, string, string?][]): Choice[] => values.map(([value, name, hint]) => ({ value, name, hint }));

export async function deviceMenu(screen: Screen, config: Settings, source: Source, recorder?: Recorder, persist = true): Promise<void> {
    const audio = recorder?.audio || new Audio();
    try {
        for (;;) {
            const devices = await screen.task("Audio devices", () => audio.devices());
            const current = source === 'mic' ? config.input : config.output;
            const list: Choice[] = [{ value: 'default', name: 'Follow system default', state: current === 'default' ? 'Selected' : '', hint: "Follow the default device, including changes during recording." }];
            for (const device of devices.filter(device => device.sourceKind === source && device.formatAvailable)) {
                list.push({ value: device.id, name: device.name, state: current === device.id ? 'Selected' : device.isDefault ? 'System default' : '', hint: device.id });
            }
            if (current !== 'default' && !list.some(choice => choice.value === current)) list.push({ value: current, name: 'Preferred device disconnected', unavailable: 'Choose another device or follow the system default. Esc keeps the current preference.' });
            list.push({ value: 'refresh', name: "Refresh devices" }, back);
            const selected = await screen.select(source === 'mic' ? "Choose microphone" : "Choose system audio", list, {
                detail: recorder ? "Switch devices while recording" : source === 'mic' ? "Microphone for your voice" : "Output device to capture", back: true, initialValue: current,
            });
            if (['back', 'quit', 'settings'].includes(selected)) return;
            if (selected === 'refresh') continue;
            if (recorder) await screen.task("Switch audio device", () => recorder.switch(source, selected));
            if (source === 'mic') config.input = selected; else config.output = selected;
            if (persist) await saveSettings(config);
            return;
        }
    } finally { if (!recorder) await audio.close(); }
}

export { modelMenu };

export async function settingsMenu(screen: Screen, config: Settings): Promise<void> {
    await manageSettings(screen, config, (source, draft = config) => deviceMenu(screen, draft, source, undefined, false));
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
        items.push({ value: 'organize', name: 'Rename / pin' }, { value: 'reprocess', name: "Reprocess audio", hint: "Transcribe again and choose what to keep. Existing documents stay until processing." }, back);
        const selected = await screen.select(session.name || "Recording", items, { back: true, detail: "Read, open and export" });
        if (selected === 'quit') return false;
        if (selected === 'back') return true;
        try {
            if (selected === 'settings') { await settingsMenu(screen, config); continue; }
            if (selected === 'organize') {
                const item = (await loadLibrary()).items.find(item => item.kind === 'meeting' && item.id === session.id);
                if (item) { await editLibraryMetadata(screen, item); Object.assign(session, item.data); }
            }
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
                await screen.notice("Copied", 'Markdown copied. Paste with ' + PASTE_SHORTCUT + '.');
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
                await screen.notice('Export saved', target);
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
    if (!screen.bridge) screen.recordingActive = true;
    try { return await captureFlow(screen, config); }
    finally { screen.recordingActive = false; }
}

async function captureFlow(screen: Screen, config: Settings): Promise<boolean> {
    const bridge = screen.bridge;
    if (bridge) await bridge.startRecording();
    const session = bridge?.currentSession || await createSession();
    const recorder = bridge?.currentRecorder || new Recorder(session, config);
    let stopRequested = false;
    let failure = '';
    let closeControl: (() => Promise<void>) | undefined;
    recorder.on('stopRequested', () => { stopRequested = true; });
    recorder.on('failure', error => { failure = errorMessage(error); stopRequested = true; });
    try {
        if (!bridge) { await screen.task("Starting recording", () => recorder.start()); closeControl = await startControl(recorder); }
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
                complete: () => stopRequested || session.state === 'stopped' ? 'stop' : undefined,
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
        await screen.task("Stop recording", async () => { if (bridge) await bridge.stopRecording(); else await recorder.stop(); });
        await closeControl?.(); closeControl = undefined;
        if (failure) await screen.notice("Recording stopped with an error", failure);
        return await finishFlow(screen, session, config);
    } finally {
        if (bridge) await bridge.stopRecording(); else await recorder.stop();
        await closeControl?.();
    }
}

export async function mainMenu(config: Settings): Promise<void> {
    const ui = createInterface(config);
    const { screen } = ui;
    let selectedMenu = 'record';
    try {
        for (;;) {
            if (screen.quitRequested) return;
            const catalog = await scanSessions();
            const all = catalog.sessions;
            const pending = all.find(session => session.state === 'stopped');
            if (pending && ui.bridge.finishRequested) {
                ui.bridge.finishRequested = false;
                if (!await finishFlow(screen, pending, config)) return;
                continue;
            }
            const revision = ui.bridge.revision;
            const selected = await screen.select("Capture meetings locally", () => choices([
                [ui.bridge.recording ? 'recording-controls' : catalog.issues.length ? 'recovery' : 'record', ui.bridge.recording ? 'Recording controls' : catalog.issues.length ? 'Review unreadable recording' : "Start recording", catalog.issues.length ? 'Metadata needs attention. Dictation remains available.' : "Microphone and system audio, recorded separately."],
                ...(!ui.bridge.recording && pending ? [['finish', 'Finish pending recording', all.filter(session => session.state === 'stopped').length + ' awaiting a name and transcript decision. Audio is preserved.'] as [string, string, string]] : []),
                ['dictation', "Dictation", DICTATION_SHORTCUT + ' in any app. Format, insert or copy, and save locally.'],
                ['library', 'Library', 'Search notes, recordings and every dictation. Pin what matters.'],
                ['insights', 'Insights', 'Daily activity, streaks, spoken words and WPM.'],
                ['recovery', 'Storage and recovery', 'Saved audio, interrupted captures, models and available space.'],
                ['settings', "Settings"], ['models', "Local models"], ['quit', "Quit"],
            ]), { initialValue: selectedMenu, detail: (existsSync(config.whisperModel) ? "Transcription model ready" : "Set up Whisper first") + " · Process after recording", shortcuts: { f8: 'dictation-toggle' }, complete: () => ui.bridge.revision !== revision ? 'refresh' : undefined });
            if (!['refresh', 'dictation-toggle'].includes(selected)) selectedMenu = selected;
            try {
                if (selected === 'quit') return;
                if (selected === 'dictation') await dictationMenu(screen);
                if (selected === 'dictation-toggle') { void ui.service.toggle().catch(error => notify(errorMessage(error))); }
                if (selected === 'settings') await settingsMenu(screen, config);
                if (selected === 'models') await modelMenu(screen, config);
                if (selected === 'insights') await insightsMenu(screen);
                if (selected === 'recording-controls') await recordingControls(screen);
                if (selected === 'recovery') await recoveryMenu(screen, config);
                if (selected === 'record' && !await recordFlow(screen, config)) return;
                if (selected === 'finish' && pending && !await finishFlow(screen, pending, config)) return;
                if (selected === 'library') await libraryMenu(screen, async item => {
                    if (item.kind === 'dictation') await dictationItemMenu(screen, ui.service, item.data as Dictation);
                    else if (item.data.state === 'stopped') await finishFlow(screen, item.data, config);
                    else await documentMenu(screen, item.data, config);
                });
            } catch (error) { await screen.notice("Action not completed", errorMessage(error)); }
        }
    } finally { await ui.close(); }
}
