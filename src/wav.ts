import { closeSync, fstatSync, fsyncSync, openSync, readSync, statSync, writeSync } from 'node:fs';

export const RATE = 16_000;
export const HEADER = 44;

export function wavHeader(bytes: number): Buffer {
    if (bytes > 0xffffffff - 36) throw new Error("WAV size limit reached. Start a new recording.");
    const header = Buffer.alloc(HEADER);
    header.write('RIFF', 0); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
    header.writeUInt32LE(bytes, 40);
    return header;
}

export function sampleCount(file: string): number {
    return Math.max(0, Math.floor((statSync(file).size - HEADER) / 2));
}

export class WavWriter {
    private fd: number;
    samples = 0;
    private checkpoint = 0;
    constructor(readonly file: string) {
        this.fd = openSync(file, 'wx', 0o600);
        writeSync(this.fd, wavHeader(0));
    }
    append(pcm: Buffer): void {
        wavHeader(this.samples * 2 + pcm.length);
        let offset = 0;
        while (offset < pcm.length) offset += writeSync(this.fd, pcm, offset, pcm.length - offset, HEADER + this.samples * 2 + offset);
        this.samples += pcm.length / 2;
        if (this.samples - this.checkpoint >= RATE) {
            writeSync(this.fd, wavHeader(this.samples * 2), 0, HEADER, 0);
            this.checkpoint = this.samples;
        }
    }
    padTo(samples: number): void {
        const silence = Buffer.alloc(RATE * 2);
        while (this.samples < samples) this.append(silence.subarray(0, Math.min(silence.length, (samples - this.samples) * 2)));
    }
    close(): void {
        if (this.fd < 0) return;
        const fd = this.fd; this.fd = -1;
        try { writeSync(fd, wavHeader(this.samples * 2), 0, HEADER, 0); fsyncSync(fd); }
        finally { closeSync(fd); }
    }
}

function pcmBytes(fd: number, file: string): number {
        const bytes = fstatSync(fd).size - HEADER;
        if (bytes < 0 || bytes % 2) throw new Error("Invalid audio file: " + file);
        // Only the size fields of our own PCM header may be repaired. Never turn
        // an unrelated or damaged file into a WAV by overwriting its first bytes.
        const header = Buffer.alloc(HEADER), expected = wavHeader(0);
        if (readSync(fd, header, 0, HEADER, 0) !== HEADER || !header.subarray(0, 4).equals(expected.subarray(0, 4)) ||
            !header.subarray(8, 40).equals(expected.subarray(8, 40))) throw new Error("Unsupported or damaged WAV audio file: " + file);
        return bytes;
}

export function inspectWav(file: string): number {
    const fd = openSync(file, 'r');
    try { return pcmBytes(fd, file) / 2; } finally { closeSync(fd); }
}

export function repairWav(file: string): void {
    const fd = openSync(file, 'r+');
    try {
        writeSync(fd, wavHeader(pcmBytes(fd, file)), 0, HEADER, 0);
    } finally { closeSync(fd); }
}

export function readWavSlice(file: string, offset: number, samples: number): Buffer {
    const pcm = Buffer.alloc(samples * 2);
    const fd = openSync(file, 'r');
    try {
        let read = 0;
        while (read < pcm.length) {
            const count = readSync(fd, pcm, read, pcm.length - read, HEADER + offset * 2 + read);
            if (!count) break;
            read += count;
        }
        return Buffer.concat([wavHeader(read), pcm.subarray(0, read)]);
    } finally { closeSync(fd); }
}

export function hasSpeechEnergy(wav: Buffer): boolean {
    let sum = 0;
    for (let i = HEADER; i + 1 < wav.length; i += 2) sum += (wav.readInt16LE(i) / 32768) ** 2;
    return Math.sqrt(sum / Math.max(1, (wav.length - HEADER) / 2)) > 0.002;
}
