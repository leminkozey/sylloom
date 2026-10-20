import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelServer } from '../src/server.js';

const nativeProfile = process.platform === 'darwin' && process.arch === 'arm64';

test('dictation acceleration probes installed capabilities once and preserves normal servers', { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sylloom-runtime-'));
    const model = path.join(root, 'fixture.bin'); await writeFile(model, 'Synthetic fixture');
    try {
        for (const mode of ['supported', 'old', 'failed'] as const) {
            const binary = path.join(root, mode + '.mjs');
            const flags = mode === 'supported'
                ? '--spec-type ngram-simple --spec-ngram-simple-size-n --spec-ngram-simple-size-m --spec-draft-n-max'
                : '--model --port --ctx-size';
            await writeFile(binary, '#!' + process.execPath + '\n' + `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const args = process.argv.slice(2);
if (args.includes('--help')) {
    appendFileSync(process.argv[1] + '.probes', 'x');
    console.log(${JSON.stringify(flags)}); process.exit(${mode === 'failed' ? 1 : 0});
}
const model = args[args.indexOf('--model') + 1];
writeFileSync(model + '.args.json', JSON.stringify(args));
createServer((_request, response) => { response.end('{}'); }).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
`, { mode: 0o700 });
            for (const profile of ['dictation', 'dictation', undefined] as const) {
                const server = new ModelServer(binary, model, 'llama', { profile });
                try {
                    await server.start();
                    const args: string[] = JSON.parse(await readFile(model + '.args.json', 'utf8'));
                    assert.equal(args.includes('--spec-type'), nativeProfile && mode === 'supported' && profile === 'dictation');
                    assert.equal(args[args.indexOf('--model') + 1], model);
                    assert.equal(args[args.indexOf('--parallel') + 1], '1');
                } finally { await server.stop(); }
            }
            if (nativeProfile) assert.equal(await readFile(binary + '.probes', 'utf8'), 'x', 'Capability probes are shared across servers');
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});
