import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { home } from './store.js';
import type { Recorder } from './recorder.js';
import { errorMessage } from './types.js';

const socketPath = () => process.platform === 'win32' ? '\\\\.\\pipe\\meeting-' + Buffer.from(home).toString('hex').slice(-40) : path.join(home, 'control.sock');

export async function startControl(recorder: Recorder): Promise<() => Promise<void>> {
    const address = socketPath();
    const clients = new Set<Socket>();
    if (process.platform !== 'win32') await rm(address, { force: true });
    const server = createServer(socket => {
        clients.add(socket);
        socket.once('close', () => clients.delete(socket));
        let input = '';
        socket.setTimeout(50_000, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('data', data => {
            input += data.toString();
            if (input.length > 4096) { socket.destroy(); return; }
            if (!input.includes('\n')) return;
            socket.pause();
            void (async () => {
                try {
                    const { command, value } = JSON.parse(input.split('\n')[0]!);
                    if (command === 'stop') { recorder.emit('stopRequested'); await recorder.stop(); }
                    else if (command === 'pause') await recorder.pause(true);
                    else if (command === 'resume') await recorder.pause(false);
                    else if (command === 'input' || command === 'output') {
                        if (typeof value !== 'string' || !value) throw new Error("Device ID is missing.");
                        await recorder.switch(command === 'input' ? 'mic' : 'system', value);
                    } else if (command === 'mute-mic') await recorder.toggleMute('mic');
                    else if (command === 'mute-system') await recorder.toggleMute('system');
                    else if (!['status', 'pause', 'resume'].includes(command)) throw new Error("Unknown control command.");
                    socket.end(JSON.stringify({ ok: true, id: recorder.session.id, state: recorder.session.state,
                        input: recorder.current.mic, output: recorder.current.system, muted: recorder.muted, health: recorder.health }) + '\n');
                } catch (error) { socket.end(JSON.stringify({ ok: false, error: errorMessage(error) }) + '\n'); }
            })();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, resolve);
    });
    if (process.platform !== 'win32') await chmod(address, 0o600);
    return async () => {
        for (const socket of clients) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (process.platform !== 'win32') await rm(address, { force: true });
    };
}

export function control(command: string, value?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath());
        let response = '';
        socket.setTimeout(50_000, () => socket.destroy(new Error("Recording control timed out.")));
        socket.on('error', error => reject(new Error("Could not reach a recording: " + error.message)));
        socket.on('connect', () => socket.write(JSON.stringify({ command, value }) + '\n'));
        socket.on('data', data => { response += data.toString(); if (response.length > 65536) socket.destroy(new Error("Invalid control response.")); });
        socket.on('end', () => {
            try {
                const result = JSON.parse(response);
                if (!result.ok) reject(new Error(result.error)); else resolve(result);
            } catch (error) { reject(error); }
        });
    });
}
