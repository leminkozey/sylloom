import koffi from 'koffi';

// The kernel releases this advisory lock when the descriptor closes or the
// process dies. Keep its file in place: replacing it would create a second lock.
export function lockController(fd: number, file: string): (() => void) | undefined {
    if (process.platform === 'win32') {
        const kernel = koffi.load('kernel32.dll');
        // Own a Win32 handle rather than converting Node's CRT descriptor using
        // a different C runtime's descriptor table. The kernel releases it on
        // process death, including a crash or forced termination.
        const handle = kernel.func('void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)')(file, 0xc0000000, 7, null, 3, 0x80, null);
        if (!handle || handle === -1n || handle === 0xffffffffffffffffn) throw new Error('Could not open the Sylloom controller lock.');
        const close = kernel.func('int __stdcall CloseHandle(void *)');
        const overlapped = Buffer.alloc(process.arch === 'ia32' ? 20 : 32);
        // Keep metadata writes through Node's separate handle outside the lock.
        overlapped.writeUInt32LE(4096, process.arch === 'ia32' ? 8 : 16);
        if (kernel.func('int __stdcall LockFileEx(void *, uint32, uint32, uint32, uint32, void *)')(handle, 3, 0, 1, 0, overlapped)) {
            let closed = false;
            return () => { if (!closed) { closed = true; close(handle); } };
        }
        const code = kernel.func('uint32 __stdcall GetLastError()')();
        close(handle);
        if (code === 33 || code === 997) return undefined;
        throw new Error('Could not lock the Sylloom controller (Windows ' + code + ').');
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Controller locking requires macOS or Linux.');
    const flock = koffi.load(null).func('int flock(int fd, int operation)');
    if (flock(fd, 2 | 4) === 0) return () => {}; // Descriptor close releases flock.
    const code = koffi.errno();
    if (code === (process.platform === 'darwin' ? 35 : 11)) return undefined;
    throw new Error('Could not lock the Sylloom controller (system error ' + code + ').');
}
