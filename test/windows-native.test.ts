import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import { windows } from '../src/native/windows/api.js';
import { automation, release } from '../src/native/windows/automation.js';
import { captureWindowsInput } from '../src/native/windows/input.js';
import { copyWindowsText, temporaryWindowsClipboard } from '../src/native/windows/clipboard.js';
import { registerWindowsHotkeys } from '../src/native/windows/hotkey.js';
import { createWindowsPopup, createWindowsHud } from '../src/native/windows/surface.js';
import { Audio } from '../src/audio.js';

// Explicit opt-in: opens only our own synthetic native window, briefly changes
// focus and restores the clipboard. No microphone, app data or credentials.
test('native Windows APIs render without activation and safely paste into a verified input', {
    skip: process.platform !== 'win32' || process.env.SYLLOOM_TEST_WINDOWS !== '1', timeout: 60_000,
}, async t => {
    const api = windows();
    const station = api.user.func('void * __stdcall GetProcessWindowStation()')();
    const flags = Buffer.alloc(12), length = [0];
    assert.ok(api.user.func('int __stdcall GetUserObjectInformationW(void *, int, void *, uint32, _Out_ uint32 *)')(station, 1, flags, flags.length, length));
    if (!(flags.readUInt32LE(8) & 1)) { t.skip('No visible Windows window station. Native UI acceptance requires an interactive desktop.'); return; }
    const root = automation().root(); assert.ok(root); release(root);
    const hotkeys = registerWindowsHotkeys(() => {}, () => {}, () => {}); hotkeys();
    // Test-only snapshot: the production transaction deliberately refuses to
    // restore after another writer changes the sequence. This harness performs
    // several such writes and therefore owns a separate all-format backup.
    const clipOpen = api.user.func('int __stdcall OpenClipboard(void *)');
    const clipClose = api.user.func('int __stdcall CloseClipboard()');
    const clipGet = api.user.func('void * __stdcall GetClipboardData(uint32)');
    const clipSet = api.user.func('void * __stdcall SetClipboardData(uint32, void *)');
    const clipEnum = api.user.func('uint32 __stdcall EnumClipboardFormats(uint32)');
    const duplicate = koffi.load('ole32.dll').func('void * __stdcall OleDuplicateData(void *, uint32, uint32)');
    const backupOwner = api.createWindow(0x80, 'STATIC', 'Sylloom test clipboard owner', 0, 0, 0, 0, 0, null, null, api.instance(null), null);
    assert.ok(backupOwner);
    const originals: { format: number; handle: bigint }[] = [];
    assert.ok(clipOpen(backupOwner));
    try {
        for (let format = clipEnum(0); format; format = clipEnum(format)) {
            const handle = duplicate(clipGet(format), format, 2); assert.ok(handle, 'Cannot safely preserve the original clipboard for this test');
            originals.push({ format, handle });
        }
    } finally { clipClose(); }
    copyWindowsText('Sylloom synthetic clipboard fixture');
    let current: ReturnType<typeof temporaryWindowsClipboard> | undefined;
    let popup: ReturnType<typeof createWindowsPopup> | undefined, hud: ReturnType<typeof createWindowsHud> | undefined;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
import koffi from 'koffi';
const user=koffi.load('user32.dll'), kernel=koffi.load('kernel32.dll');
const create=user.func('void * __stdcall CreateWindowExW(uint32,str16,str16,uint32,int,int,int,int,void *,void *,void *,void *)');
const send=user.func('intptr_t __stdcall SendMessageW(void *,uint32,uintptr_t,intptr_t)');
const instance=kernel.func('void * __stdcall GetModuleHandleW(str16)')(null);
const window=create(0,'STATIC','Sylloom synthetic input',0x10cf0000,100,100,520,260,null,null,instance,null);
const multiline=create(0,'EDIT','',0x50811044,10,10,470,100,window,null,instance,null);
const other=create(0,'EDIT','',0x50810000,10,130,470,30,window,null,instance,null);
let edit=multiline;
if(!window||!edit||!other)throw Error('Could not create the native input fixture.');
const point=koffi.struct({x:'int32',y:'int32'});
const msg=koffi.struct({hwnd:'void *',message:'uint32',wParam:'uintptr_t',lParam:'intptr_t',time:'uint32',pt:point,private:'uint32'});
const peek=user.func('PeekMessageW','int',[koffi.out(koffi.pointer(msg)),'void *','uint32','uint32','uint32']);
const timer=setInterval(()=>{const m={};for(let i=0;i<64&&peek(m,null,0,0,1);i++){const b=Buffer.alloc(koffi.sizeof(msg));koffi.encode(b,msg,m);user.func('int __stdcall TranslateMessage(void *)')(b);user.func('intptr_t __stdcall DispatchMessageW(void *)')(b);}},10);
process.on('message',m=>{
 if(m.type==='prepare'){
  edit=m.singleLine?other:multiline;
  send(edit,0xcf,0,0); send(edit,0xcc,0,0);
  user.func('int __stdcall SetWindowTextW(void *,str16)')(edit,m.text);
  send(edit,0xb1,m.start,m.end);
  user.func('int __stdcall SetForegroundWindow(void *)')(window);
  user.func('void * __stdcall SetFocus(void *)')(edit);
 }
 if(m.type==='blur')user.func('void * __stdcall SetFocus(void *)')(other);
 if(m.type==='selection')send(edit,0xb1,0,2);
 if(m.type==='readonly')send(edit,0xcf,1,0);
 if(m.type==='password')send(edit,0xcc,42,0);
 if(m.type==='change')user.func('int __stdcall SetWindowTextW(void *,str16)')(edit,m.text);
 const b=Buffer.alloc(20000);user.func('int __stdcall GetWindowTextW(void *,void *,int)')(edit,b,10000);
 process.send({text:b.toString('utf16le').split('\\0')[0],window:String(window),password:Number(send(edit,0xd2,0,0))});
});
process.on('disconnect',()=>{clearInterval(timer);user.func('int __stdcall DestroyWindow(void *)')(window);process.exit(0);});
process.send({ready:true});
`], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: false });
    let diagnostic = ''; child.stderr?.on('data', value => { diagnostic = (diagnostic + value).slice(-2000); });
    const message = () => once(child, 'message', { signal: AbortSignal.timeout(8000) }).then(([result]) => result);
    const request = (value: object) => { const result = message(); child.send(value); return result; };
    try {
        await message();
        const fixture = await request({ type: 'prepare', text: 'Before selected after', start: 7, end: 15 });
        await delay(150);
        const foreground = api.foreground();
        let pauses = 0;
        popup = createWindowsPopup(() => {}); hud = createWindowsHud({ onTogglePause: () => { pauses++; } });
        popup.show('Incoming call', 'Synthetic native smoke test', [{ id: 'record', label: 'Record' }, { id: 'dismiss', label: 'Dismiss' }]);
        hud.render({ phase: 'recording', level: .35 });
        await delay(250);
        assert.equal(api.foreground(), foreground, 'The popup and waveform must preserve focus');
        for (const view of [
            { phase: 'processing' as const, level: 0 },
            { phase: 'copied' as const, level: 0 },
            { phase: 'error' as const, level: 0, feedback: 'microphone' as const },
            { phase: 'recording' as const, level: .04, mode: 'meeting' as const, elapsed: 42 },
            { phase: 'paused' as const, level: 0, mode: 'meeting' as const, elapsed: 42 },
            { phase: 'paused' as const, level: 0, mode: 'meeting' as const, elapsed: 42, notice: { title: 'Copied to clipboard', detail: 'Synthetic expanded bubble smoke test.' } },
        ]) {
            hud.render(view); await delay(100);
            assert.equal(api.foreground(), foreground, 'Morphs, pause and expanded messages must preserve focus');
        }
        assert.equal(pauses, 0, 'Rendering cannot trigger a pause action');
        hud.hide(); popup.hide(); await delay(200);
        await t.test('focused text insertion and selection/focus guards', async context => {
            if (String(foreground) !== fixture.window) { context.skip('This runner has no interactive foreground desktop. Test real insertion on a Windows desktop.'); return; }
            const captured = captureWindowsInput(); assert.ok(captured.target, captured.reason);
            try {
                assert.equal(await captured.target.insert('Grüße,\n世界'), true, captured.target.reason);
                assert.equal((await request({ type: 'read' })).text.replace(/\r\n/gu, '\n'), 'Before Grüße,\n世界 after');
            } finally { captured.target.close(); }
            for (const changed of ['blur', 'change', 'selection', 'readonly', 'password']) {
                await request({ type: 'prepare', text: 'Before selected after', start: 7, end: 15, singleLine: changed === 'password' }); await delay(60);
                const target = captureWindowsInput(); assert.ok(target.target, target.reason);
                const changedInput = await request({ type: changed, text: 'New manual text' });
                if (changed === 'password') assert.equal(changedInput.password, 42, 'The fixture must really enable password masking');
                try { assert.equal(await target.target.insert('Must not appear'), false, changed + ' must prevent insertion'); }
                finally { target.target.close(); }
                assert.doesNotMatch((await request({ type: 'read' })).text, /Must not appear/);
            }
        });
        const open = api.user.func('int __stdcall OpenClipboard(void *)'), close = api.user.func('int __stdcall CloseClipboard()');
        const get = api.user.func('void * __stdcall GetClipboardData(uint32)');
        const lock = api.kernel.func('void * __stdcall GlobalLock(void *)'), unlock = api.kernel.func('int __stdcall GlobalUnlock(void *)');
        const readText = () => {
            assert.ok(open(null));
            try { const handle = get(13), pointer = lock(handle); assert.ok(pointer); try { return koffi.decode.string16(pointer); } finally { unlock(handle); } }
            finally { close(); }
        };
        copyWindowsText('Sylloom synthetic clipboard fixture');
        current = temporaryWindowsClipboard('Temporary Unicode: ä, 世界');
        assert.ok(current.isCurrent(), 'The published clipboard transaction must still own its revision');
        assert.equal(readText(), 'Temporary Unicode: ä, 世界'); current.restore(); current.dispose();
        assert.equal(readText(), 'Sylloom synthetic clipboard fixture');
        current = temporaryWindowsClipboard('First line\nSecond line');
        assert.equal(readText(), 'First line\r\nSecond line'); current.restore(); current.dispose();
        current = temporaryWindowsClipboard('Temporary again'); copyWindowsText('New user clipboard'); current.restore(); current.dispose();
        assert.equal(readText(), 'New user clipboard', 'Do not overwrite a newer clipboard item');
    } finally {
        hud?.close(); popup?.close(); current?.dispose();
        // Explicit opt-in runs on an otherwise idle test desktop. Restore every
        // original format, including non-text data, rather than only plain text.
        const empty = api.user.func('int __stdcall EmptyClipboard()');
        assert.ok(clipOpen(backupOwner));
        try { assert.ok(empty()); for (const entry of originals) assert.ok(clipSet(entry.format, entry.handle)); }
        finally { clipClose(); api.destroyWindow(backupOwner); }
        child.disconnect(); await once(child, 'exit', { signal: AbortSignal.timeout(5000) }).catch(() => { child.kill(); });
        assert.equal(diagnostic, '');
    }
});

test('Windows WASAPI backend loads and enumerates without starting capture', {
    skip: process.platform !== 'win32' || process.env.SYLLOOM_TEST_WINDOWS !== '1', timeout: 60_000,
}, async () => {
    const audio = new Audio(); audio.on('failure', () => {});
    try { const capabilities = await audio.capabilities(); assert.ok(capabilities); await audio.devices(); }
    finally { await audio.close(); }
});
