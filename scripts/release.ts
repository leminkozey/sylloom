import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, copyFile, chmod, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const roots = ['src', 'test', 'scripts', 'assets', '.github'];
const files = ['README.md', 'DESIGN.md', 'NOTICE.md', 'AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', 'install.sh', 'sylloom'];

export async function publicFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    const visit = async (relative: string): Promise<void> => {
        const info = await lstat(path.join(root, relative));
        if (info.isSymbolicLink()) throw new Error('Release contains a symlink: ' + relative);
        if (info.isDirectory()) {
            for (const name of (await readdir(path.join(root, relative))).sort()) {
                if (name === '.DS_Store') continue;
                if (name.startsWith('.')) throw new Error('Unexpected hidden release entry: ' + relative + '/' + name);
                await visit(path.join(relative, name));
            }
        } else if (info.isFile()) {
            const directory = relative.split(path.sep)[0]!;
            const extensions: Record<string, RegExp> = { src: /\.ts$/, test: /\.test\.ts$/, scripts: /\.ts$/, assets: /\.svg$/, '.github': /\.ya?ml$/ };
            if (extensions[directory] && !extensions[directory]!.test(relative)) throw new Error('Unexpected release file type: ' + relative);
            result.push(relative);
        }
        else throw new Error('Unexpected release entry: ' + relative);
    };
    for (const relative of [...files, ...roots]) {
        if (existsSync(path.join(root, relative))) await visit(relative);
    }
    return result.sort();
}

export async function checkPublicFiles(root: string, selected: string[]): Promise<void> {
    const identities = [...new Set([userInfo().username, path.basename(homedir()), ...(process.env.SYLLOOM_PRIVACY_TERMS || '').split(',')])]
        .filter(value => value.length >= 3 && !['runner', 'root', 'user'].includes(value.toLowerCase()));
    const rules: [string, RegExp][] = [
        ['absolute user path', /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"'`]+/i],
        ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
        ['credential token', /\b(?:sk-[a-zA-Z0-9]{20,}|gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,})\b/],
        ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ];
    for (const relative of selected) {
        if (/\.(?:wav|aiff|mp3|m4a|gguf|bin|log)$/i.test(relative)) throw new Error('Private or binary data in release: ' + relative);
        const content = await readFile(path.join(root, relative), 'utf8');
        for (const [label, pattern] of rules) if (pattern.test(content)) throw new Error('Release check found ' + label + ' in ' + relative);
        for (const identity of identities) {
            const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'iu').test(content)) {
                throw new Error('Release check found a local identity in ' + relative);
            }
        }
    }
}

async function main(): Promise<void> {
    const selected = await publicFiles(project);
    for (const required of [...files, 'src/cli.ts', 'assets/logo.svg']) {
        if (!selected.includes(required)) throw new Error('Required release file missing: ' + required);
    }
    await checkPublicFiles(project, selected);
    console.log('Checked ' + selected.length + ' public source files. No matching private paths, identities or credentials found.');
    if (process.argv.includes('--check')) return;
    const metadata = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')) as { version: string };
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid release version.');
    const label = 'sylloom-' + metadata.version;
    const temporary = await mkdtemp(path.join(tmpdir(), 'sylloom-release-'));
    const output = path.join(project, 'release');
    try {
        const directory = path.join(temporary, label); await mkdir(directory);
        const manifest: { file: string; sha256: string }[] = [];
        for (const relative of selected) {
            const target = path.join(directory, relative);
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(path.join(project, relative), target);
            await chmod(target, ['sylloom', 'install.sh'].includes(relative) ? 0o755 : 0o644);
            manifest.push({ file: relative, sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
        }
        await writeFile(path.join(directory, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
        await mkdir(output, { recursive: true });
        const archive = path.join(output, label + '-source.tar.gz');
        const result = spawnSync('tar', ['-czf', archive, '-C', temporary, '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root', label], {
            encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
        });
        if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Could not create source archive.');
        const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
        await writeFile(archive + '.sha256', digest + '  ' + path.basename(archive) + '\n');
        console.log(path.relative(project, archive));
    } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
