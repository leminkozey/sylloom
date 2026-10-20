import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
export const powershellPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export async function powershell(script: string, environment: NodeJS.ProcessEnv = {}, signal?: AbortSignal, timeout = 10_000): Promise<string> {
    // Only fixed scripts go in the command. Paths, date ranges and other values
    // are separate environment data, never interpolated PowerShell source.
    const encoded = Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64');
    const result = await execute(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true, encoding: 'utf8', env: { ...process.env, ...environment }, maxBuffer: 2 * 1024 ** 2, timeout, signal,
    });
    return result.stdout.replace(/^\uFEFF/u, '').trim();
}
