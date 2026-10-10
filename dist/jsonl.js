import { StringDecoder } from 'node:string_decoder';
export function serializeJsonLine(value, maxRecordBytes) {
    if (maxRecordBytes !== undefined && (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1))
        throw new RangeError('JSONL maxRecordBytes must be a positive safe integer');
    const json = JSON.stringify(value);
    if (json === undefined)
        throw new TypeError('JSONL value is not serializable');
    if (maxRecordBytes !== undefined && Buffer.byteLength(json, 'utf8') + 1 > maxRecordBytes)
        throw new RangeError(`JSONL record exceeds ${maxRecordBytes} bytes`);
    return `${json}\n`;
}
/** Strict LF framing. CR is accepted only as the final byte before LF. */
export class JsonlReader {
    maxRecordBytes;
    maxBufferBytes;
    decoder = new StringDecoder('utf8');
    fragments = [];
    recordBytes = 0;
    prefix = '';
    ended = false;
    failed = false;
    skippingRecord = false;
    onRecord;
    onError;
    skipRecordPrefixes;
    prefixLength;
    constructor(onRecord, options = {}, onError) {
        this.onRecord = onRecord;
        this.onError = onError;
        this.maxRecordBytes = options.maxRecordBytes ?? options.maxBufferBytes;
        this.maxBufferBytes = options.maxBufferBytes;
        this.skipRecordPrefixes = options.skipRecordPrefixes ?? [];
        this.prefixLength = Math.max(0, ...this.skipRecordPrefixes.map((prefix) => prefix.length));
        if ((this.maxRecordBytes !== undefined && (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1)) ||
            (this.maxBufferBytes !== undefined && (!Number.isSafeInteger(this.maxBufferBytes) || this.maxBufferBytes < 1)) ||
            (this.maxRecordBytes !== undefined &&
                this.maxBufferBytes !== undefined &&
                this.maxBufferBytes < this.maxRecordBytes)) {
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
            if (this.fragments.length > 0)
                throw new SyntaxError('JSONL stream ended with an unterminated record');
        }
        catch (error) {
            this.fail(error);
        }
    }
    /** Stop accepting records without reporting a second error. */
    stop() {
        this.failed = true;
        this.ended = true;
        this.fragments = [];
    }
    append(text) {
        let start = 0;
        while (start < text.length && !this.failed) {
            const newline = text.indexOf('\n', start);
            const fragment = text.slice(start, newline < 0 ? text.length : newline);
            if (!this.skippingRecord) {
                if (this.prefix.length < this.prefixLength)
                    this.prefix += fragment.slice(0, this.prefixLength - this.prefix.length);
                this.skippingRecord = this.skipRecordPrefixes.some((prefix) => this.prefix.startsWith(prefix));
                if (this.skippingRecord)
                    this.fragments = [];
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
            if (newline < 0)
                return;
            if (!this.skippingRecord)
                this.parseRecord(this.fragments.join(''), true);
            this.fragments = [];
            this.recordBytes = 0;
            this.prefix = '';
            this.skippingRecord = false;
            start = newline + 1;
        }
    }
    parseRecord(line, terminated) {
        if (terminated && line.endsWith('\r'))
            line = line.slice(0, -1);
        if (this.maxRecordBytes !== undefined &&
            Buffer.byteLength(line, 'utf8') + (terminated ? 1 : 0) > this.maxRecordBytes) {
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
        this.fragments = [];
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
