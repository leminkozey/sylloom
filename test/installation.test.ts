import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installCommand } from '../src/installation.js';

test('global command handles spaces and shell syntax, works without Node on PATH, and is repeatable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-command-'));
    const project = path.join(root, "project's $(touch injected) files");
    const userHome = path.join(root, 'user'); const binDirectory = path.join(root, "bin's tools");
    try {
        await mkdir(path.join(project, 'dist'), { recursive: true }); await mkdir(userHome);
        await writeFile(path.join(project, 'dist', 'cli.js'), '');
        await writeFile(path.join(project, 'sylloom'), 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
        const options = { project, userHome, binDirectory, environment: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' } };
        await writeFile(path.join(userHome, '.zshrc'), '# Existing configuration');
        const first = await installCommand(options);
        assert.equal(first.shellFiles.length, 1);
        const config = await readFile(path.join(userHome, '.zshrc'), 'utf8');
        assert.ok(config.startsWith('# Existing configuration\n'));
        const arguments_ = ['--name', 'a b', "quote's", '$(touch injected)', 'äöü'];
        const result = spawnSync(first.command, arguments_, { cwd: userHome, env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { args: arguments_, cwd: await realpath(userHome) });
        assert.equal(existsSync(path.join(userHome, 'injected')), false);
        const second = await installCommand(options); assert.equal(second.shellFiles.length, 0);
        assert.equal(await readFile(path.join(userHome, '.zshrc'), 'utf8'), config);
        if (existsSync('/bin/zsh')) {
            const shell = spawnSync('/bin/zsh', ['-ic', 'command -v sylloom; sylloom --version'], { cwd: root, encoding: 'utf8',
                env: { ...process.env, HOME: userHome, ZDOTDIR: userHome, PATH: '/usr/bin:/bin' } });
            assert.equal(shell.status, 0, shell.stderr); assert.ok(shell.stdout.includes(first.command));
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('installation preserves foreign commands and dangling links, and migrates its own old symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-command-'));
    const project = path.join(root, 'project'); const binDirectory = path.join(root, 'bin');
    try {
        await mkdir(path.join(project, 'dist'), { recursive: true }); await mkdir(binDirectory);
        await writeFile(path.join(project, 'dist', 'cli.js'), ''); await writeFile(path.join(project, 'sylloom'), '');
        const options = { project, binDirectory, userHome: root, configurePath: false };
        const command = path.join(binDirectory, 'sylloom');
        await writeFile(command, 'foreign command'); await assert.rejects(installCommand(options), /Existing command was preserved/);
        assert.equal(await readFile(command, 'utf8'), 'foreign command'); await rm(command);
        await symlink(path.join(root, 'missing'), command); await assert.rejects(installCommand(options), /Existing command was preserved/); await rm(command);
        await symlink(path.join(project, 'sylloom'), command); await installCommand(options);
        assert.match(await readFile(command, 'utf8'), /Sylloom command launcher/);
        assert.equal(existsSync(path.join(root, '.zshrc')), false);
        await assert.rejects(installCommand({ ...options, binDirectory: project }), /outside/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('PATH setup respects custom zsh locations and existing bash login files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-shell-'));
    try {
        const project = path.join(root, 'project'); await mkdir(path.join(project, 'dist'), { recursive: true });
        await writeFile(path.join(project, 'dist', 'cli.js'), ''); await writeFile(path.join(project, 'sylloom'), '');
        const base = { project, userHome: root, binDirectory: path.join(root, 'bin') };
        const custom = path.join(root, 'zsh');
        await installCommand({ ...base, environment: { PATH: '/bin', SHELL: '/bin/zsh', ZDOTDIR: custom } });
        assert.equal(existsSync(path.join(custom, '.zshrc')), true); assert.equal(existsSync(path.join(root, '.zshrc')), false);
        await writeFile(path.join(root, '.bash_profile'), '# Existing login\n');
        await installCommand({ ...base, environment: { PATH: '/bin', SHELL: '/bin/bash' } });
        assert.match(await readFile(path.join(root, '.bash_profile'), 'utf8'), /^# Existing login\n/);
        assert.equal(existsSync(path.join(root, '.bashrc')), true); assert.equal(existsSync(path.join(root, '.profile')), false);
    } finally { await rm(root, { recursive: true, force: true }); }
});
