/** Luminaries map and public IDs: one through 64 ASCII characters with alphanumeric edges. */
export declare function isLuminariesId(value: string): boolean;
/** Pi session IDs use the same ASCII alphabet without Luminaries's 64-character map-key limit. */
export declare function isPiSessionId(value: string): boolean;
export declare function isLowercaseSha256(value: string): boolean;
/** Canonical UUID text with RFC variant and versions 1 through 8. */
export declare function isUuid(value: string): boolean;
export declare function isAsciiControlCharacter(value: string): boolean;
/** Controls that can alter terminal presentation without appearing as ordinary text. */
export declare function hasUnsafeHumanFacingControl(value: string): boolean;
