export const isWindows = process.platform === 'win32';
export const isDesktop = process.platform === 'darwin' || isWindows;
export const ALT_KEY = isWindows ? 'Alt' : 'Option';
export const PASTE_SHORTCUT = isWindows ? 'Ctrl+V' : 'Cmd+V';
export const CALL_APPLE_LABEL = isWindows ? 'Phone Link' : 'FaceTime / iPhone';
