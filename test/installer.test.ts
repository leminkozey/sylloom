import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('installer preserves commands, respects model profiles and stops on failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-installer-test-'));
    const project = path.join(root, 'project with spaces');
    const commands = path.join(root, 'commands');
    const links = path.join(root, 'links');
    const log = path.join(root, 'calls.txt');
    try {
        for (const directory of [project, commands, links]) await mkdir(directory);
        await copyFile(new URL('../install.sh', import.meta.url), path.join(project, 'install.sh'));
        await writeFile(path.join(project, 'sylloom'), '#!/bin/sh\n');
        const stubs = {
            uname: 'if [ "$1" = -s ]; then echo "${SYLLOOM_QA_OS:-Darwin}"; else echo arm64; fi',
            sw_vers: 'echo 14.4',
            node: 'if [ "$1" = -e ]; then exit 0; fi; printf "node %s\\n" "$*" >> "$SYLLOOM_QA_LOG"',
            npm: 'printf "npm %s\\n" "$*" >> "$SYLLOOM_QA_LOG"; exit "${SYLLOOM_QA_NPM_FAIL:-0}"',
            'whisper-server': 'exit 0',
            'llama-server': 'exit 0',
            brew: 'exit 1',
        };
        for (const [name, script] of Object.entries(stubs)) await writeFile(path.join(commands, name), '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
        const run = async (args: string[], extra: Record<string, string> = {}) => {
            await writeFile(log, '');
            const result = spawnSync('/bin/bash', [path.join(project, 'install.sh'), ...args], { encoding: 'utf8',
                env: { ...process.env, PATH: commands + ':/usr/bin:/bin', SYLLOOM_BIN_DIR: links, SYLLOOM_QA_LOG: log, ...extra } });
            return { ...result, calls: await readFile(log, 'utf8') };
        };
        let result = await run(['--check']); assert.equal(result.status, 0, result.stderr); assert.equal(result.calls, '');
        result = await run(['--dictation-only', '--no-link']); assert.equal(result.status, 0, result.stderr);
        assert.match(result.calls, /npm ci\nnpm run build/);
        assert.match(result.calls, /models install dictation-whisper --keep-selection/);
        assert.match(result.calls, /models install formatter --keep-selection/);
        assert.doesNotMatch(result.calls, /models install (?:all|llama|whisper) /);
        result = await run(['--skip-models', '--no-link']); assert.equal(result.status, 0); assert.doesNotMatch(result.calls, /models install/);
        result = await run(['--no-link']); assert.equal(result.status, 0); assert.match(result.calls, /models install all --keep-selection/);
        result = await run(['--no-link'], { SYLLOOM_QA_NPM_FAIL: '1' }); assert.notEqual(result.status, 0); assert.doesNotMatch(result.calls, /models install/);
        result = await run(['--check'], { SYLLOOM_QA_OS: 'Linux' }); assert.notEqual(result.status, 0); assert.equal(result.calls, '');
        await writeFile(path.join(links, 'sylloom'), 'existing command');
        result = await run(['--skip-models']); assert.notEqual(result.status, 0); assert.match(result.stderr, /Existing command was preserved/);
        assert.equal(await readFile(path.join(links, 'sylloom'), 'utf8'), 'existing command');
    } finally { await rm(root, { recursive: true, force: true }); }
});
