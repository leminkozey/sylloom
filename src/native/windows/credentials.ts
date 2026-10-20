import koffi from 'koffi';

export function windowsTeamsToken(value?: string): string | undefined {
    const library = koffi.load('advapi32.dll'), kernel = koffi.load('kernel32.dll');
    const credential = koffi.struct({ flags: 'uint32', type: 'uint32', target: 'str16', comment: 'str16',
        written: koffi.struct({ low: 'uint32', high: 'uint32' }), size: 'uint32', blob: 'void *', persist: 'uint32',
        count: 'uint32', attributes: 'void *', alias: 'str16', username: 'str16' });
    const target = 'Sylloom.Teams/local-api';
    if (value !== undefined) {
        const content = Buffer.from(value, 'utf8');
        if (!value.trim() || content.length > 2560) throw new Error('Enter a valid Teams token, at most 2560 UTF-8 bytes.');
        const write = library.func('CredWriteW', 'int', [koffi.pointer(credential), 'uint32']);
        if (!write({ flags: 0, type: 1, target, comment: null, written: { low: 0, high: 0 }, size: content.length,
            blob: content, persist: 2, count: 0, attributes: null, alias: null, username: 'local-api' }, 0)) throw new Error('Could not save the Teams token in Windows Credential Manager.');
        return value;
    }
    const pointer: unknown[] = [null];
    if (!library.func('int __stdcall CredReadW(str16, uint32, uint32, _Out_ void **)')(target, 1, 0, pointer)) {
        if (kernel.func('uint32 __stdcall GetLastError()')() === 1168) return undefined;
        throw new Error('Windows Credential Manager access failed.');
    }
    try { const record = koffi.decode(pointer[0], credential); return Buffer.from(koffi.view(record.blob, record.size)).toString('utf8'); }
    finally { library.func('void __stdcall CredFree(void *)')(pointer[0]); }
}
