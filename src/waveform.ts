export type WavePhase = 'starting' | 'recording' | 'processing' | 'copied' | 'error';

// Audio is sampled at 20 Hz; geometry can be rendered at any refresh rate.
// Keep history and displayed heights separate so silence travels through the
// trace while each bar eases to its next height instead of jumping there.
export class Waveform {
    private history: number[];
    private heights: number[];
    private last?: number;
    private sampleTime = 0;
    constructor(readonly count = 13) {
        this.history = Array(count).fill(0); this.heights = Array(count).fill(2);
    }
    reset(): void {
        this.history.fill(0); this.heights.fill(2); this.last = undefined; this.sampleTime = 0;
    }
    update(phase: WavePhase, level: number, now: number, motion = true): readonly number[] {
        const delta = this.last === undefined ? 50 : Math.max(0, Math.min(100, now - this.last));
        this.last = now;
        const normalized = Number.isFinite(level) && level > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(level) + 55) / 45)) : 0;
        this.sampleTime += delta;
        const samples = Math.min(this.count, Math.floor(this.sampleTime / 50));
        if (samples) {
            this.history.splice(0, samples); this.history.push(...Array<number>(samples).fill(phase === 'recording' ? normalized : 0));
            this.sampleTime %= 50;
        }
        const waiting = phase === 'starting' || phase === 'processing';
        for (let i = 0; i < this.count; i++) {
            const value = waiting ? motion ? .15 + (Math.sin(now / 240 - i * .6) + 1) * .15 : .25 : phase === 'recording' ? this.history[i]! : .15;
            const target = 2 + value * 24;
            const current = this.heights[i]!;
            const blend = motion ? 1 - Math.exp(-delta / (target > current ? 55 : 180)) : 1;
            this.heights[i] = current + (target - current) * blend;
        }
        return this.heights;
    }
}
