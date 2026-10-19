import { readFileSync } from 'node:fs';

export const name = 'sylloom';
export const displayName = 'Sylloom';
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; homepage?: string };
export const version = metadata.version;
export const repositoryUrl = metadata.homepage || '';

// Original seven-bar waveform. No upstream brand assets are included.
export const mark = ['      ▄      ', '  ▄   █   ▄  ', '  █ ▄ █ ▄ █  ', '▃ █ █ █ █ █ ▃'];
