import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import style from './style.js';
import { cleanText } from '../types.js';
import { onShutdown } from '../lifecycle.js';
import { renderMarkdown, wrapText } from './markdown.js';
import { name, version, mark } from '../brand.js';
import renderList from './render-list.js';

export type Choice = { value: string; name: string; hint?: string; toggle?: boolean; state?: string;
    action?: boolean; group?: string; section?: string; unavailable?: string; requires?: string };
type SelectionOptions = {
    detail?: string | (() => string);
    before?: () => string[];
    back?: boolean;
    footer?: string;
    shortcuts?: Record<string, string>;
    complete?: () => string | undefined;
    initialValue?: string;
    activateWithSpace?: boolean;
};

export function fit(text: string, width: number): string {
    if (width <= 0) return '';
    if (stringWidth(text) <= width) return text;
    let end = Math.max(0, width - 1);
    let result = sliceAnsi(text, 0, end);
    while (stringWidth(result) > width - 1 && end > 0) result = sliceAnsi(text, 0, --end);
    return result + '…';
}

export function editorLayout(letters: string[], width: number) {
    const rows = ['']; const starts = [0]; const positions: { row: number; column: number }[] = [];
    let column = 0;
    for (let index = 0; index <= letters.length; index++) {
        const letter = letters[index];
        if (letter !== undefined && letter !== '\n' && column + stringWidth(letter) > width) { rows.push(''); starts.push(index); column = 0; }
        positions.push({ row: rows.length - 1, column });
        if (letter === undefined) break;
        if (letter === '\n') { rows.push(''); starts.push(index + 1); column = 0; }
        else { rows[rows.length - 1] += letter; column += stringWidth(letter); }
    }
    return { rows, starts, positions };
}

export class Screen {
    quitRequested = false;
    taskActive = false;
    recordingActive = false;
    editingActive = false;
    dictation?: import('../dictation.js').DictationService;
    bridge?: import('../meeting-bridge.js').MeetingBridge;
    private keyHandler?: (text: string, key: Key) => void;
    private redraw?: () => void;
    private previous = '';
    private unregister = () => {};
    private closed = false;
    private timer: NodeJS.Timeout;
    private onKey = (text: string, key: Key) => this.keyHandler?.(text, key || {});
    private onResize = () => { this.previous = ''; this.redraw?.(); };
    constructor() {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The UI requires an interactive terminal. Alternatively: sylloom record --headless.");
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('keypress', this.onKey);
        process.stdout.on('resize', this.onResize);
        process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
        this.unregister = onShutdown(() => this.close());
        this.timer = setInterval(() => this.redraw?.(), 200);
    }

    get width(): number { return Math.max(1, (process.stdout.columns || 80) - 4); }
    get capacity(): number { return Math.max(1, (process.stdout.rows || 24) - (this.fullHeader ? 13 : 9)); }
    private get fullHeader(): boolean { return (process.stdout.rows || 24) >= 28 && (process.stdout.columns || 80) >= 40; }

    frame(title: string, detail: string, content: string[], footer = "↑/↓ Move · Enter Select · Esc Back", hint = "Ctrl+C Quit · F2 Settings"): void {
        const width = this.width;
        const rows = process.stdout.rows || 24;
        if (width < 32 || rows < 16) {
            this.paint(['  ' + fit("Resize terminal to at least 36 × 16.", width)], rows);
            return;
        }
        const lines: string[] = [];
        if (this.fullHeader) {
            lines.push('');
            mark.forEach((line, index) => lines.push('  ' + style(line, 'logo') + (index === 1 ? '   ' + style(name, 'logo') : index === 2 ? '   ' + style(version, 'muted') : '')));
        } else lines.push('  ' + style(name, 'logo'));
        lines.push('  ' + style(fit(cleanText(title), width), 'strong'));
        lines.push('  ' + style(fit(cleanText(detail), width), 'muted'));
        lines.push('  ' + style('─'.repeat(width), 'divider'), '');
        const available = Math.max(0, rows - lines.length - 4);
        for (const line of content.slice(0, available)) lines.push('  ' + fit(line.replace(/[\r\n]/g, ' '), width));
        while (lines.length < rows - 4) lines.push('');
        lines.push('  ' + style(fit(footer, width), 'muted'));
        const status = this.taskActive ? "Ctrl+C Cancel · Dictation available after processing"
            : this.recordingActive ? hint : this.dictation?.status || hint;
        lines.push('  ' + style(fit(status, width), this.dictation?.state === 'recording' ? 'accent' : 'muted'));
        this.paint(lines, rows);
    }

    private paint(lines: string[], rows: number): void {
        while (lines.length < rows - 1) lines.push('');
        const value = lines.slice(0, rows - 1).map(line => line + '\x1b[K').join('\r\n');
        if (value !== this.previous) { process.stdout.write('\x1b[H' + value + '\x1b[J'); this.previous = value; }
    }

    select(title: string, choices: Choice[] | (() => Choice[]), options: SelectionOptions = {}): Promise<string> {
        if (this.quitRequested) return Promise.resolve('quit');
        return new Promise(resolve => {
            const initial = typeof choices === 'function' ? choices() : choices;
            let selected = Math.max(0, initial.findIndex(row => row.value === options.initialValue));
            let current: Choice[] = [];
            const done = (value: string) => { this.keyHandler = undefined; this.redraw = undefined; resolve(value); };
            this.redraw = () => {
                const complete = options.complete?.();
                if (complete) { done(complete); return; }
                current = typeof choices === 'function' ? choices() : choices;
                selected = Math.max(0, Math.min(selected, current.length - 1));
                const before = options.before?.() || [];
                const choice = current[selected];
                const blocked = choice?.requires ? current.find(row => row.value === choice.requires) : undefined;
                const hint = choice?.unavailable || (choice?.requires && !blocked?.toggle ? 'Enable ' + (blocked?.name.toLowerCase() || choice.requires) + ' first.' : choice?.hint || '');
                const actions = current.filter(row => row.action || ['save', 'back'].includes(row.value));
                const rows = current.filter(row => !actions.includes(row));
                const values = rows.some(row => row.toggle !== undefined || row.state !== undefined || row.unavailable);
                const output = renderList({ rows: rows.map(row => ({ value: row.value,
                    cells: [row.name, row.unavailable ? 'Unavailable' : row.state ?? (row.toggle === undefined ? '' : row.toggle ? 'On' : 'Off')], group: row.group, section: row.section })),
                    columns: values ? [{ title: '' }, { title: '', width: Math.min(20, Math.max(12, Math.floor(this.width / 4))) }] : undefined,
                    actions, selected: choice?.value || '', width: this.width, height: this.capacity - before.length, detail: hint });
                const lines = [...before, ...output.trimEnd().split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line)];
                const detail = typeof options.detail === 'function' ? options.detail() : options.detail || '';
                this.frame(title, detail, lines, options.footer);
            };
            this.keyHandler = (text, key) => {
                if (key.ctrl && key.name === 'c') { this.quitRequested = true; done('quit'); return; }
                if (key.name === 'escape' && options.back) { done('back'); return; }
                if (this.width < 32 || (process.stdout.rows || 24) < 16) return;
                if (key.name === 'f2') { done('settings'); return; }
                if (key.name === 'up' || (key.ctrl && key.name === 'p')) selected = (selected - 1 + current.length) % Math.max(1, current.length);
                else if (key.name === 'down' || (key.ctrl && key.name === 'n')) selected = (selected + 1) % Math.max(1, current.length);
                else if ((key.name === 'return' || key.name === 'enter' || options.activateWithSpace && (text === ' ' || key.name === 'space') || current[selected]?.toggle !== undefined && (text === ' ' || key.name === 'space' || key.name === 'left' || key.name === 'right')) && current[selected]) {
                    const row = current[selected]!;
                    if (row.unavailable || row.requires && !current.find(required => required.value === row.requires)?.toggle) { this.redraw?.(); return; }
                    if (row.toggle !== undefined && (key.name === 'left' && !row.toggle || key.name === 'right' && row.toggle)) return;
                    done(row.value); return;
                }
                else if (options.shortcuts?.[key.name || ''] || (text && options.shortcuts?.[text])) { done((options.shortcuts[key.name || ''] || options.shortcuts[text])!); return; }
                this.redraw?.();
            };
            this.redraw();
        });
    }

    input(title: string, detail: string, initial = '', options: { secret?: boolean; multiline?: boolean } = {}): Promise<string | null> {
        return new Promise(resolve => {
            const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            let letters = [...segmenter.segment(initial)].map(item => item.segment);
            let cursor = letters.length;
            let pasting = false, pasted = '', previousCR = false;
            let verticalColumn: number | undefined;
            if (options.multiline) this.editingActive = true;
            const done = (value: string | null) => { this.editingActive = false; this.redraw = undefined; this.keyHandler = undefined; resolve(value); };
            const insert = (text: string) => {
                const value = options.multiline ? cleanText(text.replace(/\r\n?/g, '\n')) : cleanText(text).replace(/\s+/g, ' ');
                const prefix = letters.slice(0, cursor).join('');
                const parts = [...segmenter.segment(prefix + value + letters.slice(cursor).join(''))];
                cursor = parts.filter(part => part.index < prefix.length + value.length).length;
                letters = parts.map(part => part.segment); verticalColumn = undefined;
            };
            this.redraw = () => {
                if (options.multiline) {
                    const { rows, starts, positions } = editorLayout(letters, Math.max(1, this.width - 3));
                    const position = positions[cursor]!;
                    const left = letters.slice(starts[position.row], cursor).join('');
                    rows[position.row] = left + style('│', 'accent') + rows[position.row]!.slice(left.length);
                    const start = Math.max(0, position.row - this.capacity + 2);
                    this.frame(title, detail, rows.slice(start, start + this.capacity - 1), 'Ctrl+S Save · Enter New line · Esc Cancel · Arrows Move', 'Dictation paused while editing · Ctrl+C Quit without saving');
                    return;
                }
                let left = options.secret ? '•'.repeat(cursor) : letters.slice(0, cursor).join('');
                const right = options.secret ? '•'.repeat(letters.length - cursor) : letters.slice(cursor).join('');
                while (stringWidth(left) > this.width - 5) left = [...segmenter.segment(left)].slice(1).map(item => item.segment).join('');
                this.frame(title, detail, [style('› ', 'accent') + left + style('│', 'accent') + right], "Enter Save · Esc Cancel · ←/→ Cursor", "Ctrl+C Leave pending and quit");
            };
            this.keyHandler = (text, key) => {
                if (key.name === 'paste-start') { pasting = true; pasted = ''; return; }
                if (key.name === 'paste-end') { pasting = false; insert(pasted); pasted = ''; this.redraw?.(); return; }
                if (pasting) { pasted += text || key.sequence || ''; return; }
                if (key.ctrl && key.name === 'c') { this.quitRequested = true; done(null); return; }
                if (key.name === 'escape') { done(null); return; }
                if (options.multiline && key.ctrl && key.name === 's') { done(letters.join('')); return; }
                const wasCR = previousCR; previousCR = key.name === 'return';
                if (key.name === 'return' || key.name === 'enter') {
                    if (options.multiline && key.name === 'enter' && wasCR) return;
                    if (!options.multiline) { done(letters.join('')); return; }
                    insert('\n'); this.redraw?.(); return;
                }
                if (options.multiline && (key.name === 'up' || key.name === 'down')) {
                    const { positions, rows } = editorLayout(letters, Math.max(1, this.width - 3));
                    const position = positions[cursor]!; verticalColumn ??= position.column;
                    const row = Math.max(0, Math.min(rows.length - 1, position.row + (key.name === 'up' ? -1 : 1)));
                    const choices = positions.map((point, index) => ({ ...point, index })).filter(point => point.row === row);
                    cursor = choices.reduce((best, point) => Math.abs(point.column - verticalColumn!) < Math.abs(best.column - verticalColumn!) ? point : best).index;
                    this.redraw?.(); return;
                }
                verticalColumn = undefined;
                if (options.multiline && (key.name === 'home' || key.name === 'end')) {
                    const { positions, starts } = editorLayout(letters, Math.max(1, this.width - 3));
                    const row = positions[cursor]!.row;
                    const end = starts[row + 1] ?? letters.length;
                    cursor = key.name === 'home' ? starts[row]! : end > 0 && letters[end - 1] === '\n' ? end - 1 : end;
                    this.redraw?.(); return;
                }
                if (key.name === 'left') cursor = Math.max(0, cursor - 1);
                else if (key.name === 'right') cursor = Math.min(letters.length, cursor + 1);
                else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
                else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = letters.length;
                else if (key.name === 'backspace' && cursor) { letters.splice(--cursor, 1); }
                else if (key.name === 'delete') letters.splice(cursor, 1);
                else if (!key.ctrl && !key.meta && text && !/^[\x00-\x1f\x7f]/.test(text)) {
                    insert(text);
                }
                this.redraw?.();
            };
            this.redraw();
        });
    }

    async task<T>(title: string, work: (update: (text: string) => void, signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.dictation?.busy) throw new Error("Stop or cancel dictation first.");
        this.taskActive = true;
        let detail = "Working…";
        let dots = 0;
        const controller = new AbortController();
        this.keyHandler = (_text, key) => {
            if (key.ctrl && key.name === 'c') {
                this.quitRequested = true;
                controller.abort();
                detail = "Cancel requested. Closing active resources…";
                this.redraw?.();
            }
        };
        this.redraw = () => this.frame(title, detail, [style('  ' + ['·  ', '·· ', '···'][dots++ % 3], 'accent')], "Please wait", "Waiting for the current operation.");
        this.redraw();
        try {
            await this.dictation?.releaseModels();
            controller.signal.throwIfAborted();
            const result = await work(text => { detail = text; this.redraw?.(); }, controller.signal);
            controller.signal.throwIfAborted();
            return result;
        } finally { this.taskActive = false; this.redraw = undefined; this.keyHandler = undefined; }
    }

    async notice(title: string, message: string): Promise<void> {
        await this.select(title, [{ value: 'back', name: "Back" }], { back: true, before: () => wrapText(cleanText(message), this.width) });
    }

    browse(title: string, items: (query: string) => Choice[], options: { detail: () => string; shortcut?: (key: Key) => boolean | string; search?: { query: string } }): Promise<string | undefined> {
        let query = options.search?.query || ''; let selected = 0; let choices: Choice[] = [];
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return new Promise(resolve => {
            const done = (value?: string) => { if (options.search) options.search.query = query; this.redraw = undefined; this.keyHandler = undefined; resolve(value); };
            this.redraw = () => {
                const selectedValue = choices[selected]?.value;
                choices = items(query);
                const index = choices.findIndex(choice => choice.value === selectedValue);
                selected = index >= 0 ? index : Math.max(0, Math.min(selected, choices.length - 1));
                const capacity = Math.max(1, this.capacity - 4);
                const start = Math.max(0, Math.min(selected - capacity + 1, choices.length - capacity));
                const lines = [style('Search  ', 'muted') + fit(query || 'Type to search…', this.width - 8), ''];
                if (!choices.length) lines.push(style('No matches. Clear the search or change filters.', 'muted'));
                for (let index = start; index < Math.min(choices.length, start + capacity); index++) {
                    lines.push(style((index === selected ? '› ' : '  ') + choices[index]!.name, index === selected ? 'accent' : 'strong'));
                }
                lines.push('', style(choices[selected]?.hint || '', 'muted'));
                this.frame(title, options.detail() + ' · ' + choices.length + ' results', lines,
                    'Tab Type · Ctrl+P Pinned · Ctrl+S Sort · Ctrl+F Filters', 'Enter Open · Ctrl+U Clear · Ctrl+R Refresh · Esc Back');
            };
            this.keyHandler = (text, key) => {
                if (key.ctrl && key.name === 'c') { this.quitRequested = true; done(); return; }
                if (key.name === 'escape') { done(); return; }
                if (key.name === 'return' && choices[selected]) { done(choices[selected]!.value); return; }
                if (key.name === 'up' || key.name === 'down') selected = (selected + (key.name === 'up' ? -1 : 1) + choices.length) % Math.max(1, choices.length);
                else {
                    const action = options.shortcut?.(key);
                    if (typeof action === 'string') { done(action); return; }
                    if (action) { selected = 0; choices = []; this.redraw?.(); return; }
                    if (key.ctrl && key.name === 'u') { query = ''; selected = 0; choices = []; }
                    else if (key.name === 'backspace') { query = [...segmenter.segment(query)].slice(0, -1).map(part => part.segment).join(''); selected = 0; choices = []; }
                    else if (!key.ctrl && !key.meta && text && !/^[\x00-\x1f\x7f]/.test(text)) { query = (query + cleanText(text).replace(/\s+/g, ' ')).slice(0, 300); selected = 0; choices = []; }
                }
                this.redraw?.();
            };
            this.redraw();
        });
    }

    page(title: string, render: (width: number) => string[], options: { footer?: string; actions?: Record<string, string> } = {}): Promise<string | undefined> {
        let offset = 0;
        return new Promise(resolve => {
            const done = (value?: string) => { this.keyHandler = undefined; this.redraw = undefined; resolve(value); };
            this.redraw = () => {
                const lines = render(this.width); const capacity = this.capacity;
                offset = Math.max(0, Math.min(offset, lines.length - capacity));
                this.frame(title, 'Line ' + (offset + 1) + ' of ' + lines.length, lines.slice(offset, offset + capacity),
                    options.footer || '↑/↓ Scroll · PgUp/PgDn Page · Home/End', 'Enter or Esc Back · Ctrl+C Quit');
            };
            this.keyHandler = (_text, key) => {
                if (key.ctrl && key.name === 'c') { this.quitRequested = true; done(); return; }
                if (key.name === 'escape' || key.name === 'return') { done(); return; }
                if (options.actions?.[key.name || '']) { done(options.actions[key.name!]!); return; }
                if (key.name === 'up' || key.name === 'pageup') offset -= key.name === 'pageup' ? this.capacity : 1;
                if (key.name === 'down' || key.name === 'pagedown') offset += key.name === 'pagedown' ? this.capacity : 1;
                if (key.name === 'home') offset = 0;
                if (key.name === 'end') offset = Number.MAX_SAFE_INTEGER;
                this.redraw?.();
            };
            this.redraw();
        });
    }

    async view(title: string, text: () => string, options: { markdown?: boolean } = { markdown: true }): Promise<void> {
        let offset = 0;
        let previousText = '';
        let previousWidth = 0;
        let lines: string[] = [];
        await new Promise<void>(resolve => {
            const done = () => { this.keyHandler = undefined; this.redraw = undefined; resolve(); };
            this.redraw = () => {
                const value = text();
                if (value !== previousText || this.width !== previousWidth) {
                    previousText = value; previousWidth = this.width;
                    lines = options.markdown ? renderMarkdown(value, this.width) : wrapText(cleanText(value), this.width);
                }
                const capacity = this.capacity;
                offset = Math.max(0, Math.min(offset, lines.length - capacity));
                this.frame(title, "Line " + (offset + 1) + " of " + lines.length, lines.slice(offset, offset + capacity), "↑/↓ Scroll · PgUp/PgDn Page · Home/End", "Enter or Esc Back · Ctrl+C Quit");
            };
            this.keyHandler = (_text, key) => {
                if (key.ctrl && key.name === 'c') { this.quitRequested = true; done(); return; }
                if (key.name === 'escape' || key.name === 'return') { done(); return; }
                if (key.name === 'up' || key.name === 'pageup') offset -= key.name === 'pageup' ? this.capacity : 1;
                if (key.name === 'down' || key.name === 'pagedown') offset += key.name === 'pagedown' ? this.capacity : 1;
                if (key.name === 'end') offset = Math.max(0, lines.length - this.capacity);
                if (key.name === 'home') offset = 0;
                this.redraw?.();
            };
            this.redraw();
        });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.unregister();
        clearInterval(this.timer);
        process.stdin.off('keypress', this.onKey);
        process.stdout.off('resize', this.onResize);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
    }
}
