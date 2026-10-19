export function callDemo(motion: MediaQueryList): void {
    const host = document.querySelector<HTMLElement>('#call-demo')!;
    const popup = host.querySelector<HTMLElement>('.call-popup')!;
    const primary = host.querySelector<HTMLButtonElement>('#demo-record')!;
    const secondary = host.querySelector<HTMLButtonElement>('#demo-dismiss')!;
    const hangups = [...host.querySelectorAll<HTMLButtonElement>('[data-hangup]')];
    const toggle = host.querySelector<HTMLButtonElement>('#call-motion')!;
    const instruction = host.querySelector<HTMLElement>('#call-instruction')!;
    const title = host.querySelector<HTMLElement>('#popup-title')!;
    const description = host.querySelector<HTMLElement>('#popup-description')!;
    type State = 'prompt' | 'recording' | 'ending' | 'saved' | 'dismissed';
    let provider = 'FaceTime', state: State = 'prompt';
    let connected = true, hidden = false, visible = false, paused = motion.matches;
    let elapsed = 0, last = 0, frame = 0;
    const durations: Record<State, number> = { prompt: 3000, recording: 4400, ending: 1500, saved: 3800, dismissed: 3800 };
    function render() {
        host.dataset.callState = state; host.classList.toggle('popup-hidden', hidden);
        popup.inert = hidden;
        for (const hangup of hangups) hangup.disabled = !connected;
        const recording = state === 'recording' || state === 'ending';
        const app = provider === 'FaceTime' ? 'FaceTime / iPhone' : provider;
        // Match the real titles, copy and actions in src/meeting-bridge.ts.
        title.textContent = state === 'saved' ? 'Recording saved' : recording ? 'Recording meeting' : 'Call detected';
        description.textContent = state === 'saved' ? 'Name the recording and choose what happens to its transcript.'
            : recording ? 'Microphone and system audio stay on this computer.' : app + ' · Record? Auto-stop on hangup.';
        primary.textContent = state === 'saved' ? 'Finish' : recording ? 'Stop' : 'Record';
        secondary.textContent = state === 'saved' ? 'Later' : recording ? 'Hide' : 'Dismiss';
        for (const status of host.querySelectorAll<HTMLElement>('.sample-call-status')) status.textContent = !connected ? 'Call ended' : provider === 'FaceTime' ? 'From your iPhone · 0:05' : provider === 'WhatsApp' ? '00:05' : 'Connected';
        instruction.textContent = state === 'prompt' ? 'A call is detected. You choose whether to record.'
            : state === 'recording' ? 'Recording both sides. The same controls as the Mac popup.'
            : state === 'ending' ? 'Call ended. Sylloom confirms the hangup.'
            : state === 'saved' ? 'Stopped automatically. Finish the recording in your CLI.' : 'Dismissed. No audio was recorded.';
    }
    function change(next: State) { const wasHidden = hidden; state = next; elapsed = 0; last = 0; hidden = next === 'ending' ? wasHidden : next === 'dismissed'; render(); }
    function reset() { connected = true; hidden = false; change('prompt'); }
    function tick(now: number) {
        frame = 0;
        if (!visible || paused || motion.matches || document.hidden) { last = 0; return; }
        if (last) elapsed += Math.min(now - last, 100);
        last = now;
        if (elapsed >= durations[state]) {
            if (state === 'prompt') change('recording');
            else if (state === 'recording') { connected = false; change('ending'); }
            else if (state === 'ending') change('saved');
            else reset();
        }
        frame = requestAnimationFrame(tick);
    }
    function sync() {
        cancelAnimationFrame(frame); frame = 0; last = 0;
        toggle.setAttribute('aria-pressed', String(paused)); toggle.setAttribute('aria-label', paused ? 'Play call demo' : 'Pause call demo');
        toggle.innerHTML = '<span aria-hidden="true">' + (paused ? '▷' : 'Ⅱ') + '</span>';
        toggle.hidden = motion.matches; host.classList.toggle('is-playing', visible && !paused && !document.hidden);
        if (visible && !paused && !motion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    }
    primary.addEventListener('click', () => {
        if (state === 'prompt') change('recording');
        else if (state === 'recording' || state === 'ending') change('saved');
        else if (state === 'saved') { document.querySelector('#meeting')!.scrollIntoView({ behavior: motion.matches ? 'instant' : 'smooth' }); }
        sync();
    });
    secondary.addEventListener('click', () => {
        if (state === 'recording' || state === 'ending' || state === 'saved') { hidden = true; render(); }
        else change('dismissed');
        toggle.focus({ preventScroll: true }); sync();
    });
    for (const hangup of hangups) hangup.addEventListener('click', () => {
        connected = false; change(state === 'recording' ? 'ending' : 'dismissed');
        if (motion.matches && state === 'ending') change('saved');
        primary.focus({ preventScroll: true }); sync();
    });
    toggle.addEventListener('click', () => { paused = !paused; sync(); });
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-call-app]')) button.addEventListener('click', () => {
        provider = button.dataset.callApp!; host.dataset.provider = provider;
        for (const sibling of host.querySelectorAll('[data-call-app]')) sibling.setAttribute('aria-pressed', String(sibling === button));
        for (const pane of host.querySelectorAll<HTMLElement>('[data-call-pane]')) pane.hidden = pane.dataset.callPane !== provider;
        reset(); sync();
    });
    new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting || false; sync(); }, { threshold: .25 }).observe(host);
    motion.addEventListener('change', () => { paused = motion.matches; if (motion.matches && state === 'ending') change('saved'); sync(); });
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); frame = 0; });
    window.addEventListener('pageshow', sync);
    render(); sync();
}
