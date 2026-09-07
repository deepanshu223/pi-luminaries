import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export interface LuminariesTerminalWidth {
  visibleWidth: typeof visibleWidth;
  truncateToWidth: typeof truncateToWidth;
}

export const HOST_TERMINAL_WIDTH: LuminariesTerminalWidth = Object.freeze({
  visibleWidth,
  truncateToWidth,
});

export function boundTerminalLines(
  lines: readonly string[],
  width: number,
  terminalWidth: LuminariesTerminalWidth = HOST_TERMINAL_WIDTH,
): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  return lines.map((line) =>
    terminalWidth.visibleWidth(line) <= safeWidth ? line : terminalWidth.truncateToWidth(line, safeWidth, ''),
  );
}
