import type { Readable } from 'node:stream';
export interface JsonlLimits {
    maxRecordBytes?: number;
    maxBufferBytes?: number;
    skipOversizedRecordPrefix?: string;
}
export declare function serializeJsonLine(value: unknown, maxRecordBytes?: number): string;
export type JsonlRecordHandler = (value: unknown, raw: string) => void;
export type JsonlErrorHandler = (error: Error) => void;
/** Strict LF framing. CR is accepted only as the final byte before LF. */
export declare class JsonlReader {
    readonly maxRecordBytes: number;
    readonly maxBufferBytes: number;
    private readonly decoder;
    private buffer;
    private ended;
    private failed;
    private skippingRecord;
    private readonly onRecord;
    private readonly onError?;
    private readonly skipOversizedRecordPrefix?;
    constructor(onRecord: JsonlRecordHandler, options?: JsonlLimits, onError?: JsonlErrorHandler);
    feed(chunk: Uint8Array | string): void;
    end(): void;
    /** Stop accepting records without reporting a second error. */
    stop(): void;
    private append;
    private drain;
    private parseRecord;
    private fail;
}
export declare function attachJsonlLineReader(stream: Readable, onRecord: JsonlRecordHandler, options?: JsonlLimits, onError?: JsonlErrorHandler): JsonlReader;
