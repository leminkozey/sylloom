import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import style from './style.js';
import { cleanText } from '../types.js';

function unescape(value: string): string {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return cleanText(value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name: string) => {
        if (!name.startsWith('#')) return named[name.toLowerCase()] || match;
        const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }));
}

function inline(tokens: Token[] = []): string {
    let output = '';
    for (const token of tokens) {
        switch (token.type) {
            case 'strong': output += style(inline(token.tokens), 'strong'); break;
            case 'em': output += style(inline(token.tokens), 'emphasis'); break;
            case 'del': output += style(inline(token.tokens), 'muted'); break;
            case 'codespan': output += style(unescape(token.text), 'accent'); break;
            case 'link': {
                const label = inline(token.tokens);
                output += style(label, 'accent');
                if (cleanText(label) !== token.href) output += style(' (' + cleanText(token.href) + ')', 'muted');
                break;
            }
            case 'image': output += unescape(token.text); break;
            case 'br': output += '\n'; break;
            case 'html': break;
            default:
                if ('tokens' in token && token.tokens) output += inline(token.tokens);
                else if ('text' in token) output += unescape(token.text || '');
        }
    }
    return output;
}

export function wrapText(text: string, width: number): string[] {
    width = Math.max(2, width);
    const result: string[] = [];
    for (const line of text.split('\n')) {
        const length = stringWidth(line);
        if (!length) { result.push(''); continue; }
        let start = 0;
        while (start < length) {
            let end = Math.min(length, start + width);
            let part = sliceAnsi(line, start, end);
            while (stringWidth(part) > width && end > start + 1) part = sliceAnsi(line, start, --end);
            if (end < length) {
                const space = cleanText(part).lastIndexOf(' ');
                const before = cleanText(part).slice(0, space);
                if (space > 0 && stringWidth(before) >= width / 3) {
                    end = start + stringWidth(before);
                    part = sliceAnsi(line, start, end);
                }
            }
            result.push(part);
            start = end;
            while (start < length && sliceAnsi(line, start, start + 1) === ' ') start++;
        }
    }
    return result;
}

function table(token: Tokens.Table, width: number): string[] {
    const rows = [token.header, ...token.rows].map(row => row.map(cell => inline(cell.tokens)));
    const count = token.header.length;
    if (!count) return [];
    const available = width - (count - 1) * 3;
    if (available < count * 8) {
        const lines: string[] = [];
        for (const row of rows.slice(1)) {
            row.forEach((cell, index) => lines.push(...wrapText(style(cleanText(rows[0]![index] || '') + ': ', 'strong') + cell, width)));
            lines.push('');
        }
        return lines;
    }
    const sizes = token.header.map((_cell, index) => Math.max(8, ...rows.map(row => stringWidth(row[index] || ''))));
    while (sizes.reduce((sum, size) => sum + size, 0) > available) {
        const widest = sizes.indexOf(Math.max(...sizes));
        sizes[widest]!--;
    }
    const lines: string[] = [];
    rows.forEach((row, rowIndex) => {
        const cells = row.map((cell, index) => wrapText(cell, sizes[index]!));
        const height = Math.max(...cells.map(cell => cell.length));
        for (let index = 0; index < height; index++) {
            lines.push(cells.map((cell, column) => {
                const text = cell[index] || '';
                const padding = Math.max(0, sizes[column]! - stringWidth(text));
                const align = token.align[column];
                const left = align === 'right' ? padding : align === 'center' ? Math.floor(padding / 2) : 0;
                return ' '.repeat(left) + (rowIndex === 0 ? style(text, 'strong') : text) + ' '.repeat(padding - left);
            }).join(style(' │ ', 'divider')));
        }
        if (rowIndex === 0) lines.push(style(sizes.map(size => '─'.repeat(size)).join('─┼─'), 'divider'));
    });
    return lines;
}

function blocks(tokens: Token[] = [], width: number, compact = false): string[] {
    const lines: string[] = [];
    for (const token of tokens) {
        switch (token.type) {
            case 'heading': {
                const heading = inline(token.tokens);
                if (lines.length && lines.at(-1) !== '') lines.push('');
                lines.push(...wrapText(style(heading, token.depth <= 2 ? 'accent' : 'strong'), width));
                if (token.depth === 1) lines.push(style('━'.repeat(Math.min(width, stringWidth(heading))), 'divider'));
                lines.push('');
                break;
            }
            case 'paragraph': case 'text':
                lines.push(...wrapText(token.tokens ? inline(token.tokens) : unescape(token.text), width));
                if (token.type === 'paragraph' || !compact) lines.push('');
                break;
            case 'list':
                token.items.forEach((item: Tokens.ListItem, index: number) => {
                    const marker = item.task ? (item.checked ? '☑ ' : '☐ ') : token.ordered ? String(Number(token.start) + index) + '. ' : '• ';
                    const indent = ' '.repeat(stringWidth(marker));
                    const content = blocks(item.tokens, Math.max(2, width - stringWidth(marker)), !item.loose);
                    while (content.at(-1) === '') content.pop();
                    content.forEach((line, lineIndex) => lines.push((lineIndex === 0 ? style(marker, 'accent') : indent) + line));
                });
                lines.push('');
                break;
            case 'blockquote':
                lines.push(...blocks(token.tokens, Math.max(2, width - 2)).map(line => style('│ ', 'divider') + line), '');
                break;
            case 'code':
                if (token.lang) lines.push(style(token.lang, 'muted'));
                lines.push(...wrapText(cleanText(token.text), Math.max(2, width - 2)).map(line => '  ' + line), '');
                break;
            case 'table': lines.push(...table(token as Tokens.Table, width), ''); break;
            case 'hr': lines.push(style('─'.repeat(width), 'divider'), ''); break;
            case 'space': if (lines.length && lines.at(-1) !== '') lines.push(''); break;
            case 'html': break;
            default: if ('text' in token && token.text) lines.push(...wrapText(unescape(token.text), width));
        }
    }
    return lines;
}

export function renderMarkdown(markdown: string, width = 80): string[] {
    const lines = blocks(Lexer.lex(cleanText(markdown), { gfm: true }), Math.max(8, width));
    while (lines.at(-1) === '') lines.pop();
    return lines;
}
