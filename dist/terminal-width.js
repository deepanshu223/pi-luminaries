import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
export const HOST_TERMINAL_WIDTH = Object.freeze({
    visibleWidth,
    truncateToWidth,
});
export function boundTerminalLines(lines, width, terminalWidth = HOST_TERMINAL_WIDTH) {
    const safeWidth = Math.max(0, Math.floor(width));
    // Pi exempts Kitty and iTerm image lines from text width checks; preserve their protocol payloads.
    return lines.map((line) => line.includes('\x1b_G') || line.includes('\x1b]1337;File=') || terminalWidth.visibleWidth(line) <= safeWidth
        ? line
        : terminalWidth.truncateToWidth(line, safeWidth, ''));
}
