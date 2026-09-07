import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
export interface LuminariesTerminalWidth {
    visibleWidth: typeof visibleWidth;
    truncateToWidth: typeof truncateToWidth;
}
export declare const HOST_TERMINAL_WIDTH: LuminariesTerminalWidth;
export declare function boundTerminalLines(lines: readonly string[], width: number, terminalWidth?: LuminariesTerminalWidth): string[];
