import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { home, sessionDirectory } from './store.js';
import { cleanText } from './types.js';
import type { Session } from './types.js';

export type DocumentKind = 'note' | 'transcript';
export type ExportFormat = 'md' | 'html';

export function documentPath(session: Session, kind: DocumentKind): string {
    return path.join(sessionDirectory(session.id), kind + '.md');
}

export function exportName(session: Session, kind: DocumentKind, format: ExportFormat): string {
    const name = (session.name || session.id).normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '') || session.id;
    return name + (kind === 'transcript' ? "-transcript" : '') + '.' + format;
}

export function renderHtml(markdown: string, title: string): string {
    const body = sanitizeHtml(marked.parse(cleanText(markdown), { async: false, gfm: true }), {
        allowedTags: [...sanitizeHtml.defaults.allowedTags, 'input'],
        allowedAttributes: { a: ['href', 'title'], input: ['type', 'checked', 'disabled'], code: ['class'], th: ['align'], td: ['align'] },
        allowedSchemes: ['https', 'http', 'mailto'],
        transformTags: { input: (_tag, attributes) => ({ tagName: 'input', attribs: { type: 'checkbox', disabled: 'disabled', ...(attributes.checked !== undefined ? { checked: 'checked' } : {}) } }) },
    });
    const safeTitle = title.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
        '<title>' + safeTitle + '</title><style>' +
        ':root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.65}body{margin:0;background:light-dark(#f7f7f5,#171719);color:light-dark(#222,#e7e7e9)}' +
        'main{max-width:76ch;margin:3rem auto;padding:0 1.5rem 4rem}h1,h2,h3{line-height:1.25;margin-top:2em}h1{font-size:2rem}h2{font-size:1.3rem;border-bottom:1px solid light-dark(#ddd,#39393d);padding-bottom:.5rem}' +
        'a{color:light-dark(#2525cc,#a3a6ff)}pre{padding:1rem;overflow:auto;background:light-dark(#eee,#242427);border-radius:5px}code{font-family:ui-monospace,monospace;font-size:.9em}' +
        'blockquote{border-left:3px solid light-dark(#ccc,#555);margin-left:0;padding-left:1rem}table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:.5rem .75rem;border:1px solid light-dark(#ccc,#444);text-align:left}' +
        'li{margin:.3rem 0}input{accent-color:#686be7} @media print{:root{color-scheme:light}body{background:#fff;color:#111}main{margin:0;max-width:none;padding:0}h2,h3{break-after:avoid}li,blockquote{break-inside:avoid}}' +
        '</style></head><body><main>' + body + '</main></body></html>\n';
}

export async function exportDocument(session: Session, kind: DocumentKind, destination: string, format: ExportFormat, overwrite = false): Promise<string> {
    const target = path.resolve(destination.startsWith('~/') ? path.join(homedir(), destination.slice(2)) : destination);
    if (path.extname(target).toLowerCase() !== '.' + format) throw new Error("Export path must end in ." + format + ".");
    const source = documentPath(session, kind);
    const markdown = await readFile(source, 'utf8');
    const content = format === 'html' ? renderHtml(markdown, session.name || 'Meeting') : markdown;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
    try {
        await writeFile(temporary, content, { mode: 0o600 });
        if (overwrite) await rename(temporary, target);
        else await copyFile(temporary, target, constants.COPYFILE_EXCL);
        return target;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error("Destination already exists. Choose another name or use --force.");
        throw error;
    } finally { await rm(temporary, { force: true }); }
}

export async function openDocument(session: Session, kind: DocumentKind): Promise<string> {
    if (process.platform !== 'darwin') throw new Error("Opening in a browser currently requires macOS. Export the note as HTML instead.");
    const target = path.join(home, 'views', session.id + '-' + kind + '.html');
    await exportDocument(session, kind, target, 'html', true);
    await new Promise<void>((resolve, reject) => {
        const child = spawn('open', [target], { stdio: 'ignore' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error("Could not open the browser.")));
    });
    return target;
}
