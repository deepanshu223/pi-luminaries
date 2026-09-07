import { mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSessionContext, migrateSessionEntries, parseSessionEntries, SessionManager, } from '@earendil-works/pi-coding-agent';
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { isRecord } from "./scheduler-state.js";
import { isPiSessionId } from "./identifiers.js";
const UNSUPPORTED_DIRECTORY_SYNC = new Set(['EPERM', 'EINVAL']);
function errorCode(value) {
    if (typeof value !== 'object' || value === null || !Object.prototype.hasOwnProperty.call(value, 'code'))
        return undefined;
    const code = Reflect.get(value, 'code');
    return typeof code === 'string' ? code : undefined;
}
function isMessageContent(value) {
    return (typeof value === 'string' ||
        (Array.isArray(value) && value.every((part) => isRecord(part) && typeof part.type === 'string')));
}
function isPiSessionMessage(value) {
    if (!isRecord(value) || typeof value.role !== 'string' || typeof value.timestamp !== 'number')
        return false;
    if (value.role === 'user')
        return isMessageContent(value.content);
    if (value.role === 'assistant')
        return (Array.isArray(value.content) &&
            value.content.every((part) => isRecord(part) && typeof part.type === 'string') &&
            typeof value.api === 'string' &&
            typeof value.provider === 'string' &&
            typeof value.model === 'string' &&
            isRecord(value.usage) &&
            typeof value.stopReason === 'string');
    if (value.role === 'toolResult')
        return (typeof value.toolCallId === 'string' &&
            typeof value.toolName === 'string' &&
            isMessageContent(value.content) &&
            typeof value.isError === 'boolean');
    if (value.role === 'bashExecution')
        return (typeof value.command === 'string' &&
            typeof value.output === 'string' &&
            (value.exitCode === undefined || typeof value.exitCode === 'number') &&
            typeof value.cancelled === 'boolean' &&
            typeof value.truncated === 'boolean');
    if (value.role === 'custom')
        return (typeof value.customType === 'string' && isMessageContent(value.content) && typeof value.display === 'boolean');
    if (value.role === 'branchSummary')
        return typeof value.summary === 'string' && typeof value.fromId === 'string';
    if (value.role === 'compactionSummary')
        return typeof value.summary === 'string' && typeof value.tokensBefore === 'number';
    return false;
}
function encodedRecord(value) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new Error('Pi session contains a non-serializable record');
    return `${encoded}\n`;
}
function verifiedHeader(value, expectedId) {
    if (typeof value !== 'object' || value === null)
        throw new Error('Pi session header is not an object');
    if (Reflect.get(value, 'type') !== 'session' || Reflect.get(value, 'id') !== expectedId)
        throw new Error(`Pi session header does not match the requested ${LUMINARIES_IDENTITY.label} session identity`);
}
function validateImportedSession(header, entries) {
    if (!isPiSessionId(header.id) ||
        typeof header.timestamp !== 'string' ||
        !header.timestamp ||
        typeof header.cwd !== 'string' ||
        !isAbsolute(header.cwd) ||
        (header.parentSession !== undefined && typeof header.parentSession !== 'string'))
        throw new Error('Pi session header identity or working directory is invalid');
    const prior = new Set();
    for (const entry of entries) {
        if (!isRecord(entry) ||
            typeof entry.id !== 'string' ||
            !entry.id ||
            prior.has(entry.id) ||
            (entry.parentId !== null && (typeof entry.parentId !== 'string' || !prior.has(entry.parentId))))
            throw new Error('Pi session entry ancestry is invalid or cyclic');
        prior.add(entry.id);
    }
}
function openPiSession(sessionFile, cwd, expectedSessionId) {
    try {
        const manager = SessionManager.open(sessionFile, undefined, cwd);
        verifiedHeader(manager.getHeader(), expectedSessionId);
        return manager;
    }
    catch (error) {
        throw new Error('Conversation history is unavailable or unreadable; inspect it from the owning Pi session', {
            cause: error,
        });
    }
}
async function readSessionImage(sessionFileInput) {
    const sessionFile = resolve(await realpath(sessionFileInput));
    const bytes = await readFile(sessionFile);
    const text = bytes.toString('utf8');
    const records = parseSessionEntries(text);
    if (records.length !== text.split('\n').filter((line) => line.trim()).length)
        throw new Error('Pi session contains a malformed record');
    migrateSessionEntries(records);
    const first = records[0];
    const header = first?.type === 'session' ? first : undefined;
    if (!header)
        throw new Error('Pi session has no header');
    verifiedHeader(header, header.id);
    const entries = records.filter((record) => record.type !== 'session');
    validateImportedSession(header, entries);
    const context = buildSessionContext(entries);
    const name = entries
        .flatMap((entry) => isRecord(entry) && entry.type === 'session_info' && typeof entry.name === 'string' ? [entry.name] : [])
        .at(-1);
    return {
        bytes,
        info: {
            sessionId: header.id,
            sessionFile,
            cwd: header.cwd,
            ...(header.parentSession ? { parentSession: resolve(dirname(sessionFile), header.parentSession) } : {}),
            ...(name ? { name } : {}),
            ...(context.model ? { model: context.model } : {}),
            thinking: context.thinkingLevel,
            entries: structuredClone(entries),
            messages: structuredClone(context.messages),
            contentHash: createHash('sha256').update(bytes).digest('hex'),
        },
    };
}
async function readSessionInfo(sessionFileInput) {
    return (await readSessionImage(sessionFileInput)).info;
}
async function syncPath(path, flags = 'r') {
    const handle = await open(path, flags);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function matchingSessionFile(directory, sessionId) {
    let names;
    try {
        names = await readdir(directory);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return undefined;
        throw error;
    }
    const matches = names.filter((name) => name.endsWith(`_${sessionId}.jsonl`));
    if (matches.length > 1)
        throw new Error(`Pi session identity '${sessionId}' has multiple files`);
    return matches[0] ? join(directory, matches[0]) : undefined;
}
function handoffMarker(entries, operationId, kind) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!isRecord(entry) ||
            entry.type !== 'custom_message' ||
            (entry.customType !== 'Pi session handoff' && entry.customType !== 'luminaries-session-handoff'))
            continue;
        if (!isRecord(entry.details) || entry.details.operationId !== operationId || entry.details.kind !== kind)
            continue;
        return entry.details;
    }
    return undefined;
}
async function verifyFork(targetFile, targetCwd, input, source) {
    const target = await readSessionInfo(targetFile);
    const marker = handoffMarker(target.entries, input.operationId, input.kind);
    if (target.sessionId !== input.sessionId ||
        resolve(target.cwd) !== resolve(targetCwd) ||
        !marker ||
        marker.sourceSessionId !== source.sessionId ||
        marker.sourceSessionFile !== source.sessionFile)
        throw new Error(`Forked Pi session '${input.sessionId}' does not match its handoff identity`);
    return target;
}
async function performForkSession(input) {
    const sourceImage = await readSessionImage(input.sourceFile);
    const source = sourceImage.info;
    const targetCwd = resolve(input.targetCwd);
    const targetDirectory = resolve(input.targetSessionDir ?? SessionManager.create(targetCwd).getSessionDir());
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const existing = await matchingSessionFile(targetDirectory, input.sessionId);
    if (existing)
        return verifyFork(existing, targetCwd, input, source);
    const stagingDirectory = join(targetDirectory, `.luminaries-handoff-${input.sessionId}`);
    await rm(stagingDirectory, { recursive: true, force: true });
    await mkdir(stagingDirectory, { mode: 0o700 });
    try {
        const sourceCopy = join(stagingDirectory, 'source.jsonl');
        await writeFile(sourceCopy, sourceImage.bytes, { flag: 'wx', mode: 0o600 });
        await syncPath(sourceCopy, 'r+');
        SessionManager.open(sourceCopy, stagingDirectory);
        const migratedSource = await readSessionInfo(sourceCopy);
        const initialFork = SessionManager.forkFrom(sourceCopy, targetCwd, stagingDirectory, {
            id: input.sessionId,
        });
        const stagedFile = initialFork.getSessionFile();
        if (!stagedFile)
            throw new Error('Pi did not persist the forked session');
        const stagedBytes = await readFile(stagedFile, 'utf8');
        const newline = stagedBytes.indexOf('\n');
        if (newline < 0)
            throw new Error('Forked Pi session has no complete header');
        const header = JSON.parse(stagedBytes.slice(0, newline));
        if (!isRecord(header) || header.type !== 'session')
            throw new Error('Forked Pi session header is invalid');
        await writeFile(stagedFile, `${JSON.stringify({ ...header, parentSession: source.sessionFile })}${stagedBytes.slice(newline)}`);
        await syncPath(stagedFile, 'r+');
        const fork = SessionManager.open(stagedFile, stagingDirectory, targetCwd);
        fork.appendCustomMessageEntry('Pi session handoff', input.contextNote, true, {
            operationId: input.operationId,
            kind: input.kind,
            sourceSessionId: source.sessionId,
            sourceSessionFile: source.sessionFile,
            sourceHash: source.contentHash,
        });
        fork.appendSessionInfo(input.destinationName);
        const staged = await readSessionInfo(stagedFile);
        if (JSON.stringify(staged.messages.slice(0, migratedSource.messages.length)) !==
            JSON.stringify(migratedSource.messages))
            throw new Error(`Forked Pi session '${input.sessionId}' did not preserve its active source context`);
        await verifyFork(stagedFile, targetCwd, input, source);
        await syncPath(stagedFile, 'r+');
        const publishedFile = join(targetDirectory, basename(stagedFile));
        await rename(stagedFile, publishedFile);
        await syncPath(publishedFile, 'r+');
        try {
            await syncPath(targetDirectory);
        }
        catch (error) {
            if (!UNSUPPORTED_DIRECTORY_SYNC.has(errorCode(error) ?? ''))
                throw error;
        }
        return verifyFork(publishedFile, targetCwd, input, source);
    }
    finally {
        await rm(stagingDirectory, { recursive: true, force: true });
    }
}
/**
 * Pi defers writing a new session until an assistant message exists. Luminaries must bind
 * physical private identity before child launch, so persist Pi's own public header
 * and entries without inventing a model-visible message.
 */
async function persistSeededPiSession(manager) {
    const sessionFile = manager.getSessionFile();
    if (!sessionFile)
        throw new Error(`Pi did not allocate a private ${LUMINARIES_IDENTITY.label} session file`);
    const expectedId = manager.getSessionId();
    const header = manager.getHeader();
    verifiedHeader(header, expectedId);
    const expected = Buffer.from([header, ...manager.getEntries()].map((record) => encodedRecord(record)).join(''), 'utf8');
    let created = false;
    let handle;
    try {
        handle = await open(sessionFile, 'wx+', 0o600);
        created = true;
    }
    catch (error) {
        if (errorCode(error) !== 'EEXIST')
            throw error;
        handle = await open(sessionFile, 'r+');
    }
    try {
        if (created)
            await handle.writeFile(expected);
        else {
            const size = (await handle.stat()).size;
            if (size > expected.byteLength)
                throw new Error('Existing Pi session seed contains records outside the requested starting context');
            const present = Buffer.alloc(size);
            let offset = 0;
            while (offset < size) {
                const { bytesRead } = await handle.read(present, offset, size - offset, offset);
                if (!bytesRead)
                    throw new Error('Existing Pi session seed ended during verification');
                offset += bytesRead;
            }
            if (!expected.subarray(0, size).equals(present))
                throw new Error('Existing Pi session seed differs from the requested starting context');
            if (size < expected.byteLength)
                await handle.write(expected.subarray(size), 0, expected.byteLength - size, size);
        }
        await handle.sync();
        const complete = Buffer.alloc(expected.byteLength);
        let offset = 0;
        while (offset < complete.byteLength) {
            const { bytesRead } = await handle.read(complete, offset, complete.byteLength - offset, offset);
            if (!bytesRead)
                throw new Error('Pi session seed remained incomplete after persistence');
            offset += bytesRead;
        }
        if (!complete.equals(expected))
            throw new Error('Pi session seed verification failed');
    }
    finally {
        await handle.close();
    }
    try {
        const directory = await open(dirname(sessionFile), 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    catch (error) {
        if (!UNSUPPORTED_DIRECTORY_SYNC.has(errorCode(error) ?? ''))
            throw error;
    }
    return sessionFile;
}
/** Lazy supported Pi API adapter; no Pi runtime object is retained across extension replacement. */
export function createPiSessionHost() {
    const forks = new Map();
    const readContext = async (sessionFile, _cwd, expectedSessionId) => {
        const manager = openPiSession(sessionFile, _cwd, expectedSessionId);
        return {
            entries: structuredClone(manager.buildContextEntries()),
            messages: structuredClone(manager.buildSessionContext().messages),
        };
    };
    return {
        async createSeededSession(input) {
            const manager = SessionManager.create(input.cwd, input.sessionDir, {
                id: input.sessionId,
                ...(input.parentSession ? { parentSession: input.parentSession } : {}),
            });
            for (const message of input.messages) {
                if (!isPiSessionMessage(message))
                    throw new Error('Transferred Pi context contains an invalid message');
                manager.appendMessage(structuredClone(message));
            }
            return persistSeededPiSession(manager);
        },
        readContext,
        async readMessages(sessionFile, _cwd, expectedSessionId) {
            return (await readContext(sessionFile, _cwd, expectedSessionId)).messages;
        },
        async inspectSession(sessionFile) {
            return readSessionInfo(sessionFile);
        },
        async listSessions() {
            return (await SessionManager.listAll()).map((session) => ({
                sessionFile: resolve(session.path),
                sessionId: session.id,
                cwd: session.cwd,
                ...(session.name ? { name: session.name } : {}),
                modifiedAtMs: session.modified.getTime(),
                messageCount: session.messageCount,
                firstMessage: session.firstMessage,
            }));
        },
        async forkSession(input) {
            const fingerprint = JSON.stringify(input);
            const active = forks.get(input.sessionId);
            if (active) {
                if (active.fingerprint !== fingerprint)
                    throw new Error(`Pi session identity '${input.sessionId}' was reused for another handoff`);
                return active.promise;
            }
            const promise = performForkSession(input);
            const request = { fingerprint, promise };
            forks.set(input.sessionId, request);
            try {
                return await promise;
            }
            finally {
                if (forks.get(input.sessionId) === request)
                    forks.delete(input.sessionId);
            }
        },
    };
}
