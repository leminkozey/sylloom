import { mkdir, readFile, writeFile, rename, rm, link } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { powershell } from './powershell.js';
import type { CommandInstallation, InstallOptions } from '../../installation.js';

export const windowsLauncherMarker = '@echo off\r\nrem Sylloom command launcher v1\r\n';
export function windowsLauncher(node: string, entry: string): string {
    if (/["\r\n\0]/u.test(node + entry)) throw new Error('Invalid launcher path.');
    const quote = (text: string) => '"' + text.replaceAll('%', '%%') + '"';
    return windowsLauncherMarker + 'rem Sylloom target: ' + Buffer.from(entry, 'utf8').toString('base64') + '\r\n' +
        'setlocal DisableDelayedExpansion\r\n' + quote(node) + ' ' + quote(entry) + ' %*\r\nexit /b %errorlevel%\r\n';
}
export function windowsLauncherTarget(content: string): string | undefined {
    if (!content.startsWith(windowsLauncherMarker)) return undefined;
    const encoded = content.match(/^rem Sylloom target: ([a-zA-Z0-9+/=]+)\r?$/mu)?.[1];
    return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined;
}
export async function installWindowsCommand(options: InstallOptions = {}): Promise<CommandInstallation> {
    const environment = options.environment || process.env, userHome = options.userHome || homedir();
    const project = path.resolve(options.project || fileURLToPath(new URL('../../../', import.meta.url)));
    const directory = path.resolve(options.binDirectory || environment.SYLLOOM_BIN_DIR || path.join(environment.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'), 'Sylloom', 'bin'));
    if (/[;\r\n\0"]/u.test(directory)) throw new Error('The command directory cannot contain semicolons, quotes or line breaks.');
    if (!existsSync(path.join(project, 'dist', 'cli.js'))) throw new Error('Build Sylloom first with install.ps1 or npm run build.');
    const command = path.join(directory, 'sylloom.cmd'), entry = path.join(project, 'sylloom');
    await mkdir(directory, { recursive: true });
    const existing = lstatSync(command, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || !(await readFile(command, 'utf8')).startsWith(windowsLauncherMarker))) throw new Error('Existing command was preserved: ' + command);
    const temp = path.join(directory, '.sylloom-' + randomUUID() + '.tmp');
    try {
        await writeFile(temp, windowsLauncher(options.node || process.execPath, entry), { flag: 'wx' });
        if (existing) await rename(temp, command); else await link(temp, command);
    } finally { await rm(temp, { force: true }); }
    const onPath = (environment.PATH || environment.Path || '').split(';').some(part => path.resolve(part).toLowerCase() === directory.toLowerCase());
    if (!onPath && options.configurePath !== false) await powershell(`
$directory=$env:SYLLOOM_COMMAND_DIRECTORY
$current=[Environment]::GetEnvironmentVariable('Path','User')
$entries=@($current -split ';'|Where-Object { $_ })
if(-not ($entries|Where-Object {$_.TrimEnd('\\') -ieq $directory.TrimEnd('\\')})){
 [Environment]::SetEnvironmentVariable('Path',(($entries+$directory)-join ';'),'User')
}`, { SYLLOOM_COMMAND_DIRECTORY: directory });
    return { command, shellFiles: [], onPath };
}
