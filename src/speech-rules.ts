import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicJson, home } from './store.js';
import { cleanText } from './types.js';

export type Word = { id: string; text: string; enabled: boolean };
export type Correction = { id: string; from: string; to: string; enabled: boolean };
export type Snippet = { id: string; trigger: string; text: string; enabled: boolean };
export type SpeechRules = { version: 1; enabled: boolean; words: Word[]; corrections: Correction[]; snippets: Snippet[] };
export const emptySpeechRules = (): SpeechRules => ({ version: 1, enabled: true, words: [], corrections: [], snippets: [] });
const file = () => path.join(home, 'speech-rules.json');
const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
export const spokenTrigger = (text: string): string => normalize(text).replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
const phrase = (value: unknown, maximum: number): value is string => typeof value === 'string' && value === cleanText(value) &&
    Boolean(value.trim()) && value.length <= maximum && /[\p{L}\p{N}]/u.test(value) && !/[\r\n]/.test(value);

export function validateSpeechRules(value: unknown): SpeechRules {
    const rules = value as SpeechRules | null;
    if (!rules || rules.version !== 1 || typeof rules.enabled !== 'boolean' || !Array.isArray(rules.words) ||
        !Array.isArray(rules.corrections) || !Array.isArray(rules.snippets)) throw new Error('Invalid words and snippets data. The original file was preserved.');
    const entries = [...rules.words, ...rules.corrections, ...rules.snippets];
    if (rules.words.length > 64 || rules.corrections.length > 200 || rules.snippets.length > 100 || entries.some(entry =>
        !entry || !/^[a-f0-9-]{36}$/.test(entry.id) || typeof entry.enabled !== 'boolean') || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Invalid speech rule entries or limit exceeded.');
    if (rules.words.some(word => !phrase(word.text, 80)) || rules.words.map(word => word.text).join(', ').length > 1000) throw new Error('Dictionary supports 64 terms and 1000 characters in total. Use names or short technical terms.');
    if (rules.corrections.some(rule => !phrase(rule.from, 120) || typeof rule.to !== 'string' || !rule.to.trim() || rule.to.length > 200 ||
        rule.to !== cleanText(rule.to) || /[\r\n]/.test(rule.to))) throw new Error('Corrections need a spoken phrase and nonempty replacement on one line, from 1 to 120 / 200 characters.');
    if (rules.snippets.some(rule => !phrase(rule.trigger, 120) || !spokenTrigger(rule.trigger) || typeof rule.text !== 'string' ||
        !rule.text.trim() || rule.text.length > 20000 || rule.text !== cleanText(rule.text))) throw new Error('Snippets need a word-based trigger and text from 1 to 20000 characters.');
    for (const keys of [rules.words.map(word => normalize(word.text)), rules.corrections.map(rule => normalize(rule.from)), rules.snippets.map(rule => spokenTrigger(rule.trigger))]) {
        if (new Set(keys).size !== keys.length) throw new Error('That word or trigger already exists. Edit the existing entry instead.');
    }
    return rules;
}

export async function loadSpeechRules(): Promise<SpeechRules> {
    if (!existsSync(file())) return emptySpeechRules();
    try { return validateSpeechRules(JSON.parse(await readFile(file(), 'utf8'))); }
    catch (error) { throw new Error('Words and snippets could not be loaded. Original file preserved. ' + (error instanceof Error ? error.message : String(error))); }
}
export async function saveSpeechRules(rules: SpeechRules): Promise<void> { await atomicJson(file(), validateSpeechRules(rules)); }
export function removeSpeechRule(rules: SpeechRules, id: string): SpeechRules {
    return { ...rules, words: rules.words.filter(entry => entry.id !== id), corrections: rules.corrections.filter(entry => entry.id !== id), snippets: rules.snippets.filter(entry => entry.id !== id) };
}
export function toggleSpeechRule(rules: SpeechRules, id: string): SpeechRules {
    return { ...rules, words: rules.words.map(entry => entry.id === id ? { ...entry, enabled: !entry.enabled } : entry),
        corrections: rules.corrections.map(entry => entry.id === id ? { ...entry, enabled: !entry.enabled } : entry),
        snippets: rules.snippets.map(entry => entry.id === id ? { ...entry, enabled: !entry.enabled } : entry) };
}
export function addWord(rules: SpeechRules, text: string): SpeechRules {
    return validateSpeechRules({ ...rules, words: [...rules.words, { id: randomUUID(), text: text.trim(), enabled: true }] });
}
export function addCorrection(rules: SpeechRules, from: string, to: string): SpeechRules {
    return validateSpeechRules({ ...rules, corrections: [...rules.corrections, { id: randomUUID(), from: from.trim(), to: to.trim(), enabled: true }] });
}
export function addSnippet(rules: SpeechRules, trigger: string, text: string): SpeechRules {
    return validateSpeechRules({ ...rules, snippets: [...rules.snippets, { id: randomUUID(), trigger: trigger.trim(), text: text.replace(/\r\n?/g, '\n'), enabled: true }] });
}
export function dictionaryPrompt(rules: SpeechRules): string {
    const terms = rules.enabled ? rules.words.filter(word => word.enabled).map(word => word.text) : [];
    return terms.length ? terms.join(', ') : '';
}
export function matchSnippet(text: string, rules: SpeechRules): Snippet | undefined {
    return rules.enabled ? rules.snippets.find(rule => rule.enabled && spokenTrigger(rule.trigger) === spokenTrigger(text)) : undefined;
}

// Apply all matches to the original input in one pass. Replacements cannot
// trigger another rule. Preserve URLs, addresses, paths and code verbatim.
export function applyTextRules(text: string, rules: SpeechRules): string {
    if (!rules.enabled) return text;
    const replacements = new Map<string, { from: string; to: string }>();
    for (const word of rules.words.filter(word => word.enabled)) replacements.set(normalize(word.text), { from: word.text, to: word.text });
    for (const rule of rules.corrections.filter(rule => rule.enabled)) replacements.set(normalize(rule.from), rule);
    if (!replacements.size) return text;
    const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alternatives = [...replacements.values()].sort((a, b) => b.from.length - a.from.length).map(rule => rule.from.normalize('NFC').split(/\s+/).map(escape).join('\\s+'));
    const pattern = new RegExp('(?<![\\p{L}\\p{N}_-])(?:' + alternatives.join('|') + ')(?![\\p{L}\\p{N}_-])', 'giu');
    const protectedText = /(```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|(?=\n|$))|https?:\/\/\S+|www\.\S+|[\p{L}\p{N}.%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|(?:~?[/\\]|[A-Za-z]:[/\\])[\p{L}\p{N}_./\\~-]+|[\p{L}\p{N}_-]+(?:[./\\][\p{L}\p{N}_-]+)+)/giu;
    return text.split(protectedText).map((part, index) => index % 2 ? part : part.normalize('NFC').replace(pattern, match => replacements.get(normalize(match))?.to || match)).join('');
}
