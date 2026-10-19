// Adapted from velora-cli/src/terminal/style.ts. Palette and color controls are shared.
export default function style(text: string, name: 'accent' | 'logo' | 'strong' | 'emphasis' | 'muted' | 'divider' | 'OK' | 'Warning' | 'Error' | 'heat0' | 'heat1' | 'heat2' | 'heat3' | 'heat4'): string {
    let enabled = Boolean(process.stdout.isTTY);
    if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') enabled = true;
    if (process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb' || process.env.FORCE_COLOR === '0') enabled = false;
    if (!enabled) return text;
    const styles = { strong: '1', emphasis: '3', muted: '2', divider: '90', accent: '38;2;104;107;231', logo: '38;2;255;255;255', OK: '32', Warning: '38;5;208', Error: '31',
        heat0: '90', heat1: '38;2;74;73;115', heat2: '38;2;104;107;180', heat3: '38;2;136;139;240', heat4: '38;2;195;197;255' };
    let code = styles[name];
    if (name === 'accent' && process.env.COLORFGBG?.split(';').at(-1) === '15') code = '38;2;37;37;204';
    return '\x1b[' + code + 'm' + text + '\x1b[0m';
}
