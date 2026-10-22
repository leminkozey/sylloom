import { PASTE_SHORTCUT } from './platform.js';

export type BubbleNotice = { title: string; detail: string };

// Native UI receives short, actionable copy, never native codes, paths, model
// output or an arbitrary error string. Technical details stay in diagnostics.
export function bubbleNotice(message: string): BubbleNotice {
    if (/could not copy|clipboard.*(?:busy|timed out)|clipboard timed out/i.test(message)) return { title: 'Could not copy text', detail: 'Open Library and copy your saved dictation again.' };
    if (/processing failed.*copied|original text copied/i.test(message)) return { title: 'Original text copied', detail: "Formatting couldn't finish. Press " + PASTE_SHORTCUT + ' to paste the original text.' };
    if (/copied|paste/i.test(message)) return { title: 'Copied to clipboard', detail: 'Press ' + PASTE_SHORTCUT + ' to paste your text.' };
    if (/hotkey|shortcut|RegisterHotKey/i.test(message)) return { title: 'Shortcut unavailable', detail: 'Choose another key in Settings → Global shortcuts.' };
    if (/microphone|audio device.*mic|mic[: ].*(error|permission|device|lost|stall)/i.test(message)) return { title: 'Microphone unavailable', detail: 'Choose a microphone in Settings → Recording and audio.' };
    if (/indicator unavailable|bubble unavailable/i.test(message)) return { title: 'Capture bubble unavailable', detail: 'Open Sylloom to check the recording controls.' };
    if (/pause state|could not pause|could not resume/i.test(message)) return { title: 'Could not change pause state', detail: 'Use Recording controls in Sylloom to try again.' };
    if (/recording or processing is active|active dictation before/i.test(message)) return { title: 'Recording is still active', detail: 'Finish the current recording before starting another action.' };
    if (/model.*missing|formatter missing|set up.*model/i.test(message)) return { title: 'Set up dictation models', detail: 'Open Settings → Models and performance to choose a model.' };
    if (/transcrib|whisper|formatter|processing failed|llama|mlx|model/i.test(message)) return { title: 'Could not process dictation', detail: 'Your audio is in Library. Check Models in Settings to retry.' };
    if (/bridge unavailable|outlook|calendar/i.test(message)) return { title: 'Meeting connection unavailable', detail: 'Check Call recording prompts and Outlook in Settings.' };
    return { title: 'Action could not finish', detail: 'Open Sylloom to review the details and try again.' };
}
