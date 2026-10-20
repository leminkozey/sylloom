import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { home } from './store.js';
import { repositoryUrl } from './brand.js';
import { activityCalendar, loadInsights } from './insights.js';
import type { Insights } from './insights.js';
import type { Screen } from './terminal/screen.js';
import { copyText } from './clipboard.js';
import style from './terminal/style.js';
export { openExternal } from './external.js';
import { openExternal } from './external.js';

const number = (value: number) => value.toLocaleString('en');
export function shareText(stats: Insights): string {
    return `I’ve spoken ${number(stats.words)} words with Sylloom.\n${stats.currentStreak}-day streak · ${stats.wpm} WPM · ${number(stats.dictations)} dictations.\nLocal voice, less typing.\n${repositoryUrl}`;
}
export function shareUrl(stats: Insights): string {
    const url = new URL('https://x.com/intent/tweet'); url.searchParams.set('text', shareText(stats)); return url.href;
}

export function renderInsights(stats: Insights, width: number, now = new Date()): string[] {
    const weeks = Math.max(1, Math.min(53, Math.floor((width - 6) / 2)));
    const cells = activityCalendar(stats.days, now, weeks);
    const labels = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2024, 0, 1 + index)).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }));
    const lines = [style('YOUR VOICE, IN NUMBERS', 'accent'), '',
        style(number(stats.words) + ' words', 'strong') + '  ·  ' + stats.wpm + ' WPM',
        stats.currentStreak + '-day streak  ·  Best ' + stats.longestStreak + ' days',
        number(stats.dictations) + ' dictations  ·  ' + Math.round(stats.seconds / 60) + ' min of voice', '',
        'Today  ' + number(stats.today.words) + ' words · ' + stats.today.dictations + ' dictations', '',
        style('ACTIVITY · LAST ' + weeks + ' WEEKS', 'muted')];
    for (let row = 0; row < 7; row++) {
        lines.push(labels[row] + '  ' + Array.from({ length: weeks }, (_, week) => {
            const cell = cells[week * 7 + row]!;
            return cell.future ? '  ' : style(['·', '░', '▒', '▓', '█'][cell.level]! + ' ', ('heat' + cell.level) as 'heat0');
        }).join(''));
    }
    lines.push('', style('Less · ░ ▒ ▓ █ More · Local calendar days', 'muted'), '',
        stats.meetingCount + ' meetings  ·  ' + stats.notes + ' structured notes',
        style('WPM uses recording time, including pauses. Meetings excluded.', 'muted'),
        style('Activity counts spoken transcript words, once per dictation.', 'muted'));
    if (!stats.words) lines.push('', 'Your first dictation starts the grid. Every word stays local.');
    if (stats.warnings.length) lines.push('', style(stats.warnings.length + ' Library items could not be indexed.', 'Warning'));
    return lines;
}

export function insightsHtml(stats: Insights, now = new Date()): string {
    const nonce = randomBytes(18).toString('base64');
    // Allowlist only aggregates. Never serialize a Library item, title or transcript.
    const payload = JSON.stringify({ words: stats.words, wpm: stats.wpm, dictations: stats.dictations, seconds: stats.seconds,
        currentStreak: stats.currentStreak, longestStreak: stats.longestStreak, today: stats.today.words,
        meetings: stats.meetingCount, notes: stats.notes, cells: activityCalendar(stats.days, now),
        generated: now.toLocaleString('en-GB'), share: shareText(stats) }).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'">
<title>Sylloom · Insights</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111114;color:#eeedf4;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:48px 32px 64px}header,.row{display:flex;align-items:center;justify-content:space-between;gap:24px}header{border-bottom:1px solid #303037;padding-bottom:24px}.brand{display:flex;align-items:center;gap:12px;font-weight:650;letter-spacing:-.03em;font-size:22px}.mark{height:30px;display:flex;align-items:center;gap:3px}.mark i{width:3px;background:#ffffff;border-radius:2px}small,.eyebrow{font-size:12px;color:#a6a6b4}.eyebrow{letter-spacing:.14em;text-transform:uppercase;color:#9c9fff}h1{font-size:clamp(38px,6vw,68px);line-height:1.06;font-weight:500;letter-spacing:-.06em;max-width:700px;margin:20px 0}p{line-height:1.6;color:#aaaab8}.intro{padding:52px 0 30px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #303037;border-radius:12px;overflow:hidden}.metric{padding:26px;border-right:1px solid #303037}.metric:last-child{border:0}.value{font-size:38px;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.label{color:#a6a6b4;font-size:13px;margin-top:6px}.section{margin-top:34px;padding:26px;border:1px solid #303037;border-radius:12px}h2{font-size:16px;font-weight:550;margin:0}.grid-scroll{overflow-x:auto;padding-top:22px}.calendar{display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;grid-auto-columns:minmax(10px,1fr);gap:5px;min-width:760px;margin:16px 0}.cell{border:0;padding:0;border-radius:2px;background:#24242c;cursor:default}.cell[data-level="1"]{background:#414260}.cell[data-level="2"]{background:#6266a2}.cell[data-level="3"]{background:#898dee}.cell[data-level="4"]{background:#bfc2ff}.cell:focus-visible{outline:2px solid white;outline-offset:2px}.cell.future{visibility:hidden}.legend{display:flex;align-items:center;gap:5px;justify-content:flex-end;font-size:11px;color:#aaaab8}.legend i{height:10px;width:10px;border-radius:2px}.buttons{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;font-size:13px;border:1px solid #43434e;border-radius:7px;padding:10px 15px;background:transparent;color:#eeedf4;cursor:pointer}button:hover{border-color:#bfc2ff}button.primary{background:#bfc2ff;color:#171722;border-color:#bfc2ff}dialog{background:#1b1b21;color:#eeedf4;border:1px solid #43434e;border-radius:12px;max-width:540px;padding:28px}dialog::backdrop{background:#000a}textarea{width:100%;resize:vertical;min-height:145px;font:15px/1.6 system-ui;background:#111114;color:#eeedf4;border:1px solid #43434e;border-radius:6px;padding:15px;margin:18px 0}footer{border-top:1px solid #303037;margin-top:34px;padding-top:20px;color:#a6a6b4;font-size:12px}.note{font-size:12px}#day{font-size:13px;color:#bfc2ff;min-height:20px}#message{color:#bfc2ff;font-size:12px}select{background:#17171d;color:#eeedf4;border:1px solid #43434e;border-radius:5px;padding:6px}@media(max-width:650px){main{padding:24px 18px}.metrics{grid-template-columns:1fr 1fr}.metric{border-bottom:1px solid #303037;padding:18px}.value{font-size:30px}.row{align-items:flex-start;flex-wrap:wrap}.section{padding:18px}header small{display:none}}
</style></head><body><main>
<header><div class="brand"><span class="mark" aria-hidden="true">${[8, 24, 16, 32, 16, 24, 8].map(height => `<i style="height:${height}px"></i>`).join('')}</span>Sylloom</div><small>Local voice. A little less typing.</small></header>
<div class="intro"><div class="eyebrow">Your voice, in numbers</div><h1>A thought spoken.<br>A little momentum.</h1><p id="today"></p></div>
<div class="metrics"><div class="metric"><div class="value" id="words"></div><div class="label">Words spoken</div></div><div class="metric"><div class="value" id="wpm"></div><div class="label">Words per minute</div></div><div class="metric"><div class="value" id="streak"></div><div class="label">Current day streak</div></div><div class="metric"><div class="value" id="dictations"></div><div class="label">Dictations</div></div></div>
<section class="section"><div class="row"><h2>A year of showing up</h2><select id="period" aria-label="Activity period"><option value="53">Last year</option><option value="13">Last 13 weeks</option><option value="4">Last 4 weeks</option></select></div><div class="grid-scroll"><div class="calendar" id="calendar" role="group" aria-label="Daily spoken words"></div></div><div id="day" aria-live="polite">Choose a day to see its word count.</div><div class="legend">Less ${['#24242c','#414260','#6266a2','#898dee','#bfc2ff'].map(color => `<i style="background:${color}"></i>`).join('')} More</div></section>
<section class="section"><div class="row"><div><h2 id="best"></h2><p id="meetings"></p></div><div class="buttons"><button id="share" class="primary">Share on X</button><button id="png">Save share card</button></div></div><p class="note">WPM includes pauses and uses recording time. Words come from the original transcript, counted once per dictation. Meeting words are excluded. Deleting a dictation keeps its activity count.</p><span id="message" role="status"></span></section>
<footer id="generated"></footer></main>
<dialog id="preview"><h2>Your X draft</h2><p class="note">Only these numbers and the project link are shared. Edit the draft before opening X.</p><textarea id="draft" aria-label="X draft" maxlength="280"></textarea><div class="buttons"><button id="open-x" class="primary">Open X composer</button><button id="copy">Copy text</button><button id="close">Back</button></div><p class="note">Attach the saved share card in X if you like. Nothing is posted automatically.</p></dialog>
<script nonce="${nonce}">const data=${payload};
const byId=id=>document.getElementById(id), fmt=n=>n.toLocaleString('en');
byId('words').textContent=fmt(data.words);byId('wpm').textContent=data.wpm;byId('streak').textContent=data.currentStreak;byId('dictations').textContent=fmt(data.dictations);
byId('today').textContent=fmt(data.today)+' words today. '+(data.words?'Your ideas are adding up.':'Your first dictation starts the grid.');
byId('best').textContent='Best streak: '+data.longestStreak+' days';byId('meetings').textContent=data.meetings+' meetings · '+data.notes+' structured notes · '+Math.round(data.seconds/60)+' minutes of dictation';
byId('generated').textContent='Private, local snapshot · '+data.generated+' · Reopen Insights from Sylloom to refresh.';
function grid(){const cells=data.cells.slice(-Number(byId('period').value)*7);byId('calendar').replaceChildren(...cells.map(cell=>{const b=document.createElement('button');b.className='cell'+(cell.future?' future':'');b.dataset.level=cell.level;b.disabled=cell.future;b.setAttribute('aria-label',cell.date+': '+fmt(cell.words)+' words');b.title=b.getAttribute('aria-label');b.onfocus=b.onmouseenter=b.onclick=()=>byId('day').textContent=b.title;return b}));}grid();byId('period').onchange=grid;
byId('share').onclick=()=>{byId('draft').value=data.share;byId('preview').showModal()};byId('close').onclick=()=>byId('preview').close();
byId('open-x').onclick=()=>window.open('https://x.com/intent/tweet?text='+encodeURIComponent(byId('draft').value),'_blank','noopener,noreferrer');
byId('copy').onclick=async()=>{try{await navigator.clipboard.writeText(byId('draft').value);byId('copy').textContent='Copied'}catch{byId('draft').select();byId('copy').textContent=/Mac|iPhone|iPad/.test(navigator.platform)?'Press Cmd+C':'Press Ctrl+C'}};
byId('png').onclick=()=>{try{const c=document.createElement('canvas');c.width=1200;c.height=630;const x=c.getContext('2d');x.fillStyle='#111114';x.fillRect(0,0,1200,630);x.fillStyle='#ffffff';[8,24,16,32,16,24,8].forEach((h,i)=>x.fillRect(64+i*7,68-h/2,4,h));x.font='600 26px system-ui';x.fillStyle='#ffffff';x.fillText('Sylloom',130,78);x.font='20px system-ui';x.fillStyle='#a6a6b4';x.fillText('MY VOICE, IN NUMBERS',64,150);x.font='500 86px system-ui';x.fillStyle='#eeedf4';x.fillText(fmt(data.words)+' words spoken',64,254);x.font='28px system-ui';x.fillStyle='#bfc2ff';x.fillText(data.currentStreak+'-day streak    '+data.wpm+' WPM    '+fmt(data.dictations)+' dictations',64,316);data.cells.forEach((a,i)=>{if(a.future)return;x.fillStyle=['#24242c','#414260','#6266a2','#898dee','#bfc2ff'][a.level];x.fillRect(64+Math.floor(i/7)*20,365+(i%7)*19,14,13)});x.font='18px system-ui';x.fillStyle='#a6a6b4';x.fillText('Local voice. A little less typing.',64,574);x.fillText('Recording-based WPM · '+data.generated,640,574);c.toBlob(blob=>{if(!blob){byId('message').textContent='Could not save the card.';return}const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download='sylloom-insights.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);byId('message').textContent='Share card saved. Attach it to your X draft.'},'image/png')}catch{byId('message').textContent='Could not save the card. Try Safari or Chrome.'}};
</script></body></html>`;
}

export async function saveInsightsView(stats: Insights): Promise<string> {
    const directory = path.join(home, 'views'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, 'insights.html'); await writeFile(target, insightsHtml(stats), { mode: 0o600 }); return target;
}
export async function insightsMenu(screen: Screen): Promise<void> {
    for (;;) {
        if (screen.quitRequested) return;
        const stats = await loadInsights();
        const action = await screen.page('Insights', width => renderInsights(stats, width), {
            footer: 'O Browser · S Share on X · R Refresh · Esc Back', actions: { o: 'open', s: 'share', r: 'refresh' },
        });
        if (!action || screen.quitRequested) return;
        if (action === 'open') await openExternal(await saveInsightsView(stats));
        if (action === 'share') {
            const selected = await screen.select('Share on X', [
                { value: 'open', name: 'Open X composer', hint: 'Review and publish there. Nothing posts automatically.' },
                { value: 'copy', name: 'Copy share text' }, { value: 'back', name: 'Back' },
            ], { back: true, before: () => shareText(stats).split('\n').concat(''), detail: 'Aggregate stats only. No transcript text.' });
            if (selected === 'quit' || screen.quitRequested) return;
            if (selected === 'open') await openExternal(shareUrl(stats));
            if (selected === 'copy') await copyText(shareText(stats));
        }
    }
}
