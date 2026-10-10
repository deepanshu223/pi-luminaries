import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

/** Byte bounds are opt-in; native Pi events may contain multiple full-size images. */
export interface JsonlLimits {
  maxRecordBytes?: number;
  maxBufferBytes?: number;
  skipRecordPrefixes?: readonly string[];
}

export function serializeJsonLine(value: unknown, maxRecordBytes?: number): string {
  if (maxRecordBytes !== undefined && (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1))
    throw new RangeError('JSONL maxRecordBytes must be a positive safe integer');
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('JSONL value is not serializable');
  if (maxRecordBytes !== undefined && Buffer.byteLength(json, 'utf8') + 1 > maxRecordBytes)
    throw new RangeError(`JSONL record exceeds ${maxRecordBytes} bytes`);
  return `${json}\n`;
}

export type JsonlRecordHandler = (value: unknown, raw: string) => void;
export type JsonlErrorHandler = (error: Error) => void;

/** Strict LF framing. CR is accepted only as the final byte before LF. */
export class JsonlReader {
  readonly maxRecordBytes: number | undefined;
  readonly maxBufferBytes: number | undefined;
  private readonly decoder = new StringDecoder('utf8');
  private fragments: string[] = [];
  private recordBytes = 0;
  private prefix = '';
  private ended = false;
  private failed = false;
  private skippingRecord = false;
  private readonly onRecord: JsonlRecordHandler;
  private readonly onError?: JsonlErrorHandler;
  private readonly skipRecordPrefixes: readonly string[];
  private readonly prefixLength: number;

  constructor(onRecord: JsonlRecordHandler, options: JsonlLimits = {}, onError?: JsonlErrorHandler) {
    this.onRecord = onRecord;
    this.onError = onError;
    this.maxRecordBytes = options.maxRecordBytes ?? options.maxBufferBytes;
    this.maxBufferBytes = options.maxBufferBytes;
    this.skipRecordPrefixes = options.skipRecordPrefixes ?? [];
    this.prefixLength = Math.max(0, ...this.skipRecordPrefixes.map((prefix) => prefix.length));
    if (
      (this.maxRecordBytes !== undefined && (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1)) ||
      (this.maxBufferBytes !== undefined && (!Number.isSafeInteger(this.maxBufferBytes) || this.maxBufferBytes < 1)) ||
      (this.maxRecordBytes !== undefined &&
        this.maxBufferBytes !== undefined &&
        this.maxBufferBytes < this.maxRecordBytes)
    ) {
      throw new RangeError('JSONL limits must be positive safe integers and buffer must hold one record');
    }
  }

  feed(chunk: Uint8Array | string): void {
    if (this.ended || this.failed) return;
    try {
      this.append(this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    } catch (error) {
      this.fail(error);
    }
  }

  end(): void {
    if (this.ended || this.failed) return;
    this.ended = true;
    try {
      this.append(this.decoder.end());
      if (this.skippingRecord) throw new SyntaxError('JSONL stream ended with an unterminated record');
      if (this.fragments.length > 0) throw new SyntaxError('JSONL stream ended with an unterminated record');
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stop accepting records without reporting a second error. */
  stop(): void {
    this.failed = true;
    this.ended = true;
    this.fragments = [];
  }

  private append(text: string): void {
    let start = 0;
    while (start < text.length && !this.failed) {
      const newline = text.indexOf('\n', start);
      const fragment = text.slice(start, newline < 0 ? text.length : newline);
      if (!this.skippingRecord) {
        if (this.prefix.length < this.prefixLength)
          this.prefix += fragment.slice(0, this.prefixLength - this.prefix.length);
        this.skippingRecord = this.skipRecordPrefixes.some((prefix) => this.prefix.startsWith(prefix));
        if (this.skippingRecord) this.fragments = [];
        else {
          this.fragments.push(fragment);
          if (this.maxRecordBytes !== undefined || this.maxBufferBytes !== undefined)
            this.recordBytes += Buffer.byteLength(fragment, 'utf8');
          if (this.maxRecordBytes !== undefined && this.recordBytes + (newline < 0 ? 0 : 1) > this.maxRecordBytes)
            throw new RangeError(`JSONL record exceeds ${this.maxRecordBytes} bytes`);
          if (this.maxBufferBytes !== undefined && this.recordBytes > this.maxBufferBytes)
            throw new RangeError(`JSONL parser buffer exceeds ${this.maxBufferBytes} bytes`);
        }
      }
      if (newline < 0) return;
      if (!this.skippingRecord) this.parseRecord(this.fragments.join(''), true);
      this.fragments = [];
      this.recordBytes = 0;
      this.prefix = '';
      this.skippingRecord = false;
      start = newline + 1;
    }
  }

  private parseRecord(line: string, terminated: boolean): void {
    if (terminated && line.endsWith('\r')) line = line.slice(0, -1);
    if (
      this.maxRecordBytes !== undefined &&
      Buffer.byteLength(line, 'utf8') + (terminated ? 1 : 0) > this.maxRecordBytes
    ) {
      throw new RangeError(`JSONL record exceeds ${this.maxRecordBytes} bytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SyntaxError(`Malformed JSONL record: ${reason}`);
    }
    this.onRecord(value, line);
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.ended = true;
    this.fragments = [];
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.onError) {
      this.onError(normalized);
      return;
    }
    throw normalized;
  }
}

export function attachJsonlLineReader(
  stream: Readable,
  onRecord: JsonlRecordHandler,
  options: JsonlLimits = {},
  onError?: JsonlErrorHandler,
): JsonlReader {
  const reader = new JsonlReader(onRecord, options, onError);
  stream.on('data', (chunk: Buffer | string) => reader.feed(chunk));
  stream.once('end', () => reader.end());
  return reader;
}
