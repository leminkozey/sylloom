import { isMainThread } from 'node:worker_threads';
import koffi from 'koffi';

let initialized = false;

export function initializeAppKit(): void {
    if (!isMainThread) throw new Error('AppKit must be initialized on the main thread.');
    if (process.platform !== 'darwin') throw new Error('AppKit requires macOS.');
    if (initialized) return;
    const carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
    const psn = koffi.struct({ highLongOfPSN: 'uint32', lowLongOfPSN: 'uint32' });
    const transform = carbon.func('TransformProcessType', 'int32', [koffi.pointer(psn), 'uint32']);
    if (transform({ highLongOfPSN: 0, lowLongOfPSN: 2 }, 4) !== 0) throw new Error('macOS could not register the background application.');
    // Finish creating NSApplication before a worker or Carbon event pump starts.
    // Initializing it in the observer worker races ReceiveNextEvent on startup.
    const load = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit').func('bool NSApplicationLoad(void)');
    if (!load()) throw new Error('macOS could not initialize the application event loop.');
    initialized = true;
}
