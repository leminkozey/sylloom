import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sourceFingerprint } from '../src/build-info.js';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), [], { cwd: root, stdio: 'inherit' });
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(root, 'dist', 'build-info.json'), JSON.stringify({ version: metadata.version,
    sourceHash: await sourceFingerprint(root), builtAt: new Date().toISOString() }, null, 2) + '\n');
