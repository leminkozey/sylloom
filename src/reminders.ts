import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { atomicJson, home } from './store.js';
import type { CalendarEvent } from './calendar.js';

export function upcomingTeamsMeetings(events: CalendarEvent[], minutes: number, now = Date.now()): CalendarEvent[] {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return [];
    return events.filter(event => !event.allDay && event.isTeams && Date.parse(event.start) > now && Date.parse(event.start) - now <= minutes * 60000)
        .sort((a, b) => a.start.localeCompare(b.start));
}

// Store only occurrence keys and times. A restart must not repeat a dismissed
// reminder, while a moved instance gets a reminder for its new start time.
export class MeetingReminders {
    private shown: Record<string, number> = {};
    private readable = true;
    private file = path.join(home, 'meeting-reminders.json');
    async load(): Promise<void> {
        if (!existsSync(this.file)) return;
        let data: unknown;
        try { data = JSON.parse(await readFile(this.file, 'utf8')); }
        catch { this.readable = false; throw new Error('Meeting reminder history is unreadable. Its file was preserved.'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) { this.readable = false; throw new Error('Meeting reminder history is unreadable. Its file was preserved.'); }
        this.shown = Object.fromEntries(Object.entries(data).filter((entry): entry is [string, number] => /^[a-f0-9]{32}:\d+$/.test(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1])));
    }
    async next(events: CalendarEvent[], minutes: number, now = Date.now()): Promise<CalendarEvent | undefined> {
        if (!this.readable) throw new Error('Meeting reminder history is unreadable. Its file was preserved.');
        const key = (event: CalendarEvent) => event.id + ':' + Date.parse(event.start);
        const event = upcomingTeamsMeetings(events, minutes, now).find(event => !Object.hasOwn(this.shown, key(event)));
        return event;
    }
    async markShown(event: CalendarEvent, now = Date.now()): Promise<void> {
        if (!this.readable) throw new Error('Meeting reminder history is unreadable. Its file was preserved.');
        const shown = Object.fromEntries(Object.entries(this.shown).filter(([, time]) => time > now - 7 * 86400000));
        shown[event.id + ':' + Date.parse(event.start)] = now;
        await atomicJson(this.file, shown); this.shown = shown;
    }
}
