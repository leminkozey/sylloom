import { headlineMorph } from './headline.js';
import { callDemo } from './call-demo.js';
import { demoWaveform } from './dictation-waveform.js';
import { noteExport } from './note-export.js';
document.documentElement.classList.add('has-js');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const reveal = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        reveal.unobserve(entry.target);
    }
}, { threshold: .12 });
document.querySelectorAll('.reveal').forEach(element => reveal.observe(element));
const scene = document.querySelector<HTMLElement>('#demo')!;
const drawWaveform = demoWaveform(scene, reducedMotion);
let text = document.querySelector<HTMLElement>('[data-dictated=message]')!;
const demoStatus = document.querySelector<HTMLElement>('#demo-status')!;
const replay = document.querySelector<HTMLButtonElement>('#replay')!;
const motionToggle = document.querySelector<HTMLButtonElement>('#motion-toggle')!;
const examples = {
    message: { title: 'New message', context: 'A little catch-up', text: 'The Mac build is ready. Let’s review it together on Friday morning.' },
    email: { title: 'New email', context: 'Friday’s review', text: 'Hi Alex,\n\nThe Mac build is ready for review. Could we go through it together on Friday morning?\n\nThanks,\nSam' },
    list: { title: 'A plan for Friday', context: 'Your next steps', text: '☐ Review the Mac build\n☐ Check the Markdown export\n☐ Share the release notes' },
};
let format: keyof typeof examples = 'message';
let message = examples[format].text;
const phases = [
    { name: 'idle', duration: 1100, label: 'Speak. Press again. It’s written.' },
    { name: 'recording', duration: 2600, label: 'A thought, out loud.' },
    { name: 'processing', duration: 800, label: 'A little structure.' },
    { name: 'typing', duration: 2200, label: 'Right where you’re writing.' },
    { name: 'done', duration: 3800, label: 'Your words. Ready to go.' },
];
let phase = 0;
let elapsed = 0;
let last = 0;
let frame = 0;
let visible = false;
let paused = reducedMotion.matches;
function render() {
    const current = phases[phase]!;
    drawWaveform(current.name, elapsed, performance.now());
    scene.classList.toggle('delivery-complete', current.name === 'done' && elapsed >= 1200);
    if (scene.dataset.phase !== current.name) scene.dataset.phase = current.name;
    if (demoStatus.textContent !== current.label) demoStatus.textContent = current.label;
    const visibleText = current.name === 'typing' ? message.slice(0, Math.floor(Math.min(1, elapsed / 1750) * message.length))
        : current.name === 'done' ? message : '';
    if (text.textContent !== visibleText) text.textContent = visibleText;
}
function canPlay() { return visible && !paused && !document.hidden && !reducedMotion.matches; }
function tick(now: number) {
    frame = 0;
    if (!canPlay()) { last = 0; return; }
    if (last) elapsed += Math.min(now - last, 100);
    last = now;
    if (elapsed >= phases[phase]!.duration) { elapsed = 0; phase = (phase + 1) % phases.length; }
    render();
    frame = requestAnimationFrame(tick);
}
function syncPlayback() {
    const active = canPlay();
    motionToggle.hidden = reducedMotion.matches;
    replay.setAttribute('aria-label', reducedMotion.matches ? 'Show dictation demo result' : 'Replay dictation demo');
    scene.classList.toggle('is-paused', !active);
    motionToggle.setAttribute('aria-pressed', String(paused));
    motionToggle.setAttribute('aria-label', paused ? 'Play demo animation' : 'Pause demo animation');
    motionToggle.innerHTML = '<span aria-hidden="true">' + (paused ? '▷' : 'Ⅱ') + '</span>';
    if (!active && frame) { cancelAnimationFrame(frame); frame = 0; last = 0; }
    if (active && !frame) frame = requestAnimationFrame(tick);
}
new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting || false;
    syncPlayback();
}, { threshold: .15 }).observe(scene);
motionToggle.addEventListener('click', () => {
    paused = !paused;
    if (reducedMotion.matches) { phase = 4; render(); paused = true; }
    syncPlayback();
});
replay.addEventListener('click', () => {
    phase = reducedMotion.matches ? 4 : 0;
    elapsed = 0;
    last = 0;
    paused = reducedMotion.matches;
    render();
    syncPlayback();
});
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-format]')) button.addEventListener('click', () => {
    format = button.dataset.format as keyof typeof examples;
    message = examples[format].text;
    scene.dataset.format = format;
    for (const pane of scene.querySelectorAll<HTMLElement>('[data-app-pane]')) pane.hidden = pane.dataset.appPane !== format;
    text = scene.querySelector<HTMLElement>('[data-dictated="' + format + '"]')!;
    for (const sibling of document.querySelectorAll('button[data-format]')) sibling.setAttribute('aria-pressed', String(sibling === button));
    phase = reducedMotion.matches ? 4 : 0; elapsed = 0; last = 0;
    paused = reducedMotion.matches;
    render(); syncPlayback();
});
document.addEventListener('visibilitychange', syncPlayback);
reducedMotion.addEventListener('change', () => {
    paused = reducedMotion.matches;
    phase = paused ? 4 : 0;
    elapsed = 0;
    render();
    syncPlayback();
});
if (reducedMotion.matches) phase = 4;
render();
syncPlayback();
const copyButton = document.querySelector<HTMLButtonElement>('#copy-install')!;
const copyStatus = document.querySelector<HTMLElement>('#copy-status')!;
let resetCopy: ReturnType<typeof setTimeout> | undefined;
copyButton.addEventListener('click', async () => {
    const code = document.querySelector<HTMLElement>('#install-code')!;
    clearTimeout(resetCopy);
    try {
        await navigator.clipboard.writeText(code.textContent?.trim() || '');
        copyButton.textContent = 'Copied ✓';
        copyStatus.textContent = 'Commands copied. Paste them into your terminal when you’re ready.';
    } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection?.removeAllRanges();
        selection?.addRange(range);
        copyStatus.textContent = 'Copy access is unavailable. The commands are selected; press ⌘C or Ctrl+C.';
    }
    resetCopy = setTimeout(() => {
        copyButton.innerHTML = 'Copy commands <span aria-hidden="true">⧉</span>';
    }, 3500);
});
window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    clearTimeout(resetCopy);
});
window.addEventListener('pageshow', syncPlayback);

callDemo(reducedMotion);
noteExport();
void headlineMorph(reducedMotion);

// The spotlight opens the photo into the page as it reaches the viewport.
// Pointer light remains optional; touch devices keep the photograph untouched.
let spotlightFrame = 0;
function updateSpotlight() {
    spotlightFrame = 0;
    const bounds = scene.getBoundingClientRect();
    const open = reducedMotion.matches ? 0 : Math.max(0, Math.min(1, (innerHeight * .72 - bounds.top) / (innerHeight * .57)));
    scene.style.setProperty('--open', open.toFixed(3));
}
function requestSpotlight() { if (!spotlightFrame) spotlightFrame = requestAnimationFrame(updateSpotlight); }
window.addEventListener('scroll', requestSpotlight, { passive: true });
window.addEventListener('resize', requestSpotlight, { passive: true });
reducedMotion.addEventListener('change', requestSpotlight);
updateSpotlight();
window.addEventListener('pagehide', () => { cancelAnimationFrame(spotlightFrame); spotlightFrame = 0; });
