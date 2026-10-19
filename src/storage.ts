import { lstat, readdir, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { home, scanSessions } from './store.js';
import { loadLibrary } from './library.js';
import type { Settings } from './types.js';

export async function directoryBytes(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) total += await directoryBytes(file);
        else if (entry.isFile()) total += (await lstat(file)).size;
    }
    return total;
}
export const formatBytes = (bytes: number): string => bytes < 1024 ** 2 ? Math.round(bytes / 1024) + ' KiB' : bytes < 1024 ** 3 ? (bytes / 1024 ** 2).toFixed(1) + ' MiB' : (bytes / 1024 ** 3).toFixed(2) + ' GiB';
export async function storageOverview(config: Settings): Promise<string[]> {
    const library = await loadLibrary();
    const catalog = await scanSessions();
    const [meetings, dictations, models, disk] = await Promise.all([
        directoryBytes(path.join(home, 'recordings')), directoryBytes(path.join(home, 'dictations')),
        directoryBytes(path.join(home, 'models')), statfs(home).catch(() => undefined),
    ]);
    const pending = library.items.filter(item => ['failed', 'canceled', 'interrupted', 'pending'].includes(item.status));
    const model = (label: string, file: string) => label + ': ' + (existsSync(file) ? 'Ready' : 'Missing · Local models → Install');
    return ['# Storage and recovery', '', '## Local storage', '',
        '- Meetings: ' + formatBytes(meetings), '- Dictations: ' + formatBytes(dictations), '- Bundled models: ' + formatBytes(models),
        '- Free disk space: ' + (disk ? formatBytes(disk.bavail * disk.bsize) : 'Unavailable'), '',
        'Audio and text stay saved until you explicitly delete an item.', '', '## Recovery', '',
        '- ' + pending.length + ' items need attention. Open Library → Needs attention.',
        '- ' + library.warnings.length + ' items could not be indexed. Their files are preserved.', '',
        ...pending.slice(0, 15).map(item => '- ' + item.title.replace(/[\r\n]/g, ' ') + ' · ' + item.status), '',
        ...(catalog.issues.length ? ['## Unreadable recordings', '',
            'New meetings are blocked until these metadata files are repaired. Dictation, existing notes and settings remain available.',
            'Restore session.json from a backup or inspect the preserved folder. Never invent a transcript decision.', '',
            ...catalog.issues.flatMap(issue => ['- ' + issue.id + ': ' + issue.message, '  Metadata: ' + issue.file]), ''] : []),
        ...(library.warnings.length ? ['## Index warnings', '', ...library.warnings.map(warning => '- ' + warning), ''] : []),
        '## Model readiness', '', model('Meeting recognition', config.whisperModel), model('Dictation recognition', config.dictationWhisperModel),
        model('Dictation formatter', config.dictationModel), model('Note model', config.llmModel), '',
        'Permissions and audio devices: sylloom doctor. External custom model files are not included in bundled model storage.'];
}
