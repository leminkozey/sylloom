export type Source = 'mic' | 'system';
export type Decision = 'summarize' | 'note-only' | 'keep' | 'delete';
export type DictationFormat = 'message' | 'email' | 'list';
export type Session = {
    id: string;
    name: string | null;
    startedAt: string;
    stoppedAt: string | null;
    state: 'recording' | 'paused' | 'stopped' | 'done';
    decision: Decision | null;
    recovered: boolean;
    transcriptionRevision?: number;
    pinned?: boolean;
    events: { at: string; message: string }[];
};
export type Segment = { source: Source; start: number; end: number; text: string };
export type Chunk = {
    profile?: string;
    language?: string;
    source: Source;
    offset: number;
    samples: number;
    state: 'done' | 'error';
    segments: Segment[];
    error?: string;
};
export type Settings = {
    input: string;
    output: string;
    language: string;
    live: boolean;
    whisperBinary: string;
    whisperModel: string;
    llm: 'llama' | 'ollama';
    llmBinary: string;
    llmModel: string;
    ollamaModel: string;
    ollamaUrl: string;
    dictationModel: string;
    dictationFormat: DictationFormat;
    dictationWhisperModel: string;
    dictationWarmSeconds: number;
    dictationPolish: 'auto' | 'always' | 'off';
    dictationAutoInsert: boolean;
    dictationShortcut: string;
    dictationTalkMode: 'toggle' | 'hold';
    globalShortcuts: boolean;
    copyLatestShortcut: boolean;
    dictationIndicator: boolean;
    dictationNotifications: boolean;
    calendarFile: string;
    bridgeEnabled: boolean;
    detectAppleCalls: boolean;
    detectWhatsAppCalls: boolean;
    detectTeamsCalls: boolean;
    callAutoStop: boolean;
    calendarAutoRefresh: boolean;
    calendarOutlook: boolean;
    calendarSystem: boolean;
    meetingReminders: boolean;
    reminderMinutes: number;
    teamsPort: number;
};
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function cleanText(text: string): string {
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
