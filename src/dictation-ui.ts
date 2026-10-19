import { Screen } from './terminal/screen.js';
import { DictationService } from './dictation.js';
import { libraryMenu, editLibraryMetadata } from './library-ui.js';
import { loadLibrary } from './library.js';
import type { Dictation } from './dictation.js';
import { formatLabels } from './formatter.js';
import { COPY_SHORTCUT, DICTATION_SHORTCUT } from './hotkey.js';
import type { DictationFormat, Settings } from './types.js';
import { errorMessage } from './types.js';
import { MeetingBridge } from './meeting-bridge.js';
import { notify } from './clipboard.js';

export function createInterface(config: Settings) {
    const screen = new Screen();
    const service = new DictationService(config, () => screen.recordingActive || screen.taskActive);
    screen.dictation = service;
    const bridge = new MeetingBridge(config, service, screen);
    screen.bridge = bridge;
    service.listen();
    void bridge.start().catch(error => notify('Local bridge unavailable: ' + errorMessage(error)));
    return { screen, service, bridge, close: async () => { try { await bridge.close(); } finally { try { await service.close(); } finally { screen.close(); } } } };
}

export async function dictationItemMenu(screen: Screen, service: DictationService, item: Dictation): Promise<void> {
    for (;;) {
        if (screen.quitRequested) return;
        const selected = await screen.select(item.name && item.name !== 'Dictation' ? item.name : "Dictation · " + new Date(item.startedAt).toLocaleString("en-GB"), [
            ...(item.text ? [{ value: 'view', name: "Read formatted text" }, { value: 'copy', name: "Copy formatted text" }] : []),
            ...(item.raw ? [{ value: 'raw', name: "Read original transcript" }, { value: 'copy-raw', name: "Copy original transcript" }] : []),
            { value: 'retry', name: 'Reformat saved text', hint: 'Reuse the transcript. Keep the previous result if processing fails.' },
            { value: 'transcribe', name: 'Transcribe audio again', hint: 'Use the current recognition model. Keep the previous result until success.' },
            { value: 'organize', name: 'Rename / pin' },
            { value: 'delete', name: "Delete dictation, audio and text" }, { value: 'back', name: "Back" },
        ], { back: true, detail: item.error || [item.outcome, formatLabels[item.format], item.delivery?.kind, item.delivery?.reason].filter(Boolean).join(' · '),
            before: () => item.timings ? [
                'Recognition ' + (item.timings.transcriptionMs / 1000).toFixed(1) + ' s · Formatting ' + (item.timings.formattingMs / 1000).toFixed(1) + ' s',
                'Total ' + (item.timings.totalMs / 1000).toFixed(1) + ' s · Formatter ' + (item.timings.usedFormatter ? 'used' : 'skipped') + ' · ' + COPY_SHORTCUT + ' Copy latest', '',
            ] : [] });
        if (['quit', 'back', 'settings'].includes(selected)) return;
        try {
            if (selected === 'organize') {
                const saved = (await loadLibrary()).items.find(value => value.kind === 'dictation' && value.id === item.id);
                if (saved) { await editLibraryMetadata(screen, saved, service); Object.assign(item, saved.data); }
            }
            if (selected === 'view' || selected === 'raw') await screen.view("Dictation", () => (selected === 'raw' ? item.raw : item.text) || '');
            if (selected === 'copy' || selected === 'copy-raw') await service.copy(item, selected === 'copy-raw');
            if (selected === 'retry' || selected === 'transcribe') {
                const format = await screen.select("Format dictation", [...Object.entries(formatLabels).map(([value, name]) => ({ value, name })), { value: 'back', name: "Back" }], { back: true });
                if (Object.hasOwn(formatLabels, format)) {
                    if (service.busy) throw new Error("Stop or cancel dictation first.");
                    void service.retry(item, format as DictationFormat, selected === 'transcribe').catch(error => notify(errorMessage(error))); return;
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
            { value: 'toggle', name: service.state === 'recording' ? "Stop dictation and insert / copy" : service.busy ? "Processing…" : "Record microphone", hint: DICTATION_SHORTCUT + " works in any app." },
            ...(service.busy ? [{ value: 'cancel', name: "Cancel dictation" }] : []),
            ...(service.current && !service.busy ? [{ value: 'current', name: "Open latest dictation", hint: service.message }] : []),
            { value: 'history', name: "Saved dictations" }, { value: 'back', name: "Back" },
        ], { back: true, detail: () => service.message,
            before: () => service.recorder ? ["Microphone: " + service.recorder.current.mic + ' · ' + service.recorder.health.mic, "Level: " + Math.round(service.recorder.levels.mic * 100) + '%', ''] : [],
            footer: "Enter Select · F8 Start/stop · Esc Back · Ctrl+C Quit", shortcuts: { f8: 'toggle' } });
        if (['back', 'quit', 'settings'].includes(selected)) return;
        if (selected === 'toggle') { void service.toggle().catch(error => notify(errorMessage(error))); }
        if (selected === 'cancel') await service.cancel();
        if (selected === 'current' && service.current) await dictationItemMenu(screen, service, service.current);
        if (selected === 'history') await libraryMenu(screen, async item => { await dictationItemMenu(screen, service, item.data as Dictation); }, 'dictation');
        if (screen.quitRequested) return;
    }
}
