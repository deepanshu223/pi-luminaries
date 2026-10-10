export declare const PUBLIC_RESULT_BYTES: number;
export declare function receiptWireBytes(toolCallId: string, message: string, details: Readonly<Record<string, unknown>>, terminate?: boolean): number;
export interface ProjectionCursorScope {
    rootId: string;
    callerId: string;
    view: string;
    filter: string;
    revision: number;
}
export declare function encodeProjectionCursor(scope: ProjectionCursorScope, key: string): string;
export declare function decodeProjectionCursor(value: string | undefined, expected: ProjectionCursorScope): string | undefined;
export declare function buildBytePage<T>(options: {
    items: readonly T[];
    afterKey?: string;
    keyOf: (item: T) => string;
    requestedLimit: number;
    scope: ProjectionCursorScope;
    buildDetails: (items: readonly T[], nextCursor: string | undefined, remaining: number) => Record<string, unknown>;
    measureDetails: (details: Readonly<Record<string, unknown>>) => number;
}): Record<string, unknown>;
