import { renderMarkdown } from '../src/terminal/markdown.js';
import { sampleNote } from '../website/sample-note.js';

// Render text through the CLI's own Markdown implementation. This is an HTML
// excerpt, not a terminal screenshot or a replacement for real Ghostty captures.
export function terminalNote(): string {
    const previous = { force: process.env.FORCE_COLOR, no: process.env.NO_COLOR, term: process.env.TERM };
    let lines: string[];
    try {
        process.env.FORCE_COLOR = '1'; delete process.env.NO_COLOR; process.env.TERM = 'xterm-256color';
        lines = renderMarkdown(sampleNote, 56);
    } finally {
        for (const [name, value] of [['FORCE_COLOR', previous.force], ['NO_COLOR', previous.no], ['TERM', previous.term]] as const) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    let output = '', open = false;
    const styles: Record<string, string> = { '1': 'strong', '2': 'muted', '3': 'emphasis', '90': 'divider', '38;2;104;107;231': 'accent', '38;2;37;37;204': 'accent' };
    for (const part of lines.join('\n').split(/(\x1b\[[\d;]*m)/)) {
        if (part.startsWith('\x1b[')) {
            if (open) output += '</span>'; open = false;
            const style = styles[part.slice(2, -1)];
            if (style) { output += '<span class="term-' + style + '">'; open = true; }
        } else output += escape(part);
    }
    return output + (open ? '</span>' : '');
}
