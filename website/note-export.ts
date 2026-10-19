import { sampleNote } from './sample-note.js';
export function noteExport(): void {
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function release() { if (url) URL.revokeObjectURL(url); url = undefined; }
    document.querySelector('#download-note')!.addEventListener('click', () => {
        clearTimeout(timer); release();
        url = URL.createObjectURL(new Blob([sampleNote], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'friday-release-review.md';
        document.body.append(link); link.click(); link.remove();
        document.querySelector('#export-status')!.textContent = 'Sample Markdown download started.';
        timer = setTimeout(release, 10000);
    });
    window.addEventListener('pagehide', () => { clearTimeout(timer); release(); });
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href="#requirements"]')) anchor.addEventListener('click', () => { document.querySelector<HTMLDetailsElement>('#requirements')!.open = true; });
}
