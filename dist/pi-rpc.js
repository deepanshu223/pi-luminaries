import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { isPiSessionId } from "./identifiers.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
export class PiRpcCommandError extends Error {
    command;
    constructor(command, message) {
        super(message);
        this.name = 'PiRpcCommandError';
        this.command = command;
    }
}
const UNSAFE_DIRECT_INVOCATION_EXTENSIONS = new Set(['.cmd', '.bat', '.js', '.mjs', '.cjs']);
const GENERIC_RUNTIME_EXECUTABLES = {
    bun: true,
    'bun.exe': true,
    deno: true,
    'deno.exe': true,
    electron: true,
    'electron.exe': true,
    node: true,
    'node.exe': true,
};
const INHERITED_PARENT_SESSION_ENV = [
    'PI_SESSION_ID',
    'PI_SESSION_FILE',
    'PI_PROVIDER',
    'PI_MODEL',
    'PI_REASONING_LEVEL',
];
const DEFAULTS = {
    maxPendingRequests: 128,
    maxQueuedCommands: 128,
    maxStderrBytes: 64 * 1024,
    maxDiagnostics: 32,
    requestTimeoutMs: 30_000,
};
// These summaries repeat messages already emitted individually. Settlement uses agent_settled.
const REDUNDANT_SUMMARY_PREFIXES = ['{"type":"agent_end","messages":', '{"type":"turn_end","message":'];
function childError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function recordOf(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}
function isWithin(child, parent) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
}
function validateBaseInvocationArgs(invocation) {
    const option = (invocation.args ?? []).find((arg) => arg.startsWith('-'));
    if (option)
        throw new Error(`Pi base invocation arguments cannot contain CLI options: ${option}`);
}
/** Build a private, fresh or exact-resume Pi RPC invocation. */
export function buildPrivateSessionLaunch(options, invocation) {
    validateBaseInvocationArgs(invocation);
    if (!isAbsolute(options.privateSessionDir) || !isAbsolute(options.cwd))
        throw new TypeError('privateSessionDir and cwd must be absolute');
    if (!isPiSessionId(options.sessionId))
        throw new TypeError('sessionId must start and end with an alphanumeric character and contain only alphanumerics, ., _ or -');
    const privateSessionDir = resolve(options.privateSessionDir);
    const cwd = resolve(options.cwd);
    const args = ['--mode', 'rpc', '--session-dir', privateSessionDir];
    let sessionFile;
    if (options.sessionFile !== undefined) {
        if (!isAbsolute(options.sessionFile))
            throw new TypeError('sessionFile must be absolute');
        sessionFile = resolve(options.sessionFile);
        if (!isWithin(sessionFile, privateSessionDir))
            throw new Error('sessionFile must be inside privateSessionDir');
        args.push('--session', sessionFile);
    }
    else
        args.push('--session-id', options.sessionId);
    if (options.agentId)
        args.push('--name', options.agentId);
    if (options.provider)
        args.push('--provider', options.provider);
    if (options.model)
        args.push('--model', options.model);
    if (options.thinking)
        args.push('--thinking', options.thinking);
    if (options.tools !== undefined) {
        if (options.tools.some((tool) => !tool ||
            tool.includes(',') ||
            [...tool].some((character) => {
                const code = character.codePointAt(0) ?? 0;
                return code < 32 || code === 127;
            })))
            throw new TypeError('tools contains a value that cannot be represented by Pi --tools');
        args.push(options.tools.length ? '--tools' : '--no-tools');
        if (options.tools.length)
            args.push(options.tools.join(','));
    }
    if (options.noExtensions !== false)
        args.push('--no-extensions');
    if (options.extension) {
        if (!isAbsolute(options.extension))
            throw new TypeError('extension must be absolute');
        args.push('--extension', resolve(options.extension));
    }
    for (const extension of options.extensions ?? []) {
        if (!isAbsolute(extension))
            throw new TypeError('extensions must contain only absolute paths');
        args.push('--extension', resolve(extension));
    }
    if (options.noContextFiles)
        args.push('--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--append-system-prompt', '');
    else if (options.skills !== undefined)
        args.push('--no-skills');
    for (const skill of options.skills ?? []) {
        if (!isAbsolute(skill))
            throw new TypeError('skills must contain only absolute paths');
        args.push('--skill', resolve(skill));
    }
    if (!options.noContextFiles && options.promptTemplates !== undefined)
        args.push('--no-prompt-templates');
    for (const promptTemplate of options.promptTemplates ?? []) {
        if (!isAbsolute(promptTemplate))
            throw new TypeError('promptTemplates must contain only absolute paths');
        args.push('--prompt-template', resolve(promptTemplate));
    }
    if (!options.noContextFiles && options.themes !== undefined)
        args.push('--no-themes');
    for (const theme of options.themes ?? []) {
        if (!isAbsolute(theme))
            throw new TypeError('themes must contain only absolute paths');
        args.push('--theme', resolve(theme));
    }
    if (options.systemPrompt)
        args.push('--system-prompt', options.systemPrompt);
    return {
        invocation: { command: invocation.command, args: [...(invocation.args ?? []), ...args] },
        sessionId: options.sessionId,
        privateSessionDir,
        sessionFile,
        cwd,
    };
}
function validateInvocation(invocation) {
    if (!invocation.command || !isAbsolute(invocation.command))
        throw new Error('Pi invocation command must be an absolute executable path');
    if (UNSAFE_DIRECT_INVOCATION_EXTENSIONS.has(extname(invocation.command).toLowerCase()))
        throw new Error('Pi invocation must be an executable or Node CLI path, not a shell wrapper or direct JavaScript file');
    return { command: resolve(invocation.command), args: [...(invocation.args ?? [])] };
}
/** Resolve an explicit invocation, or the exact executable/script running this Pi owner. */
export function resolvePiInvocation(explicit) {
    if (explicit)
        return validateInvocation(explicit);
    if (isAbsolute(process.execPath) &&
        existsSync(process.execPath) &&
        !Object.hasOwn(GENERIC_RUNTIME_EXECUTABLES, basename(process.execPath).toLowerCase()))
        return validateInvocation({ command: process.execPath });
    const script = process.argv[1];
    if (script && isAbsolute(script) && existsSync(script))
        return validateInvocation({ command: process.execPath, args: [script] });
    throw new Error('Pi invocation is required; pass the absolute Pi executable or runtime plus its absolute current script');
}
export function verifyPrivateSessionState(value, expected) {
    const state = recordOf(value);
    if (!state)
        throw new Error('Pi session state is not an object');
    if (state.sessionId !== expected.sessionId)
        throw new Error(`Pi session ID mismatch: expected ${expected.sessionId}, got ${String(state.sessionId)}`);
    if (typeof state.sessionFile !== 'string' ||
        !isAbsolute(state.sessionFile) ||
        !isWithin(state.sessionFile, expected.privateSessionDir))
        throw new Error(`Pi session file is not an absolute path inside the private session directory: ${String(state.sessionFile)}`);
    if (expected.sessionFile !== undefined && resolve(state.sessionFile) !== resolve(expected.sessionFile))
        throw new Error(`Pi session file mismatch: expected ${expected.sessionFile}, got ${state.sessionFile}`);
    return state;
}
/** One Pi RPC process. Command writes are serialized; responses/events are independent. */
export class PiRpcProcess extends EventEmitter {
    child;
    reader;
    pending = new Map();
    writeChain = Promise.resolve();
    queuedCommands = 0;
    sequence = 0;
    closed = false;
    intentionalClose = false;
    exited = false;
    exitError;
    failureEmitted = false;
    closePromise;
    terminationPromise;
    settlementActive = false;
    cancelSettlement;
    stderrRing = [];
    diagnosticsRing = [];
    limits;
    options;
    constructor(options) {
        super();
        this.options = options;
        this.limits = {
            maxRecordBytes: options.limits?.maxRecordBytes,
            maxBufferBytes: options.limits?.maxBufferBytes,
            maxPendingRequests: options.limits?.maxPendingRequests ?? DEFAULTS.maxPendingRequests,
            maxQueuedCommands: options.limits?.maxQueuedCommands ?? DEFAULTS.maxQueuedCommands,
            maxStderrBytes: options.limits?.maxStderrBytes ?? DEFAULTS.maxStderrBytes,
            maxDiagnostics: options.limits?.maxDiagnostics ?? DEFAULTS.maxDiagnostics,
        };
        for (const [name, value] of Object.entries(this.limits)) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
                throw new RangeError(`Pi RPC ${name} must be a positive safe integer`);
        }
        if (this.limits.maxBufferBytes !== undefined &&
            this.limits.maxRecordBytes !== undefined &&
            this.limits.maxBufferBytes < this.limits.maxRecordBytes)
            throw new RangeError('Pi RPC maxBufferBytes must hold one record');
    }
    start() {
        if (this.child)
            throw new Error('Pi RPC process already started');
        if (this.closed)
            throw new Error('Pi RPC process is closed');
        const invocation = validateInvocation(this.options.invocation);
        const env = { ...process.env };
        for (const key of INHERITED_PARENT_SESSION_ENV)
            delete env[key];
        for (const [key, value] of Object.entries(this.options.env ?? {})) {
            if (value === undefined)
                delete env[key];
            else
                env[key] = value;
        }
        for (const key of this.options.unsetEnv ?? [])
            delete env[key];
        const child = spawn(invocation.command, [...(invocation.args ?? [])], {
            cwd: this.options.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child = child;
        if (!child.stdin || !child.stdout || !child.stderr) {
            child.kill('SIGKILL');
            throw new Error('Pi RPC process did not expose all configured stdio pipes');
        }
        child.once('error', (error) => this.intentionalClose ? this.addDiagnostic(childError(error)) : this.recordFailure(childError(error)));
        child.once('exit', (code, signal) => {
            this.exited = true;
            if (!this.intentionalClose && !this.exitError)
                this.recordFailure(new Error(`Pi RPC process exited (code=${String(code)}, signal=${String(signal)})`), false);
            this.safeEmit('exit', { code, signal, error: this.exitError });
        });
        this.reader = attachJsonlLineReader(child.stdout, (value) => this.handleRecord(value), { ...this.limits, skipRecordPrefixes: REDUNDANT_SUMMARY_PREFIXES }, (error) => this.recordFailure(error));
        child.stdin?.on('error', (error) => this.closed || this.intentionalClose
            ? this.addDiagnostic(childError(error))
            : this.recordFailure(childError(error)));
        child.stdout?.on('error', (error) => this.closed || this.intentionalClose
            ? this.addDiagnostic(childError(error))
            : this.recordFailure(childError(error)));
        child.stderr?.on('error', (error) => this.addDiagnostic(childError(error)));
        child.stderr.on('data', (chunk) => this.captureStderr(String(chunk)));
    }
    request(command, timeoutMs = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs) {
        if (!this.child || this.closed || this.exitError)
            return Promise.reject(this.exitError ?? new Error('Pi RPC process is not running'));
        if (this.pending.size >= this.limits.maxPendingRequests)
            return Promise.reject(new Error('Pi RPC pending-request bound exceeded'));
        if (this.queuedCommands >= this.limits.maxQueuedCommands)
            return Promise.reject(new Error('Pi RPC command queue bound exceeded'));
        if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
            return Promise.reject(new RangeError('Pi RPC request timeout must be null or positive'));
        if (command.id !== undefined && typeof command.id !== 'string' && typeof command.id !== 'number')
            return Promise.reject(new TypeError('Pi RPC request id must be a string or number'));
        const id = command.id === undefined ? `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}${++this.sequence}` : command.id;
        if (this.pending.has(id))
            return Promise.reject(new Error(`Duplicate Pi RPC request id: ${String(id)}`));
        const commandName = typeof command.type === 'string' ? command.type : 'unknown';
        const outbound = { ...command, id };
        this.queuedCommands++;
        let rejectRequest = () => undefined;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            rejectRequest = rejectPromise;
            const timer = timeoutMs === null
                ? undefined
                : setTimeout(() => {
                    const pending = this.pending.get(id);
                    if (!pending)
                        return;
                    const error = new Error(`Pi RPC response timeout for ${String(id)}`);
                    this.pending.delete(id);
                    rejectPromise(error);
                    this.recordFailure(error);
                }, timeoutMs);
            this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, command: commandName });
        });
        const dispatch = async () => {
            try {
                if (!this.pending.has(id))
                    return;
                if (!this.child || this.closed)
                    throw new Error('Pi RPC process closed before command dispatch');
                await this.write(serializeJsonLine(outbound, this.limits.maxRecordBytes));
            }
            catch (error) {
                const pending = this.pending.get(id);
                if (pending && this.pending.delete(id)) {
                    if (pending.timer)
                        clearTimeout(pending.timer);
                    rejectRequest(childError(error));
                    if (!this.intentionalClose)
                        this.recordFailure(childError(error));
                }
            }
            finally {
                this.queuedCommands--;
            }
        };
        this.writeChain = this.writeChain.then(dispatch, dispatch);
        return promise;
    }
    async getState(expected, timeoutMs = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs) {
        const response = await this.request({ type: 'get_state' }, timeoutMs);
        return verifyPrivateSessionState(recordOf(response.data) ?? response, expected);
    }
    async requestAndWaitForSettled(command, timeoutMs = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs, onAdmitted, settlementTimeoutMs = timeoutMs) {
        const wait = this.createSettlementWait(settlementTimeoutMs);
        try {
            const response = this.request(command, timeoutMs).then(async (value) => {
                await onAdmitted?.(value);
                return value;
            });
            const [accepted, settled] = await Promise.all([response, wait.promise]);
            return { response: accepted, settled };
        }
        catch (error) {
            const normalized = childError(error);
            wait.cancel(normalized);
            if (!this.exitError && normalized.message === 'Pi agent_settled timeout') {
                const indeterminate = new Error('Pi RPC command outcome is indeterminate because agent_settled was not observed', { cause: normalized });
                this.recordFailure(indeterminate);
                throw indeterminate;
            }
            throw normalized;
        }
    }
    waitForAgentSettled(timeoutMs = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs) {
        return this.createSettlementWait(timeoutMs).promise;
    }
    createSettlementWait(timeoutMs) {
        if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
            throw new RangeError('Pi agent settlement timeout must be null or positive');
        if (this.exitError)
            throw this.exitError;
        if (this.closed)
            throw new Error('Pi RPC process is closed');
        if (this.settlementActive)
            throw new Error('Pi agent settlement wait already active; overlapping activations are refused');
        this.settlementActive = true;
        let finish = () => undefined;
        let cancel = () => undefined;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            let started = false;
            let finished = false;
            const timer = timeoutMs === null ? undefined : setTimeout(() => finish(new Error('Pi agent_settled timeout')), timeoutMs);
            const onEvent = (event) => {
                if (event.type === 'agent_start')
                    started = true;
                else if (event.type === 'agent_settled' && started)
                    finish(undefined, event);
            };
            const onFailure = (error) => finish(error);
            const cleanup = () => {
                if (timer)
                    clearTimeout(timer);
                this.off('event', onEvent);
                this.off('failure', onFailure);
                this.settlementActive = false;
                if (this.cancelSettlement === cancel)
                    this.cancelSettlement = undefined;
            };
            finish = (error, event) => {
                if (finished)
                    return;
                finished = true;
                cleanup();
                if (error)
                    rejectPromise(error);
                else if (event)
                    resolvePromise(event);
                else
                    rejectPromise(new Error('Pi settlement completed without an event'));
            };
            cancel = (error) => finish(error);
            this.cancelSettlement = cancel;
            this.on('event', onEvent);
            this.on('failure', onFailure);
        });
        return { promise, cancel };
    }
    get stderr() {
        return this.stderrRing;
    }
    get diagnostics() {
        return this.diagnosticsRing;
    }
    get process() {
        return this.child;
    }
    async close(timeoutMs = 2_000) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
            throw new RangeError('Pi RPC close timeout must be positive');
        if (this.closePromise)
            return this.closePromise;
        this.closePromise = this.closeImpl(timeoutMs);
        return this.closePromise;
    }
    async closeImpl(timeoutMs) {
        this.closed = true;
        this.intentionalClose = true;
        const closeError = new Error('Pi RPC process closed');
        this.reader?.stop();
        this.cancelSettlement?.(closeError);
        this.rejectPending(closeError);
        const child = this.child;
        if (!child || this.exited || child.exitCode !== null || child.signalCode !== null) {
            this.removeChildListeners();
            return;
        }
        if (child.stdin && !child.stdin.destroyed)
            child.stdin.end();
        try {
            await (this.terminationPromise ??= this.terminateChild(child, timeoutMs));
        }
        catch (error) {
            this.intentionalClose = false;
            this.recordFailure(childError(error), false);
            throw error;
        }
        finally {
            this.removeChildListeners();
        }
    }
    write(line) {
        return new Promise((resolvePromise, rejectPromise) => {
            if (!this.child?.stdin || this.child.stdin.destroyed)
                return rejectPromise(new Error('Pi RPC stdin is unavailable'));
            this.child.stdin.write(line, 'utf8', (error) => (error ? rejectPromise(error) : resolvePromise()));
        });
    }
    handleRecord(value) {
        if (this.closed || this.exitError)
            return;
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return this.recordFailure(new Error('Pi RPC record is not an object'));
        const record = recordOf(value);
        if (!record)
            return this.recordFailure(new Error('Pi RPC record is not an object'));
        if (record.type === 'extension_ui_request' && isBlockingExtensionUiMethod(record.method)) {
            if (typeof record.id !== 'string')
                return this.recordFailure(new Error('Blocking Pi extension UI request has no string id'));
            const notice = {
                id: record.id,
                method: record.method,
                title: boundedUiTitle(record.title),
            };
            const respond = async () => {
                try {
                    await this.write(serializeJsonLine({ type: 'extension_ui_response', id: notice.id, cancelled: true }, this.limits.maxRecordBytes));
                    this.safeEmit('extension_ui_cancelled', notice);
                }
                catch (error) {
                    this.recordFailure(childError(error));
                }
            };
            this.writeChain = this.writeChain.then(respond, respond);
            return;
        }
        if (record.type === 'response') {
            const responseId = record.id;
            if ((typeof responseId !== 'string' && typeof responseId !== 'number') || !this.pending.has(responseId))
                return this.recordFailure(new Error(`Pi RPC response has unknown request id ${String(responseId)}`));
            if (typeof record.success !== 'boolean')
                return this.recordFailure(new Error(`Pi RPC response for ${String(responseId)} has no boolean success field`));
            const pending = this.pending.get(responseId);
            if (!pending)
                return this.recordFailure(new Error(`Pi RPC response lost request id ${String(responseId)}`));
            this.pending.delete(responseId);
            if (pending.timer)
                clearTimeout(pending.timer);
            if (!record.success) {
                const detail = typeof record.error === 'string'
                    ? record.error
                    : record.error && typeof record.error === 'object'
                        ? JSON.stringify(record.error)
                        : 'Pi RPC command failed';
                pending.reject(new PiRpcCommandError(pending.command, detail));
            }
            else
                pending.resolve({ ...record, id: responseId });
            return;
        }
        this.safeEmit('event', record);
    }
    captureStderr(text) {
        const bytes = Buffer.from((this.stderrRing[0] ?? '') + text, 'utf8');
        const tail = bytes.subarray(Math.max(0, bytes.length - this.limits.maxStderrBytes));
        this.stderrRing.splice(0, this.stderrRing.length, tail.toString('utf8'));
        this.safeEmit('stderr', this.stderrRing[0]);
    }
    rejectPending(error) {
        for (const pending of this.pending.values()) {
            if (pending.timer)
                clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    recordFailure(error, terminate = true) {
        if (!this.exitError)
            this.exitError = error;
        this.closed = true;
        this.reader?.stop();
        if (this.child?.stdin && !this.child.stdin.destroyed)
            this.child.stdin.destroy();
        this.cancelSettlement?.(this.exitError);
        this.rejectPending(this.exitError);
        if (!this.failureEmitted) {
            this.failureEmitted = true;
            this.safeEmit('failure', this.exitError);
        }
        if (terminate && this.child && !this.exited && !this.intentionalClose)
            void (this.terminationPromise ??= this.terminateChild(this.child, 2_000)).catch((terminationError) => this.addDiagnostic(childError(terminationError)));
    }
    safeEmit(event, ...args) {
        for (const listener of this.rawListeners(event)) {
            try {
                Reflect.apply(listener, this, args);
            }
            catch (error) {
                this.addDiagnostic(new Error(`Pi RPC ${event} listener failed: ${childError(error).message}`));
            }
        }
    }
    addDiagnostic(error) {
        this.diagnosticsRing.push(error.message);
        while (this.diagnosticsRing.length > this.limits.maxDiagnostics)
            this.diagnosticsRing.shift();
    }
    async terminateChild(child, timeoutMs) {
        if (this.exited || child.exitCode !== null || child.signalCode !== null)
            return;
        const deadline = Date.now() + timeoutMs;
        const graceful = Math.max(1, Math.floor(timeoutMs / 3));
        try {
            await this.waitForExit(child, graceful);
            return;
        }
        catch {
            /* escalate */
        }
        try {
            child.kill('SIGTERM');
        }
        catch (error) {
            this.addDiagnostic(childError(error));
        }
        const afterTerm = deadline - Date.now();
        if (afterTerm > 1) {
            try {
                await this.waitForExit(child, Math.max(1, Math.floor(afterTerm / 2)));
                return;
            }
            catch {
                /* escalate */
            }
        }
        try {
            child.kill('SIGKILL');
        }
        catch (error) {
            this.addDiagnostic(childError(error));
        }
        const finalBudget = deadline - Date.now();
        if (finalBudget < 1)
            throw new Error('Pi RPC child exit was not confirmed before timeout');
        await this.waitForExit(child, finalBudget);
    }
    waitForExit(child, timeoutMs) {
        if (this.exited || child.exitCode !== null || child.signalCode !== null)
            return Promise.resolve();
        return new Promise((resolvePromise, rejectPromise) => {
            let timer;
            const done = () => {
                clearTimeout(timer);
                child.off('exit', done);
                resolvePromise();
            };
            timer = setTimeout(() => {
                child.off('exit', done);
                rejectPromise(new Error('Pi RPC child exit was not confirmed before timeout'));
            }, timeoutMs);
            child.once('exit', done);
            if (this.exited || child.exitCode !== null || child.signalCode !== null)
                done();
        });
    }
    removeChildListeners() {
        const child = this.child;
        if (!child)
            return;
        child.removeAllListeners('error');
        child.removeAllListeners('exit');
        child.stdin?.removeAllListeners();
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
    }
}
function isBlockingExtensionUiMethod(value) {
    return value === 'select' || value === 'confirm' || value === 'input' || value === 'editor';
}
function boundedUiTitle(value) {
    if (typeof value !== 'string' || !value.trim())
        return 'untitled request';
    const clean = [...value]
        .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
    })
        .join('');
    let result = clean.slice(0, 256);
    while (Buffer.byteLength(result) > 512)
        result = result.slice(0, -1);
    return result || 'untitled request';
}
