import type { Readable } from 'node:stream';
/** Byte bounds are opt-in; native Pi events may contain multiple full-size images. */
export interface JsonlLimits {
    maxRecordBytes?: number;
    maxBufferBytes?: number;
    skipRecordPrefixes?: readonly string[];
}
export declare function serializeJsonLine(value: unknown, maxRecordBytes?: number): string;
export type JsonlRecordHandler = (value: unknown, raw: string) => void;
export type JsonlErrorHandler = (error: Error) => void;
/** Strict LF framing. CR is accepted only as the final byte before LF. */
export declare class JsonlReader {
    readonly maxRecordBytes: number | undefined;
    readonly maxBufferBytes: number | undefined;
    private readonly decoder;
    private fragments;
    private recordBytes;
    private prefix;
    private ended;
    private failed;
    private skippingRecord;
    private readonly onRecord;
    private readonly onError?;
    private readonly skipRecordPrefixes;
    private readonly prefixLength;
    constructor(onRecord: JsonlRecordHandler, options?: JsonlLimits, onError?: JsonlErrorHandler);
    feed(chunk: Uint8Array | string): void;
    end(): void;
    /** Stop accepting records without reporting a second error. */
    stop(): void;
    private append;
    private parseRecord;
    private fail;
}
export declare function attachJsonlLineReader(stream: Readable, onRecord: JsonlRecordHandler, options?: JsonlLimits, onError?: JsonlErrorHandler): JsonlReader;
