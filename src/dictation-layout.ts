import { cleanText } from './types.js';

// Keep offsets when inspecting spoken commands: quoted words and code are data.
export const dictationLiterals = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|$)|"[^"\n]*"|„[^“\n]*“|“[^”\n]*”|«[^»\n]*»|(?<!\p{L})'[^'\n]*')/gu;
export function spokenOnly(text: string): string {
    return text.split(dictationLiterals).map((part, index) => index % 2 ? ' '.repeat(part.length) : part).join('');
}

export function speechParagraphs(raw: string): string[] {
    const text = cleanText(raw), speech = spokenOnly(text);
    const protectedRanges = [...text.matchAll(dictationLiterals)].map(match => [match.index!, match.index! + match[0].length]);
    const command = /(?:(?:neuer|nächster) Ansatz\s*[,;.]\s*(?:(?:nein|ich meine)\s*,?\s*)?)?(?:neuer Absatz|nächster Absatz|Absatzwechsel|new paragraph|párrafo siguiente|nouveau paragraphe|новый абзац|新しい段落|新段落|另起一段)(?!\p{L})(?:\s*,?\s*(?:meine ich|ich meine))?\s*[,.!。]?/giu;
    return text.replace(command, (match, offset: number) => {
        if (protectedRanges.some(([start, end]) => offset < end! && offset + match.length > start!)) return match;
        const before = speech.slice(0, offset), after = speech.slice(offset + match.length);
        // Commands are standalone spoken segments. Talking about a paragraph
        // or asking another person to add one is ordinary dictated content.
        if (before.trim() && !/[.!?…,:;。\n]\s*$/u.test(before)) return match;
        const clause = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('?'), before.lastIndexOf('!'), before.lastIndexOf('\n')) + 1);
        if (/(?<!\p{L})(?:wort|befehl|kommando|ausdruck|beispiel|sage|sagen|gesagt|sagt|say|said|saying|term|phrase|command|example|called|literal|palabra|comando|mot|commande|слово|команда)(?!\p{L})/iu.test(clause)) return match;
        if (!/[.!。]\s*$/u.test(match) && /^(?:bedeutet|heißt|ist|wird|soll|kann|im\b|means|is\b|should|in the|significa|es\b|signifie|est\b|означает)/iu.test(after.trimStart())) return match;
        return '\n\n';
    }).split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
}

export function emailContext(raw: string): boolean {
    const speech = spokenOnly(raw);
    return /^\s*(?:ähm?\s*[,;]?\s*)?(?:(?:hallo|guten (?:tag|morgen|abend)|sehr geehrte[rn]?)\s+(?:frau|herr|damen)\b|(?:dear|hello|hi)\s+\p{L}|(?:bonjour|cher|chère|estimado|estimada|уважаемый|уважаемая)\s+\p{L})/iu.test(speech) &&
        /(?<!\p{L})(?:(?:viele|freundliche|beste|herzliche|mit freundlichen) grüßen?|(?:best|kind) regards|sincerely|cordialement|saludos|с уважением)(?!\p{L})/iu.test(speech);
}

export type DictationBlock = { text: string; item?: boolean; tasks?: boolean; heading?: boolean };
const ordinal = /\b(?:erstens|zweitens|drittens|viertens|fünftens|sechstens|siebtens|achtens|neuntens|zehntens|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/giu;
const orders = [['erstens', 'zweitens', 'drittens', 'viertens', 'fünftens', 'sechstens', 'siebtens', 'achtens', 'neuntens', 'zehntens'],
    ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']];
const trimItem = (text: string) => text.trim().replace(/^[,;:]\s*/u, '').replace(/[,;:]?\s+(?:und|and)\s*$/iu, '').replace(/[,;:]\s*$/u, '').trim();

function canceledItem(text: string): boolean {
    const speech = spokenOnly(text);
    // Only discard a clearly withdrawn final item, never an ordinary "egal".
    return /(?:\b(?:wobei|nein|nee?|doch nicht)\b[\s,]*)+(?:egal\b[\s,]*)(?:passt schon\b)?[\s.!?…]*$/iu.test(speech) &&
        /\b(?:nein|nee?|doch nicht)\b/iu.test(speech);
}

function cleanListEnding(text: string): string {
    // Scope this to list data. Uncertainty in ordinary prose must survive.
    return text.replace(/(?:^|(?<=[.!?…])\s+|,\s*|\s+)(?:(?:und|and)\s+)?(?:naja|na ja|well|ähm?|ehm?|uhm?|um)[\s,.!?…]*(?:(?:ja|yeah|keine Ahnung|i don['’]t know)[\s,.!?…]*)*$/iu, '').trimEnd();
}

function hasTaskAction(text: string): boolean {
    const speech = spokenOnly(text).trim().replace(/[.!?…]+$/u, '');
    return /(?:^|\s)\p{Ll}[\p{L}-]*(?:en|ern|eln)$/u.test(speech) ||
        /^(?:please\s+)?(?:buy|pay|call|check|send|write|read|review|pick up|water|book|finish|update|fix|collect)\b/iu.test(speech);
}

export function listBlocks(raw: string, paragraphs: string[], tasks = false): DictationBlock[] {
    const text = cleanListEnding(paragraphs.join('\n\n')), speech = spokenOnly(text);
    paragraphs = text.split(/\n\s*\n/).filter(Boolean);
    const markers = [...speech.matchAll(ordinal)];
    if (markers.length >= 2 && orders.some(order => markers.every((match, index) => match[0].toLowerCase() === order[index]))) {
        const heading = trimItem(text.slice(0, markers[0]!.index));
        const items = markers.map((match, index) => trimItem(text.slice(match.index! + match[0].length, markers[index + 1]?.index ?? text.length)));
        if (canceledItem(items.at(-1)!)) items.pop();
        return [...(heading ? [{ text: heading.replace(/:$/, '') + ':', heading: true }] : []), ...items.filter(Boolean).map(text => ({ text, item: true }))];
    }
    // Already dictated Markdown and separate spoken paragraphs are unambiguous.
    if (paragraphs.length > 1) return paragraphs.map((text, index) => ({ text: text.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u, ''), heading: index === 0 && /:$/.test(text),
        item: !(index === 0 && /^(?:(?:meine|unsere|die|my|our|the)\s+)?(?:to[ -]?do[ -]?(?:liste|list)|aufgabenliste|checkliste|checklist|liste|list)\b/iu.test(text)) }));
    const intro = speech.match(/^((?:(?:meine|unsere|die|my|our|the)\s+)?(?:to[ -]?do[ -]?(?:liste|list)|aufgabenliste|checkliste|checklist|liste|list)(?:\s+(?:für|for)\s+[^,.:;\n]{1,60})?(?:\s+(?:ist|lautet|is))?)[,.:;]/iu);
    const colon = speech.indexOf(':');
    const heading = intro ? text.slice(0, intro[1]!.length) : colon >= 0 ? text.slice(0, colon) : '';
    let body = intro ? text.slice(intro[0].length).trim() : colon >= 0 ? text.slice(colon + 1).trim() : text;
    if (canceledItem(body)) {
        const additions = [...spokenOnly(body).matchAll(/\b(?:außerdem(?:\s+noch)?|und\s+(?:ja\s+)?auch)\b/giu)];
        const start = additions.at(-1)?.index;
        if (start !== undefined) body = trimItem(body.slice(0, start));
    }
    const bodySpeech = spokenOnly(body);
    // Split explicit list data, not commas in a quote or a decimal number.
    const possible = [...bodySpeech.matchAll(/[,;](?!\d)|[.!?]\s+(?=\p{Lu})|\s+und\s+|\s+and\s+/giu)];
    const separators = possible.filter((match, index) => {
        const left = body.slice(possible[index - 1] ? possible[index - 1]!.index! + possible[index - 1]![0].length : 0, match.index);
        const right = body.slice(match.index! + match[0].length, possible[index + 1]?.index ?? body.length);
        // Conditions and qualifications belong to their action. Making
        // "delete the file, but only after approval" two independently checked
        // tasks would detach the restriction from the destructive action.
        if (/^[,;]/.test(match[0])) return !/^(?:wenn|weil|damit|falls|ob|aber|jedoch|sondern|außer|sofern|solange|nur|erst|if|when|because|while|but|unless|except|until|provided|only)\b/iu.test(right.trimStart());
        if (/^[.!?]/.test(match[0])) return tasks && hasTaskAction(left) && hasTaskAction(right);
        // "Buy bread and butter" is one task; "buy bread and call Sam" is two.
        return !tasks || !hasTaskAction(body) || (hasTaskAction(left) && hasTaskAction(right));
    });
    if (separators.length) {
        let start = 0;
        const items = separators.map(match => { const item = body.slice(start, match.index); start = match.index! + match[0].length; return item.trim(); });
        items.push(body.slice(start).trim());
        // Keep a dangling verbal ending with its last item for tail cleanup.
        const tails: string[] = [];
        while (items.length > 1 && /^(?:(?:und|and)\s+)?(?:ähm?|eh|ehm?|ja|naja|na ja|yeah|um|uh)[\s,.!?…]*(?:(?:ja|naja|na ja|yeah)[\s,.!?…]*)*$/iu.test(items.at(-1)!)) tails.unshift(items.pop()!);
        if (tails.length) items[items.length - 1] += ', und ' + tails.join(', ');
        if (items.length > 1) {
            const request = /\b(?:schreib|erstelle|mache|formatiere|write|create|make|format)\b/iu.test(heading);
            return [...(heading && !request ? [{ text: heading + ':', heading: true }] : []), ...items.filter(Boolean).map(text => ({ text, item: true }))];
        }
    }
    const request = /\b(?:schreib|erstelle|mache|formatiere|write|create|make|format)\b/iu.test(heading);
    return [...(heading && !request ? [{ text: heading + ':', heading: true }] : []), ...(body ? [{ text: body, item: true }] : [])];
}

type ListRegion = { start: number; end: number; blocks: DictationBlock[] };
const listHeading = /(?:(?:meine|unsere|die|my|our|the)\s+)?(?:to[ -]?do[ -]?(?:liste|list)|aufgabenliste|checkliste|checklist|task list|packliste|packing list|einkaufsliste|shopping list|liste|list|aufgaben für (?:heute|morgen)|tasks for (?:today|tomorrow))(?:\s+(?:für|for)\s+[^,.:;\n]{1,60})?(?:\s+(?:ist|lautet|is))?[,.:;]/giu;
const taskHeading = /to[ -]?do|aufgaben|checklist|checkliste|tasks?/iu;
const listClosing = /(?<!\p{L})(?:(?:ja|genau|okay|ok|und|so|and)[,\s]+)*(?:das war['’]?s|das ist alles|ende der liste|that['’]?s all|end of (?:the )?list)(?!\p{L})[,.!;:]?\s*/giu;

// A list ends at an explicit closing or a return to narration. An action such
// as "Danach das Paket abholen" still belongs to the list.
function listEnd(body: string): { end: number; resume: number } {
    const trimmed = cleanListEnding(body), speech = spokenOnly(body).slice(0, trimmed.length);
    const closing = [...speech.matchAll(listClosing)].find(match => !speech.slice(0, match.index).trim() || /[.!?,;]\s*$/u.test(speech.slice(0, match.index)));
    let end = closing?.index ?? trimmed.length, resume = closing ? closing.index! + closing[0].length : body.length;
    for (const boundary of speech.matchAll(/[.!?]\s+|\n\s*\n/gu)) {
        const start = boundary.index! + boundary[0].length;
        if (start >= end) break;
        const sentence = speech.slice(start).split(/(?<=[.!?])\s+|\n\s*\n/u)[0]!.trim();
        if (/^(?:(?:und|and)\s+)?(?:ich|wir|du|i|we|you)\s+/iu.test(sentence) && !/^(?:ich (?:brauche|muss)|i (?:need|have to))\b/iu.test(sentence) ||
            /^(?:danach|anschließend|nachdem|außerdem|übrigens|im anschluss|after that|afterwards|then|once|by the way)\b/iu.test(sentence) &&
            (!hasTaskAction(sentence) || /(?<!\p{L})(?:ich|wir|du|i|we|you)(?!\p{L})/iu.test(sentence))) {
            end = boundary.index! + (/^[.!?]/u.test(boundary[0]) ? 1 : 0); resume = start; break;
        }
    }
    return { end, resume };
}

function proseBlocks(text: string): DictationBlock[] {
    return text.split(/\n\s*\n/u).map(text => ({ text: text.trim() })).filter(block => block.text);
}

/** Preserve ordered prose/list/prose sections instead of assigning one layout
 * to the entire dictation. The fallback is reserved for explicit List mode or
 * an enumeration without a nominal heading. */
export function dictationBlocks(paragraphs: string[], fallback: 'prose' | 'list' | 'tasks' = 'prose'): DictationBlock[] {
    const text = paragraphs.join('\n\n'), speech = spokenOnly(text), regions: ListRegion[] = [];
    for (const heading of speech.matchAll(listHeading)) {
        const before = speech.slice(0, heading.index);
        const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1;
        const lead = before.slice(boundary).trim();
        if (lead && !/^(?:schreib(?:e)?|erstelle?|mache?|formatiere?|write|create|make|format)\b/iu.test(lead)) continue;
        const start = lead ? boundary + before.slice(boundary).search(/\S/u) : heading.index!;
        const bodyStart = heading.index! + heading[0].length;
        const next = [...speech.slice(bodyStart).matchAll(listHeading)][0]?.index;
        const limit = next === undefined ? text.length : bodyStart + next;
        const body = text.slice(bodyStart, limit), end = listEnd(body);
        const source = text.slice(start, bodyStart + end.end);
        const tasks = taskHeading.test(heading[0]);
        const blocks = listBlocks(source, speechParagraphs(source), tasks).map(block => ({ ...block, tasks }));
        if (blocks.some(block => block.item)) regions.push({ start, end: bodyStart + end.resume, blocks });
    }
    // An implicit packing list needs both a nearby packing context and repeated
    // item clauses. A lone "I need ..." in ordinary prose is never a list.
    const clause = /(?<!\p{L})(?:(?:also|und|so|and)\s+)?(?:ich (?:brauche|muss)|i (?:need(?:\s+to)?|have to))\s+/giu;
    const markers = [...speech.matchAll(clause)].filter(match => !speech.slice(0, match.index).trim() || /[,;:.!?]\s*$|\s+(?:und|and)\s*$/iu.test(speech.slice(0, match.index)));
    for (let index = 0; index < markers.length; index++) {
        const first = markers[index]!, start = first.index!;
        if (regions.some(region => start >= region.start && start < region.end)) continue;
        if (!/\b(?:einpacken|mitnehmen|packliste|einkaufen|besorgen|packing|to pack|to bring|shopping)\b/iu.test(speech.slice(Math.max(0, start - 350), start))) continue;
        const items: DictationBlock[] = [];
        let end = start, resume = start;
        for (let itemIndex = index; itemIndex < markers.length; itemIndex++) {
            const marker = markers[itemIndex]!, bodyStart = marker.index! + marker[0].length;
            const next = markers[itemIndex + 1]?.index ?? text.length;
            const body = text.slice(bodyStart, next);
            const boundary = listEnd(body);
            const sentenceEnd = [...spokenOnly(body).matchAll(/[.!?](?:\s+|$)|\n\s*\n/gu)][0];
            const cut = Math.min(boundary.end, sentenceEnd ? sentenceEnd.index! + (/^[.!?]/u.test(sentenceEnd[0]) ? 1 : 0) : body.length);
            const item = trimItem(body.slice(0, cut));
            if (!item) break;
            items.push({ text: item, item: true });
            end = bodyStart + cut;
            resume = !speech.slice(bodyStart + cut, bodyStart + boundary.end).trim() ? bodyStart + boundary.resume : end;
            if (speech.slice(end, next).trim() || boundary.resume < body.length) break;
        }
        if (items.length >= 2) {
            regions.push({ start, end: resume, blocks: items });
            while (markers[index + 1] && markers[index + 1]!.index! < end) index++;
        }
    }
    if (!regions.length) {
        if (fallback === 'prose') return proseBlocks(text);
        const end = listEnd(text), source = text.slice(0, end.end);
        return [...listBlocks(source, speechParagraphs(source), fallback === 'tasks').map(block => ({ ...block, tasks: fallback === 'tasks' })), ...proseBlocks(text.slice(end.resume))];
    }
    const blocks: DictationBlock[] = [];
    let cursor = 0;
    for (const region of regions.sort((a, b) => a.start - b.start)) {
        if (region.start < cursor) continue;
        blocks.push(...proseBlocks(text.slice(cursor, region.start)), ...region.blocks);
        cursor = region.end;
    }
    return [...blocks, ...proseBlocks(text.slice(cursor))];
}

export function renderDictationBlocks(blocks: DictationBlock[]): string {
    return blocks.filter(block => block.text.trim()).map((block, index, present) => {
        const separator = !index ? '' : block.item && (present[index - 1]!.item || present[index - 1]!.heading) ? '\n' : '\n\n';
        const text = block.item ? (block.tasks ? '- [ ] ' : '- ') + block.text.replace(/\n+/gu, ' ') : block.heading ? block.text : layoutProse(block.text);
        return separator + text;
    }).join('');
}

export function layoutEmail(text: string): string {
    const paragraphs = speechParagraphs(text);
    if (!paragraphs.length) return text;
    paragraphs[0] = paragraphs[0]!.replace(/^(\s*(?:Hallo|Guten (?:Tag|Morgen|Abend)|Sehr geehrte[rn]?|Hello|Hi|Dear|Bonjour|Cher|Chère|Estimado|Estimada|Уважаемый|Уважаемая)\s+[^,\n]+,)\s+(?=\S)/iu, '$1\n\n');
    const last = paragraphs.length - 1;
    paragraphs[last] = paragraphs[last]!.replace(/(?<!\p{L})((?:Vielen Dank und )?(?:viele|freundliche|beste|herzliche|mit freundlichen) Grüßen?|(?:Thanks and )?(?:best|kind) regards|Sincerely|Cordialement|Saludos|С уважением),\s+([^\n]+)$/iu,
        (_match, closing: string, sender: string) => closing[0]!.toUpperCase() + closing.slice(1) + '\n' + sender);
    paragraphs[last] = paragraphs[last]!.replace(/(Vielen Dank|Thank you|Thanks),\s+(?=(?:Mit freundlichen|Best|Kind)\b)/iu, '$1,\n\n');
    return paragraphs.join('\n\n');
}

export function layoutProse(text: string): string {
    return speechParagraphs(text).flatMap(paragraph => {
        if (paragraph.length < 350) return [paragraph];
        const speech = spokenOnly(paragraph);
        const boundaries = [...speech.matchAll(/(?<=[.!?])\s+(?=(?:Und genau,? was ich noch sagen wollte|Außerdem möchte ich|Ein weiteres Thema|One more thing|On another topic|Par ailleurs|Otro tema)\b)/giu)];
        const cuts = boundaries.map(match => match.index!).filter(index => index >= 160 && paragraph.length - index >= 100);
        if (!cuts.length && paragraph.length > 1000) {
            let start = 0;
            for (const match of speech.matchAll(/[.!?。！？](?:\s+|(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]))/gu)) {
                const end = match.index! + 1;
                if (end - start >= 600 && paragraph.length - end >= 160) { cuts.push(end); start = end; }
            }
        }
        let start = 0;
        return [...cuts, paragraph.length].map(end => { const part = paragraph.slice(start, end).trim(); start = end; return part; }).filter(Boolean);
    }).join('\n\n');
}

export function preserveAnswerPrefixes(source: string, text: string): string {
    for (const answer of spokenOnly(source).matchAll(/(?:^|[.!?]\s+)(Ja|Nein|Yes|No|Oui|Non|Sí|Да|Нет),\s+(\p{L}+)/giu)) {
        const word = answer[2]!;
        if (new RegExp('(?:^|[.!?]\\s+)' + answer[1] + ',\\s+' + word + '(?!\\p{L})', 'iu').test(text)) continue;
        const boundary = new RegExp('(^|[.!?]\\s+)(' + word + ')(?!\\p{L})', 'iu');
        text = text.replace(boundary, (_match, before: string) => before + answer[1] + ', ' + word);
    }
    return text;
}
