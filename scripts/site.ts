import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { terminalNote } from './site-content.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'website');
const output = path.join(root, 'dist', 'site');
const mode = process.argv[2] || 'serve';
if (!['serve', 'build'].includes(mode)) throw new Error('Use site.ts serve or site.ts build.');

const config = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [], skipLibCheck: true };
const modules = (await readdir(source)).filter(name => name.endsWith('.ts'));
const program = ts.createProgram(modules.map(name => path.join(source, name)), config);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
}));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.endsWith('.ts')) continue;
    await cp(path.join(source, entry.name), path.join(output, entry.name), { recursive: true });
}
await writeFile(path.join(output, 'index.html'), (await readFile(path.join(source, 'index.html'), 'utf8')).replace('{{NOTE_OUTPUT}}', terminalNote()));
for (const name of modules) {
    const javascript = ts.transpileModule(await readFile(path.join(source, name), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
    await writeFile(path.join(output, name.replace(/\.ts$/, '.js')), javascript);
}
await mkdir(path.join(output, 'src'), { recursive: true });
await writeFile(path.join(output, 'src', 'waveform.js'), ts.transpileModule(await readFile(path.join(root, 'src', 'waveform.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText);
console.log('Built static product page: dist/site');
if (mode === 'serve') {
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
    const requestedPort = process.env.SYLLOOM_SITE_PORT || '4173';
    if (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1024 || Number(requestedPort) > 65535) throw new Error('SYLLOOM_SITE_PORT must be 1024–65535.');
    const server = createServer(async (request, response) => {
        if (!['GET', 'HEAD'].includes(request.method || '')) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
        try {
            const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
            const file = path.resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname));
            if (!file.startsWith(output + path.sep) || !types[path.extname(file)]) { response.writeHead(404); response.end(); return; }
            const data = await readFile(file);
            response.writeHead(200, { 'Content-Type': types[path.extname(file)]!, 'Content-Length': data.length,
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'self'; img-src 'self'; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
            response.end(request.method === 'HEAD' ? undefined : data);
        } catch { response.writeHead(404); response.end(); }
    });
    server.on('error', error => { console.error('Could not start preview: ' + error.message); process.exitCode = 1; });
    server.listen(Number(requestedPort), '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + requestedPort));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}
