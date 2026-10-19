type Glyph = { from: Float32Array; to: Float32Array; columns: number; x1: number; x2: number };
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => value * value * (3 - 2 * value);

// Signed distance fields preserve each letter while a narrow wave refracts its
// contours into the second font. The text never changes rendering surfaces.
function distanceField(pixels: Uint8ClampedArray, width: number, height: number): Float32Array {
    function distance(inside: boolean): Float32Array {
        const values = new Float32Array(width * height);
        for (let i = 0; i < values.length; i++) values[i] = (pixels[i * 4 + 3]! > 110) === inside ? 0 : 1000;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (x) values[i] = Math.min(values[i]!, values[i - 1]! + 1);
            if (y) values[i] = Math.min(values[i]!, values[i - width]! + 1);
            if (x && y) values[i] = Math.min(values[i]!, values[i - width - 1]! + Math.SQRT2);
            if (x < width - 1 && y) values[i] = Math.min(values[i]!, values[i - width + 1]! + Math.SQRT2);
        }
        for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
            const i = y * width + x;
            if (x < width - 1) values[i] = Math.min(values[i]!, values[i + 1]! + 1);
            if (y < height - 1) values[i] = Math.min(values[i]!, values[i + width]! + 1);
            if (x < width - 1 && y < height - 1) values[i] = Math.min(values[i]!, values[i + width + 1]! + Math.SQRT2);
            if (x && y < height - 1) values[i] = Math.min(values[i]!, values[i + width - 1]! + Math.SQRT2);
        }
        return values;
    }
    const ink = distance(true), paper = distance(false);
    return ink.map((value, i) => value - paper[i]!);
}
export async function headlineMorph(motion: MediaQueryList): Promise<void> {
    await document.fonts.ready;
    for (const host of document.querySelectorAll<HTMLElement>('[data-fluid-text]')) createMorph(host, motion);
}
function createMorph(host: HTMLElement, motion: MediaQueryList): void {
    const source = host.querySelector<HTMLElement>('.morph-start')!;
    const target = host.querySelector<HTMLElement>('.morph-final')!;
    const canvas = host.querySelector<HTMLCanvasElement>('canvas')!;
    const context = canvas.getContext('2d');
    if (!context) return;
    const letters = [...source.textContent!];
    let frame = 0, last = 0, elapsed = 0, width = 0, height = 0;
    let glyphs: Glyph[] = [];
    let visible = false;
    let previousProgress = -1;
    let fromScale = 1, toScale = 1, fromBaseline = 0, toBaseline = 0, fromX = 0, toX = 0;
    let fromFont = '', toFont = '', fromSpace = 0, toSpace = 0;
    const centered = host.dataset.align !== 'left';
    let anchor = 0;
    function drawText(targetFont: boolean) {
        context!.clearRect(0, 0, width, height); context!.globalAlpha = 1;
        context!.save();
        context!.translate(0, targetFont ? toBaseline : fromBaseline);
        context!.scale(1, targetFont ? toScale : fromScale);
        context!.font = targetFont ? toFont : fromFont;
        let x = targetFont ? toX : fromX;
        for (const letter of letters) {
            context!.fillText(letter, x, 0);
            x += context!.measureText(letter).width + (targetFont ? toSpace : fromSpace);
        }
        context!.restore();
    }
    function pause() { cancelAnimationFrame(frame); frame = 0; last = 0; }
    function prepare() {
        const bounds = host.getBoundingClientRect();
        width = bounds.width; height = Math.ceil(bounds.height);
        const inkHeight = height * .70;
        const inkTop = (height - inkHeight) / 2;
        const dpr = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        context!.setTransform(dpr, 0, 0, dpr, 0, 0);
        context!.fillStyle = getComputedStyle(target).color;
        const surface = document.createElement('canvas');
        const ctx = surface.getContext('2d', { willReadFrequently: true })!;
        function layout(element: HTMLElement) {
            const style = getComputedStyle(element);
            const font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
            ctx.font = font;
            const spacing = parseFloat(style.letterSpacing) || 0;
            const advances = letters.map(letter => ctx.measureText(letter).width);
            const total = advances.reduce((sum, value) => sum + value, 0) + spacing * (letters.length - 1);
            // Variable-font metrics can disagree with the pixels actually
            // painted (notably the left side bearing). Measure the real ink.
            const raster = document.createElement('canvas');
            const size = parseFloat(style.fontSize), padding = 32, rasterBaseline = Math.ceil(size * 2);
            raster.width = Math.ceil(total + padding * 3); raster.height = Math.ceil(size * 3);
            const probe = raster.getContext('2d', { willReadFrequently: true })!;
            probe.font = font;
            let cursor = padding;
            for (const [index, letter] of letters.entries()) { probe.fillText(letter, cursor, rasterBaseline); cursor += advances[index]! + spacing; }
            const pixels = probe.getImageData(0, 0, raster.width, raster.height).data;
            let left = raster.width, top = raster.height, bottom = 0;
            for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) if (pixels[(y * raster.width + x) * 4 + 3]! > 100) {
                left = Math.min(left, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
            }
            const scale = inkHeight / (bottom - top + 1);
            const baseline = inkTop - (top - rasterBaseline) * scale;
            const inkLeft = padding - left;
            let x = 0;
            const positions = advances.map(advance => { const position = x; x += advance + spacing; return position; });
            return { font, spacing, total, positions, advances, baseline, scale, inkLeft };
        }
        const a = layout(source), b = layout(target);
        anchor = centered ? (width - Math.max(a.total, b.total)) / 2 : 3;
        fromScale = a.scale; toScale = b.scale; fromBaseline = a.baseline; toBaseline = b.baseline;
        fromX = anchor + a.inkLeft; toX = anchor + b.inkLeft;
        fromFont = a.font; toFont = b.font; fromSpace = a.spacing; toSpace = b.spacing;
        glyphs = letters.flatMap((letter, i) => {
            if (letter === ' ') return [];
            const columns = Math.ceil(Math.max(a.advances[i]!, b.advances[i]!) + 32);
            surface.width = columns; surface.height = height;
            function mask(font: string, scale: number, baseline: number) {
                ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, columns, height); ctx.font = font;
                ctx.setTransform(1, 0, 0, scale, 0, baseline);
                ctx.fillStyle = '#000'; ctx.fillText(letter, 12, 0);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                return distanceField(ctx.getImageData(0, 0, columns, height).data, columns, height);
            }
            return [{ columns, from: mask(a.font, a.scale, a.baseline), to: mask(b.font, b.scale, b.baseline), x1: fromX + a.positions[i]! - 12, x2: toX + b.positions[i]! - 12 }];
        });
        host.classList.add('has-morph');
        previousProgress = -1;
        drawText(motion.matches);
    }
    function tick(now: number) {
        frame = 0;
        if (!visible || document.hidden || motion.matches) { last = 0; return; }
        if (last) elapsed += Math.min(now - last, 60);
        last = now;
        const hold = 2400, duration = 1550;
        const cycle = elapsed % (hold * 2 + duration * 2);
        const progress = cycle < hold ? 0 : cycle < hold + duration ? (cycle - hold) / duration
            : cycle < hold * 2 + duration ? 1 : 1 - (cycle - hold * 2 - duration) / duration;
        const p = ease(progress);
        if (progress === previousProgress && (progress === 0 || progress === 1)) { frame = requestAnimationFrame(tick); return; }
        previousProgress = progress;
        host.dataset.morphState = progress === 0 ? 'sans' : progress === 1 ? 'serif' : 'water';
        if (progress === 0 || progress === 1) drawText(progress === 1);
        else {
            context!.clearRect(0, 0, width, height);
            const envelope = Math.sin(progress * Math.PI);
            const step = width < 600 ? 1.4 : 1.7;
            const front = width * (-.15 + p * 1.3);
            for (const glyph of glyphs) {
                const x0 = glyph.x1 + (glyph.x2 - glyph.x1) * p;
                for (let y = 0; y < height; y += step) for (let x = 0; x < glyph.columns; x += step) {
                    const i = Math.floor(y) * glyph.columns + Math.floor(x);
                    const d = glyph.from[i]! * (1 - p) + glyph.to[i]! * p;
                    const gx = x0 + x;
                    const band = Math.exp(-Math.pow((gx - front) / (width * .25), 2));
                    const ripple = Math.sin(gx * .045 + y * .025 - p * 10) * envelope * band;
                    // Refraction travels through the letter contours. A shared
                    // ink bounds and a single canvas keep both ends pixel-aligned.
                    const coverage = clamp(.6 - d + ripple * .4);
                    if (coverage < .04) continue;
                    const px = gx;
                    const py = y;
                    context!.globalAlpha = coverage;
                    context!.beginPath(); context!.arc(px, py, step * (.6 - .12 * envelope * band), 0, Math.PI * 2); context!.fill();
                }
            }
            context!.globalAlpha = 1;
        }
        frame = requestAnimationFrame(tick);
    }
    function play() {
        if (motion.matches || document.hidden || !visible || frame) return;
        last = 0; frame = requestAnimationFrame(tick);
    }
    prepare();
    new IntersectionObserver(entries => {
        visible = entries[0]?.isIntersecting || false;
        if (!visible && frame) { cancelAnimationFrame(frame); frame = 0; last = 0; }
        else if (visible) play();
    }, { threshold: .6 }).observe(host);
    motion.addEventListener('change', () => { pause(); if (motion.matches) { drawText(true); host.dataset.morphState = 'serif'; } else { previousProgress = -1; play(); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { pause(); } else play(); });
    new ResizeObserver(() => {
        const bounds = host.getBoundingClientRect();
        if (Math.abs(bounds.width - width) > 1 || Math.abs(bounds.height - height) > 1) { prepare(); }
    }).observe(host);
    window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); frame = 0; last = 0; });
    window.addEventListener('pageshow', play);
    if (motion.matches) { drawText(true); host.dataset.morphState = 'serif'; }
}
