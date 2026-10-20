import { parentPort } from 'node:worker_threads';
import { capabilities, devices, openStream } from '@studio-sadola/flexaudio';
import type { FlexStream, OpenOptions } from '@studio-sadola/flexaudio';
import type { Source } from './types.js';

const port = parentPort!;
const streams = new Map<Source, FlexStream>();
const options = (source: Source, device?: string): OpenOptions => ({
    kind: source, deviceId: device === 'default' ? undefined : device,
    outputRate: 16000, outputChannels: 1, chunkMs: 20, silenceProbe: false,
});

async function handle(message: { id: number; command: string; source: Source; device: string; value: number }) {
    try {
        let result: unknown;
        const stream = streams.get(message.source);
        switch (message.command) {
            case 'capabilities': result = await capabilities(); break;
            case 'devices': result = devices(); break;
            case 'start': {
                if (stream) throw new Error("Audio source is already running.");
                const source = message.source;
                const opened = openStream(options(source, message.device), chunk => {
                    if (!chunk.frames) return;
                    const pcm = new Uint8Array(chunk.data.length * 2);
                    const view = new DataView(pcm.buffer);
                    for (let i = 0; i < chunk.data.length; i++) {
                        const sample = Math.max(-1, Math.min(1, chunk.data[i] || 0));
                        view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
                    }
                    port.postMessage({ type: 'pcm', source, pcm, frame: Number(chunk.frameIndex),
                        flags: chunk.flags, rms: chunk.rms, at: Date.now(), dropped: chunk.droppedBefore }, [pcm.buffer]);
                }, event => port.postMessage({ type: 'event', source, event }));
                streams.set(source, opened);
                break;
            }
            case 'switch':
                if (!stream) throw new Error("Audio source is not running.");
                stream.switchSource(options(message.source, message.device));
                break;
            case 'pause': for (const item of streams.values()) item.pause(); break;
            case 'resume': for (const item of streams.values()) item.resume(); break;
            case 'gain':
                if (!stream) throw new Error("Audio source is not running.");
                stream.setGain(message.value);
                break;
            case 'stop': {
                const failures: string[] = [];
                for (const [source, item] of streams) {
                    try { await item.stop(); }
                    catch (error) { failures.push(source + ': ' + (error instanceof Error ? error.message : String(error))); }
                }
                streams.clear();
                if (failures.length) throw new Error(failures.join('\n'));
                break;
            }
            default: throw new Error('Unknown audio command.');
        }
        port.postMessage({ type: 'response', id: message.id, result });
    } catch (error) {
        port.postMessage({ type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
}

let queue = Promise.resolve();
port.on('message', message => { queue = queue.then(() => handle(message)); });
