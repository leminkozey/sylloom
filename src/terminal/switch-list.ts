// Adapted from velora-cli/src/terminal/switch-list.ts. Uses the same draft,
// dependency rules and Save/Discard flow with Sylloom's existing terminal loop.
import type { Choice, Screen } from './screen.js';

export type SwitchRow = { value: string; name: string; enabled: boolean | null; hint: string;
    group?: string; section?: string; unavailable?: string; requires?: string };
type SwitchOptions = { rows: SwitchRow[]; saveLabel?: string; initialValue?: string; detail?: string; extra?: Choice[] };

export function changeSwitch(rows: SwitchRow[], value: string): SwitchRow[] {
    const index = rows.findIndex(row => row.value === value);
    const row = rows[index];
    if (!row || row.unavailable || row.requires && !rows.find(required => required.value === row.requires)?.enabled) return rows;
    const next = rows.map(row => ({ ...row }));
    next[index]!.enabled = !row.enabled;
    if (!next[index]!.enabled) for (const dependent of next) if (dependent.requires === value) dependent.enabled = false;
    return next;
}

export default async function switchList(screen: Screen, title: string, config: SwitchOptions): Promise<{ rows: SwitchRow[]; action: string } | null> {
    let draft = config.rows.map(row => ({ ...row }));
    let selected = config.initialValue;
    while (!screen.quitRequested) {
        selected = await screen.select(title, [...draft.map(row => ({ ...row, toggle: row.enabled ?? undefined,
            state: row.enabled === null ? 'Not set' : undefined })), ...(config.extra || []),
            { value: 'save', name: config.saveLabel || 'Save changes', action: true },
            { value: 'back', name: 'Discard changes', action: true }], {
            back: true, initialValue: selected, activateWithSpace: true, detail: config.detail || 'Save applies changes. Esc discards unsaved edits.',
            footer: '↑/↓ Move · Enter/Space Change · Esc Discard',
        });
        if (['back', 'quit', 'settings'].includes(selected)) return null;
        if (selected === 'save' || config.extra?.some(choice => choice.value === selected)) return { rows: draft, action: selected };
        draft = changeSwitch(draft, selected);
    }
    return null;
}
