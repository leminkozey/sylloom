import koffi from 'koffi';
import type { CallApp } from './app-reader.js';

export type AudioActivity = { supported: boolean; apps: Partial<Record<CallApp, { input: boolean; output: boolean }>> };

// Read stream activity flags, never audio samples. A duplex stream is evidence
// of an active audio session; it cannot prove an incoming/ringing call.
export function audioActivity(enabled: CallApp[] = ['teams', 'apple', 'whatsapp']): AudioActivity {
    if (process.platform !== 'darwin') return { supported: false, apps: {} };
    try {
        const core = koffi.load('/System/Library/Frameworks/CoreAudio.framework/CoreAudio');
        const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
        const address = koffi.struct({ selector: 'uint32', scope: 'uint32', element: 'uint32' });
        const size = core.func('AudioObjectGetPropertyDataSize', 'int32', ['uint32', koffi.pointer(address), 'uint32', 'void *', koffi.out(koffi.pointer('uint32'))]);
        const data = core.func('AudioObjectGetPropertyData', 'int32', ['uint32', koffi.pointer(address), 'uint32', 'void *', koffi.inout(koffi.pointer('uint32')), 'void *']);
        const release = cf.func('void CFRelease(void *)');
        const string = cf.func('bool CFStringGetCString(void *, void *, long, uint32)');
        const four = (value: string) => Buffer.from(value).readUInt32BE();
        const property = (selector: string) => ({ selector: four(selector), scope: four('glob'), element: 0 });
        const read = (id: number, selector: string, bytes: number) => {
            const buffer = Buffer.alloc(bytes), length = [bytes];
            if (data(id, property(selector), 0, null, length, buffer) !== 0 || length[0] !== bytes) throw new Error('Audio process data is unavailable.');
            return buffer;
        };
        const length = [0];
        if (size(1, property('prs#'), 0, null, length) !== 0 || length[0]! > 32768 || length[0]! % 4) return { supported: false, apps: {} };
        const processes = read(1, 'prs#', length[0]!);
        const apps: AudioActivity['apps'] = { apple: { input: false, output: false }, teams: { input: false, output: false }, whatsapp: { input: false, output: false } };
        for (let offset = 0; offset < processes.length; offset += 4) {
            const id = processes.readUInt32LE(offset);
            let pointer: unknown;
            try {
                pointer = koffi.decode(read(id, 'pbid', 8), 'void *');
                if (!pointer) continue;
                const bytes = Buffer.alloc(1024); if (!string(pointer, bytes, bytes.length, 0x08000100)) continue;
                const bundle = bytes.toString('utf8').split('\0')[0]!;
                const app = /^com\.apple\.(avconferenced|FaceTime|mobilephone)$/.test(bundle) ? 'apple' : /^(net\.whatsapp\.WhatsApp|com\.whatsapp\.WhatsApp)(\.|$)/i.test(bundle) ? 'whatsapp' : /^com\.microsoft\.teams2?(\.|$)/i.test(bundle) ? 'teams' : undefined;
                if (!app || !enabled.includes(app)) continue;
                apps[app]!.input ||= Boolean(read(id, 'piri', 4).readUInt32LE());
                apps[app]!.output ||= Boolean(read(id, 'piro', 4).readUInt32LE());
            } catch { return { supported: false, apps: {} }; }
            finally { if (pointer) release(pointer); }
        }
        return { supported: true, apps };
    } catch { return { supported: false, apps: {} }; }
}
