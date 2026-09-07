import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
export const HOST_TERMINAL_WIDTH = Object.freeze({
    visibleWidth,
    truncateToWidth,
});
export function boundTerminalLines(lines, width, terminalWidth = HOST_TERMINAL_WIDTH) {
    const safeWidth = Math.max(0, Math.floor(width));
    return lines.map((line) => terminalWidth.visibleWidth(line) <= safeWidth ? line : terminalWidth.truncateToWidth(line, safeWidth, ''));
}
