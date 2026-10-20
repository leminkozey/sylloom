// Node fixtures and user-provided JS runtimes must also work on Windows, where
// CreateProcess does not interpret a Unix shebang. Never invoke a command shell.
export function processCommand(binary: string, args: string[]): [string, string[]] {
    return /\.(?:mjs|cjs|js)$/iu.test(binary) ? [process.execPath, [binary, ...args]] : [binary, args];
}
