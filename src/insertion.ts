import { copyText } from './clipboard.js';
import { captureInput, accessibilityStatus } from './native/input.js';

export type InputTarget = { insert(text: string, signal?: AbortSignal): boolean | Promise<boolean>; close(): void; reason?: string };
export type CapturedInput = { target?: InputTarget; reason: string };
export type Delivery = { kind: 'inserted' | 'clipboard'; at: string; reason?: string; raw?: boolean };
export { captureInput, accessibilityStatus };

export async function deliverText(text: string, input: CapturedInput, signal?: AbortSignal, copy = copyText): Promise<Delivery> {
    let reason = input.reason;
    try {
        signal?.throwIfAborted();
        if (!text.trim()) throw new Error('No text to deliver. Clipboard preserved.');
        if (input.target && await input.target.insert(text, signal)) return { kind: 'inserted', at: new Date().toISOString(), ...(input.target.reason ? { reason: input.target.reason } : {}) };
        if (input.target) reason = input.target.reason || 'The input changed or did not accept insertion.';
    } catch (error) {
        if (signal?.aborted || !text.trim()) throw error;
        reason = 'The app did not accept insertion.';
    }
    finally { input.target?.close(); }
    signal?.throwIfAborted();
    await copy(text);
    return { kind: 'clipboard', at: new Date().toISOString(), reason };
}
