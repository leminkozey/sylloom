import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverText } from '../src/insertion.js';

test('successful insertion preserves clipboard and releases the captured input', async () => {
    let closed = 0; let content = '';
    const result = await deliverText('Hallo Sam.\n\nBitte prüfen.', { reason: '', target: {
        insert(text) { content = text; return true; }, close() { closed++; },
    } }, undefined, async () => { assert.fail('Clipboard must remain unchanged'); });
    assert.equal(result.kind, 'inserted'); assert.equal(content, 'Hallo Sam.\n\nBitte prüfen.'); assert.equal(closed, 1);
});

test('no field, changed focus and native errors all fall back to exact formatted text', async () => {
    for (const insert of [undefined, () => false, () => { throw new Error('Unsupported app'); }]) {
        let copied = ''; let closed = 0;
        const result = await deliverText('• Eins\n• Zwei', { reason: 'No field', target: insert ? { insert, close() { closed++; } } : undefined },
            undefined, async text => { copied = text; });
        assert.equal(result.kind, 'clipboard'); assert.equal(copied, '• Eins\n• Zwei'); assert.equal(closed, insert ? 1 : 0);
    }
});

test('canceled and empty delivery never modifies a field or clipboard and releases references', async () => {
    let closed = 0; const target = { insert() { assert.fail('Must not insert'); }, close() { closed++; } };
    const controller = new AbortController(); controller.abort();
    const copy = async () => { assert.fail('Must not copy'); };
    await assert.rejects(deliverText('Text', { target, reason: '' }, controller.signal, copy));
    await assert.rejects(deliverText(' ', { target, reason: '' }, undefined, copy), /No text/);
    assert.equal(closed, 2);
});

test('asynchronous paste is awaited and exact failure reasons survive clipboard fallback', async () => {
    let copied = ''; let closed = false; let finished = false;
    const target = { reason: 'The app did not confirm the pasted text.',
        async insert() { await new Promise(resolve => setTimeout(resolve, 5)); finished = true; return false; },
        close() { assert.equal(finished, true); closed = true; } };
    const result = await deliverText('Hallo Sam.', { target, reason: '' }, undefined, async text => { copied = text; });
    assert.equal(result.kind, 'clipboard'); assert.equal(result.reason, target.reason); assert.equal(copied, 'Hallo Sam.'); assert.equal(closed, true);
});

test('a clipboard restoration warning never triggers duplicate delivery after successful insertion', async () => {
    const result = await deliverText('Hallo Sam.', { reason: '', target: { reason: 'Previous clipboard unavailable.',
        insert: async () => true, close() {},
    } }, undefined, async () => { assert.fail('Already inserted; do not overwrite the clipboard'); });
    assert.equal(result.kind, 'inserted'); assert.equal(result.reason, 'Previous clipboard unavailable.');
});
