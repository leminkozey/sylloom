import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { homedir } from 'node:os';
import ICAL from 'ical.js';
import { atomicJson, home } from './store.js';
import { cleanText, errorMessage } from './types.js';
import type { Settings } from './types.js';

export type CalendarEvent = { id: string; source: 'outlook' | 'system' | 'ics' | 'outlook-visible'; calendarId: string; uid: string;
    occurrence: string; title: string; start: string; end: string; timezone: string; allDay: boolean; joinUrl?: string; isTeams?: boolean };
export type CalendarStatus = { source: string; state: 'ready' | 'partial' | 'unavailable'; message: string };
export type CalendarSnapshot = { events: CalendarEvent[]; statuses: CalendarStatus[]; updatedAt: string; from: string; to: string; stale?: boolean };
const exec = promisify(execFile);
const cacheFile = () => path.join(home, 'calendar-cache.json');
export const eventId = (source: string, calendar: string, uid: string, occurrence: string) => createHash('sha256').update(JSON.stringify([source, calendar, uid, occurrence])).digest('hex').slice(0, 32);
const safe = (text: unknown, limit = 300) => cleanText(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, limit);

export function calendarRange(anchor = new Date(), days = 42): { from: string; to: string } {
    const from = new Date(anchor); from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + days);
    return { from: from.toISOString(), to: to.toISOString() };
}
export function validateRange(from: string, to: string): void {
    const length = Date.parse(to) - Date.parse(from);
    if (!Number.isFinite(length) || length <= 0 || length > 93 * 86400000) throw new Error('Choose a calendar range of no more than 93 days.');
}
export function normalizeEvent(value: Omit<CalendarEvent, 'id'>): CalendarEvent {
    if (!Number.isFinite(Date.parse(value.start)) || !Number.isFinite(Date.parse(value.end)) || Date.parse(value.end) <= Date.parse(value.start)) throw new Error('Calendar event has invalid dates.');
    const title = safe(value.title) || 'Untitled event';
    let joinUrl: string | undefined;
    try { const url = new URL(value.joinUrl || ''); if (url.protocol === 'https:' && /(^|\.)teams\.microsoft\.com$|(^|\.)teams\.live\.com$/.test(url.hostname)) joinUrl = url.href; } catch {}
    return { ...value, title, start: new Date(value.start).toISOString(), end: new Date(value.end).toISOString(), joinUrl, isTeams: Boolean(joinUrl || value.isTeams === true),
        id: eventId(value.source, value.calendarId, value.uid, value.occurrence) };
}
export function teamsLink(text: string): string | undefined {
    return text.match(/https:\/\/(?:[\w-]+\.)?teams\.(?:microsoft|live)\.com\/[^\s<>"']+/i)?.[0];
}

export function parseCalendarFile(text: string, from: string, to: string, identity = 'local-file'): CalendarEvent[] {
    validateRange(from, to);
    if (Buffer.byteLength(text) > 5 * 1024 ** 2) throw new Error('Calendar file exceeds 5 MiB. Export a smaller date range.');
    const root = new ICAL.Component(ICAL.parse(text));
    const zones = root.getAllSubcomponents('vtimezone').map(zone => new ICAL.Timezone(zone));
    const knownZones = new Set(['UTC', 'GMT', ...zones.map(zone => zone.tzid)]);
    const previousZones = zones.map(zone => ({ id: zone.tzid, previous: ICAL.TimezoneService.get(zone.tzid) }));
    for (const zone of zones) ICAL.TimezoneService.register(zone);
    const events: CalendarEvent[] = []; const seen = new Set<string>(); const deadline = performance.now() + 1500;
    try {
    for (const component of root.getAllSubcomponents('vevent')) {
        const event = new ICAL.Event(component);
        if (event.isRecurrenceException() || component.getFirstPropertyValue('status') === 'CANCELLED') continue;
        const tzid = String(component.getFirstProperty('dtstart')?.getParameter('tzid') || '');
        if (tzid && !knownZones.has(tzid)) throw new Error('The ICS timezone needs a VTIMEZONE definition: ' + safe(tzid));
        const iterator = event.iterator();
        for (let count = 0; ; count++) {
            if (count > 20000 || performance.now() > deadline || events.length >= 2000) throw new Error('Calendar expansion limit reached. Export a smaller date range.');
            const occurrence = iterator.next(); if (!occurrence) break;
            const detail = event.getOccurrenceDetails(occurrence);
            const start = detail.startDate.toJSDate(); const end = detail.endDate.toJSDate();
            if (detail.item.component.getFirstPropertyValue('status') !== 'CANCELLED' && end.getTime() > Date.parse(from) && start.getTime() < Date.parse(to)) {
                const value = normalizeEvent({ source: 'ics', calendarId: identity, uid: event.uid, occurrence: occurrence.toString(),
                    title: detail.item.summary, start: start.toISOString(), end: end.toISOString(), timezone: tzid || (detail.startDate.zone.tzid === 'UTC' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone),
                    allDay: detail.startDate.isDate, joinUrl: teamsLink(['url', 'location', 'description'].map(key => detail.item.component.getFirstPropertyValue(key) || '').join(' ')) });
                if (!seen.has(value.id)) { seen.add(value.id); events.push(value); }
            }
            if (!event.isRecurring() || occurrence.toJSDate().getTime() >= Date.parse(to)) break;
        }
    }
    // A moved exception can fall inside the requested range even when its
    // original occurrence is outside the iterator's upper bound.
    for (const component of root.getAllSubcomponents('vevent')) {
        const event = new ICAL.Event(component);
        if (!event.isRecurrenceException()) continue;
        const occurrence = event.recurrenceId.toString();
        const id = eventId('ics', identity, event.uid, occurrence);
        const existing = events.findIndex(value => value.id === id);
        if (existing >= 0) events.splice(existing, 1);
        if (component.getFirstPropertyValue('status') === 'CANCELLED') continue;
        const tzid = String(component.getFirstProperty('dtstart')?.getParameter('tzid') || '');
        if (tzid && !knownZones.has(tzid)) throw new Error('The ICS timezone needs a VTIMEZONE definition: ' + safe(tzid));
        const start = event.startDate.toJSDate(), end = event.endDate.toJSDate();
        if (end.getTime() > Date.parse(from) && start.getTime() < Date.parse(to)) events.push(normalizeEvent({ source: 'ics', calendarId: identity,
            uid: event.uid, occurrence, title: event.summary, start: start.toISOString(), end: end.toISOString(), allDay: event.startDate.isDate,
            timezone: tzid || (event.startDate.zone.tzid === 'UTC' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone), joinUrl: teamsLink(['url', 'location', 'description'].map(key => component.getFirstPropertyValue(key) || '').join(' ')) }));
    }
    return events.sort((a, b) => a.start.localeCompare(b.start));
    } finally {
        for (const zone of previousZones) { if (zone.previous) ICAL.TimezoneService.register(zone.previous); else ICAL.TimezoneService.remove(zone.id); }
    }
}

const outlookScript = 'const teamsLink=' + teamsLink.toString() + ';\n' + `function run(args) {
 const app=Application('Microsoft Outlook');
 if(!app.running()) return JSON.stringify({unavailable:'Open Outlook to read its local calendar.'});
 const collection=app.calendarEvents.whose({_and:[{startTime:{_lessThan:new Date(args[1])}},{endTime:{_greaterThan:new Date(args[0])}}]});
 const ids=collection.id(), titles=collection.subject(), starts=collection.startTime(), ends=collection.endTime();
 if(ids.length>2000) return JSON.stringify({unavailable:'Calendar range contains too many events.'});
 if(!ids.length) return JSON.stringify({events:[],scriptingEvents:app.calendarEvents().length,scriptingAccounts:app.exchangeAccounts().length+app.imapAccounts().length+app.popAccounts().length});
 const places=ids.length?collection.location():[], descriptions=ids.length?collection.plainTextContent():[];
 return JSON.stringify({events:ids.map((id,i)=>{const link=teamsLink(String(descriptions[i]||''));return {uid:String(id),title:titles[i],start:starts[i].toISOString(),end:ends[i].toISOString(),joinUrl:link,isTeams:!!link||/^Microsoft Teams(?: Meeting| Besprechung)?$/i.test(String(places[i]||''))}})});
}`;
const systemScript = 'const teamsLink=' + teamsLink.toString() + ';\n' + `ObjC.import('EventKit'); ObjC.import('Foundation');
function run(args) {
 const store=$.EKEventStore.alloc.init;
 if($.EKEventStore.authorizationStatusForEntityType(0)!==3 && args[2]==='request') {
  let finished=false; store.requestFullAccessToEventsWithCompletion(function(){finished=true});
  const deadline=Date.now()+20000;
  while(!finished && Date.now()<deadline) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
 }
 if($.EKEventStore.authorizationStatusForEntityType(0)!==3) return JSON.stringify({unavailable:'Calendar access is not granted. Use Connect system calendar.'});
 const predicate=store.predicateForEventsWithStartDateEndDateCalendars($.NSDate.dateWithTimeIntervalSince1970(Date.parse(args[0])/1000),$.NSDate.dateWithTimeIntervalSince1970(Date.parse(args[1])/1000),null);
 const values=store.eventsMatchingPredicate(predicate); const events=[];
 for(let i=0;i<Math.min(values.count,2000);i++) {
  const e=values.objectAtIndex(i), cal=e.calendar;
  events.push({uid:ObjC.unwrap(e.calendarItemIdentifier)||ObjC.unwrap(e.eventIdentifier),calendarId:ObjC.unwrap(cal.calendarIdentifier),title:ObjC.unwrap(e.title),
   joinUrl:teamsLink(String(ObjC.unwrap(e.notes)||'')),start:new Date(e.startDate.timeIntervalSince1970*1000).toISOString(),end:new Date(e.endDate.timeIntervalSince1970*1000).toISOString(),allDay:!!e.allDay,
   occurrence:new Date((e.occurrenceDate||e.startDate).timeIntervalSince1970*1000).toISOString()});
 }
 return JSON.stringify({events,partial:values.count>2000});
}`;

async function appCalendar(source: 'outlook' | 'system', from: string, to: string, request = false, signal?: AbortSignal): Promise<{ events: CalendarEvent[]; status: CalendarStatus }> {
    if (process.platform !== 'darwin') return { events: [], status: { source, state: 'unavailable', message: 'Native calendar access requires macOS.' } };
    try {
        const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source === 'outlook' ? outlookScript : systemScript, from, to, request ? 'request' : 'read'], { timeout: request ? 25000 : 8000, maxBuffer: 2 * 1024 ** 2, signal });
        const result = JSON.parse(stdout) as { events?: Partial<CalendarEvent>[]; unavailable?: string; partial?: boolean; scriptingEvents?: number; scriptingAccounts?: number };
        const events = (result.events || []).map(row => normalizeEvent({ source, calendarId: row.calendarId || source, uid: String(row.uid), occurrence: row.occurrence || row.start!,
            title: row.title || '', start: row.start!, end: row.end!, allDay: Boolean(row.allDay), timezone: row.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, joinUrl: row.joinUrl, isTeams: row.isTeams }));
        if (source === 'outlook' && !events.length && result.scriptingEvents === 0 && result.scriptingAccounts === 0 && await newOutlookMode(signal)) {
            return { events: [], status: { source, state: 'unavailable', message: 'New Outlook is running. Its scripting interface exposes no accounts or events from your current profile. Current appointments are not accessible through this connection.' } };
        }
        return { events, status: { source, state: result.unavailable ? 'unavailable' : source === 'outlook' || result.partial ? 'partial' : 'ready',
            message: result.unavailable || (source === 'outlook' ? events.length ? 'Local Outlook scripting. Recurring-event coverage depends on the app.' : 'Outlook scripting returned no events. New Outlook may not expose its active calendar.' : events.length + ' system calendar events.') } };
    } catch (error) {
        signal?.throwIfAborted();
        const denied = /not authorized|-1743|not permitted/i.test(errorMessage(error));
        return { events: [], status: { source, state: 'unavailable', message: denied ? 'Allow calendar automation in macOS Privacy & Security.' : 'Local calendar API did not respond. Open the app and check permissions.' } };
    }
}
async function newOutlookMode(signal?: AbortSignal): Promise<boolean> {
    const file = path.join(homedir(), 'Library/Containers/com.microsoft.Outlook/Data/Library/Preferences/com.microsoft.Outlook.plist');
    for (const key of ['IsRunningNewOutlook', 'RunningNewOutlook']) {
        try {
            const { stdout } = await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { timeout: 1000, maxBuffer: 1024, signal });
            if (stdout.trim() === 'true') return true;
            if (stdout.trim() === 'false') return false;
        } catch { signal?.throwIfAborted(); }
    }
    return false;
}
export async function readLocalCalendar(config: Settings, from: string, to: string, requestSystemAccess = false, signal?: AbortSignal): Promise<CalendarSnapshot> {
    validateRange(from, to);
    const events: CalendarEvent[] = []; const statuses: CalendarStatus[] = [];
    if (config.calendarFile) {
        try {
            if ((await stat(config.calendarFile)).size > 5 * 1024 ** 2) throw new Error('Calendar file exceeds 5 MiB.');
            events.push(...parseCalendarFile(await readFile(config.calendarFile, 'utf8'), from, to, createHash('sha256').update(config.calendarFile).digest('hex')));
            statuses.push({ source: 'ics', state: 'ready', message: 'Watching a local calendar file.' });
        } catch (error) { statuses.push({ source: 'ics', state: 'unavailable', message: errorMessage(error) }); }
    }
    for (const source of ['outlook', 'system'] as const) {
        signal?.throwIfAborted();
        if (source === 'outlook' ? !config.calendarOutlook : !config.calendarSystem) { statuses.push({ source, state: 'unavailable', message: 'Disabled in Settings.' }); continue; }
        const result = await appCalendar(source, from, to, source === 'system' && requestSystemAccess, signal);
        events.push(...result.events); statuses.push(result.status);
    }
    const snapshot: CalendarSnapshot = { events, statuses, updatedAt: new Date().toISOString(), from, to };
    signal?.throwIfAborted();
    if (events.length || statuses.some(status => status.state === 'ready')) await atomicJson(cacheFile(), snapshot);
    else {
        const cached = await cachedCalendar();
        if (cached.events.length) return { ...cached, statuses, stale: true };
    }
    return snapshot;
}
export async function cachedCalendar(): Promise<CalendarSnapshot> {
    try {
        const data = JSON.parse(await readFile(cacheFile(), 'utf8')) as CalendarSnapshot;
        if (!Array.isArray(data.events)) throw new Error('Invalid calendar cache');
        return { ...data, events: data.events.map(event => normalizeEvent(event)) };
    } catch { return { events: [], statuses: [], updatedAt: '', ...calendarRange() }; }
}
