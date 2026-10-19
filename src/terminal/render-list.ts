// Adapted from velora-cli/src/terminal/render-list.ts. Original table layout,
// sticky actions and scroll hints; cell sizing uses Sylloom's Unicode support.
import style from './style.js';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import { cleanText } from '../types.js';

function cellText(text: string, width: number): string {
    const value = cleanText(text).replace(/[\r\n]/g, ' ');
    const cropped = stringWidth(value) > width ? sliceAnsi(value, 0, Math.max(0, width - 1)) + '…' : value;
    return cropped + ' '.repeat(Math.max(0, width - stringWidth(cropped)));
}

export type ListRow = { value: string; cells: string[]; group?: string; section?: string };
export type ListColumn = { title: string; width?: number };
type ListAction = { value: string; name: string };
type ListOptions = {
    rows: ListRow[];
    columns?: ListColumn[];
    actions?: ListAction[];
    selected: string;
    width: number;
    height: number;
    emptyMessage?: string;
    detail?: string;
};

export default function renderList(config: ListOptions): string {
    var { rows, selected, width, height } = config;
    var columns = config.columns || [{ title: '' }];
    var actions = config.actions || [];
    var COLUMN_GAP = 3;
    var remainingWidth = width - COLUMN_GAP * (columns.length - 1);
    var flexibleColumns = 0;
    for (var column of columns) {
        if (column.width !== undefined) {
            remainingWidth -= column.width;
        } else {
            flexibleColumns++;
        }
    }
    var widths: number[] = [];
    var showHeading = false;
    for (var column of columns) {
        var size = column.width;
        if (size === undefined) {
            size = Math.floor(remainingWidth / flexibleColumns);
            remainingWidth -= size;
            flexibleColumns--;
        }
        widths.push(Math.max(1, size));
        showHeading = showHeading || Boolean(column.title);
    }
    var divider = '  ' + style('─'.repeat(width), 'divider') + '\n';
    var output = '';
    var headingRows = 0;
    if (showHeading) {
        output = '  ';
        for (var columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            if (columnIndex > 0) {
                output += style(' │ ', 'divider');
            }
            output += style(cellText(columns[columnIndex]!.title, widths[columnIndex]!), 'muted');
        }
        output += '\n' + divider;
        headingRows = 2;
    }
    var blocks: { value: string; text: string; height: number }[] = [];
    for (var index = 0; index < rows.length; index++) {
        var row = rows[index]!;
        var text = '';
        var blockHeight = 1;
        if (row.section) {
            text += '  ' + style(cellText(row.section, width), 'strong') + '\n';
            blockHeight++;
        }
        text += '  ';
        for (var columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            if (columnIndex > 0) {
                text += style(' │ ', 'divider');
            }
            var cell = row.cells[columnIndex] || '';
            var cellWidth = widths[columnIndex]!;
            var marker = '';
            if (columnIndex === 0) {
                marker = '  ';
                if (row.value === selected && rows[index - 1]?.value !== row.value) {
                    marker = '› ';
                }
                cellWidth = Math.max(0, cellWidth - marker.length);
            }
            var formatted = marker + cellText(cell, cellWidth);
            if (row.value === selected) {
                formatted = style(formatted, 'accent');
            }
            text += formatted;
        }
        text += '\n';
        var group = row.group || row.value;
        var nextGroup = rows[index + 1]?.group || rows[index + 1]?.value;
        if (config.columns && group !== nextGroup) {
            text += divider;
            blockHeight++;
        }
        blocks.push({ value: row.value, text, height: blockHeight });
    }
    var SCROLL_HINT_ROWS = 1;
    var actionRows = 0;
    if (actions.length) {
        actionRows = actions.length + 1;
    }
    var DETAIL_TEXT_ROWS = 2;
    var detailRows = 0;
    if (config.detail !== undefined) { detailRows = DETAIL_TEXT_ROWS + 1; }
    var capacity = Math.max(0, height - headingRows - actionRows - SCROLL_HINT_ROWS - detailRows);
    var anchor = 0;
    for (var index = 0; index < blocks.length; index++) {
        if (blocks[index]!.value === selected) {
            anchor = index;
        }
    }
    for (var action of actions) {
        if (action.value === selected) {
            anchor = Math.max(0, blocks.length - 1);
        }
    }
    var start = 0;
    var used = 0;
    for (var index = 0; index <= anchor && index < blocks.length; index++) {
        used += blocks[index]!.height;
        while (used > capacity && start < index) {
            used -= blocks[start]!.height;
            start++;
        }
    }
    var end = start;
    used = 0;
    while (end < blocks.length && used + blocks[end]!.height <= capacity) {
        output += blocks[end]!.text;
        used += blocks[end]!.height;
        end++;
    }
    if (actions.length || detailRows) {
        output += '  \n'.repeat(capacity - used);
    }
    var hint = '';
    if (start > 0) {
        hint = '↑ More above';
    }
    if (end < blocks.length) {
        hint += '  ↓ More below';
    }
    if (rows.length === 0) {
        hint = config.emptyMessage ?? 'No entries.';
    }
    output += '  ' + style(hint.slice(0, width), 'muted') + '\n';
    if (config.detail !== undefined) {
        output += '  \n';
        var remaining = config.detail;
        for (var index = 0; index < DETAIL_TEXT_ROWS; index++) {
            var text = remaining;
            if (remaining.length > width) {
                var end = remaining.lastIndexOf(' ', width);
                if (end < 1) { end = width; }
                text = remaining.slice(0, end);
                remaining = remaining.slice(end).trimStart();
                if (index === DETAIL_TEXT_ROWS - 1) { text = text.slice(0, width - 1) + '…'; }
            } else {
                remaining = '';
            }
            output += '  ' + style(text, 'muted') + '\n';
        }
    }
    if (actions.length) {
        output += '\n';
        for (var action of actions) {
            var label = '  ' + action.name;
            if (action.value === selected) {
                label = style('› ' + action.name, 'accent');
            }
            output += '  ' + label + '\n';
        }
    }
    return output;
}
