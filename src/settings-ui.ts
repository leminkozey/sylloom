import { saveSettings } from './store.js';
import { modelMenu } from './model-ui.js';
import { bridgeMenu, outlookSourcesMenu, recoveryMenu } from './bridge-ui.js';
import { accessibilityStatus } from './insertion.js';
import { openExternal } from './insights-ui.js';
import { formatLabels } from './formatter.js';
import type { Screen, Choice } from './terminal/screen.js';
import type { Settings, Source } from './types.js';
import { errorMessage } from './types.js';
import { speechRulesMenu } from './speech-rules-ui.js';
import switchList from './terminal/switch-list.js';
import type { SwitchRow } from './terminal/switch-list.js';

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

export async function manageSettings(screen: Screen, config: Settings, devices: (source: Source, draft?: Settings) => Promise<void>): Promise<void> {
    let selected = 'dictation';
    while (!screen.quitRequested) {
        selected = await screen.select('Settings', [
            { value: 'dictation', name: 'Dictation', state: formatLabels[config.dictationFormat], hint: 'Insertion, waveform, notifications, formatting and default format.' },
            { value: 'words', name: 'Words and snippets', hint: 'Personal spellings, explicit corrections and whole-dictation text snippets. Kept locally.' },
            { value: 'shortcuts', name: 'Global shortcuts', state: config.globalShortcuts ? 'On' : 'Off', hint: 'Dictate from any app and copy the latest result.' },
            { value: 'recording', name: 'Recording and audio', state: config.input === 'default' ? 'System default' : 'Custom input', hint: 'Microphone, system audio and automatic stop after calls.' },
            { value: 'calendar', name: 'Outlook meeting reminders', state: config.meetingReminders ? config.reminderMinutes + ' min before' : 'Off', hint: 'Teams reminders, lead time and local calendar connections.' },
            { value: 'bridge', name: 'Call recording prompts', state: config.bridgeEnabled ? 'On' : 'Off', hint: 'FaceTime, iPhone, WhatsApp and Teams. App switches and the local Teams API credential.' },
            { value: 'models', name: 'Models and performance', state: config.language === 'auto' ? 'Auto language' : config.language.toUpperCase(), hint: 'Choose local models, recognition language and how long models stay warm.' },
            { value: 'permissions', name: 'Permissions', hint: 'Check Accessibility and open macOS privacy settings.' },
            { value: 'storage', name: 'Storage and recovery', hint: 'Storage usage, pending recordings and interrupted dictations.' }, back,
        ], { back: true, initialValue: selected, detail: 'Choose a category. Current values appear on the right.' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
            if (Object.hasOwn(groups, selected)) await editGroup(screen, config, selected as Group, devices);
            if (selected === 'bridge') await bridgeMenu(screen, config);
            if (selected === 'words') await speechRulesMenu(screen);
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

async function editGroup(screen: Screen, config: Settings, group: Group, devices: (source: Source, draft?: Settings) => Promise<void>): Promise<void> {
    const section = groups[group], draft = { ...config }; let selected = section.switches[0]!.key as string;
    const keys = section.switches.map(row => row.key) as (keyof Settings)[];
    if (group === 'dictation') keys.push('dictationFormat', 'dictationPolish');
    if (group === 'calendar') keys.push('reminderMinutes');
    if (group === 'recording') keys.push('input', 'output');
    while (!screen.quitRequested) {
        const rows: SwitchRow[] = section.switches.map(row => ({ value: row.key, name: row.name, hint: row.hint, enabled: draft[row.key],
            ...(row.key === 'copyLatestShortcut' ? { requires: 'globalShortcuts' } : {}) }));
        const extra: Choice[] = [];
        if (group === 'dictation') {
            rows.push({ value: 'formatting', name: 'Format dictated text', enabled: draft.dictationPolish !== 'off', hint: 'Off skips the formatter model. Explicit words and snippets still apply unless disabled separately.' });
            extra.push({ value: 'polish', name: 'Formatting mode', state: draft.dictationPolish === 'always' ? 'Always' : 'Automatic', requires: 'formatting', hint: 'Choose when the local formatter model is used.' },
                { value: 'format', name: 'Default format', state: formatLabels[draft.dictationFormat], hint: 'Choose Message, Email or List.' });
        }
        if (group === 'recording') extra.push({ value: 'mic', name: 'Microphone', state: draft.input === 'default' ? 'System default' : 'Custom', hint: draft.input },
            { value: 'system', name: 'System audio', state: draft.output === 'default' ? 'System default' : 'Custom', hint: draft.output });
        if (group === 'calendar') extra.push({ value: 'minutes', name: 'Remind before meeting', state: draft.reminderMinutes + ' min', hint: 'Choose a preset or custom lead time from 1 to 60 minutes.' },
            { value: 'sources', name: 'Local calendar connections…', state: 'Manage', hint: 'Explicit connection actions apply immediately. Reminder edits stay in this draft.' });
        const result = await switchList(screen, 'Settings / ' + section.title, { rows, extra, initialValue: selected });
        if (!result) return;
        for (const row of result.rows) {
            const entry = section.switches.find(entry => entry.key === row.value);
            if (entry) draft[entry.key] = row.enabled === true;
            if (row.value === 'formatting') draft.dictationPolish = !row.enabled ? 'off' : draft.dictationPolish === 'off' ? 'auto' : draft.dictationPolish;
        }
        selected = result.action;
        try {
        if (selected === 'polish') {
            const mode = await pickValue(screen, 'Formatting mode', [{ value: 'auto', name: 'Automatic', hint: 'Clean speech and structure lists. Skip the model only for short, simple messages.' }, { value: 'always', name: 'Always', hint: 'Polish every dictation with the local model.' }], draft.dictationPolish);
            if (mode === 'auto' || mode === 'always') draft.dictationPolish = mode;
        }
        if (selected === 'format') {
            const format = await pickValue(screen, 'Default dictation format', Object.entries(formatLabels).map(([value, name]) => ({ value, name })), draft.dictationFormat);
            if (Object.hasOwn(formatLabels, format)) draft.dictationFormat = format as Settings['dictationFormat'];
        }
        if (selected === 'mic' || selected === 'system') await devices(selected, draft);
        if (selected === 'sources') await outlookSourcesMenu(screen, config);
        if (selected === 'minutes') {
            const value = await pickNumber(screen, 'Meeting reminder lead time', [1, 5, 10, 15, 30, 60], draft.reminderMinutes, 1, 60, 'min');
            if (value !== null) draft.reminderMinutes = value;
        }
        if (selected === 'save') {
            if (screen.dictation?.busy) { await screen.notice('Dictation active', 'Finish or cancel dictation before applying settings.'); continue; }
            const changed = Object.fromEntries(keys.map(key => [key, draft[key]]));
            await saveSettings({ ...config, ...changed }); Object.assign(config, changed);
            if (group === 'dictation' || group === 'shortcuts') screen.dictation?.listen();
            if (group === 'calendar') screen.bridge?.configureCalendar();
            return;
        }
        } catch (error) { await screen.notice('Settings / ' + section.title, errorMessage(error) + ' Your draft is retained.'); }
    }
}

async function performanceSettings(screen: Screen, config: Settings): Promise<void> {
    const draft = { ...config };
    let selected = 'models';
    while (!screen.quitRequested) {
        selected = await screen.select('Settings / Models and performance', [
            { value: 'models', name: 'Manage local models…', state: 'Manage', hint: 'Explicit installs and model selections apply immediately. Other edits stay in this draft.' },
            { value: 'language', name: 'Recognition language', state: draft.language === 'auto' ? 'Automatic' : draft.language.toUpperCase(), hint: 'Choose a common language or enter another Whisper language code.' },
            { value: 'warm', name: 'Keep models warm', state: draft.dictationWarmSeconds ? draft.dictationWarmSeconds + ' s' : 'Off', hint: '0 releases models after each dictation. Higher values reduce repeated startup time.' },
            { value: 'save', name: 'Save changes', action: true }, { value: 'back', name: 'Discard changes', action: true },
        ], { back: true, initialValue: selected, detail: 'Save language and performance edits. Esc discards. Model management is an immediate action.' });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        try {
        if (selected === 'models') { await modelMenu(screen, config); void screen.dictation?.prewarm(); }
        if (selected === 'language') {
            const language = await pickValue(screen, 'Recognition language', [{ value: 'auto', name: 'Automatic detection' }, { value: 'de', name: 'German' }, { value: 'en', name: 'English' },
                { value: 'fr', name: 'French' }, { value: 'es', name: 'Spanish' }, { value: 'it', name: 'Italian' }, { value: 'custom', name: 'Other language code…' }], draft.language);
            const value = language === 'custom' ? await screen.input('Recognition language', 'auto or a two/three-letter language code', draft.language) : language;
            if (value !== null && !['back', 'quit', 'settings'].includes(value)) { if (!/^(auto|[a-z]{2,3})$/.test(value.trim())) throw new Error('Enter auto or a valid language code.'); draft.language = value.trim(); }
        }
        if (selected === 'warm') {
            const value = await pickNumber(screen, 'Keep models warm', [0, 30, 60, 120, 300, 600], draft.dictationWarmSeconds, 0, 600, 's');
            if (value !== null) draft.dictationWarmSeconds = value;
        }
        if (selected === 'save') {
            if (screen.dictation?.busy) { await screen.notice('Dictation active', 'Finish or cancel dictation before saving performance settings.'); continue; }
            await saveSettings({ ...config, language: draft.language, dictationWarmSeconds: draft.dictationWarmSeconds });
            Object.assign(config, { language: draft.language, dictationWarmSeconds: draft.dictationWarmSeconds });
            if (draft.dictationWarmSeconds > 0) void screen.dictation?.prewarm();
            else await screen.dictation?.releaseModels();
            return;
        }
        } catch (error) { await screen.notice('Performance settings', errorMessage(error) + ' Your draft is retained.'); }
    }
}

async function pickValue(screen: Screen, title: string, values: Choice[], current: string): Promise<string> {
    const choices = values.some(choice => choice.value === current) ? values : [{ value: current, name: 'Current value · ' + current }, ...values];
    return screen.select(title, [...choices.map(choice => ({ ...choice, state: choice.value === current ? 'Selected' : '' })), back],
        { back: true, initialValue: current, detail: 'Choose a value. Selected marks the current draft. Esc keeps it unchanged.' });
}

async function pickNumber(screen: Screen, title: string, values: number[], current: number, minimum: number, maximum: number, unit: string): Promise<number | null> {
    const selected = await pickValue(screen, title, [...values.map(value => ({ value: String(value), name: value === 0 ? 'Off · release after each dictation' : value + ' ' + unit })),
        { value: 'custom', name: 'Custom value…' }], String(current));
    if (['back', 'quit', 'settings'].includes(selected)) return null;
    if (selected !== 'custom') return Number(selected);
    for (;;) {
        const text = await screen.input(title, 'Whole numbers from ' + minimum + ' to ' + maximum + '. Esc keeps the current value.', String(current));
        if (text === null) return null;
        const value = Number(text);
        if (text.trim() && Number.isInteger(value) && value >= minimum && value <= maximum) return value;
        await screen.notice('Choose a valid value', 'Enter a whole number from ' + minimum + ' to ' + maximum + '.');
        if (screen.quitRequested) return null;
    }
}
