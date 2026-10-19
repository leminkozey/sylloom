import { homedir } from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { home, saveSettings, scanSessions, sessionDirectory } from './store.js';
import { cachedCalendar } from './calendar.js';
import { storageOverview } from './storage.js';
import { teamsToken } from './native/keychain.js';
import { errorMessage } from './types.js';
import { openExternal } from './insights-ui.js';
import type { Settings } from './types.js';
import type { Screen } from './terminal/screen.js';

export async function bridgeMenu(screen: Screen, config: Settings): Promise<void> {
    let selected = 'toggle';
    while (!screen.quitRequested) {
        selected = await screen.select('Settings / Call recording prompts', [
            { value: 'toggle', name: 'Call detection and recording prompt', toggle: config.bridgeEnabled, hint: 'Local app controls, audio activity and Teams device API. Applies immediately.' },
            { value: 'detectAppleCalls', name: 'FaceTime and iPhone calls', toggle: config.detectAppleCalls, hint: 'Calls that reach this Mac. Detects the Apple call interface and active audio streams.' },
            { value: 'detectWhatsAppCalls', name: 'WhatsApp calls', toggle: config.detectWhatsAppCalls, hint: 'Native Mac app. Incoming controls and active audio streams; live verification required.' },
            { value: 'detectTeamsCalls', name: 'Teams calls', toggle: config.detectTeamsCalls, hint: 'Local Teams API and app controls.' },
            { value: 'token', name: 'Save local Teams API token…', hint: 'Teams → Settings → Privacy → Third-party app API. Stored in macOS Keychain.' },
            { value: 'port', name: 'Local API port · ' + config.teamsPort }, { value: 'back', name: 'Back' },
        ], { back: true, initialValue: selected, detail: screen.bridge?.call.message || 'Local call detection runs with the CLI.' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
            if (selected === 'toggle') await screen.bridge?.setBridge(!config.bridgeEnabled);
            if (selected === 'detectAppleCalls' || selected === 'detectWhatsAppCalls' || selected === 'detectTeamsCalls') {
                config[selected] = !config[selected]; await saveSettings(config); await screen.bridge?.setBridge(config.bridgeEnabled);
            }
            if (selected === 'token') {
                const value = await screen.input('Local Teams API token', 'Paste the token from Teams settings. Input is hidden.', '', { secret: true });
                if (value?.trim()) { teamsToken(value.trim()); await screen.bridge?.setBridge(config.bridgeEnabled); }
            }
            if (selected === 'port') {
                const value = await screen.input('Local API port', '1024–65535. Default: 8124', String(config.teamsPort));
                if (value !== null) { const port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Enter a valid port.'); config.teamsPort = port; await saveSettings(config); await screen.bridge?.setBridge(config.bridgeEnabled); }
            }
        } catch (error) { await screen.notice('Call recording prompts', errorMessage(error)); }
    }
}

export async function outlookSourcesMenu(screen: Screen, config: Settings): Promise<void> {
    let selected = 'outlook';
    while (!screen.quitRequested) {
        const snapshot = screen.bridge ? (await screen.bridge.snapshot()).calendar : await cachedCalendar();
        selected = await screen.select('Settings / Local Outlook connection', [
            { value: 'outlook', name: config.calendarOutlook ? 'Reconnect local Outlook' : 'Connect local Outlook', hint: 'Read this Mac’s Outlook data. No extension, Graph connection or new account login.' },
            ...(config.calendarOutlook ? [{ value: 'disconnect', name: 'Disconnect Outlook' }] : []),
            { value: 'refresh', name: 'Check connection' },
            { value: 'system', name: 'Use an existing macOS calendar…', hint: 'Optional fallback. macOS asks for read access; no account is added.' },
            { value: 'file', name: 'Use a local .ics file…', hint: config.calendarFile || 'Optional fallback if the installed Outlook mode does not expose events.' },
            { value: 'back', name: 'Back' },
        ], { back: true, initialValue: selected, detail: 'Only Teams meetings trigger reminders. Source coverage is shown below.', before: () => (snapshot?.statuses || []).map(status => status.source + ' · ' + status.state + ' · ' + status.message).concat('') });
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
            { back: true, detail: () => bridge.progress, complete: () => bridge.recording ? undefined : 'back' });
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
            { value: 'folder', name: 'Open local data folder', hint: 'Inspect saved audio, documents and settings in Finder.' },
            ...issues.map(issue => ({ value: issue.id, name: 'Inspect unreadable recording · ' + issue.id, hint: 'Opens its preserved folder. Repair session.json from a backup; no files are changed.' })),
            { value: 'back', name: 'Back' },
        ], { back: true, initialValue: selected, detail: issues.length ? issues.length + ' unreadable recording(s). Dictation remains available.' : 'Files stay saved until you explicitly delete an item.' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
            if (selected === 'overview') { const lines = await storageOverview(config); await screen.view('Storage and recovery', () => lines.join('\n')); }
            else if (selected === 'folder') await openExternal(home);
            else if (issues.some(issue => issue.id === selected)) await openExternal(sessionDirectory(selected));
        } catch (error) { await screen.notice('Recovery', errorMessage(error)); }
    }
}
