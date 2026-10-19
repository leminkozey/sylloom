import { loadLibrary, searchLibrary, librarySnippet, updateLibraryItem, validDay } from './library.js';
import type { Library, LibraryItem, LibraryFilter } from './library.js';
import type { Screen } from './terminal/screen.js';
import type { DictationService } from './dictation.js';
import { errorMessage } from './types.js';

export async function editLibraryMetadata(screen: Screen, item: LibraryItem, service?: DictationService): Promise<void> {
    if (service?.busy && service.current?.id === item.id) throw new Error('Stop or cancel this dictation first.');
    const action = await screen.select(item.title, [
        { value: 'rename', name: 'Rename' }, { value: 'pin', name: item.pinned ? 'Unpin' : 'Pin to top' }, { value: 'back', name: 'Back' },
    ], { back: true, detail: 'Organize this saved item' });
    if (action === 'rename') {
        const name = await screen.input('Rename', 'A name you can find again', item.title);
        if (name !== null) await updateLibraryItem(item, { name });
    }
    if (action === 'pin') await updateLibraryItem(item, { pinned: !item.pinned });
    if (service?.current?.id === item.id) Object.assign(service.current, { name: item.data.name, pinned: item.pinned });
}

export async function libraryMenu(screen: Screen, open: (item: LibraryItem) => Promise<void>, initial?: 'meeting' | 'dictation'): Promise<void> {
    let tab = initial === 'meeting' ? 1 : initial === 'dictation' ? 2 : 0;
    let pinned = false; let order = 0;
    const search = { query: '' };
    const extra: Pick<LibraryFilter, 'from' | 'to' | 'status'> = {};
    const tabs = ['All', 'Meetings', 'Dictations', 'Needs attention'];
    const orders = ['recent', 'oldest', 'words'] as const;
    for (;;) {
        if (screen.quitRequested) return;
        let library: Library = { items: [], warnings: [] };
        let active = true; let refreshError = '';
        let refreshing = Promise.resolve();
        const reload = () => {
            refreshing = refreshing.then(async () => {
                if (!active) return;
                const next = await loadLibrary();
                if (active) { library = next; refreshError = ''; }
            }).catch(error => { refreshError = 'Refresh failed: ' + errorMessage(error); });
            return refreshing;
        };
        screen.dictation?.on('update', reload);
        const filter = (): LibraryFilter => ({ ...extra, kind: initial || (tab === 1 ? 'meeting' : tab === 2 ? 'dictation' : undefined), pinned, attention: tab === 3, sort: orders[order] });
        let selected: string | undefined;
        try {
            await reload();
            selected = await screen.browse('Library', query => searchLibrary(library.items, query, filter()).map(item => ({
            value: item.kind + ':' + item.id,
            name: (item.pinned ? '★ ' : '') + new Date(item.date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' · ' +
                (item.kind === 'dictation' ? 'DICT' : 'MEET') + ' · ' + item.title,
            hint: item.status + ' · ' + item.words.toLocaleString('en') + ' words · ' + Math.round(item.seconds) + ' s · ' + librarySnippet(item, query),
        })), { search, detail: () => [tabs[tab], pinned ? 'Pinned' : '', orders[order], extra.from ? 'From ' + extra.from : '', extra.to ? 'To ' + extra.to : '', extra.status,
            library.warnings.length ? library.warnings.length + ' index warnings · Ctrl+E details' : '', refreshError].filter(Boolean).join(' · '),
            shortcut: key => {
                if (key.name === 'tab') {
                    if (initial) tab = tab === 3 ? initial === 'meeting' ? 1 : 2 : 3;
                    else tab = (tab + (key.shift ? -1 : 1) + tabs.length) % tabs.length;
                    return true;
                }
                if (key.ctrl && key.name === 'p') { pinned = !pinned; return true; }
                if (key.ctrl && key.name === 's') { order = (order + 1) % orders.length; return true; }
                if (key.ctrl && key.name === 'r') { reload(); return true; }
                if (key.ctrl && key.name === 'f') return 'filters';
                if (key.ctrl && key.name === 'e') return 'warnings';
                return false;
            },
            });
        } finally {
            active = false; screen.dictation?.off('update', reload); await refreshing;
        }
        if (!selected || screen.quitRequested) return;
        if (selected === 'filters') { await libraryFilters(screen, extra); continue; }
        if (selected === 'warnings') {
            await screen.view('Library index warnings', () => library.warnings.length ?
                ['# Preserved files need attention', '', ...library.warnings.map(warning => '- ' + warning), '',
                    'Open Storage and recovery to inspect unreadable meeting folders. Run sylloom recovery for metadata paths.',
                    'Healthy items remain searchable. No files have been removed.'].join('\n') : 'No index warnings.');
            continue;
        }
        const item = library.items.find(item => item.kind + ':' + item.id === selected);
        if (item) try { await open(item); } catch (error) { await screen.notice('Library', errorMessage(error)); }
    }
}

async function libraryFilters(screen: Screen, filter: Pick<LibraryFilter, 'from' | 'to' | 'status'>): Promise<void> {
    for (;;) {
        if (screen.quitRequested) return;
        const action = await screen.select('Library filters', [
            { value: 'from', name: 'From date', hint: filter.from || 'Any date' },
            { value: 'to', name: 'Through date', hint: filter.to || 'Any date' },
            { value: 'status', name: 'State', hint: filter.status || 'All states' },
            { value: 'clear', name: 'Clear filters' }, { value: 'back', name: 'Back' },
        ], { back: true, detail: 'Dates use your local timezone. Both dates are inclusive.' });
        if (['back', 'quit', 'settings'].includes(action)) return;
        try {
            if (action === 'clear') { delete filter.from; delete filter.to; delete filter.status; }
            if (action === 'from' || action === 'to') {
                const value = await screen.input('Date filter', 'YYYY-MM-DD, or leave empty to clear', filter[action] || '');
                if (value === null) continue;
                if (value && !validDay(value)) throw new Error('Enter a valid date such as 2026-10-19.');
                const next = { ...filter, [action]: value || undefined };
                if (next.from && next.to && next.from > next.to) throw new Error('The end date must be on or after the start date.');
                Object.assign(filter, next);
            }
            if (action === 'status') {
                const status = await screen.select('State', ['all', 'completed', 'failed', 'canceled', 'interrupted', 'pending', 'recording', 'note', 'transcript', 'audio only']
                    .map(value => ({ value, name: value === 'all' ? 'All states' : value })), { back: true });
                if (!['back', 'quit', 'settings'].includes(status)) filter.status = status === 'all' ? undefined : status;
            }
        } catch (error) { await screen.notice('Filter not changed', errorMessage(error)); }
    }
}
