import { spawn } from 'node:child_process';
import koffi from 'koffi';

// ShellExecute receives the target as data, without cmd.exe or shell quoting.
export async function openExternal(target: string): Promise<void> {
    if (!target || /[\0\r\n]/u.test(target)) throw new Error('Invalid external item.');
    if (process.platform === 'win32') {
        const result = koffi.load('shell32.dll').func('intptr_t __stdcall ShellExecuteW(void *, str16, str16, str16, str16, int)')(null, 'open', target, null, null, 1);
        if (Number(result) <= 32) throw new Error('Windows could not open this item.');
        return;
    }
    if (process.platform !== 'darwin') throw new Error('Opening external items requires macOS or Windows.');
    await new Promise<void>((resolve, reject) => {
        const child = spawn('open', [target], { stdio: 'ignore' });
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not open this item.')));
    });
}
