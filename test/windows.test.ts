import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { windowsLauncher, windowsLauncherTarget, installWindowsCommand } from '../src/native/windows/installation.js';
import { windowsCallProcess } from '../src/native/windows/app-reader.js';
import { notificationCallApp, callControls } from '../src/native/app-reader.js';
import { processCommand } from '../src/process-command.js';

test('Windows call observation only accepts known native app processes and attributed call controls', () => {
    for (const name of ['ms-teams.exe', 'MSTeams.exe', 'Teams.exe']) assert.equal(windowsCallProcess(path.win32.join('C:', 'Apps', name)), 'teams');
    assert.equal(windowsCallProcess('WhatsApp.Root.exe'), 'whatsapp');
    assert.equal(windowsCallProcess('PhoneExperienceHost.exe'), 'apple');
    assert.equal(windowsCallProcess('ShellExperienceHost.exe'), 'notification');
    for (const name of ['notteams.exe', 'msedge.exe', 'outlook.exe', 'ms-teams.exe.backup']) assert.equal(windowsCallProcess(name), undefined);
    assert.equal(notificationCallApp('', 'Phone Link'), 'apple');
    assert.equal(notificationCallApp('', 'a message about Phone Link'), undefined);
    assert.equal(callControls(['accept-call', 'decline-call'], 'teams', true), 'ringing');
    assert.equal(callControls(['microphone', 'Join now'], 'teams', true), 'joining');
    assert.equal(callControls(['mute-button', 'hangup-button'], 'teams', true), 'active');
});

test('Windows launcher preserves paths literally and can identify its own target', () => {
    const entry = path.win32.join('C:', 'Tools 100% & notes', 'sylloom');
    const content = windowsLauncher('C:\\Runtime tools\\node.exe', entry);
    assert.equal(windowsLauncherTarget(content), entry);
    assert.match(content, /DisableDelayedExpansion/);
    assert.match(content, /100%% & notes/);
    assert.equal(windowsLauncherTarget('@echo off\nforeign command'), undefined);
    assert.throws(() => windowsLauncher('node" & command', entry), /Invalid/);
    assert.throws(() => windowsLauncher('node', 'line\nbreak'), /Invalid/);
    assert.deepEqual(processCommand('runtime.mjs', ['a b']), [process.execPath, ['runtime.mjs', 'a b']]);
    assert.deepEqual(processCommand('llama-server.exe', ['--help']), ['llama-server.exe', ['--help']]);
});

test('Windows per-user command installation preserves foreign commands and works outside the checkout', { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sylloom-win-command-'));
    try {
        const project = path.join(root, 'project with spaces'), binDirectory = path.join(root, 'command tools');
        await mkdir(path.join(project, 'dist'), { recursive: true });
        await mkdir(binDirectory);
        await writeFile(path.join(project, 'dist', 'cli.js'), '');
        await writeFile(path.join(project, 'sylloom'), 'console.log(JSON.stringify(process.argv.slice(2)));');
        const options = { project, binDirectory, configurePath: false };
        const file = path.join(binDirectory, 'sylloom.cmd');
        await writeFile(file, '@echo off\r\necho foreign\r\n');
        await assert.rejects(installWindowsCommand(options), /preserved/);
        await rm(file);
        const installed = await installWindowsCommand(options);
        const first = await readFile(file, 'utf8');
        await installWindowsCommand(options);
        assert.equal(await readFile(file, 'utf8'), first);
        assert.equal(windowsLauncherTarget(first), path.join(project, 'sylloom'));
        assert.deepEqual(installed.shellFiles, []);
        // Invoke the batch launcher as Windows users do, with the command shell
        // confined to this test's known fixture paths and arguments.
        const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '""' + installed.command + '" --version "a b""'], { encoding: 'utf8', cwd: root, windowsVerbatimArguments: true });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), ['--version', 'a b']);
    } finally { await rm(root, { recursive: true, force: true }); }
});
