import { powershell } from './powershell.js';
import { normalizeEvent, teamsLink } from '../../calendar.js';
import type { CalendarEvent, CalendarStatus } from '../../calendar.js';

const script = `
try { $app=[Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
catch { @{unavailable='Open classic Outlook to connect its local calendar. New Outlook does not expose this COM interface; use an ICS file instead.'}|ConvertTo-Json -Compress; exit }
$namespace=$null; $folder=$null; $items=$null; $restricted=$null
try {
 $from=[DateTimeOffset]::Parse($env:SYLLOOM_CALENDAR_FROM).UtcDateTime.ToLocalTime()
 $to=[DateTimeOffset]::Parse($env:SYLLOOM_CALENDAR_TO).UtcDateTime.ToLocalTime()
 $namespace=$app.GetNamespace('MAPI'); $folder=$namespace.GetDefaultFolder(9)
 $items=$folder.Items; $items.Sort('[Start]'); $items.IncludeRecurrences=$true
 $filter="[Start] < '"+$to.ToString('g',[Globalization.CultureInfo]::CurrentCulture)+"' AND [End] > '"+$from.ToString('g',[Globalization.CultureInfo]::CurrentCulture)+"'"
 $restricted=$items.Restrict($filter); $rows=@(); $partial=$false
 foreach($event in $restricted) {
  try {
   if($rows.Count -ge 2000){$partial=$true;break}
   if($event.MeetingStatus -eq 5 -or $event.MeetingStatus -eq 7){continue}
   $start=[datetime]$event.Start; $end=[datetime]$event.End
   if($end -le $from -or $start -ge $to){continue}
   $rows+=@{uid=[string]$event.EntryID;title=[string]$event.Subject;start=$start.ToUniversalTime().ToString('o');end=$end.ToUniversalTime().ToString('o');allDay=[bool]$event.AllDayEvent;location=[string]$event.Location;body=[string]$event.Body}
  } finally { if($event){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($event)} }
 }
 @{events=$rows;partial=$partial}|ConvertTo-Json -Depth 5 -Compress
} finally {
 foreach($value in @($restricted,$items,$folder,$namespace,$app)){if($value){[void][Runtime.InteropServices.Marshal]::ReleaseComObject($value)}}
}`;

export async function windowsCalendar(source: 'outlook' | 'system', from: string, to: string, signal?: AbortSignal): Promise<{ events: CalendarEvent[]; status: CalendarStatus }> {
    if (source === 'system') return { events: [], status: { source, state: 'unavailable', message: 'Connect classic Outlook or a local ICS file on Windows.' } };
    try {
        const result = JSON.parse(await powershell(script, { SYLLOOM_CALENDAR_FROM: from, SYLLOOM_CALENDAR_TO: to }, signal)) as {
            unavailable?: string; partial?: boolean; events?: { uid: string; title: string; start: string; end: string; allDay: boolean; location: string; body: string }[] };
        const events = (result.events || []).map(row => {
            const link = teamsLink(row.body + '\n' + row.location);
            return normalizeEvent({ source, calendarId: 'outlook-default', uid: row.uid, occurrence: row.start, title: row.title,
                start: row.start, end: row.end, allDay: row.allDay, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                joinUrl: link, isTeams: Boolean(link) || /^Microsoft Teams(?: Meeting| Besprechung)?$/iu.test(row.location) });
        });
        return { events, status: { source, state: result.unavailable ? 'unavailable' : result.partial ? 'partial' : 'ready',
            message: result.unavailable || events.length + ' local classic Outlook events.' } };
    } catch {
        signal?.throwIfAborted();
        return { events: [], status: { source, state: 'unavailable', message: 'Classic Outlook did not respond. Open it with the same Windows user and privilege level. New Outlook requires a local ICS export.' } };
    }
}
