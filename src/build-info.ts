import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function sourceFingerprint(root: string): Promise<string> {
    const files = ['package.json', 'package-lock.json', 'tsconfig.json'];
    const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile() && file.endsWith('.ts')) files.push(file);
        }
    };
    await visit('src');
    const hash = createHash('sha256');
    for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(path.join(root, file))).update('\0');
    return hash.digest('hex');
}
