import { Screen } from './terminal/screen.js';
import { DictationService, dictations } from './dictation.js';
import type { Dictation } from './dictation.js';
import { formatLabels } from './formatter.js';
import { DICTATION_SHORTCUT } from './hotkey.js';
import type { DictationFormat, Settings } from './types.js';
import { errorMessage } from './types.js';

export function createInterface(config: Settings) {
    const screen = new Screen();
    const service = new DictationService(config, () => screen.recordingActive || screen.taskActive);
    screen.dictation = service;
    service.listen();
    return { screen, service, close: async () => { try { await service.close(); } finally { screen.close(); } } };
}

async function itemMenu(screen: Screen, service: DictationService, item: Dictation): Promise<void> {
    for (;;) {
        const selected = await screen.select("Dictation · " + new Date(item.startedAt).toLocaleString("en-GB"), [
            ...(item.text ? [{ value: 'view', name: "Read formatted text" }, { value: 'copy', name: "Copy formatted text" }] : []),
            ...(item.raw ? [{ value: 'raw', name: "Read original transcript" }, { value: 'copy-raw', name: "Copy original transcript" }] : []),
            { value: 'retry', name: "Reprocess / change format" },
            { value: 'delete', name: "Delete dictation, audio and text" }, { value: 'back', name: "Back" },
        ], { back: true, detail: item.error || formatLabels[item.format] });
        if (['quit', 'back', 'settings'].includes(selected)) return;
        try {
            if (selected === 'view' || selected === 'raw') await screen.view("Dictation", () => (selected === 'raw' ? item.raw : item.text) || '');
            if (selected === 'copy' || selected === 'copy-raw') await service.copy(item, selected === 'copy-raw');
            if (selected === 'retry') {
                const format = await screen.select("Format dictation", [...Object.entries(formatLabels).map(([value, name]) => ({ value, name })), { value: 'back', name: "Back" }], { back: true });
                if (Object.hasOwn(formatLabels, format)) {
                    if (service.busy) throw new Error("Stop or cancel dictation first.");
                    void service.retry(item, format as DictationFormat); return;
                }
            }
            if (selected === 'delete') {
                const confirmed = await screen.select("Delete dictation permanently?", [{ value: 'back', name: "Keep" }, { value: 'delete', name: "Delete audio and text" }], { back: true });
                if (confirmed === 'delete') { await service.remove(item); return; }
            }
        } catch (error) { await screen.notice("Dictation", errorMessage(error)); }
    }
}

export async function dictationMenu(screen: Screen, service = screen.dictation!): Promise<void> {
    for (;;) {
        const selected = await screen.select("Dictation", () => [
            { value: 'toggle', name: service.state === 'recording' ? "Stop dictation and copy" : service.busy ? "Processing…" : "Record microphone", hint: DICTATION_SHORTCUT + " works in any app." },
            ...(service.busy ? [{ value: 'cancel', name: "Cancel dictation" }] : []),
            ...(service.current && !service.busy ? [{ value: 'current', name: "Open latest dictation", hint: service.message }] : []),
            { value: 'history', name: "Saved dictations" }, { value: 'back', name: "Back" },
        ], { back: true, detail: () => service.message,
            before: () => service.recorder ? ["Microphone: " + service.recorder.current.mic + ' · ' + service.recorder.health.mic, "Level: " + Math.round(service.recorder.levels.mic * 100) + '%', ''] : [],
            footer: "Enter Select · F8 Start/stop · Esc Back · Ctrl+C Quit", shortcuts: { f8: 'toggle' } });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        if (selected === 'toggle') { void service.toggle(); }
        if (selected === 'cancel') await service.cancel();
        if (selected === 'current' && service.current) await itemMenu(screen, service, service.current);
        if (selected === 'history') {
            const all = await dictations();
            const id = await screen.select("Saved dictations", [...all.map(item => ({ value: item.id, name: new Date(item.startedAt).toLocaleString("en-GB") + ' · ' + (item.error ? "ERROR" : item.text ? formatLabels[item.format] : "OPEN"), hint: item.text?.replace(/\s+/g, ' ').slice(0, 100) || item.error })), { value: 'back', name: "Back" }], { back: true });
            const item = all.find(item => item.id === id);
            if (item) await itemMenu(screen, service, item);
        }
        if (screen.quitRequested) return;
    }
}
