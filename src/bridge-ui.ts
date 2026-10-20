import { isWindows, CALL_APPLE_LABEL } from './platform.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { home, saveSettings, scanSessions, sessionDirectory } from './store.js';
import { cachedCalendar } from './calendar.js';
import { storageOverview } from './storage.js';
import { errorMessage } from './types.js';
import { openExternal } from './insights-ui.js';
import { inspectRecordingRecovery, restoreRecordingMetadata } from './workflow.js';
import switchList from './terminal/switch-list.js';
import type { Settings } from './types.js';
import type { Screen } from './terminal/screen.js';

export async function bridgeMenu(screen: Screen, config: Settings): Promise<void> {
    const draft = { ...config };
    const keys = ['bridgeEnabled', 'detectAppleCalls', 'detectWhatsAppCalls', 'detectTeamsCalls', 'teamsPort'] as const;
    let selected = 'toggle';
    while (!screen.quitRequested) {
        const result = await switchList(screen, 'Settings / Call recording prompts', { initialValue: selected,
            rows: [{ value: 'toggle', name: 'Call detection and recording prompt', enabled: draft.bridgeEnabled, hint: 'Applies only after Save changes. Esc leaves current call detection unchanged.' },
                { value: 'detectAppleCalls', name: CALL_APPLE_LABEL + ' calls', enabled: draft.detectAppleCalls, hint: isWindows ? 'Calls forwarded to this PC through Phone Link. Supported local call controls.' : 'Calls that reach this Mac. Incoming call controls and active audio streams.' },
                { value: 'detectWhatsAppCalls', name: 'WhatsApp calls', enabled: draft.detectWhatsAppCalls, hint: 'Native desktop app. Incoming controls and active audio streams; live verification required.' },
                { value: 'detectTeamsCalls', name: 'Teams calls', enabled: draft.detectTeamsCalls, hint: 'Local Teams API and app controls.' }],
            extra: [{ value: 'port', name: 'Local API port', state: String(draft.teamsPort), hint: 'Choose the port used by the local Teams API.' },
                { value: 'token', name: 'Teams API credential…', state: isWindows ? 'Credential Manager' : 'Keychain', hint: 'Explicit credential saving applies immediately. Unsaved call preferences stay in this draft.' }],
        });
        if (!result) return;
        for (const row of result.rows) {
            if (row.value === 'toggle') draft.bridgeEnabled = row.enabled === true;
            if (row.value === 'detectAppleCalls' || row.value === 'detectWhatsAppCalls' || row.value === 'detectTeamsCalls') draft[row.value] = row.enabled === true;
        }
        selected = result.action;
        try {
            if (selected === 'token') {
                const value = await screen.input('Save local Teams API token', 'Writes to ' + (isWindows ? 'Windows Credential Manager' : 'macOS Keychain') + ' when you press Enter. Esc cancels.', '', { secret: true });
                if (value?.trim()) { const { teamsToken } = await import('./native/keychain.js'); teamsToken(value.trim()); await screen.bridge?.setBridge(config.bridgeEnabled); }
            }
            if (selected === 'port') {
                const value = await screen.input('Local API port', '1024–65535. Default: 8124', String(draft.teamsPort));
                if (value !== null) { const port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Enter a valid port.'); draft.teamsPort = port; }
            }
            if (selected === 'save') {
                if (screen.dictation?.busy || screen.bridge?.recording) throw new Error('Stop recording or dictation before applying call preferences.');
                const changed = Object.fromEntries(keys.map(key => [key, draft[key]]));
                await saveSettings({ ...config, ...changed }); Object.assign(config, changed);
                await screen.bridge?.setBridge(config.bridgeEnabled); return;
            }
        } catch (error) { await screen.notice('Call recording prompts', errorMessage(error)); }
    }
}

export async function outlookSourcesMenu(screen: Screen, config: Settings): Promise<void> {
    let selected = 'outlook';
    while (!screen.quitRequested) {
        const snapshot = screen.bridge ? (await screen.bridge.snapshot()).calendar : await cachedCalendar();
        selected = await screen.select('Settings / Local Outlook connection', [
            { value: 'outlook', name: config.calendarOutlook ? 'Reconnect local Outlook' : 'Connect local Outlook', hint: isWindows ? 'Read the running classic Outlook calendar locally. New Outlook requires a local ICS file.' : 'Read this Mac’s Outlook data. No extension, Graph connection or new account login.' },
            ...(config.calendarOutlook ? [{ value: 'disconnect', name: 'Disconnect Outlook' }] : []),
            { value: 'refresh', name: 'Check connection' },
            ...(!isWindows ? [{ value: 'system', name: 'Use an existing macOS calendar…', hint: 'Optional fallback. macOS asks for read access; no account is added.' }] : []),
            { value: 'file', name: 'Use a local .ics file…', hint: config.calendarFile || 'Optional fallback if the installed Outlook mode does not expose events.' },
            { value: 'back', name: 'Back' },
        ], { back: true, initialValue: selected, detail: 'Connection actions apply immediately. Esc returns without undoing a completed connection.', before: () => (snapshot?.statuses || []).map(status => status.source + ' · ' + status.state + ' · ' + status.message).concat('') });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
            if (selected === 'outlook' || selected === 'disconnect') { config.calendarOutlook = selected === 'outlook'; await saveSettings(config); screen.bridge?.configureCalendar(); }
            if (selected === 'system') { config.calendarSystem = true; await saveSettings(config); }
            if (selected === 'file') {
                const value = await screen.input('Local calendar file', 'Absolute .ics path, or leave empty to disconnect.', config.calendarFile);
                if (value !== null) {
                    const file = value.trim().startsWith('~/') ? path.join(homedir(), value.trim().slice(2)) : value.trim();
                    if (file && (!path.isAbsolute(file) || !/\.ics$/i.test(file) || !(await stat(file)).isFile())) throw new Error('Choose an existing local .ics file.');
                    config.calendarFile = file; await saveSettings(config);
                }
            }
            await screen.task('Checking local Outlook connection', async () => { await screen.bridge?.refreshCalendar(new Date(), selected === 'system'); });
        } catch (error) { await screen.notice('Outlook connection', errorMessage(error)); }
    }
}

export async function recordingControls(screen: Screen): Promise<void> {
    const bridge = screen.bridge!;
    while (bridge.recording && !screen.quitRequested) {
        const recorder = bridge.currentRecorder;
        const action = await screen.select('Recording meeting', [{ value: 'stop', name: 'Stop recording' }, { value: 'pause', name: bridge.currentSession?.state === 'paused' ? 'Resume' : 'Pause' },
            { value: 'mic', name: 'Microphone muted', toggle: recorder?.muted.mic || false }, { value: 'system', name: 'System audio muted', toggle: recorder?.muted.system || false },
            { value: 'back', name: 'Back · keep recording' }],
            { back: true, detail: () => bridge.progress, before: () => [...bridge.captureStatus,
                'Microphone: ' + (recorder?.health.mic || 'Starting'), 'System audio: ' + (recorder?.health.system || 'Starting'), ''], complete: () => bridge.recording ? undefined : 'back' });
        if (['back', 'quit', 'settings'].includes(action)) return;
        if (action === 'pause') await recorder?.pause();
        if (action === 'mic' || action === 'system') await recorder?.toggleMute(action);
        if (action === 'stop') { await bridge.stopRecording(); return; }
    }
}
export async function recoveryMenu(screen: Screen, config: Settings): Promise<void> {
    let selected = 'overview';
    while (!screen.quitRequested) {
        const { issues } = await scanSessions();
        selected = await screen.select('Storage and recovery', [
            { value: 'overview', name: 'Storage, recovery and model status' },
            { value: 'folder', name: 'Open local data folder', hint: 'Inspect saved audio, documents and settings in your file manager.' },
            ...issues.map(issue => ({ value: issue.id, name: 'Recover unreadable recording · ' + issue.id, hint: 'Inspect saved tracks and explicitly reconstruct pending metadata. Original files are preserved.' })),
            { value: 'back', name: 'Back' },
        ], { back: true, initialValue: selected, detail: issues.length ? issues.length + ' unreadable recording(s). Dictation remains available.' : 'Files stay saved until you explicitly delete an item.' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
            if (selected === 'overview') { const lines = await storageOverview(config); await screen.view('Storage and recovery', () => lines.join('\n')); }
            else if (selected === 'folder') await openExternal(home);
            else if (issues.some(issue => issue.id === selected)) {
                const files = await inspectRecordingRecovery(selected);
                const action = await screen.select('Recover recording metadata', [
                    ...(files.some(file => (file.samples || 0) > 0) ? [{ value: 'restore', name: 'Restore as pending recording', hint: 'Back up the original metadata first. You must name it and explicitly choose what to keep.' }] : []),
                    { value: 'folder', name: 'Inspect preserved folder' }, { value: 'back', name: 'Back' },
                ], { back: true, detail: 'Name/time may be reconstructed. Existing notes, transcripts and audio stay preserved.', before: () => files.map(file => file.name + ' · ' + file.status).concat('') });
                if (action === 'folder') await openExternal(sessionDirectory(selected));
                if (action === 'restore') { await restoreRecordingMetadata(selected); await screen.notice('Pending recording restored', 'Return to Finish pending recording to name it and choose what to keep. No restart is needed.'); }
            }
        } catch (error) { await screen.notice('Recovery', errorMessage(error)); }
    }
}
