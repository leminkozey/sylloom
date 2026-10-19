import { saveSettings } from './store.js';
import { modelMenu } from './model-ui.js';
import { bridgeMenu, outlookSourcesMenu, recoveryMenu } from './bridge-ui.js';
import { accessibilityStatus } from './insertion.js';
import { openExternal } from './insights-ui.js';
import { formatLabels } from './formatter.js';
import type { Screen, Choice } from './terminal/screen.js';
import type { Settings, Source } from './types.js';
import { errorMessage } from './types.js';

type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type Switch = { key: BooleanKey; name: string; hint: string };
const groups = {
    dictation: { title: 'Dictation', switches: [
        { key: 'dictationAutoInsert', name: 'Insert into focused input', hint: 'Recheck focus before inserting. Copy to clipboard if insertion fails.' },
        { key: 'dictationIndicator', name: 'Floating waveform', hint: 'Show the waveform at the bottom of the screen while dictating.' },
        { key: 'dictationNotifications', name: 'Dictation notifications', hint: 'Show macOS notifications for dictation results and processing errors.' },
    ] },
    shortcuts: { title: 'Global shortcuts', switches: [
        { key: 'globalShortcuts', name: 'Global shortcuts', hint: 'Ctrl+Option+Space starts/stops dictation. Ctrl+Option+Esc cancels.' },
        { key: 'copyLatestShortcut', name: 'Copy latest dictation', hint: 'Ctrl+Option+C copies the latest saved text. Requires global shortcuts On.' },
    ] },
    recording: { title: 'Recording', switches: [
        { key: 'callAutoStop', name: 'Stop when the call ends', hint: 'Stop a call-linked recording after confirmed hangup. A detector outage keeps it running.' },
    ] },
    calendar: { title: 'Outlook reminders', switches: [
        { key: 'meetingReminders', name: 'Upcoming Teams meeting reminders', hint: 'Show a compact popup before a Teams meeting. No automatic joining or recording.' },
        { key: 'calendarAutoRefresh', name: 'Check local Outlook in background', hint: 'Refresh enabled sources every minute while Sylloom runs.' },
    ] },
} satisfies Record<string, { title: string; switches: Switch[] }>;
type Group = keyof typeof groups;
const back = { value: 'back', name: 'Back' };

export async function manageSettings(screen: Screen, config: Settings, devices: (source: Source) => Promise<void>): Promise<void> {
    let selected = 'dictation';
    while (!screen.quitRequested) {
        selected = await screen.select('Settings', [
            { value: 'dictation', name: 'Dictation', hint: 'Insertion, waveform, notifications, formatting and default format.' },
            { value: 'shortcuts', name: 'Global shortcuts', hint: 'Dictate from any app and copy the latest result.' },
            { value: 'recording', name: 'Recording and audio', hint: 'Microphone, system audio and automatic stop after calls.' },
            { value: 'calendar', name: 'Outlook meeting reminders', hint: 'Teams meeting reminders, lead time and local Outlook connection.' },
            { value: 'bridge', name: 'Call recording prompts', hint: 'FaceTime, iPhone, WhatsApp and Teams. App switches and the local Teams API.' },
            { value: 'models', name: 'Models and performance', hint: 'Choose local models, language and how long models stay warm.' },
            { value: 'permissions', name: 'Permissions', hint: 'Check Accessibility and open macOS privacy settings.' },
            { value: 'storage', name: 'Storage and recovery', hint: 'Storage usage, pending recordings and interrupted dictations.' }, back,
        ], { back: true, initialValue: selected, detail: 'Choose a category. Switches show On / Off. Save applies changes.' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
            if (Object.hasOwn(groups, selected)) await editGroup(screen, config, selected as Group, devices);
            if (selected === 'bridge') await bridgeMenu(screen, config);
            if (selected === 'models') await performanceSettings(screen, config);
            if (selected === 'storage') await recoveryMenu(screen, config);
            if (selected === 'permissions') {
                const action = await screen.select('Settings / Permissions', [
                    { value: 'accessibility', name: 'Accessibility · ' + (accessibilityStatus() ? 'Allowed' : 'Required'), hint: 'Needed for automatic insertion and call controls in supported apps.' },
                    { value: 'microphone', name: 'Microphone access' }, { value: 'system', name: 'Screen and system audio access' }, back,
                ], { back: true, detail: 'Allow the terminal that runs Sylloom. Existing permissions remain under your control.' });
                const targets: Record<string, string> = { accessibility: 'Privacy_Accessibility', microphone: 'Privacy_Microphone', system: 'Privacy_ScreenCapture' };
                if (targets[action]) await openExternal('x-apple.systempreferences:com.apple.preference.security?' + targets[action]);
            }
        } catch (error) { await screen.notice('Settings', errorMessage(error)); }
    }
}

async function editGroup(screen: Screen, config: Settings, group: Group, devices: (source: Source) => Promise<void>): Promise<void> {
    const section = groups[group], draft = { ...config }; let selected = section.switches[0]!.key as string;
    const keys = section.switches.map(row => row.key) as (keyof Settings)[];
    if (group === 'dictation') keys.push('dictationFormat', 'dictationPolish');
    if (group === 'calendar') keys.push('reminderMinutes');
    while (!screen.quitRequested) {
        const rows: Choice[] = section.switches.map(row => ({ value: row.key, name: row.name, hint: row.hint, toggle: draft[row.key] }));
        if (group === 'dictation') rows.push(
            { value: 'formatting', name: 'Format dictated text', toggle: draft.dictationPolish !== 'off', hint: 'Off returns the original recognized text without using the formatter.' },
            { value: 'polish', name: 'Formatting mode · ' + (draft.dictationPolish === 'always' ? 'Always' : 'Automatic'), hint: 'Automatic skips the model for clean messages. Always polishes every dictation.' },
            { value: 'format', name: 'Default format · ' + formatLabels[draft.dictationFormat] });
        if (group === 'recording') rows.push({ value: 'mic', name: 'Microphone…', hint: config.input }, { value: 'system', name: 'System audio…', hint: config.output });
        if (group === 'calendar') rows.push({ value: 'minutes', name: 'Remind before meeting · ' + draft.reminderMinutes + ' min', hint: 'Choose a lead time from 1 to 60 minutes.' },
            { value: 'sources', name: 'Connect local Outlook…', hint: 'Connection status and optional local fallback sources.' });
        rows.push({ value: 'save', name: 'Save changes', hint: 'Apply these switches now. Esc discards edits.' }, back);
        selected = await screen.select('Settings / ' + section.title, rows, { back: true, initialValue: selected,
            detail: 'Enter / Space switches On or Off. Save applies changes. Esc discards.', footer: '↑/↓ Move · Space/Enter Change · Esc Discard' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        const row = section.switches.find(row => row.key === selected);
        if (row) { draft[row.key] = !draft[row.key]; continue; }
        if (selected === 'formatting') draft.dictationPolish = draft.dictationPolish === 'off' ? 'auto' : 'off';
        if (selected === 'polish') draft.dictationPolish = draft.dictationPolish === 'always' ? 'auto' : 'always';
        if (selected === 'format') {
            const format = await screen.select('Default dictation format', [...Object.entries(formatLabels).map(([value, name]) => ({ value, name })), back], { back: true, initialValue: draft.dictationFormat });
            if (Object.hasOwn(formatLabels, format)) draft.dictationFormat = format as Settings['dictationFormat'];
        }
        if (selected === 'mic' || selected === 'system') await devices(selected);
        if (selected === 'sources') await outlookSourcesMenu(screen, config);
        if (selected === 'minutes') {
            const value = await screen.input('Meeting reminder lead time', 'Whole minutes, from 1 to 60', String(draft.reminderMinutes));
            if (value !== null) { const minutes = Number(value); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Enter a whole number from 1 to 60.'); draft.reminderMinutes = minutes; }
        }
        if (selected === 'save') {
            if (screen.dictation?.busy) { await screen.notice('Dictation active', 'Finish or cancel dictation before applying settings.'); continue; }
            const changed = Object.fromEntries(keys.map(key => [key, draft[key]]));
            await saveSettings({ ...config, ...changed }); Object.assign(config, changed);
            if (group === 'dictation' || group === 'shortcuts') screen.dictation?.listen();
            if (group === 'calendar') screen.bridge?.configureCalendar();
            return;
        }
    }
}

async function performanceSettings(screen: Screen, config: Settings): Promise<void> {
    let selected = 'models';
    while (!screen.quitRequested) {
        selected = await screen.select('Settings / Models and performance', [
            { value: 'models', name: 'Manage local models…' },
            { value: 'language', name: 'Recognition language · ' + config.language, hint: 'auto, de, en or another Whisper language code.' },
            { value: 'warm', name: 'Keep models warm · ' + (config.dictationWarmSeconds ? config.dictationWarmSeconds + ' s' : 'Off'), hint: '0 releases models after each dictation. Higher values reduce repeated startup time.' }, back,
        ], { back: true, initialValue: selected, detail: 'Local transcription and formatting. Changes apply to subsequent processing.' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        if (selected === 'models') await modelMenu(screen, config);
        if (selected === 'language') {
            const value = await screen.input('Recognition language', 'auto or a two/three-letter language code', config.language);
            if (value !== null) { if (!/^(auto|[a-z]{2,3})$/.test(value.trim())) throw new Error('Enter auto or a valid language code.'); config.language = value.trim(); }
        }
        if (selected === 'warm') {
            const value = await screen.input('Keep models warm', 'Idle seconds from 0 to 600. 0 switches warming Off.', String(config.dictationWarmSeconds));
            if (value !== null) { const seconds = Number(value); if (!value.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 600) throw new Error('Enter a whole number from 0 to 600.'); config.dictationWarmSeconds = seconds; }
        }
        await saveSettings(config);
    }
}
