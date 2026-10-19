import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import style from './style.js';
import { cleanText } from '../types.js';
import { onShutdown } from '../lifecycle.js';
import { renderMarkdown, wrapText } from './markdown.js';
import { name, version, mark } from '../brand.js';

export type Choice = { value: string; name: string; hint?: string };
type SelectionOptions = {
    detail?: string | (() => string);
    before?: () => string[];
    back?: boolean;
    footer?: string;
    shortcuts?: Record<string, string>;
    complete?: () => string | undefined;
};

export function fit(text: string, width: number): string {
    if (width <= 0) return '';
    if (stringWidth(text) <= width) return text;
    let end = Math.max(0, width - 1);
    let result = sliceAnsi(text, 0, end);
    while (stringWidth(result) > width - 1 && end > 0) result = sliceAnsi(text, 0, --end);
    return result + '…';
}

export class Screen {
    quitRequested = false;
    taskActive = false;
    recordingActive = false;
    dictation?: import('../dictation.js').DictationService;
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
        process.stdout.write('\x1b[?1049h\x1b[?25l');
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
            mark.forEach((line, index) => lines.push('  ' + style(line, 'accent') + (index === 1 ? '   ' + style(name, 'strong') : index === 2 ? '   ' + style(version, 'muted') : '')));
        } else lines.push('  ' + style(name, 'accent'));
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
            let selected = 0;
            let current: Choice[] = [];
            const done = (value: string) => { this.keyHandler = undefined; this.redraw = undefined; resolve(value); };
            this.redraw = () => {
                const complete = options.complete?.();
                if (complete) { done(complete); return; }
                current = typeof choices === 'function' ? choices() : choices;
                selected = Math.max(0, Math.min(selected, current.length - 1));
                const before = options.before?.() || [];
                const capacity = Math.max(1, this.capacity - before.length - 2);
                const start = Math.max(0, Math.min(selected - capacity + 1, current.length - capacity));
                const lines = [...before];
                for (let index = start; index < Math.min(current.length, start + capacity); index++) {
                    const choice = current[index]!;
                    const text = (selected === index ? '› ' : '  ') + cleanText(choice.name);
                    lines.push(selected === index ? style(text, 'accent') : text);
                }
                lines.push('', style(current[selected]?.hint || '', 'muted'));
                const detail = typeof options.detail === 'function' ? options.detail() : options.detail || '';
                this.frame(title, detail, lines, options.footer);
            };
            this.keyHandler = (text, key) => {
                if (key.ctrl && key.name === 'c') { this.quitRequested = true; done('quit'); return; }
                if (key.name === 'escape' && options.back) { done('back'); return; }
                if (key.name === 'f2') { done('settings'); return; }
                if (key.name === 'up' || (key.ctrl && key.name === 'p')) selected = (selected - 1 + current.length) % Math.max(1, current.length);
                else if (key.name === 'down' || (key.ctrl && key.name === 'n')) selected = (selected + 1) % Math.max(1, current.length);
                else if (key.name === 'return' && current[selected]) { done(current[selected]!.value); return; }
                else if (options.shortcuts?.[key.name || ''] || (text && options.shortcuts?.[text])) { done((options.shortcuts[key.name || ''] || options.shortcuts[text])!); return; }
                this.redraw?.();
            };
            this.redraw();
        });
    }

    input(title: string, detail: string, initial = ''): Promise<string | null> {
        return new Promise(resolve => {
            const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            let letters = [...segmenter.segment(initial)].map(item => item.segment);
            let cursor = letters.length;
            const done = (value: string | null) => { this.redraw = undefined; this.keyHandler = undefined; resolve(value); };
            this.redraw = () => {
                let left = letters.slice(0, cursor).join('');
                const right = letters.slice(cursor).join('');
                while (stringWidth(left) > this.width - 5) left = [...segmenter.segment(left)].slice(1).map(item => item.segment).join('');
                this.frame(title, detail, [style('› ', 'accent') + left + style('│', 'accent') + right], "Enter Save · Esc Cancel · ←/→ Cursor", "Ctrl+C Leave pending and quit");
            };
            this.keyHandler = (text, key) => {
                if (key.ctrl && key.name === 'c') { this.quitRequested = true; done(null); return; }
                if (key.name === 'escape') { done(null); return; }
                if (key.name === 'return') { done(letters.join('')); return; }
                if (key.name === 'left') cursor = Math.max(0, cursor - 1);
                else if (key.name === 'right') cursor = Math.min(letters.length, cursor + 1);
                else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
                else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = letters.length;
                else if (key.name === 'backspace' && cursor) { letters.splice(--cursor, 1); }
                else if (key.name === 'delete') letters.splice(cursor, 1);
                else if (!key.ctrl && !key.meta && text && !/^[\x00-\x1f\x7f]/.test(text)) {
                    const inserted = cleanText(text).replace(/\s+/g, ' ');
                    const prefix = letters.slice(0, cursor).join('');
                    const value = prefix + inserted + letters.slice(cursor).join('');
                    const segments = [...segmenter.segment(value)];
                    cursor = segments.filter(item => item.index < prefix.length + inserted.length).length;
                    letters = segments.map(item => item.segment);
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
        process.stdout.write('\x1b[?25h\x1b[?1049l');
    }
}
