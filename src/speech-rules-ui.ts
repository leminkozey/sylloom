import { addCorrection, addSnippet, addWord, loadSpeechRules, removeSpeechRule, saveSpeechRules, toggleSpeechRule, validateSpeechRules } from './speech-rules.js';
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
            const value = await screen.input('Snippet text', 'Ctrl+S saves to your draft. Paragraphs and special characters are inserted exactly; no formatter is used.', text, { multiline: true });
            if (value === null) return rules;
            text = value;
            try { next = addSnippet(next, trigger, text); break; }
            catch (error) { await screen.notice('Snippet not saved · Draft retained', errorMessage(error)); }
        }
    }
    if (screen.quitRequested) return rules;
    const entry = next[kind].at(-1)!;
    if (existing) {
        entry.id = existing.id; entry.enabled = existing.enabled;
        const list = next[kind] as (Word | Correction | Snippet)[], index = rules[kind].findIndex(item => item.id === existing.id);
        list.splice(list.length - 1, 1); list.splice(index, 0, entry);
    }
    return validateSpeechRules(next);
}

export async function speechRulesMenu(screen: Screen, initial: Kind = 'words'): Promise<void> {
    let draft = structuredClone(await loadSpeechRules()), kind = initial;
    let selected = '';
    const kinds: Kind[] = ['words', 'corrections', 'snippets'];
    while (!screen.quitRequested) {
        const action = await screen.select(titles[kind], () => [
            ...draft[kind].map(entry => ({ value: entry.id, name: label(entry), toggle: entry.enabled,
                cells: 'from' in entry ? [entry.from, entry.to, entry.enabled ? 'On' : 'Off'] : 'trigger' in entry ? [entry.trigger, entry.text, entry.enabled ? 'On' : 'Off'] : [entry.text, entry.enabled ? 'On' : 'Off'],
                hint: 'from' in entry ? entry.from + ' → ' + entry.to : entry.text,
                group: kind })),
            { value: 'add', name: 'Add ' + (kind === 'words' ? 'word' : kind === 'corrections' ? 'correction' : 'snippet'), action: true },
            { value: 'save', name: 'Save changes', action: true }, { value: 'back', name: 'Discard changes', action: true },
        ], { back: true, initialValue: selected,
            columns: kind === 'words' ? [{ title: 'Spelling' }, { title: 'Status', width: 8 }] : [{ title: kind === 'corrections' ? 'When you say' : 'Trigger' }, { title: kind === 'corrections' ? 'Replace with' : 'Text' }, { title: 'Status', width: 8 }],
            detail: kind === 'words' ? 'Names and terms to recognize correctly. Tab: Corrections or Snippets.' : kind === 'corrections' ? 'Replace a misheard phrase automatically. Tab switches category.' : 'Say the exact trigger to insert its saved text. Tab switches category.',
            footer: 'Tab Category · A Add · Enter Edit · Space On/Off · Del Remove · Ctrl+S Save',
            shortcuts: { a: 'add', tab: 'next-kind', 'ctrl+s': 'save' },
            onToggle: id => { draft = toggleSpeechRule(draft, id); },
            onDelete: id => { draft = removeSpeechRule(draft, id); },
        });
        if (['back', 'quit', 'settings'].includes(action)) return;
        selected = action;
        try {
            if (action === 'next-kind') { kind = kinds[(kinds.indexOf(kind) + 1) % kinds.length]!; selected = ''; continue; }
            if (kinds.includes(action as Kind)) { kind = action as Kind; selected = ''; continue; }
            if (action === 'save') {
                if (screen.dictation?.busy) throw new Error('Finish or cancel dictation before saving. Your draft is retained.');
                await saveSpeechRules({ ...draft, enabled: true }); return;
            } else if (action === 'add') draft = await editEntry(screen, draft, kind);
            else { const entry = draft[kind].find(entry => entry.id === action); if (entry) draft = await editEntry(screen, draft, kind, entry); }
        } catch (error) { await screen.notice(titles[kind], errorMessage(error)); }
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
