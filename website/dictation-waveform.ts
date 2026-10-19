import { Waveform } from '../src/waveform.js';
import type { WavePhase } from '../src/waveform.js';

export function demoWaveform(host: HTMLElement, motion: MediaQueryList) {
    const waveform = new Waveform();
    const bars = [...host.querySelectorAll<HTMLElement>('.waveform i')];
    let previous = '';
    return (phase: string, elapsed: number, now: number) => {
        if (phase === 'idle' && previous !== phase) waveform.reset();
        previous = phase;
        const quiet = (elapsed > 700 && elapsed < 1500) || elapsed > 2200;
        const level = phase === 'recording' && !quiet ? .025 + Math.abs(Math.sin(elapsed / 150)) * .1 : 0;
        const state: WavePhase = phase === 'processing' || phase === 'typing' ? 'processing' : phase === 'done' ? 'copied' : phase === 'recording' ? 'recording' : 'starting';
        const heights = waveform.update(state, level, now, !motion.matches);
        for (const [index, bar] of bars.entries()) bar.style.transform = 'scaleY(' + (heights[index]! / 26).toFixed(4) + ')';
    };
}
