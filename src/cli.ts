#!/usr/bin/env node
import { Command, Option } from 'commander';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Audio } from './audio.js';
import { Recorder } from './recorder.js';
import { control, startControl } from './control.js';
import { acquireLock, home, loadSession, nameSession, saveSettings, sessionDirectory, sessions, settings } from './store.js';
import { finishSession, recoverSessions, reopenSession } from './workflow.js';
import { documentPath, exportDocument, openDocument } from './documents.js';
import type { DocumentKind, ExportFormat } from './documents.js';
import { renderMarkdown } from './terminal/markdown.js';
import { mainMenu, finishFlow, recordFlow, settingsMenu } from './app.js';
import { createInterface, dictationMenu } from './dictation-ui.js';
import { DictationService } from './dictation.js';
import { DICTATION_SHORTCUT } from './hotkey.js';
import { dictationConfig } from './dictation-models.js';
import { installModel, models } from './models.js';
import { errorMessage } from './types.js';
import type { Decision, Settings } from './types.js';
import { installSignalHandlers, onShutdown } from './lifecycle.js';

async function locked(work: () => Promise<void>): Promise<void> {
    const release = await acquireLock();
    const unregister = onShutdown(release);
    try { await recoverSessions(); await work(); }
    finally { unregister(); await release(); }
}

async function headless(config: Settings, duration?: number): Promise<void> {
    const { createSession } = await import('./store.js');
    const session = await createSession();
    const recorder = new Recorder(session, config);
    let closeControl: (() => Promise<void>) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    const onSignal = () => { stop(); };
    recorder.on('stopRequested', stop);
    recorder.on('failure', error => { process.stderr.write(errorMessage(error) + '\n'); stop(); });
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    try {
        await recorder.start();
        closeControl = await startControl(recorder);
        process.stdout.write("Recording: " + session.id + "\nPress Ctrl+C or run \"sylloom control stop\" to stop recording.\n");
        if (duration) timer = setTimeout(stop, duration * 1000);
        await stopped;
    } finally {
        clearTimeout(timer);
        process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
        await recorder.stop();
        await closeControl?.();
    }
    process.stdout.write("Audio saved: " + sessionDirectory(session.id) + "\nName this recording and choose what to keep: sylloom finish " + session.id + '\n');
}

const program = new Command().name('sylloom').description("Local dictation, audio recording and structured meeting notes.").version('0.1.0');
program.action(() => locked(async () => mainMenu(await settings())));

program.command('record').description("Record audio; process after stopping").option('--headless', "Record without the interactive UI").option('--duration <seconds>', "Stop after this many seconds")
    .addOption(new Option('--no-live', "Compatibility: processing always starts after recording").hideHelp())
    .action(options => locked(async () => {
        const config = await settings();
        let duration: number | undefined;
        if (options.duration !== undefined) {
            duration = Number(options.duration);
            if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400) throw new Error("Duration must be greater than 0 and no more than 86400 seconds.");
            if (!options.headless) throw new Error("Use --duration with --headless.");
        }
        if (options.headless) await headless(config, duration);
        else {
            const ui = createInterface(config);
            try { await recordFlow(ui.screen, config); } finally { await ui.close(); }
        }
    }));

program.command('dictate').description("Dictate from any app, format locally and copy to clipboard")
    .option('--listen', "Listen for global shortcuts without the TUI; runs until Ctrl+C")
    .addOption(new Option('--format <format>', "Format for new dictations").choices(['message', 'email', 'list']))
    .action(options => locked(async () => {
        const config = await settings();
        if (options.format) config.dictationFormat = options.format;
        if (!options.listen) {
            const ui = createInterface(config);
            try { await dictationMenu(ui.screen, ui.service); } finally { await ui.close(); }
            return;
        }
        const service = new DictationService(config);
        let timer: NodeJS.Timeout | undefined;
        let stop!: () => void;
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try {
            service.listen();
            if (service.hotkeyError) throw new Error(service.hotkeyError);
            service.on('update', () => process.stderr.write(service.message + '\n'));
            process.stderr.write("Global shortcuts ready: " + DICTATION_SHORTCUT + " Start/stop · Ctrl+Option+Esc Cancel · Ctrl+C Quit\n");
            timer = setInterval(() => {}, 1000);
            await stopped;
        } finally {
            clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
            await service.close();
        }
    }));

program.command('control <command> [value]').description("Control recording: status, pause, resume, stop, input, output, mute-mic, mute-system")
    .action(async (command, value) => { process.stdout.write(JSON.stringify(await control(command, value), null, 2) + '\n'); });

program.command('devices').description("List microphones and system audio outputs").option('--json', "Output JSON").action(async options => {
    const audio = new Audio();
    try {
        const devices = await audio.devices();
        if (options.json) process.stdout.write(JSON.stringify(devices, null, 2) + '\n');
        else {
            process.stdout.write("default = follow system default\n\n");
            for (const device of devices) process.stdout.write((device.sourceKind === 'mic' ? 'IN  ' : 'OUT ') + (device.isDefault ? '* ' : '  ') + device.id + (device.formatAvailable ? '' : " (format unavailable)") + '\n');
        }
    } finally { await audio.close(); }
});

program.command('list').description("List recordings and pending decisions").option('--json', "Output JSON").action(async options => {
    const all = await sessions();
    if (options.json) process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    else for (const session of all) process.stdout.write(session.id + '  ' + (session.state === 'done' ? "DONE" : "OPEN") + '  ' + (session.name || "Untitled") + '  ' + session.startedAt + '\n');
});

async function readableSession(id: string | undefined, kind: DocumentKind) {
    const session = id ? await loadSession(id) : (await sessions()).find(item => existsSync(documentPath(item, kind)));
    if (!session || !existsSync(documentPath(session, kind))) throw new Error(kind === 'note' ? "No saved note found." : "No saved transcript found.");
    return session;
}

program.command('show [id]').description("Read formatted Markdown in the terminal")
    .option('--transcript', "Show the transcript instead of the note").option('--raw', "Output the original Markdown")
    .action(async (id, options) => {
        const kind: DocumentKind = options.transcript ? 'transcript' : 'note';
        const session = await readableSession(id, kind);
        const text = await readFile(documentPath(session, kind), 'utf8');
        process.stdout.write(options.raw ? text : renderMarkdown(text, Math.max(8, (process.stdout.columns || 80) - 2)).join('\n') + '\n');
    });

program.command('open [id]').description("Open a local reading view in the browser").option('--transcript', "Open the transcript instead of the note")
    .action(async (id, options) => {
        const kind: DocumentKind = options.transcript ? 'transcript' : 'note';
        const session = await readableSession(id, kind);
        process.stdout.write(await openDocument(session, kind) + '\n');
    });

program.command('export [id]').description("Export a note as Markdown or HTML")
    .requiredOption('-o, --output <file>', "Destination file ending in .md or .html")
    .addOption(new Option('-f, --format <format>', "Export format; defaults to the file extension").choices(['md', 'html']))
    .option('--transcript', "Export the transcript instead of the note").option('--force', "Overwrite an existing destination file")
    .action(async (id, options) => {
        const kind: DocumentKind = options.transcript ? 'transcript' : 'note';
        const session = await readableSession(id, kind);
        const format = options.format || path.extname(options.output).slice(1).toLowerCase();
        if (!['md', 'html'].includes(format)) throw new Error("Use .md or .html as the export format.");
        process.stdout.write(await exportDocument(session, kind, options.output, format as ExportFormat, Boolean(options.force)) + '\n');
    });

program.command('reprocess <id>').description("Transcribe existing audio again and choose what to keep")
    .addOption(new Option('--action <action>', "Choose what to keep after reprocessing").choices(['summarize', 'note-only', 'keep', 'delete']))
    .action((id, options) => locked(async () => {
        if (!options.action && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("An interactive terminal or --action is required.");
        const session = await loadSession(id);
        const config = await settings();
        await reopenSession(session);
        if (options.action) {
            process.stdout.write(await finishSession(session, options.action as Decision, config, message => process.stderr.write(message + '\n')) + '\n');
        } else {
            const ui = createInterface(config);
            try { await finishFlow(ui.screen, session, config); } finally { await ui.close(); }
        }
    }));

program.command('finish [id]').description("Name a stopped recording and choose what happens to the transcript")
    .option('--name <name>', "Recording name")
    .addOption(new Option('--action <action>', "Choose what happens to this transcript").choices(['summarize', 'note-only', 'keep', 'delete']))
    .action((id, options) => locked(async () => {
        const config = await settings();
        const session = id ? await loadSession(id) : (await sessions()).find(item => item.state !== 'done');
        if (!session) throw new Error("No pending recording found.");
        if (session.state !== 'stopped') throw new Error("This recording is already finished or still running.");
        if (options.name) await nameSession(session, options.name);
        if (options.action) {
            if (!session.name) throw new Error("Missing --name. Name the recording first.");
            const result = await finishSession(session, options.action as Decision, config, message => process.stderr.write(message + '\n'));
            process.stdout.write(result + '\n');
        } else {
            const ui = createInterface(config);
            try { await finishFlow(ui.screen, session, config); } finally { await ui.close(); }
        }
    }));

program.command('settings').description("Configure devices, language and local models").action(() => locked(async () => {
    const config = await settings();
    const ui = createInterface(config);
    try { await settingsMenu(ui.screen, config); } finally { await ui.close(); }
}));

const modelCommand = program.command('models').description('Manage local models');
modelCommand.command('install <model>').description("Install whisper, dictation-whisper, llama, formatter, both or all")
    .option('--keep-selection', 'Download models without changing saved model selections')
    .action((kind, options) => locked(async () => {
    if (!['whisper', 'dictation-whisper', 'llama', 'formatter', 'both', 'all'].includes(kind)) throw new Error("Choose whisper, dictation-whisper, llama, formatter, both or all.");
    const config = await settings();
    for (const key of (kind === 'all' ? ['dictation-whisper', 'formatter', 'whisper', 'llama'] : kind === 'both' ? ['whisper', 'llama'] : [kind]) as (keyof typeof models)[]) {
        let last = 0;
        const target = await installModel(key, (received, total) => {
            if (Date.now() - last < 1000 && received < total) return;
            last = Date.now();
            process.stderr.write(models[key].label + ': ' + Math.round(received / total * 100) + '%\n');
        });
        if (key === 'whisper') config.whisperModel = target;
        else if (key === 'dictation-whisper') config.dictationWhisperModel = target;
        else if (key === 'formatter') config.dictationModel = target;
        else { config.llmModel = target; config.llm = 'llama'; }
        if (!options.keepSelection) await saveSettings(config);
        process.stdout.write(target + '\n');
    }
}));

program.command('doctor').description("Check audio backends, devices and local model requirements").action(async () => {
    const config = await settings();
    const audio = new Audio();
    try {
        const capabilities = await audio.capabilities();
        const binaryAvailable = (binary: string) => !spawnSync(binary, ['--version'], { timeout: 10_000, stdio: 'ignore' }).error;
        const report: Record<string, unknown> = {
            platform: process.platform, arch: process.arch, data: home,
            mic: capabilities.sources.mic, system: capabilities.sources.system,
            deviceChanges: "Poll every 2 seconds; missing pinned devices fall back to the system default.",
            whisperBinary: binaryAvailable(config.whisperBinary), whisperModel: existsSync(config.whisperModel),
            transcription: 'after-recording', selectedWhisperModel: path.basename(config.whisperModel),
            noteBackend: config.llm, llmBinary: binaryAvailable(config.llmBinary), llmModel: existsSync(config.llmModel),
            dictationModel: existsSync(config.dictationModel), selectedFormatter: path.basename(config.dictationModel), dictationFormat: config.dictationFormat,
            dictationWhisperModel: path.basename(dictationConfig(config).whisperModel), dictationPolish: config.dictationPolish, dictationWarmSeconds: config.dictationWarmSeconds,
            dictationShortcut: process.platform === 'darwin' ? DICTATION_SHORTCUT : "macOS only",
        };
        try { report.devices = await audio.devices(); } catch (error) { report.devicesError = errorMessage(error); }
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally { await audio.close(); }
});

installSignalHandlers();
try { await program.parseAsync(); }
catch (error) { process.stderr.write(errorMessage(error) + '\n'); process.exitCode = 1; }
