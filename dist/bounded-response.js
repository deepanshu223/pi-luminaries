export async function readBoundedResponse(response, maximumBytes, label) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
        throw new RangeError('Response byte bound must be a positive safe integer');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`${label} exceeds its bound`);
        }
    }
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            bytes += next.value.byteLength;
            if (bytes > maximumBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`${label} exceeds its bound`);
            }
            chunks.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
}
