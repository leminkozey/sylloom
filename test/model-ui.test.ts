import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Screen, Choice } from '../src/terminal/screen.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'sylloom-model-ui-')); process.env.SYLLOOM_HOME = root;
const { modelMenu } = await import('../src/model-ui.js'); const { defaults } = await import('../src/store.js');

test('model setup groups four purposes and changes only the selected role', async () => {
    const model = path.join(root, 'custom.bin'); await writeFile(model, 'fixture');
    const config = { ...defaults }; const steps = ['dictation-whisper', 'custom', 'back', 'back'];
    let menus = 0;
    const screen = { quitRequested: false,
        select: async (_title: string, choices: Choice[]) => {
            if (!menus++) {
                assert.deepEqual(choices.map(item => item.value), ['dictation-whisper', 'formatter', 'whisper', 'llama', 'back']);
                assert.ok(choices.slice(0, 4).every(item => item.state === 'Setup needed'));
            }
            return steps.shift()!;
        }, input: async () => model, notice: async () => assert.fail('Unexpected setup error'),
    };
    await modelMenu(screen as unknown as Screen, config);
    assert.equal(config.dictationWhisperModel, model); assert.equal(config.whisperModel, defaults.whisperModel);
    assert.equal(config.dictationModel, defaults.dictationModel); assert.equal(config.llmModel, defaults.llmModel);
    assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).dictationWhisperModel, model);
});

test('CLI and terminal branding use the package version and lockfile agrees', async () => {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const { version } = await import('../src/brand.js');
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), metadata.version);
    assert.equal(version, metadata.version); assert.equal(lock.version, metadata.version); assert.equal(lock.packages[''].version, metadata.version);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
