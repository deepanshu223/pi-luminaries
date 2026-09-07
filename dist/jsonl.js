import { StringDecoder } from 'node:string_decoder';
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export function serializeJsonLine(value, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1)
        throw new RangeError('JSONL maxRecordBytes must be a positive safe integer');
    const json = JSON.stringify(value);
    if (json === undefined)
        throw new TypeError('JSONL value is not serializable');
    const bytes = Buffer.byteLength(json, 'utf8') + 1;
    if (bytes > maxRecordBytes)
        throw new RangeError(`JSONL record exceeds ${maxRecordBytes} bytes`);
    return `${json}\n`;
}
/** Strict LF framing. CR is accepted only as the final byte before LF. */
export class JsonlReader {
    maxRecordBytes;
    maxBufferBytes;
    decoder = new StringDecoder('utf8');
    buffer = '';
    ended = false;
    failed = false;
    skippingRecord = false;
    onRecord;
    onError;
    skipOversizedRecordPrefix;
    constructor(onRecord, options = {}, onError) {
        this.onRecord = onRecord;
        this.onError = onError;
        this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
        this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
        this.skipOversizedRecordPrefix = options.skipOversizedRecordPrefix;
        if (!Number.isSafeInteger(this.maxRecordBytes) ||
            !Number.isSafeInteger(this.maxBufferBytes) ||
            this.maxRecordBytes < 1 ||
            this.maxBufferBytes < this.maxRecordBytes) {
            throw new RangeError('JSONL limits must be positive safe integers and buffer must hold one record');
        }
    }
    feed(chunk) {
        if (this.ended || this.failed)
            return;
        try {
            this.append(this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
        }
        catch (error) {
            this.fail(error);
        }
    }
    end() {
        if (this.ended || this.failed)
            return;
        this.ended = true;
        try {
            this.append(this.decoder.end());
            if (this.skippingRecord)
                throw new SyntaxError('JSONL stream ended with an unterminated record');
            if (this.buffer.length > 0)
                throw new SyntaxError('JSONL stream ended with an unterminated record');
            this.buffer = '';
        }
        catch (error) {
            this.fail(error);
        }
    }
    /** Stop accepting records without reporting a second error. */
    stop() {
        this.failed = true;
        this.ended = true;
        this.buffer = '';
    }
    append(text) {
        if (this.skippingRecord) {
            const newline = text.indexOf('\n');
            if (newline === -1)
                return;
            this.skippingRecord = false;
            text = text.slice(newline + 1);
            if (!text)
                return;
        }
        this.buffer += text;
        this.drain();
        if (!this.skippingRecord && Buffer.byteLength(this.buffer, 'utf8') > this.maxBufferBytes) {
            throw new RangeError(`JSONL parser buffer exceeds ${this.maxBufferBytes} bytes`);
        }
    }
    drain() {
        let newline;
        while (!this.failed && (newline = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            this.parseRecord(line, true);
        }
        if (this.failed)
            return;
        if (Buffer.byteLength(this.buffer, 'utf8') > this.maxRecordBytes) {
            if (this.skipOversizedRecordPrefix && this.buffer.startsWith(this.skipOversizedRecordPrefix)) {
                this.buffer = '';
                this.skippingRecord = true;
                return;
            }
            throw new RangeError(`JSONL record exceeds ${this.maxRecordBytes} bytes`);
        }
    }
    parseRecord(line, terminated) {
        if (terminated && line.endsWith('\r'))
            line = line.slice(0, -1);
        const bytes = Buffer.byteLength(line, 'utf8') + (terminated ? 1 : 0);
        if (bytes > this.maxRecordBytes) {
            if (this.skipOversizedRecordPrefix && line.startsWith(this.skipOversizedRecordPrefix))
                return;
            throw new RangeError(`JSONL record exceeds ${this.maxRecordBytes} bytes`);
        }
        let value;
        try {
            value = JSON.parse(line);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new SyntaxError(`Malformed JSONL record: ${reason}`);
        }
        this.onRecord(value, line);
    }
    fail(error) {
        if (this.failed)
            return;
        this.failed = true;
        this.ended = true;
        this.buffer = '';
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (this.onError) {
            this.onError(normalized);
            return;
        }
        throw normalized;
    }
}
export function attachJsonlLineReader(stream, onRecord, options = {}, onError) {
    const reader = new JsonlReader(onRecord, options, onError);
    stream.on('data', (chunk) => reader.feed(chunk));
    stream.once('end', () => reader.end());
    return reader;
}
