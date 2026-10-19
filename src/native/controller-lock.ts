import koffi from 'koffi';

// The kernel releases this advisory lock when the descriptor closes or the
// process dies. Keep its file in place: replacing it would create a second lock.
export function lockController(fd: number): boolean {
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Controller locking requires macOS or Linux.');
    const flock = koffi.load(null).func('int flock(int fd, int operation)');
    if (flock(fd, 2 | 4) === 0) return true;
    const code = koffi.errno();
    if (code === (process.platform === 'darwin' ? 35 : 11)) return false;
    throw new Error('Could not lock the Sylloom controller (system error ' + code + ').');
}
