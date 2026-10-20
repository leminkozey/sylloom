import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'sylloom-model-auth-'));
process.env.SYLLOOM_HOME = root;
const { ModelServer } = await import('../src/server.js');
const { defaults, sessionDirectory } = await import('../src/store.js');
const { formatDictation } = await import('../src/formatter.js');
const { summarize } = await import('../src/notes.js');
const note = { overview: 'A synthetic project review.', topics: [], decisions: [], openQuestions: [], nextSteps: [], risks: [] };

async function fixture(mode: 'supported' | 'flag-only' | 'old' | 'diagnostic') {
    const directory = path.join(root, randomUUID()); await mkdir(directory);
    const binary = path.join(directory, 'server.mjs');
    const help = mode === 'old' ? '--model --port' : '--api-key KEY' + (mode === 'flag-only' ? '' : ' (env: LLAMA_API_KEY)');
    await writeFile(binary, '#!' + process.execPath + '\n' + `
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const args = process.argv.slice(2);
if (args.includes('--help')) { appendFileSync(process.argv[1] + '.probes', 'x'); console.log(${JSON.stringify(help)}); process.exit(0); }
const key = process.env.LLAMA_API_KEY;
if (${JSON.stringify(mode)} === 'diagnostic') { console.error('Synthetic runtime failure, key=' + key); process.exit(1); }
createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/health' && key && request.headers.authorization !== 'Bearer ' + key) { response.writeHead(401); response.end('{}'); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const cleaned = 'Please review the package.';
    const result = request.url === '/tokenize' ? { tokens: [1,2,3] } : request.url === '/completion' ? { content: cleaned, stop: true } : request.url === '/v1/chat/completions' ? {
        choices: [{ message: { content: JSON.stringify(input.response_format?.json_schema?.name === 'meeting_note' ? ${JSON.stringify(note)} : { cleaned_text: cleaned }) }, finish_reason: 'stop' }],
    } : {};
    response.end(JSON.stringify(result));
}).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
`, { mode: 0o700 });
    const model = path.join(directory, 'fixture.gguf'); await writeFile(model, 'Synthetic weights placeholder');
    return { binary, model, directory };
}

test('managed llama requires an ephemeral key, refuses browser simple POSTs and shares capability probes', async () => {
    const { binary, model } = await fixture('supported');
    let previous = '';
    for (let restart = 0; restart < 2; restart++) {
        const server = new ModelServer(binary, model, 'llama', { profile: 'dictation' });
        try {
            const url = await server.start();
            const authorization = server.headers.Authorization!;
            assert.ok(authorization.startsWith('Bearer ')); assert.ok(authorization !== previous, 'Each process must get a new key'); previous = authorization;
            for (const headers of [{}, { Origin: 'https://review.example.invalid' }]) {
                const response = await fetch(url + '/completion', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' });
                assert.equal(response.status, 401); await response.body?.cancel();
            }
            const response = await fetch(url + '/completion', { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' }, body: '{}' });
            assert.equal(response.status, 200); await response.body?.cancel();
        } finally { await server.stop(); }
    }
    assert.equal(await readFile(binary + '.probes', 'utf8'), 'x');
});

test('unsupported custom runtimes and Whisper do not receive managed authentication', async () => {
    for (const mode of ['old', 'flag-only', 'supported'] as const) {
        const { binary, model } = await fixture(mode);
        const kind = mode === 'supported' ? 'whisper' : 'llama';
        const server = new ModelServer(binary, model, kind);
        try {
            const url = await server.start(); assert.deepEqual(server.headers, {});
            const response = await fetch(url + '/completion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.equal(response.status, 200); await response.body?.cancel();
        } finally { await server.stop(); }
    }
});

test('runtime diagnostics redact a logged process-local secret', async () => {
    const { binary, model } = await fixture('diagnostic');
    const server = new ModelServer(binary, model, 'llama');
    try {
        let message = '';
        try { await server.start(); assert.fail('Diagnostic runtime must fail'); } catch (error) { message = String(error); }
        const key = server.headers.Authorization!.slice('Bearer '.length);
        assert.ok(key.length > 30); assert.ok(!message.includes(key), 'Diagnostic exposed the runtime key'); assert.match(message, /\[redacted\]/);
    } finally { await server.stop(); }
});

test('both formatter protocols and managed meeting notes propagate only their own server key', async () => {
    const { binary, directory } = await fixture('supported');
    for (const name of ['cleanup-1-q8_0.gguf', 'quality.gguf']) {
        const model = path.join(directory, name); await writeFile(model, 'Synthetic weights placeholder');
        const result = await formatDictation('um please review the package', 'message', { ...defaults, llmBinary: binary, dictationModel: model, dictationPolish: 'always', language: 'en' });
        assert.equal(result, 'Please review the package.');
    }
    const session = { id: randomUUID(), name: 'Synthetic review', state: 'stopped' as const, startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), decision: null, recovered: false, events: [] };
    await mkdir(sessionDirectory(session.id), { recursive: true });
    const file = await summarize(session, '[00:00:01] Microphone: We reviewed the project.', { ...defaults, llmBinary: binary, llmModel: path.join(directory, 'quality.gguf') }, () => {});
    assert.match(await readFile(file, 'utf8'), /synthetic project review/);
});

test('external Ollama requests never receive a managed llama key', async context => {
    context.mock.getter(ModelServer.prototype, 'headers', () => ({ Authorization: 'Bearer synthetic-managed-only' }));
    context.mock.method(ModelServer.prototype, 'start', async () => { throw new Error('External Ollama cannot start a managed llama server'); });
    let requests = 0;
    context.mock.method(globalThis, 'fetch', async (_url, options) => {
        requests++; assert.equal(new Headers(options?.headers).has('Authorization'), false);
        return Response.json({ message: { content: JSON.stringify(note) }, done_reason: 'stop' });
    });
    const session = { id: randomUUID(), name: 'External synthetic review', state: 'stopped' as const, startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), decision: null, recovered: false, events: [] };
    await mkdir(sessionDirectory(session.id), { recursive: true });
    await summarize(session, '[00:00:01] Microphone: We reviewed the project.', { ...defaults, llm: 'ollama' }, () => {});
    assert.equal(requests, 1);
});

after(async () => { await rm(root, { recursive: true, force: true }); });
