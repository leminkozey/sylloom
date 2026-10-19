import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { modelDirectory, saveSettings } from './store.js';
import { models, installModel } from './models.js';
import { dictationConfig } from './dictation-models.js';
import type { Settings } from './types.js';
import { errorMessage } from './types.js';
import type { Screen, Choice } from './terminal/screen.js';

const back = { value: 'back', name: 'Back' };
const sections = [
    { kind: 'dictation-whisper', key: 'dictationWhisperModel', title: 'Dictation', purpose: 'Turn your voice into text quickly.', size: '1.5 GiB' },
    { kind: 'formatter', key: 'dictationModel', title: 'Dictation formatting', purpose: 'Polish messages, emails and lists.', size: '2.6 GiB' },
    { kind: 'whisper', key: 'whisperModel', title: 'Meeting transcription', purpose: 'Transcribe microphone and system audio after a meeting.', size: '2.9 GiB' },
    { kind: 'llama', key: 'llmModel', title: 'Meeting notes', purpose: 'Turn a transcript into a structured note.', size: '2.3 GiB' },
] as const;
type Section = typeof sections[number];
const selectedFile = (section: Section, config: Settings) => section.kind === 'dictation-whisper' ? dictationConfig(config).whisperModel : config[section.key];
const available = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };
const status = (section: Section, config: Settings) => section.kind === 'llama' && config.llm === 'ollama' ? 'Ollama' : available(selectedFile(section, config)) ? 'Ready' : 'Setup needed';
const label = (section: Section, config: Settings) => {
    if (section.kind === 'llama' && config.llm === 'ollama') return config.ollamaModel;
    const file = path.basename(selectedFile(section, config));
    return Object.values(models).find(model => model.file === file)?.label || file;
};

export async function modelMenu(screen: Screen, config: Settings): Promise<void> {
    while (!screen.quitRequested) {
        const selected = await screen.select('Local models', [...sections.map(section => ({
            value: section.kind, name: section.title + ' · ' + status(section, config),
            hint: label(section, config) + ' · ' + section.purpose,
        })), back], { back: true, detail: 'Choose what you want to use. Manage its model on the next screen.' });
        const section = sections.find(section => section.kind === selected);
        if (!section || screen.quitRequested) return;
        await sectionMenu(screen, config, section);
    }
}

async function sectionMenu(screen: Screen, config: Settings, section: Section): Promise<void> {
    while (!screen.quitRequested) {
        const usingOllama = section.kind === 'llama' && config.llm === 'ollama';
        const bundled = path.join(modelDirectory, models[section.kind].file);
        const current = selectedFile(section, config);
        const items: Choice[] = usingOllama ? [
            { value: 'ollama-model', name: 'Ollama model: ' + config.ollamaModel, hint: 'Choose a model already installed in your local Ollama.' },
        ] : [
            { value: 'recommended', name: existsSync(bundled) ? 'Use recommended model' : 'Install recommended model · ' + section.size,
                hint: models[section.kind].label + (current === bundled && existsSync(bundled) ? ' · Selected' : '') },
            { value: 'custom', name: 'Choose a custom model file…', hint: 'Select an existing compatible model on this Mac.' },
        ];
        if (section.kind === 'llama') items.push({ value: 'backend', name: 'Backend: ' + (usingOllama ? 'Ollama' : 'llama.cpp'), hint: 'Switch the local backend for meeting notes.' });
        items.push(back);
        const action = await screen.select(section.title, items, { back: true,
            detail: status(section, config) + ' · ' + (usingOllama ? config.ollamaModel : path.basename(current)),
            before: () => [section.purpose, ''],
        });
        if (['back', 'quit', 'settings'].includes(action) || screen.quitRequested) return;
        try {
            if (action === 'recommended') {
                const target = existsSync(bundled) ? bundled : await screen.task('Installing ' + models[section.kind].label, (update, signal) =>
                    installModel(section.kind, (received, total) => update(Math.round(received / total * 100) + '% · ' + Math.round(received / 1024 / 1024) + ' / ' + Math.round(total / 1024 / 1024) + ' MiB'), signal));
                config[section.key] = target;
            }
            if (action === 'custom') {
                const value = await screen.input(section.title + ' model', 'Path to an existing compatible model file', current);
                if (value?.trim()) {
                    const file = path.resolve(value.trim());
                    if (!existsSync(file) || !statSync(file).isFile()) throw new Error('Model file not found.');
                    config[section.key] = file;
                }
            }
            if (action === 'backend') config.llm = usingOllama ? 'llama' : 'ollama';
            if (action === 'ollama-model') {
                const value = await screen.input('Ollama model', 'Name of an already installed local model', config.ollamaModel);
                if (value?.trim()) config.ollamaModel = value.trim();
            }
            await saveSettings(config);
        } catch (error) { await screen.notice('Model setup failed', errorMessage(error)); }
    }
}
