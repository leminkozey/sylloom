import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export type ModelServerOptions = { contextSize?: number; profile?: 'dictation' };

// This specialist is a base-model completion model, not a JSON/chat model.
export const usesCleanupModel = (model: string) => path.basename(model) === 'cleanup-1-q8_0.gguf';

// Whisper can recognize more languages than the cleanup model was trained on.
// Pass an actual detected language here when available, including its full name.
export function formatterSupportsLanguage(model: string, language: string): boolean {
    return !usesCleanupModel(model) || ['auto', 'en', 'english', 'de', 'german', 'es', 'spanish', 'fr', 'french',
        'zh', 'chinese', 'ru', 'russian', 'ja', 'japanese'].includes(language.toLowerCase());
}

const execute = promisify(execFile);
const capabilities = new Map<string, Promise<string>>();

function runtimeCapabilities(binary: string): Promise<string> {
    let help = capabilities.get(binary);
    if (!help) {
        help = execute(binary, ['--help'], { timeout: 3000, maxBuffer: 1024 * 1024, encoding: 'utf8' })
            .then(result => result.stdout + result.stderr).catch(() => '');
        capabilities.set(binary, help);
    }
    return help;
}

// Keep the process-local secret out of command arguments and persistent files.
// Older/custom servers without the documented environment contract stay on
// loopback without authentication; updating the runtime enables this protection.
export async function supportsLlamaAuthentication(binary: string): Promise<boolean> {
    const description = await runtimeCapabilities(binary);
    return /--api-key(?:\s|$)/.test(description) && /\bLLAMA_API_KEY\b/.test(description);
}

// Probe the installed binary once. Older/custom runtimes keep their normal args.
export async function dictationRuntimeArguments(binary: string): Promise<string[]> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return [];
    const description = await runtimeCapabilities(binary);
    if (!description.includes('--spec-type') || !description.includes('ngram-simple') ||
        !['--spec-ngram-simple-size-n', '--spec-ngram-simple-size-m', '--spec-draft-n-max'].every(flag => description.includes(flag))) return [];
    // Propose text from the transcript; the selected model still verifies it.
    // No draft model, re-quantization or extra resident weights.
    return ['--spec-type', 'ngram-simple', '--spec-ngram-simple-size-n', '3',
        '--spec-ngram-simple-size-m', '16', '--spec-draft-n-max', '16'];
}
