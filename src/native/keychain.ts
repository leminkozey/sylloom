import koffi from 'koffi';

export function teamsToken(value?: string): string | undefined {
    if (process.platform !== 'darwin') return undefined;
    const security = koffi.load('/System/Library/Frameworks/Security.framework/Security');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const find = security.func('int32 SecKeychainFindGenericPassword(void *, uint32, str, uint32, str, _Out_ uint32 *, _Out_ void **, _Out_ void **)');
    const service = 'Sylloom.Teams'; const account = 'local-api';
    const size = [0], data = [null], item = [null];
    const status = find(null, Buffer.byteLength(service), service, Buffer.byteLength(account), account, size, data, item);
    try {
        if (value === undefined) {
            if (status === -25300) return undefined;
            if (status !== 0) throw new Error('Keychain access was not granted.');
            return Buffer.from(koffi.decode(data[0], 'uint8', size[0]!)).toString('utf8');
        }
        if (value.length > 4096 || !value.trim()) throw new Error('Enter a valid Teams API token.');
        const bytes = Buffer.byteLength(value);
        const saved = status === 0 ? security.func('int32 SecKeychainItemModifyAttributesAndData(void *, void *, uint32, str)')(item[0], null, bytes, value) :
            status === -25300 ? security.func('int32 SecKeychainAddGenericPassword(void *, uint32, str, uint32, str, uint32, str, void *)')(null, service.length, service, account.length, account, bytes, value, null) : status;
        if (saved !== 0) throw new Error('Could not save the Teams token in Keychain.');
        return value;
    } finally {
        if (data[0]) security.func('int32 SecKeychainItemFreeContent(void *, void *)')(null, data[0]);
        if (item[0]) cf.func('void CFRelease(void *)')(item[0]);
    }
}
