import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertNoPendingSession, completeSession, saveSession, sessionDirectory, sessions } from './store.js';
import { RATE, repairWav, sampleCount } from './wav.js';
import { summarize } from './notes.js';
import { IncompleteTranscriptionError, Transcription, transcriptText } from './transcription.js';
import type { Decision, Session, Settings } from './types.js';
import { errorMessage } from './types.js';

export async function recoverSessions(): Promise<void> {
    for (const session of await sessions()) {
        if (session.state === 'done') continue;
        if (session.decision === 'delete' || (session.decision === 'note-only' && existsSync(path.join(sessionDirectory(session.id), 'note.md')))) {
            await completeSession(session, session.decision);
            continue;
        }
        if (session.state === 'stopped') continue;
        let samples = 0;
        for (const source of ['mic', 'system']) {
            const file = path.join(sessionDirectory(session.id), source + '.wav');
            if (!existsSync(file)) continue;
            try {
                repairWav(file);
                samples = Math.max(samples, sampleCount(file));
            } catch (error) {
                session.events.push({ at: new Date().toISOString(), message: source + ': Audio recovery failed. Original file preserved. ' + errorMessage(error) });
            }
        }
        session.state = 'stopped'; session.recovered = true;
        session.stoppedAt = new Date(Date.parse(session.startedAt) + samples / RATE * 1000).toISOString();
        session.events.push({ at: new Date().toISOString(), message: 'Recovered after interruption; choose what to keep.' });
        await saveSession(session);
    }
}

export async function reopenSession(session: Session): Promise<void> {
    if (session.state !== 'done') throw new Error("This recording is still pending. Finish it first.");
    await assertNoPendingSession();
    if (!['mic', 'system'].some(source => {
        const file = path.join(sessionDirectory(session.id), source + '.wav');
        return existsSync(file) && sampleCount(file) > 0;
    })) throw new Error("No audio track found for reprocessing.");
    session.state = 'stopped'; session.decision = null;
    session.transcriptionRevision = (session.transcriptionRevision || 0) + 1;
    session.events.push({ at: new Date().toISOString(), message: 'Reprocessing requested; choose what to keep afterwards.' });
    await saveSession(session);
}

export async function finishSession(session: Session, decision: Decision, config: Settings, progress: (text: string) => void, existing?: Transcription, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!session.name || session.state !== 'stopped') throw new Error("Stop and name the recording first.");
    const root = sessionDirectory(session.id);
    if (decision === 'delete') {
        await existing?.close();
        signal?.throwIfAborted();
        await completeSession(session, decision);
        return root;
    }
    const transcription = existing || new Transcription(session, config);
    const cancel = () => { void transcription.close().catch(() => {}); };
    const report = () => progress('Transcription: ' + (transcription.processing || 'Chunk saved'));
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        if (!existing) await transcription.initialize();
        for (const warning of transcription.warnings) progress(warning);
        signal?.throwIfAborted();
        transcription.on('update', report);
        progress("Transcribing recorded audio…");
        let failure: unknown;
        try { await transcription.drain(); }
        catch (error) { failure = error; }
        if (failure && !(failure instanceof IncompleteTranscriptionError)) throw failure;
        if (transcription.failures) {
            progress('Retrying failed chunks…');
            await transcription.retry();
            try { await transcription.drain(); failure = undefined; }
            catch (error) { failure = error; }
        }
        if (failure && (decision !== 'keep' || !(failure instanceof IncompleteTranscriptionError))) throw failure;
        transcription.off('update', report);
        await transcription.close();
        let result = path.join(root, 'transcript.md');
        if (decision === 'summarize' || decision === 'note-only') {
            signal?.throwIfAborted();
            result = await summarize(session, transcriptText(transcription.segments), config, progress, signal);
        }
        signal?.throwIfAborted();
        await transcription.close();
        await completeSession(session, decision);
        return result;
    } finally { transcription.off('update', report); signal?.removeEventListener('abort', cancel); await transcription.close(); }
}
