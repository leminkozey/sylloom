import { appendFile, link, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceFingerprint } from './build-info.js';

const marker = '# Sylloom command launcher v1';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
type InstallOptions = { binDirectory?: string; configurePath?: boolean; userHome?: string; project?: string; node?: string; environment?: NodeJS.ProcessEnv };
export type CommandInstallation = { command: string; shellFiles: string[]; onPath: boolean };

export async function installationStatus(root = fileURLToPath(new URL('../', import.meta.url)), environment = process.env) {
    const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    let build: { version: string; sourceHash: string; builtAt: string } | undefined;
    try { build = JSON.parse(await readFile(path.join(root, 'dist', 'build-info.json'), 'utf8')); } catch { /* Old builds have no provenance file. */ }
    const command = (environment.PATH || '').split(path.delimiter).map(directory => path.join(directory, 'sylloom')).find(file => existsSync(file));
    let target: string | undefined;
    if (command) {
        if (lstatSync(command).isSymbolicLink()) target = path.resolve(path.dirname(command), await readlink(command));
        else {
            const launcher = await readFile(command, 'utf8');
            if (launcher.startsWith('#!/bin/sh\n' + marker + '\n')) {
                const match = launcher.match(/^exec "\$runtime" '(.*)' "\$@"$/m);
                if (match) target = match[1]!.replaceAll("'\\''", "'");
            }
        }
    }
    const sourceHash = await sourceFingerprint(root);
    return { sourceVersion: source.version as string, builtVersion: build?.version || 'Unknown (rebuild required)',
        builtAt: build?.builtAt, buildMatchesSource: build?.version === source.version && build?.sourceHash === sourceHash,
        sourceDirectory: path.resolve(root), runningEntrypoint: process.argv[1] ? path.resolve(process.argv[1]) : undefined,
        command: command || 'Not found on PATH', launcherTarget: target || 'Unknown or foreign launcher',
        launcherMatchesSource: target === path.join(path.resolve(root), 'sylloom'),
        update: 'In sourceDirectory: git pull --ff-only, npm ci, npm run build, then ./sylloom install. Local data and models stay in place.' };
}

export async function installCommand(options: InstallOptions = {}): Promise<CommandInstallation> {
    const environment = options.environment || process.env;
    const userHome = options.userHome || homedir();
    const project = options.project || fileURLToPath(new URL('../', import.meta.url));
    const binary = options.node || process.execPath;
    // Homebrew's opt link survives upgrades and cleanup of old Cellar versions.
    const brew = binary.match(/^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/);
    const stable = brew ? path.join(brew[1]!, 'opt', brew[2]!, 'bin', 'node') : binary;
    const fallback = existsSync(stable) ? stable : binary;
    const directory = path.resolve(options.binDirectory || environment.SYLLOOM_BIN_DIR || path.join(userHome, '.local', 'bin'));
    if (/[:\r\n\0]/.test(directory)) throw new Error('The command directory cannot contain colons, newlines or null characters.');
    const command = path.join(directory, 'sylloom'); const entrypoint = path.resolve(project, 'sylloom');
    if (command === entrypoint) throw new Error('Choose a command directory outside the Sylloom checkout.');
    if (!existsSync(path.join(project, 'dist', 'cli.js'))) throw new Error('Build Sylloom first with ./install.sh or npm run build.');
    await mkdir(directory, { recursive: true });
    const existing = lstatSync(command, { throwIfNoEntry: false });
    if (existing) {
        const owned = existing.isSymbolicLink() ? path.resolve(directory, await readlink(command)) === entrypoint :
            existing.isFile() && (await readFile(command, 'utf8')).startsWith('#!/bin/sh\n' + marker + '\n');
        if (!owned) throw new Error('Existing command was preserved: ' + command);
    }
    const temporary = path.join(directory, '.sylloom-' + randomUUID() + '.tmp');
    try {
        const script = '#!/bin/sh\n' + marker + '\nruntime=' + quote(fallback) + '\n' +
            'if command -v node >/dev/null 2>&1 && node -e ' + quote('const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=18)?0:1)') + '; then\n' +
            '  runtime=node\nfi\n' +
            'export PATH="$PATH":' + quote(brew ? path.join(brew[1]!, 'bin') : '/opt/homebrew/bin') + ':' + quote('/usr/local/bin') + '\n' +
            'exec "$runtime" ' + quote(entrypoint) + ' "$@"\n';
        await writeFile(temporary, script, { mode: 0o755, flag: 'wx' });
        if (existing) await rename(temporary, command);
        else await link(temporary, command); // Atomic creation; never replace a competing command.
    } finally { await rm(temporary, { force: true }); }

    const onPath = (environment.PATH || '').split(path.delimiter).includes(directory);
    const shellFiles: string[] = [];
    if (!onPath && options.configurePath !== false) {
        const shell = path.basename(environment.SHELL || '/bin/zsh');
        let files: string[];
        let line = 'export PATH=' + quote(directory) + ':"$PATH"';
        if (shell === 'zsh') files = [path.join(environment.ZDOTDIR || userHome, '.zshrc')];
        else if (shell === 'bash') {
            const candidates = ['.bash_profile', '.bash_login', '.profile'].map(file => path.join(userHome, file));
            files = [path.join(userHome, '.bashrc'), candidates.find(file => existsSync(file)) || candidates[2]!];
        } else if (shell === 'fish') {
            files = [path.join(environment.XDG_CONFIG_HOME || path.join(userHome, '.config'), 'fish', 'config.fish')];
            line = 'fish_add_path --prepend -- ' + quote(directory);
        } else throw new Error('Command installed at ' + command + '. Add ' + directory + ' to your shell PATH. Supported automatic setup: zsh, bash and fish.');
        for (const file of files) {
            const current = existsSync(file) ? await readFile(file, 'utf8') : '';
            if (current.split(/\r?\n/).includes(line)) continue;
            await mkdir(path.dirname(file), { recursive: true });
            await appendFile(file, (current.endsWith('\n') || !current ? '' : '\n') + '\n# Sylloom command\n' + line + '\n', { mode: 0o600 });
            shellFiles.push(file);
        }
    }
    return { command, shellFiles, onPath };
}
