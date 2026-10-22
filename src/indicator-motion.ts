import { Waveform } from './waveform.js';
import type { WavePhase } from './waveform.js';

export type Vertex = { x: number; y: number };
export type IndicatorFrame = { parts: Vertex[][]; width: number; white: number; success: number; error: number };
type Pose = { x: number; y: number; angle: number; points: Vertex[] };
const N = 24;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

// All three states have the same 13 closed contours with 48 vertices each.
// The original bars become the gear sectors and finally the check's stroke.
// Nothing is crossfaded, added, removed or swapped for a separate icon.
function capsule(x: number, y: number, width: number, height: number, rotation = 0): Vertex[] {
    const r = Math.min(width, height) / 2, straight = Math.max(0, height - 2 * r);
    const side = (s: number) => {
        if (s < .25) { const a = -Math.PI / 2 + s * 2 * Math.PI; return { x: r * Math.cos(a), y: -straight / 2 + r * Math.sin(a) }; }
        if (s <= .75) return { x: r, y: lerp(-straight / 2, straight / 2, (s - .25) * 2) };
        const a = (s - .75) * 2 * Math.PI; return { x: r * Math.cos(a), y: straight / 2 + r * Math.sin(a) };
    };
    return [...Array.from({ length: N }, (_, i) => side(i / (N - 1))), ...Array.from({ length: N }, (_, i) => { const p = side(1 - i / (N - 1)); return { x: -p.x, y: p.y }; })]
        .map(p => ({ x: x + p.x * Math.cos(rotation) - p.y * Math.sin(rotation), y: y + p.x * Math.sin(rotation) + p.y * Math.cos(rotation) }));
}
function gearSector(x: number, y: number, teeth: number, tooth: number, root: number, outer: number, hole: number, rotation: number): Pose {
    const pitch = Math.PI * 2 / teeth, theta = (tooth + .5) * pitch + rotation, middle = (root + hole) / 2;
    const angle = (t: number) => (t - .5) * pitch;
    const radius = (t: number) => root + (outer - root) * Math.min(1, Math.max(0, (t - .16) / .12), Math.max(0, (.84 - t) / .12));
    const point = (t: number, r: number) => ({ x: Math.cos(angle(t)) * r - middle, y: Math.sin(angle(t)) * r });
    const top = Array.from({ length: N }, (_, i) => { const t = i / (N - 1); return point(t, radius(t)); });
    const inside = Array.from({ length: N }, (_, i) => point(1 - i / (N - 1), hole));
    return { x: x + Math.cos(theta) * middle, y: y + Math.sin(theta) * middle, angle: theta, points: [...top, ...inside] };
}
function checkPart(cx: number, index: number): Pose {
    const a = { x: cx - 9, y: 19 }, b = { x: cx - 2.5, y: 12.5 }, c = { x: cx + 10, y: 26 };
    const first = Math.hypot(b.x - a.x, b.y - a.y), second = Math.hypot(c.x - b.x, c.y - b.y), total = first + second;
    const sample = (distance: number) => distance <= first ? { x: lerp(a.x, b.x, distance / first), y: lerp(a.y, b.y, distance / first) } : { x: lerp(b.x, c.x, (distance - first) / second), y: lerp(b.y, c.y, (distance - first) / second) };
    const start = sample(index / 13 * total), end = sample((index + 1) / 13 * total);
    return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, angle: Math.atan2(end.y - start.y, end.x - start.x) - Math.PI / 2, points: capsule(0, 0, 3.2, Math.hypot(end.x - start.x, end.y - start.y) + 3.2) };
}
function stroke(a: Vertex, b: Vertex, weight = 2.2): Pose {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2, points: capsule(0, 0, weight, Math.hypot(b.x - a.x, b.y - a.y) + weight) };
}
function mixPose(a: Pose, b: Pose, t: number): Pose {
    const angle = Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle));
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), angle: a.angle + angle * t,
        points: b.points.map((point, i) => ({ x: lerp(a.points[i]!.x, point.x, t), y: lerp(a.points[i]!.y, point.y, t) })) };
}
function matchContour(source: Vertex[], target: Vertex[]): Vertex[] {
    // Follow the same perimeter positions as the original bar. Different
    // vertex spacing would twist a rounded bar into shards during the morph.
    const reference = Math.atan2(source[0]!.y, source[0]!.x);
    let start = 0, nearest = Infinity;
    target.forEach((p, i) => { const angle = Math.atan2(p.y, p.x) - reference; const distance = Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))); if (distance < nearest) { start = i; nearest = distance; } });
    const ring = target.map((_p, i) => target[(start + i) % target.length]!);
    const cumulative = (points: Vertex[]) => { const result = [0]; for (let i = 0; i < points.length; i++) { const a = points[i]!, b = points[(i + 1) % points.length]!; result.push(result[i]! + Math.hypot(b.x - a.x, b.y - a.y)); } return result; };
    const sourceLength = cumulative(source), targetLength = cumulative(ring);
    let edge = 0;
    return source.map((_p, i) => {
        const distance = sourceLength[i]! / sourceLength.at(-1)! * targetLength.at(-1)!;
        while (edge < ring.length - 1 && targetLength[edge + 1]! < distance) edge++;
        const a = ring[edge]!, b = ring[(edge + 1) % ring.length]!, length = targetLength[edge + 1]! - targetLength[edge]!;
        const t = length > 0 ? (distance - targetLength[edge]!) / length : 0;
        return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    });
}
function micBodyPart(i: number, slash: number): Pose {
    const radius = 3.6, straight = 5.6;
    const left = lerp(-radius + i * radius / 2, -radius + i * radius * 2 / 3, i < 3 ? slash : 0);
    const right = lerp(-radius + (i + 1) * radius / 2, -radius + (i + 1) * radius * 2 / 3, i < 3 ? slash : 0);
    const rim = (x: number) => Math.sqrt(Math.max(0, radius * radius - x * x));
    const points = [...Array.from({ length: N }, (_, j) => { const x = lerp(left, right, j / (N - 1)); return { x, y: -straight / 2 - rim(x) }; }),
        ...Array.from({ length: N }, (_, j) => { const x = lerp(right, left, j / (N - 1)); return { x, y: straight / 2 + rim(x) }; })];
    return { x: 0, y: 23, angle: 0, points };
}
function microphonePart(cx: number, i: number, slash = 0): Pose {
    let pose: Pose;
    if (i < 4) {
        const body = micBodyPart(i, slash);
        if (i < 3) pose = body;
        else {
            const draw = ease(slash);
            const start = { x: -11 * draw, y: 19 + 12 * draw }, end = { x: 11 * draw, y: 19 - 12 * draw };
            pose = mixPose(body, stroke(start, end, 2.2), ease(Math.min(1, slash / .4)));
        }
    } else if (i === 4 || i === 9) {
        const x = i === 4 ? -8 : 8;
        pose = stroke({ x, y: 19 }, { x, y: 24 }, 2.1);
    } else if (i < 9) {
        // Four continuous annular slices form a true semicircle, rather than
        // straight strokes between a handful of angular control points.
        const start = Math.PI + (i - 5) * Math.PI / 4, end = start + Math.PI / 4;
        const arc = (radius: number, angle: number) => ({ x: radius * Math.cos(angle), y: 19 + radius * Math.sin(angle) });
        const points = [...Array.from({ length: N }, (_, j) => arc(9.05, lerp(start, end, j / (N - 1)))),
            ...Array.from({ length: N }, (_, j) => arc(6.95, lerp(end, start, j / (N - 1))))];
        pose = { x: 0, y: 0, angle: 0, points };
    } else if (i === 10) pose = stroke({ x: 0, y: 11 }, { x: 0, y: 8 });
    else pose = stroke({ x: i === 11 ? -5.5 : 0, y: 7 }, { x: i === 11 ? 0 : 5.5, y: 7 });
    // Center each piece on its actual geometry. This lets bars flow inward
    // without rotating into a fan or collapsing into an intermediate block.
    const points = pose.points.map(p => ({ x: pose.x + p.x * Math.cos(pose.angle) - p.y * Math.sin(pose.angle), y: pose.y + p.x * Math.sin(pose.angle) + p.y * Math.cos(pose.angle) }));
    const x = (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2;
    const y = (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2;
    return { x: cx + x * .8, y: 19 + (y - 19) * .8, angle: 0,
        points: points.map(p => ({ x: (p.x - x) * .8, y: (p.y - y) * .8 })) };
}
export function recordingTime(seconds = 0): string {
    const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return value >= 3600 ? Math.floor(value / 3600) + ':' + String(Math.floor(value / 60) % 60).padStart(2, '0') : Math.floor(value / 60).toString().padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}
export class IndicatorMotion {
    private waveform = new Waveform(13);
    private phase?: WavePhase;
    private feedback?: string;
    private since = 0;
    private from?: IndicatorFrame;
    private poses?: Pose[];
    private fromPoses?: Pose[];
    private current?: IndicatorFrame;
    constructor(private width = 122) {}
    reset(): void { this.waveform.reset(); this.phase = undefined; this.feedback = undefined; this.from = this.current = undefined; this.poses = this.fromPoses = undefined; }
    frame(phase: WavePhase, level: number, now: number, motion = true, morph = true, feedback?: 'microphone'): IndicatorFrame {
        const heights = this.waveform.update(phase, level, now, motion);
        const wave = (): Pose[] => heights.map((h, i) => ({ x: (this.width - 87) / 2 + i * 7 + 1.5, y: 19, angle: 0, points: capsule(0, 0, 3, h) }));
        const project = (pose: Pose) => pose.points.map(p => ({ x: pose.x + p.x * Math.cos(pose.angle) - p.y * Math.sin(pose.angle), y: pose.y + p.x * Math.sin(pose.angle) + p.y * Math.cos(pose.angle) }));
        if (!this.current) { this.poses = wave(); this.current = { parts: this.poses.map(project), width: this.width, white: 0, success: 0, error: 0 }; }
        if (phase !== this.phase || feedback !== this.feedback) { this.phase = phase; this.feedback = feedback; this.since = now; this.from = structuredClone(this.current); this.fromPoses = structuredClone(this.poses); }
        const processing = morph && phase === 'processing', done = morph && phase === 'copied', microphone = phase === 'error' && feedback === 'microphone';
        const center = this.width / 2;
        const elapsed = Math.max(0, now - this.since), duration = done ? 340 : 420;
        const rotation = motion && processing ? Math.max(0, elapsed - duration) / 1800 : 0;
        const micOrder = [4, 5, 6, 11, 0, 1, 10, 2, 3, 12, 7, 8, 9];
        const parts = microphone ? Array.from({ length: 13 }, (_, i) => microphonePart(center, micOrder[i]!, motion ? ease(Math.max(0, Math.min(1, (elapsed - 480) / 240))) : 1)) : processing ? Array.from({ length: 13 }, (_, i) => i < 7 ? gearSector(this.width / 2 - 10, 20, 7, i, 7.8, 11.1, 4, rotation) : gearSector(this.width / 2 + 10.5, 17.5, 6, i - 7, 6.4, 9.1, 3.1, -rotation * 7 / 6 + .32)) : done ? Array.from({ length: 13 }, (_, i) => checkPart(center, i)) : wave();
        const targetWidth = microphone ? 52 : processing ? 74 : done ? 52 : this.width;
        const t = motion ? ease(Math.max(0, Math.min(1, microphone ? (elapsed - 140) / 340 : elapsed / duration))) : 1;
        const from = this.from!;
        this.poses = parts.map((pose, i) => {
            const prior = this.fromPoses![i]!;
            const rotation = Math.atan2(Math.sin(pose.angle - prior.angle), Math.cos(pose.angle - prior.angle));
            return { x: lerp(prior.x, pose.x, t), y: lerp(prior.y, pose.y, t), angle: prior.angle + rotation * t,
                points: pose.points.map((p, j) => ({ x: lerp(prior.points[j]!.x, p.x, t), y: lerp(prior.points[j]!.y, p.y, t) })) };
        });
        if (microphone && motion) {
            const move = ease(Math.max(0, Math.min(1, (elapsed - 140) / 280)));
            const shape = ease(Math.max(0, Math.min(1, (elapsed - 240) / 240)));
            this.poses = parts.map((pose, i) => {
                const prior = this.fromPoses![i]!;
                const matched = { ...pose, points: matchContour(prior.points, pose.points) };
                return { ...mixPose(prior, matched, shape), x: lerp(prior.x, pose.x, move), y: lerp(prior.y, pose.y, move) };
            });
        }
        this.current = { parts: this.poses.map(project), width: lerp(from.width, targetWidth, t), white: lerp(from.white, phase === 'processing' || phase === 'copied' || phase === 'paused' ? 1 : 0, t),
            success: lerp(from.success, phase === 'copied' ? 1 : 0, done ? ease(Math.max(0, (t - .35) / .65)) : t), error: lerp(from.error, phase === 'error' ? 1 : 0, microphone ? motion ? ease(Math.min(1, elapsed / 140)) : 1 : t) };
        return this.current;
    }
}

export function recordingSeconds(session: { startedAt: string; events: { at: string; message: string }[] }, now = Date.now()): number {
    let pausedAt: number | undefined, pauses = 0;
    for (const event of session.events) {
        const at = Date.parse(event.at); if (!Number.isFinite(at)) continue;
        if (event.message === 'Paused. Audio is not being saved.' && pausedAt === undefined) pausedAt = at;
        if (event.message === 'Recording resumed.' && pausedAt !== undefined) { pauses += Math.max(0, at - pausedAt); pausedAt = undefined; }
    }
    return Math.max(0, ((pausedAt ?? now) - Date.parse(session.startedAt) - pauses) / 1000);
}
