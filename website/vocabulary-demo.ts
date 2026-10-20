export function vocabularyDemo(motion: MediaQueryList): void {
    const host = document.querySelector<HTMLElement>('#word-demo')!;
    const toggle = host.querySelector<HTMLButtonElement>('#word-motion')!;
    const status = host.querySelector<HTMLElement>('#word-status')!;
    const phases = [
        { name: 'heard', duration: 1400, text: 'What you said.' },
        { name: 'corrected', duration: 1100, text: 'Your saved spelling.' },
        { name: 'ready', duration: 3200, text: 'Ready to use.' },
        { name: 'reset', duration: 500, text: 'A correction you chose.' },
    ];
    let phase = motion.matches ? 2 : 0, remaining = phases[phase]!.duration;
    let visible = false, paused = motion.matches, started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function stop() {
        if (timer === undefined) return;
        clearTimeout(timer); timer = undefined;
        remaining = Math.max(0, remaining - (performance.now() - started));
    }
    function render() {
        host.dataset.wordPhase = phases[phase]!.name;
        status.textContent = phases[phase]!.text;
        toggle.hidden = motion.matches;
        toggle.setAttribute('aria-pressed', String(paused));
        toggle.setAttribute('aria-label', paused ? 'Play vocabulary demo' : 'Pause vocabulary demo');
        toggle.innerHTML = '<span aria-hidden="true">' + (paused ? '▷' : 'Ⅱ') + '</span>';
    }
    function play() {
        if (!visible || paused || motion.matches || document.hidden || timer !== undefined) return;
        started = performance.now();
        timer = setTimeout(() => {
            timer = undefined;
            phase = (phase + 1) % phases.length; remaining = phases[phase]!.duration;
            render(); play();
        }, remaining);
    }
    new IntersectionObserver(entries => {
        visible = entries[0]?.isIntersecting || false;
        if (visible) play(); else stop();
    }, { threshold: .4 }).observe(host);
    toggle.addEventListener('click', () => { stop(); paused = !paused; render(); play(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else play(); });
    motion.addEventListener('change', () => {
        stop(); paused = motion.matches; phase = paused ? 2 : 0;
        remaining = phases[phase]!.duration; render(); play();
    });
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', play);
    render();
}
