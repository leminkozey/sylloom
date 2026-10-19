const hooks = new Set<() => Promise<unknown> | void>();
let shuttingDown = false;

export function onShutdown(hook: () => Promise<unknown> | void): () => void {
    hooks.add(hook);
    return () => { hooks.delete(hook); };
}

export function installSignalHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            if (shuttingDown) return;
            shuttingDown = true;
            const timeout = setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 6000);
            timeout.unref();
            void (async () => {
                for (const hook of [...hooks].reverse()) {
                    try { await hook(); } catch { /* Other cleanup hooks still run. */ }
                }
                process.exit(signal === 'SIGINT' ? 130 : 143);
            })();
        });
    }
}
