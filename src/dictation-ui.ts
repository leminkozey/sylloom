import { Screen } from './terminal/screen.js';
import { DictationService } from './dictation.js';
import { editLibraryMetadata } from './library-ui.js';
import { loadLibrary } from './library.js';
import type { Dictation } from './dictation.js';
import { formatLabels } from './formatter.js';
import { COPY_SHORTCUT } from './hotkey.js';
import type { DictationFormat, Settings } from './types.js';
import { errorMessage } from './types.js';
import { MeetingBridge } from './meeting-bridge.js';
import { notify } from './clipboard.js';
import { teachCorrection } from './speech-rules-ui.js';

export function createInterface(config: Settings) {
    const screen = new Screen();
    const service = new DictationService(config, () => screen.recordingActive || screen.taskActive || screen.editingActive);
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
            ...(item.text ? [{ value: 'view', name: "Read result" }, { value: 'copy', name: "Copy result" }] : []),
            ...(item.raw ? [{ value: 'raw', name: "Read original transcript" }, { value: 'copy-raw', name: "Copy original transcript" }] : []),
            { value: 'edit', name: 'Edit formatted text…', hint: 'Multiline editor. Save explicitly; original recognition and audio stay unchanged.' },
            { value: 'teach', name: 'Teach a correction for future dictation…', hint: 'Separate from editing this result. Preview and save a permanent local rule explicitly.' },
            ...(item.edits?.length ? [{ value: 'versions', name: 'Read previous text versions · ' + item.edits.length }] : []),
            { value: 'retry', name: 'Reformat saved text', hint: 'Reformat even when Auto would skip. Reuse the transcript; keep the previous result if processing fails.' },
            { value: 'transcribe', name: 'Transcribe audio again', hint: 'Use the current recognition model. Keep the previous result until success.' },
            { value: 'organize', name: 'Rename / pin' },
            { value: 'delete', name: "Delete dictation, audio and text" }, { value: 'back', name: "Back" },
        ], { back: true, detail: item.error || [item.outcome, formatLabels[item.format], item.delivery?.kind, item.delivery?.reason].filter(Boolean).join(' · '),
            before: () => item.timings ? [
                'Recognition ' + (item.timings.transcriptionMs / 1000).toFixed(1) + ' s · Formatting ' + (item.timings.formattingMs / 1000).toFixed(1) + ' s',
                'Total ' + (item.timings.totalMs / 1000).toFixed(1) + ' s · Formatter ' + (item.timings.usedFormatter ? 'used' : 'skipped') +
                    ' · Text ' + (item.text === item.raw ? 'unchanged' : 'changed') + ' · ' + COPY_SHORTCUT + ' Copy latest', '',
                ...(item.recognitionLanguage ? ['Recognized language: ' + item.recognitionLanguage, ''] : []),
            ] : [] });
        if (['quit', 'back', 'settings'].includes(selected)) return;
        try {
            if (selected === 'teach') await teachCorrection(screen);
            if (selected === 'edit') {
                let draft = item.text || item.raw || '';
                while (!screen.quitRequested) {
                    const text = await screen.input('Edit dictation', 'Ctrl+S saves. Esc cancels. This changes only this result, not any dictionary rules.', draft, { multiline: true });
                    if (text === null) break;
                    draft = text;
                    try { await service.edit(item, text); break; }
                    catch (error) { await screen.notice('Edit not saved · Draft retained', errorMessage(error)); }
                }
            }
            if (selected === 'versions') await screen.view('Previous formatted text', () => (item.edits || []).map(version => 'Saved before edit: ' + version.at + '\n\n' + version.text).join('\n\n────────────────\n\n'), { markdown: false });
            if (selected === 'organize') {
                const saved = (await loadLibrary()).items.find(value => value.kind === 'dictation' && value.id === item.id);
                if (saved) { await editLibraryMetadata(screen, saved, service); Object.assign(item, saved.data); }
            }
            if (selected === 'view' || selected === 'raw') await screen.view("Dictation", () => (selected === 'raw' ? item.raw : item.text) || '');
            if (selected === 'copy' || selected === 'copy-raw') await service.copy(item, selected === 'copy-raw');
            if (selected === 'retry' || selected === 'transcribe') {
                const format = await screen.select("Format dictation", [...Object.entries(formatLabels).map(([value, name]) => ({ value, name, state: value === item.format ? 'Selected' : '' })), { value: 'back', name: "Back" }], { back: true, initialValue: item.format });
                if (Object.hasOwn(formatLabels, format)) {
                    if (service.busy) throw new Error("Stop or cancel dictation first.");
                    const operation = selected === 'retry' ? service.reformat(item, format as DictationFormat) : service.retry(item, format as DictationFormat, true);
                    void operation.catch(error => notify(errorMessage(error))); return;
                }
            }
            if (selected === 'delete') {
                const confirmed = await screen.select("Delete dictation permanently?", [{ value: 'back', name: "Keep" }, { value: 'delete', name: "Delete audio and text" }], { back: true });
                if (confirmed === 'delete') { await service.remove(item); return; }
            }
        } catch (error) { await screen.notice("Dictation", errorMessage(error)); }
    }
}
