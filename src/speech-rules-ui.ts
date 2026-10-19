import { addCorrection, addSnippet, addWord, applyTextRules, loadSpeechRules, matchSnippet, removeSpeechRule, saveSpeechRules, toggleSpeechRule, validateSpeechRules } from './speech-rules.js';
import type { SpeechRules, Word, Correction, Snippet } from './speech-rules.js';
import type { Screen } from './terminal/screen.js';
import { errorMessage } from './types.js';

type Kind = 'words' | 'corrections' | 'snippets';
const titles: Record<Kind, string> = { words: 'Dictionary', corrections: 'Corrections', snippets: 'Spoken snippets' };
const back = { value: 'back', name: 'Back' };
const label = (entry: Word | Correction | Snippet) => 'from' in entry ? entry.from + ' → ' + entry.to : 'trigger' in entry ? 'Say: “' + entry.trigger + '”' : entry.text;
async function editEntry(screen: Screen, rules: SpeechRules, kind: Kind, existing?: Word | Correction | Snippet): Promise<SpeechRules> {
    let next = existing ? removeSpeechRule(rules, existing.id) : rules;
    if (kind === 'words') {
        const word = await screen.input('Preferred spelling', 'Names or short technical terms. Hints local recognition and preserves this spelling in future dictation.', existing && 'text' in existing ? existing.text : '');
        if (word === null) return rules;
        next = addWord(next, word);
    } else if (kind === 'corrections') {
        const from = await screen.input('Phrase to correct', 'Whole words only. URLs, paths and Markdown code are protected. This does not edit old dictations.', existing && 'from' in existing ? existing.from : '');
        if (from === null) return rules;
        const to = await screen.input('Replace with', 'Applied once after formatting. Replacement text cannot trigger another rule.', existing && 'to' in existing ? existing.to : '');
        if (to === null) return rules;
        next = addCorrection(next, from, to);
    } else {
        const trigger = await screen.input('Say this exact phrase', 'Use a deliberate prefix, for example “Textbaustein Signatur”. The entire dictation must match.', existing && 'trigger' in existing ? existing.trigger : '');
        if (trigger === null) return rules;
        addSnippet(next, trigger, 'Trigger validation');
        let text = existing && 'text' in existing ? existing.text : '';
        while (!screen.quitRequested) {
            const value = await screen.input('Snippet text', 'Ctrl+S continues to preview. Paragraphs and special characters are inserted exactly; no formatter is used.', text, { multiline: true });
            if (value === null) return rules;
            text = value;
            try { next = addSnippet(next, trigger, text); break; }
            catch (error) { await screen.notice('Snippet not saved · Draft retained', errorMessage(error)); }
        }
    }
    if (screen.quitRequested) return rules;
    const entry = next[kind].at(-1)!;
    if (existing) { entry.id = existing.id; entry.enabled = existing.enabled; }
    const before = 'from' in entry ? entry.from : 'trigger' in entry ? entry.trigger : entry.text.toLocaleLowerCase();
    const after = 'from' in entry ? entry.to : entry.text;
    await screen.view('Preview · ' + titles[kind], () => 'SAY / BEFORE\n\n' + before + '\n\nAFTER\n\n' + after, { markdown: false });
    if (screen.quitRequested) return rules;
    const action = await screen.select('Preview · ' + titles[kind], [{ value: 'use', name: 'Use in draft', hint: 'Save changes on Words and snippets to apply. Existing recordings remain unchanged.' }, back],
        { back: true, detail: kind === 'snippets' ? 'Only this complete spoken phrase expands. No expansion inside a normal sentence.' : 'Future dictation only. Original recognized text always stays preserved.', before: () => ['Say / Before: ' + before, 'Preview reviewed. Existing recordings stay unchanged.', ''] });
    return action === 'use' ? validateSpeechRules(next) : rules;
}

export async function speechRulesMenu(screen: Screen): Promise<void> {
    let draft = structuredClone(await loadSpeechRules());
    for (;;) {
        if (screen.quitRequested) return;
        const action = await screen.select('Words and snippets', [
            { value: 'enabled', name: 'Use personal words and snippets', toggle: draft.enabled },
            ...(['words', 'corrections', 'snippets'] as const).map(kind => ({ value: kind, name: titles[kind] + ' · ' + draft[kind].length })),
            { value: 'preview', name: 'Test a phrase…', hint: 'Preview deterministic corrections and snippet matching. No audio or model is started.' },
            { value: 'save', name: 'Save changes' }, { value: 'back', name: 'Back · discard draft' },
        ], { back: true, detail: 'Save applies to future dictation and explicit history retries. Esc discards this draft. Meeting transcripts are unchanged.' });
        if (['back', 'quit', 'settings'].includes(action)) return;
        try {
            if (action === 'enabled') draft.enabled = !draft.enabled;
            if (action === 'save') {
                if (screen.dictation?.busy) throw new Error('Finish or cancel dictation before saving words and snippets. Your draft is retained.');
                await saveSpeechRules(draft); return;
            }
            if (action === 'preview') {
                const text = await screen.input('Test a phrase', 'Recognition/formatting are not run. Preview only your current draft rules.', '', { multiline: true });
                if (text !== null) { const snippet = matchSnippet(text, draft); await screen.view('Rules preview · ' + (snippet ? 'Exact snippet match' : 'Corrections'), () => 'BEFORE\n\n' + text + '\n\nAFTER\n\n' + (snippet?.text ?? applyTextRules(text, draft)), { markdown: false }); }
            }
            if (action === 'words' || action === 'corrections' || action === 'snippets') {
                const kind = action;
                for (;;) {
                    const selected = await screen.select(titles[kind], [{ value: 'add', name: 'Add ' + (kind === 'words' ? 'word' : kind === 'corrections' ? 'correction' : 'snippet') },
                        ...draft[kind].map(entry => ({ value: entry.id, name: label(entry), toggle: entry.enabled })), back],
                        { back: true, detail: 'Entries are still a draft. Open one to edit, disable or remove it.' });
                    if (['back', 'quit', 'settings'].includes(selected)) break;
                    try {
                        if (selected === 'add') draft = await editEntry(screen, draft, kind);
                        else {
                            const entry = draft[kind].find(entry => entry.id === selected); if (!entry) continue;
                            const operation = await screen.select(label(entry), [{ value: 'edit', name: 'Edit…' }, { value: 'toggle', name: 'Enabled', toggle: entry.enabled },
                                { value: 'remove', name: 'Remove from draft' }, back], { back: true, detail: 'Save on Words and snippets to apply changes.' });
                            if (operation === 'toggle') draft = toggleSpeechRule(draft, selected);
                            if (operation === 'remove') draft = removeSpeechRule(draft, selected);
                            if (operation === 'edit') draft = await editEntry(screen, draft, kind, entry);
                        }
                    } catch (error) { await screen.notice(titles[kind], errorMessage(error)); }
                    if (screen.quitRequested) return;
                }
            }
        } catch (error) { await screen.notice('Words and snippets', errorMessage(error)); }
    }
}

export async function teachCorrection(screen: Screen): Promise<void> {
    const saved = await loadSpeechRules();
    const draft = await editEntry(screen, saved, 'corrections');
    if (draft === saved) return;
    const action = await screen.select('Save a permanent correction?', [{ value: 'save', name: 'Save for future dictation', hint: 'This does not edit the selected saved dictation. Use Edit formatted text for that.' }, back], { back: true });
    if (action === 'save') {
        if (screen.dictation?.busy) throw new Error('Finish or cancel dictation before saving a rule.');
        await saveSpeechRules(draft);
    }
}
