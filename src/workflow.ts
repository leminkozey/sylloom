import { existsSync } from 'node:fs';
import path from 'node:path';
import { copyFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertNoPendingSession, completeSession, loadSession, saveSession, sessionDirectory, sessions } from './store.js';
import { inspectWav, RATE, repairWav, sampleCount } from './wav.js';
import { summarize } from './notes.js';
import { IncompleteTranscriptionError, Transcription, transcriptText } from './transcription.js';
import type { Decision, Session, Settings } from './types.js';
import { errorMessage } from './types.js';

export async function inspectRecordingRecovery(id: string): Promise<{ name: string; status: string; samples?: number }[]> {
    const root = sessionDirectory(id);
    return ['mic.wav', 'system.wav', 'note.md', 'transcript.md'].map(name => {
        const file = path.join(root, name);
        if (!existsSync(file)) return { name, status: 'Missing' };
        if (!name.endsWith('.wav')) return { name, status: 'Preserved document' };
        try { const samples = inspectWav(file); return { name, samples, status: samples > 0 ? (samples / RATE).toFixed(1) + ' s · Recoverable PCM audio' : 'Empty audio' }; }
        catch { return { name, status: 'Damaged or unsupported audio · Preserved' }; }
    });
}

export async function restoreRecordingMetadata(id: string): Promise<Session> {
    let valid = false;
    try { await loadSession(id); valid = true; } catch { /* Only unreadable metadata may be reconstructed. */ }
    if (valid) throw new Error('This recording already has valid metadata. Use Finish pending recording or Library.');
    const root = sessionDirectory(id), files = await inspectRecordingRecovery(id);
    const samples = Math.max(0, ...files.map(file => file.samples || 0));
    if (!samples) throw new Error('No recoverable audio found. Files were preserved; restore metadata from a backup instead.');
    const metadata = path.join(root, 'session.json');
    const info = await stat(root);
    const startedAt = new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString();
    const backup = 'session.json.unreadable-' + randomUUID();
    if (existsSync(metadata)) await copyFile(metadata, path.join(root, backup), constants.COPYFILE_EXCL);
    const session: Session = { id, name: null, startedAt, stoppedAt: new Date(Date.parse(startedAt) + samples / RATE * 1000).toISOString(),
        state: 'stopped', decision: null, recovered: true, events: [
            { at: new Date().toISOString(), message: 'Metadata explicitly reconstructed. Name and time may differ from the original. Transcript decision remains pending. Original metadata backup: ' + backup },
            ...files.map(file => ({ at: new Date().toISOString(), message: file.name + ': ' + file.status })),
        ] };
    await saveSession(session);
    return session;
}

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
