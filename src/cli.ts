#!/usr/bin/env node
import { isDesktop, ALT_KEY } from './platform.js';
import { processCommand } from './process-command.js';
import { Command, Option } from 'commander';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Audio } from './audio.js';
import { Recorder } from './recorder.js';
import { control, startControl } from './control.js';
import { acquireLock, home, loadSession, nameSession, saveSettings, scanSessions, sessionDirectory, sessions, settings } from './store.js';
import { finishSession, inspectRecordingRecovery, recoverSessions, reopenSession, restoreRecordingMetadata } from './workflow.js';
import { documentPath, exportDocument, openDocument } from './documents.js';
import type { DocumentKind, ExportFormat } from './documents.js';
import { renderMarkdown } from './terminal/markdown.js';
import { mainMenu, finishFlow, recordFlow, settingsMenu } from './app.js';
import { createInterface } from './dictation-ui.js';
import { DictationService, recoverDictations } from './dictation.js';
import { dictationConfig } from './dictation-models.js';
import { installModel, models } from './models.js';
import { errorMessage } from './types.js';
import type { Decision, Settings } from './types.js';
import { installSignalHandlers, onShutdown } from './lifecycle.js';
import { loadLibrary, searchLibrary, librarySnippet } from './library.js';
import { loadInsights } from './insights.js';
import { renderInsights, saveInsightsView, openExternal } from './insights-ui.js';
import { accessibilityStatus } from './insertion.js';
import { installCommand, installationStatus } from './installation.js';
import { version } from './brand.js';
import { MeetingBridge } from './meeting-bridge.js';
import { readLocalCalendar, calendarRange } from './calendar.js';
import { storageOverview } from './storage.js';
import { CallDetector, enabledCallApps } from './calls.js';
import { previewPopups } from './popup-preview.js';
import { previewIndicator, previewBubbleNotice } from './indicator-preview.js';
import { addCorrection, addSnippet, addWord, applyTextRules, loadSpeechRules, matchSnippet, removeSpeechRule, saveSpeechRules, toggleSpeechRule } from './speech-rules.js';

async function locked(work: () => Promise<void>): Promise<void> {
    const release = await acquireLock();
    const unregister = onShutdown(release);
    try {
        await recoverSessions(); await recoverDictations();
        const { issues } = await scanSessions();
        if (issues.length) process.stderr.write(issues.length + ' recording(s) need metadata repair. Run "sylloom recovery" for preserved files. Dictation remains available.\n');
        await work();
    }
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

const program = new Command().name('sylloom').description("Local dictation, audio recording and structured meeting notes.").version(version);
program.action(() => locked(async () => mainMenu(await settings())));

program.command('install').description('Install the global sylloom command for this user')
    .option('--bin-dir <directory>', 'Command directory; defaults to the per-user command directory')
    .option('--no-path', 'Leave PATH configuration unchanged')
    .action(async options => {
        const result = await installCommand({ binDirectory: options.binDir, configurePath: options.path });
        process.stdout.write('Command installed: ' + result.command + '\n');
        if (result.shellFiles.length) process.stdout.write('PATH configured in: ' + result.shellFiles.join(', ') + '\n');
        process.stdout.write(result.onPath ? 'Ready. Run sylloom from any directory.\n' :
            options.path ? 'Open a new terminal, then run sylloom from any directory.\n' : 'Add the command directory to PATH, then run sylloom.\n');
    });

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

program.command('dictate').description("Dictate from any app, format locally and insert or copy")
    .option('--listen', "Listen for global shortcuts without the TUI; runs until Ctrl+C")
    .addOption(new Option('--format <format>', "Format for new dictations").choices(['message', 'email', 'list']))
    .action(options => locked(async () => {
        const config = await settings();
        if (options.format) config.dictationFormat = options.format;
        if (!options.listen) {
            await mainMenu(config);
            return;
        }
        let bridge: MeetingBridge;
        const service = new DictationService(config, () => Boolean(bridge?.recording || bridge?.working));
        bridge = new MeetingBridge(config, service);
        let timer: NodeJS.Timeout | undefined;
        let stop!: () => void;
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try {
            service.listen();
            if (service.hotkeyError) throw new Error(service.hotkeyError);
            await bridge.start();
            service.on('update', () => process.stderr.write(service.message + '\n'));
            process.stderr.write("Global shortcuts ready: " + service.shortcut + " · " + service.talkHint + " · Ctrl+" + ALT_KEY + "+Esc Cancel · Ctrl+C Quit\n");
            timer = setInterval(() => {}, 1000);
            await stopped;
        } finally {
            clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
            try { await bridge.close(); } finally { await service.close(); }
        }
    }));

program.command('recovery').description('Show local storage, pending captures and model readiness')
    .action(async () => { process.stdout.write((await storageOverview(await settings())).join('\n') + '\n'); });

program.command('repair-recording <id>').description('Inspect unreadable meeting metadata; restore only on explicit request')
    .option('--restore-metadata', 'Back up unreadable metadata and reconstruct a stopped recording with its decision pending')
    .action(async (id, options) => {
        if (!options.restoreMetadata) { process.stdout.write(JSON.stringify(await inspectRecordingRecovery(id), null, 2) + '\n'); return; }
        await locked(async () => { await restoreRecordingMetadata(id); process.stdout.write('Metadata restored as pending. Name the recording and choose what to keep: sylloom finish ' + id + '\n'); });
    });

program.command('status').description('Show source version, built version and the actual global launcher target')
    .option('--json', 'Output installation details as JSON')
    .action(async options => {
        const status = await installationStatus();
        if (options.json) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        else process.stdout.write(['Source version: ' + status.sourceVersion, 'Built CLI version: ' + status.builtVersion,
            'Build matches source: ' + (status.buildMatchesSource ? 'Yes' : 'No · Run npm run build in the source directory'),
            'Source directory: ' + status.sourceDirectory, 'Global command: ' + status.command, 'Launcher target: ' + status.launcherTarget,
            'Launcher matches this source: ' + (status.launcherMatchesSource ? 'Yes' : 'No · Run ./sylloom install from the intended checkout'), '', status.update].join('\n') + '\n');
    });

const rulesCommand = program.command('rules').description('Manage local dictionary, correction rules and whole-dictation snippets');
rulesCommand.command('list').description('Show saved rules').action(async () => { process.stdout.write(JSON.stringify(await loadSpeechRules(), null, 2) + '\n'); });
rulesCommand.command('word <term>').description('Add a preferred spelling for future dictation')
    .action(term => locked(async () => { await saveSpeechRules(addWord(await loadSpeechRules(), term)); process.stdout.write('Dictionary word saved. Existing dictations are unchanged.\n'); }));
rulesCommand.command('correct <heard> <replacement>').description('Add an explicit whole-word correction')
    .action((heard, replacement) => locked(async () => { await saveSpeechRules(addCorrection(await loadSpeechRules(), heard, replacement)); process.stdout.write('Correction saved for future dictation and explicit retries.\n'); }));
rulesCommand.command('snippet <trigger>').description('Add an exact whole-dictation snippet')
    .option('--text <text>', 'Literal snippet content').option('--file <file>', 'Read multiline snippet content from a UTF-8 file')
    .action((trigger, options) => locked(async () => {
        if ((options.text === undefined) === (options.file === undefined)) throw new Error('Choose exactly one of --text or --file.');
        const text = options.file ? await readFile(path.resolve(options.file), 'utf8') : options.text;
        await saveSpeechRules(addSnippet(await loadSpeechRules(), trigger, text)); process.stdout.write('Snippet saved. Say the entire trigger by itself: ' + trigger + '\n');
    }));
for (const operation of ['remove', 'toggle'] as const) rulesCommand.command(operation + ' <id>').description(operation === 'remove' ? 'Remove one saved word or rule' : 'Switch one saved word or rule On / Off')
    .action(id => locked(async () => {
        const rules = await loadSpeechRules();
        if (![...rules.words, ...rules.corrections, ...rules.snippets].some(entry => entry.id === id)) throw new Error('Rule not found. Run sylloom rules list.');
        await saveSpeechRules(operation === 'remove' ? removeSpeechRule(rules, id) : toggleSpeechRule(rules, id)); process.stdout.write('Rule ' + (operation === 'remove' ? 'removed' : 'toggled') + '.\n');
    }));
for (const operation of ['enable', 'disable'] as const) rulesCommand.command(operation).description('Switch all personal words and snippets ' + (operation === 'enable' ? 'On' : 'Off'))
    .action(() => locked(async () => { await saveSpeechRules({ ...await loadSpeechRules(), enabled: operation === 'enable' }); }));
rulesCommand.command('preview <text>').description('Preview rules without audio capture or a model')
    .action(async text => { const rules = await loadSpeechRules(), snippet = matchSnippet(text, rules); process.stdout.write(JSON.stringify({ before: text, after: snippet?.text ?? applyTextRules(text, rules), snippet: snippet?.trigger || null }, null, 2) + '\n'); });

program.command('preview-popups').description('Preview native popup animations without recording audio')
    .action(async () => {
        process.stdout.write('Popup preview: call, reminder and saved recording. No audio is recorded. Ctrl+C closes the preview.\n');
        await previewPopups();
    });

program.command('preview-indicator').description('Preview the dictation bubble with simulated microphone levels')
    .option('--repeat <count>', 'Repeat the animation preview', '1').option('--meeting', 'Preview interactive meeting pause/resume').option('--microphone-error', 'Preview the microphone error morph').option('--clipboard', 'Preview clipboard fallback feedback').option('--notice', 'Preview the shared bubble expanding for a message')
    .action(async options => {
        process.stdout.write('Dictation bubble preview with simulated levels. No microphone or audio capture. Ctrl+C closes the preview.\n');
        if (options.notice) { await previewBubbleNotice(); return; }
        await previewIndicator({ repeat: Math.max(1, Math.min(10, Number(options.repeat) || 1)), meeting: options.meeting, microphoneError: options.microphoneError, clipboard: options.clipboard });
    });

program.command('bridge').description('Probe local call and Outlook connections without recording')
    .action(async () => {
        const config = await settings();
        const detector = new CallDetector(config.teamsPort);
        detector.enabledApps = enabledCallApps(config); detector.readOutlook = config.calendarOutlook;
        try {
            if (config.bridgeEnabled) { detector.start(); await new Promise(resolve => setTimeout(resolve, 3500)); }
            else detector.setState('unknown', 'none', 'Call recording prompts are disabled.');
            const range = calendarRange(); const calendar = await readLocalCalendar(config, range.from, range.to);
            process.stdout.write(JSON.stringify({ call: detector.snapshot, visibleOutlookEvent: Boolean(detector.visibleEvent), events: calendar.events.length, sources: calendar.statuses }, null, 2) + '\n');
        } finally { await detector.close(); }
    });

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
    const { sessions: all, issues } = await scanSessions();
    for (const issue of issues) process.stderr.write(issue.id + ': ' + issue.message + ' Run "sylloom recovery".\n');
    if (options.json) process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    else for (const session of all) process.stdout.write(session.id + '  ' + (session.state === 'done' ? "DONE" : "OPEN") + '  ' + (session.name || "Untitled") + '  ' + session.startedAt + '\n');
});

program.command('library [query]').description('Search saved notes, recordings and dictations')
    .addOption(new Option('--type <type>', 'Filter by kind').choices(['meeting', 'dictation']))
    .option('--pinned', 'Only pinned items').option('--json', 'Output JSON')
    .action(async (query, options) => {
        const library = await loadLibrary();
        const items = searchLibrary(library.items, query, { kind: options.type, pinned: options.pinned });
        const results = items.map(item => {
            const { id, kind, title, date, status, pinned, words, seconds, data } = item;
            return { id, kind, title, date, status, pinned, words, seconds, snippet: librarySnippet(item, query),
                delivery: kind === 'dictation' ? (data as import('./dictation.js').Dictation).delivery : undefined };
        });
        if (options.json) process.stdout.write(JSON.stringify({ items: results, warnings: library.warnings }, null, 2) + '\n');
        else {
            for (const item of results) process.stdout.write(`${item.id}  ${item.kind.toUpperCase()}  ${item.pinned ? '★ ' : ''}${item.title}  [${item.status}]\n  ${item.snippet}\n`);
            if (!results.length) process.stdout.write('No matching items.\n');
            for (const warning of library.warnings) process.stderr.write(warning + '\n');
        }
    });

program.command('stats').description('Local activity, streaks, spoken words and WPM')
    .option('--json', 'Output aggregate JSON').option('--open', 'Open the interactive local dashboard')
    .action(async options => {
        // Read-only snapshots also work while the interactive controller records.
        const stats = await loadInsights(new Date(), undefined, false);
        if (options.json) process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
        else if (!options.open) process.stdout.write(renderInsights(stats, process.stdout.columns || 112).join('\n') + '\n');
        if (options.open) { const file = await saveInsightsView(stats); await openExternal(file); process.stdout.write(file + '\n'); }
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
        const session = id ? await loadSession(id) : (await sessions()).find(item => item.state === 'stopped');
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
modelCommand.command('install <model>').description("Install whisper, dictation-whisper, llama, formatter, formatter-quality, both or all")
    .option('--keep-selection', 'Download models without changing saved model selections')
    .action((kind, options) => locked(async () => {
    if (!['whisper', 'dictation-whisper', 'llama', 'formatter', 'formatter-quality', 'both', 'all'].includes(kind)) throw new Error("Choose whisper, dictation-whisper, llama, formatter, formatter-quality, both or all.");
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
        else if (key === 'formatter' || key === 'formatter-quality') config.dictationModel = target;
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
        const binaryAvailable = (binary: string) => {
            const result = spawnSync(...processCommand(binary, ['--help']), { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
            return !result.error && result.status === 0;
        };
        const report: Record<string, unknown> = {
            version, platform: process.platform, arch: process.arch, data: home,
            mic: capabilities.sources.mic, system: capabilities.sources.system,
            deviceChanges: "Poll every 2 seconds; missing pinned devices fall back to the system default.",
            whisperBinary: binaryAvailable(config.whisperBinary), whisperModel: existsSync(config.whisperModel),
            transcription: 'after-recording', selectedWhisperModel: path.basename(config.whisperModel),
            noteBackend: config.llm, llmBinary: binaryAvailable(config.llmBinary), llmModel: existsSync(config.llmModel),
            dictationModel: existsSync(config.dictationModel), selectedFormatter: path.basename(config.dictationModel), dictationFormat: config.dictationFormat,
            dictationWhisperModel: path.basename(dictationConfig(config).whisperModel), dictationPolish: config.dictationPolish, dictationWarmSeconds: config.dictationWarmSeconds,
            dictationShortcut: isDesktop ? config.dictationShortcut : 'Unsupported platform', dictationTalkMode: config.dictationTalkMode,
            dictationAutoInsert: config.dictationAutoInsert, accessibility: accessibilityStatus(),
        };
        try { report.devices = await audio.devices(); } catch (error) { report.devicesError = errorMessage(error); }
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally { await audio.close(); }
});

installSignalHandlers();
try { await program.parseAsync(); }
catch (error) { process.stderr.write(errorMessage(error) + '\n'); process.exitCode = 1; }
