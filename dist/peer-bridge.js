import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { SchedulerStateError, SchedulerStore } from "./scheduler-store.js";
import { DurablePiActor } from "./actor-runtime.js";
import { readBoundedResponse } from "./bounded-response.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { isRecord } from "./scheduler-state.js";
const MAX_TOOL_RESPONSE_BYTES = 48 * 1024;
const MIN_CONNECTION_LIMIT = 32;
const MIN_IN_FLIGHT_LIMIT = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const TOOL_PATH = '/v1/tools';
/** Bounded loopback framing/authentication. SchedulerStore remains the only durable authority. */
export class PeerBridgeServer {
    store;
    onDiagnostic;
    bindings = new Map();
    sockets = new Set();
    server;
    baseUrl;
    closePromise;
    toolHandler;
    attachmentHandler;
    attachmentObserver;
    inFlightRequests = new Set();
    observerRequests = new Set();
    observerSockets = new Set();
    accepting = true;
    constructor(options) {
        this.store = options.store;
        this.onDiagnostic = options.onDiagnostic;
    }
    get url() {
        if (!this.baseUrl)
            throw new Error('Peer bridge is not listening');
        return this.baseUrl;
    }
    get activeCredentialCount() {
        return this.bindings.size;
    }
    setToolHandler(handler) {
        this.toolHandler = handler;
    }
    setAttachmentHandler(handler, observer) {
        this.attachmentHandler = handler;
        this.attachmentObserver = handler ? observer : undefined;
    }
    async start() {
        if (this.server)
            throw new Error('Peer bridge already started');
        this.accepting = true;
        const bridgeLimits = () => {
            const capacity = this.store.snapshot().root.maxOpenAgents;
            const reserved = Math.min(Number.MAX_SAFE_INTEGER, capacity + 2);
            const observerAllowance = Math.max(MIN_CONNECTION_LIMIT, capacity);
            return {
                connections: Math.min(Number.MAX_SAFE_INTEGER, reserved + observerAllowance),
                requests: Math.min(Number.MAX_SAFE_INTEGER, reserved + Math.max(MIN_IN_FLIGHT_LIMIT, capacity)),
                observerConnections: observerAllowance,
                observerRequests: Math.max(MIN_IN_FLIGHT_LIMIT, capacity),
            };
        };
        const server = createServer((request, response) => {
            const limits = bridgeLimits();
            const observer = this.attachmentObserver?.(request) === true;
            if (!this.accepting ||
                this.inFlightRequests.size >= limits.requests ||
                (observer &&
                    ((!this.observerSockets.has(request.socket) && this.observerSockets.size >= limits.observerConnections) ||
                        this.observerRequests.size >= limits.observerRequests))) {
                if (observer) {
                    response.shouldKeepAlive = false;
                    response.setHeader('connection', 'close');
                }
                this.reply(response, 503, { v: 1, ok: false, code: 'bridge_busy' });
                return;
            }
            if (observer)
                this.observerSockets.add(request.socket);
            const observerFinished = observer
                ? new Promise((resolve) => {
                    const finish = () => {
                        response.off('finish', finish);
                        response.off('close', finish);
                        resolve();
                    };
                    response.once('finish', finish);
                    response.once('close', finish);
                })
                : Promise.resolve();
            const abortController = new AbortController();
            const abort = () => {
                if (!response.writableEnded)
                    abortController.abort(new Error('Peer bridge client disconnected'));
            };
            request.once('aborted', abort);
            response.once('close', abort);
            let operation;
            operation = this.handle(request, response, abortController.signal)
                .catch(() => {
                try {
                    if (!response.destroyed)
                        response.destroy();
                }
                catch {
                    // The response transport is already broken; its rejection must not escape Node's callback boundary.
                }
            })
                .then(() => observerFinished)
                .finally(() => {
                request.off('aborted', abort);
                response.off('close', abort);
                this.inFlightRequests.delete(operation);
                this.observerRequests.delete(operation);
            });
            this.inFlightRequests.add(operation);
            if (observer)
                this.observerRequests.add(operation);
        });
        server.requestTimeout = 15_000;
        server.headersTimeout = 10_000;
        server.keepAliveTimeout = 1_000;
        server.on('connection', (socket) => {
            if (this.sockets.size >= bridgeLimits().connections) {
                socket.destroy();
                return;
            }
            this.sockets.add(socket);
            socket.once('close', () => {
                this.sockets.delete(socket);
                this.observerSockets.delete(socket);
            });
        });
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Peer bridge did not acquire a loopback port');
        this.baseUrl = `http://127.0.0.1:${address.port}${TOOL_PATH}`;
        return this.baseUrl;
    }
    issue(agentId, options = {}) {
        if (!this.baseUrl)
            throw new Error('Peer bridge must start before credentials are issued');
        const snapshot = this.store.snapshot();
        const agent = snapshot.agents[agentId];
        if (!agent || agent.lifecycle !== 'open')
            throw new SchedulerStateError('agent_unavailable', `Agent '${agentId}' is not open`);
        const token = randomBytes(32).toString('base64url');
        this.bindings.set(token, {
            agentId: agent.agentId,
            rootId: snapshot.root.rootId,
            sessionId: options.sessionId,
            generation: options.generation,
            expectedBuildId: options.buildId,
        });
        return {
            url: this.baseUrl,
            token,
            agentId: agent.agentId,
            rootId: snapshot.root.rootId,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.generation ? { generation: options.generation } : {}),
            ...(options.buildId ? { buildId: options.buildId } : {}),
        };
    }
    bind(credential, actor) {
        const binding = this.bindings.get(credential.token);
        const identity = actor.runtimeIdentity;
        if (binding?.expectedBuildId !== undefined && binding.reportedBuildId !== binding.expectedBuildId)
            throw new SchedulerStateError('runtime_build_mismatch', 'Managed child did not bind the accepted package build');
        if (!binding ||
            binding.agentId !== credential.agentId ||
            binding.rootId !== credential.rootId ||
            identity.agentId !== binding.agentId)
            throw new SchedulerStateError('bridge_auth', 'Peer bridge credential does not match the actor');
        const agent = this.store.snapshot().agents[binding.agentId];
        if (!agent || agent.runtimeOwner !== identity.runtimeOwner || agent.runtimePhase !== 'ready')
            throw new SchedulerStateError('runtime_owner', `Actor '${identity.agentId}' does not own the durable runtime`);
        binding.runtimeOwner = identity.runtimeOwner;
    }
    revoke(credential) {
        return this.bindings.delete(credential.token);
    }
    revokeAgent(agentId) {
        let removed = 0;
        for (const [token, binding] of this.bindings) {
            if (binding.agentId === agentId && this.bindings.delete(token))
                removed++;
        }
        return removed;
    }
    async close() {
        if (this.closePromise)
            return this.closePromise;
        this.accepting = false;
        const server = this.server;
        this.bindings.clear();
        this.attachmentHandler = undefined;
        this.attachmentObserver = undefined;
        this.baseUrl = undefined;
        if (!server)
            return;
        for (const socket of this.sockets)
            socket.destroy();
        this.closePromise = (async () => {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 2_000);
                timer.unref();
                server.close(() => {
                    clearTimeout(timer);
                    this.sockets.clear();
                    this.observerSockets.clear();
                    resolve();
                });
            });
            if (this.inFlightRequests.size)
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
                    timer.unref();
                    void Promise.allSettled([...this.inFlightRequests]).then(() => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
        })();
        return this.closePromise;
    }
    async handle(request, response, signal) {
        try {
            if (this.attachmentHandler && (await this.attachmentHandler(request, response)))
                return;
            if (request.method !== 'POST' || request.url !== TOOL_PATH)
                return this.reply(response, 404, { v: 1, ok: false, code: 'not_found' });
            const token = bearer(request.headers.authorization);
            const binding = token ? this.bindings.get(token) : undefined;
            if (!binding)
                return this.reply(response, 401, { v: 1, ok: false, code: 'unauthorized' });
            const input = parseBridgeRequest(await readJson(request, signal));
            if (input.action === 'build') {
                if (!binding.expectedBuildId || input.buildId !== binding.expectedBuildId)
                    throw new SchedulerStateError('runtime_build_mismatch', 'Managed child build does not match its owner');
                binding.reportedBuildId = input.buildId;
                this.reply(response, 200, { v: 1, ok: true, buildId: input.buildId });
                return;
            }
            if (!binding.runtimeOwner)
                return this.reply(response, 401, { v: 1, ok: false, code: 'unauthorized' });
            if (!this.toolHandler)
                throw new SchedulerStateError('bridge_unavailable', 'Bridge tool service is unavailable');
            const result = await this.toolHandler({
                agentId: binding.agentId,
                rootId: binding.rootId,
                runtimeOwner: binding.runtimeOwner,
                ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
                ...(binding.generation ? { generation: binding.generation } : {}),
                ...(binding.reportedBuildId ? { buildId: binding.reportedBuildId } : {}),
            }, {
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                input: input.input,
                ...(input.parentContext ? { parentContext: input.parentContext } : {}),
            }, signal);
            this.reply(response, 200, { v: 1, ok: true, toolCallId: input.toolCallId, result });
        }
        catch (error) {
            const cancelled = signal.aborted;
            const internal = !cancelled && !(error instanceof SchedulerStateError);
            const code = cancelled
                ? 'bridge_cancelled'
                : internal
                    ? 'bridge_internal'
                    : error instanceof SchedulerStateError
                        ? error.code
                        : 'bridge_internal';
            const incidentId = internal ? `bridge-${randomBytes(12).toString('hex')}` : undefined;
            if (internal)
                this.onDiagnostic?.(error);
            this.reply(response, internal ? 500 : code === 'command_id_reuse' ? 409 : 400, {
                v: 1,
                ok: false,
                code,
                ...(incidentId ? { incidentId } : {}),
                message: error instanceof SchedulerStateError
                    ? error.message.slice(0, 500)
                    : `${LUMINARIES_IDENTITY.label} bridge operation failed. The owner can use the incident ID for diagnostics.`,
            });
        }
    }
    reply(response, status, value) {
        if (response.writableEnded)
            return;
        let body = `${JSON.stringify(value)}\n`;
        const oversized = Buffer.byteLength(body) > MAX_TOOL_RESPONSE_BYTES;
        if (oversized)
            body = `${JSON.stringify({ v: 1, ok: false, code: 'bridge_response_bound' })}\n`;
        response.writeHead(oversized ? 500 : status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
        });
        response.end(body);
    }
}
function parseBridgeRequest(value) {
    if (!isRecord(value))
        throw new SchedulerStateError('input_invalid', 'Bridge request must be an object');
    if (value.v !== 1)
        throw new SchedulerStateError('input_invalid', 'Bridge version must be 1');
    const action = value.action;
    if (action !== 'build' && action !== 'tool')
        throw new SchedulerStateError('input_invalid', `Bridge action '${String(action)}' is invalid`);
    if (action === 'build') {
        rejectUnknownFields(value, ['v', 'action', 'buildId'], 'Bridge build binding');
        if (!isSha256(value.buildId))
            throw new SchedulerStateError('input_invalid', 'Bridge build identity is invalid');
        return { v: 1, action, buildId: value.buildId };
    }
    rejectUnknownFields(value, ['v', 'action', 'toolCallId', 'toolName', 'input', 'parentContext'], 'Bridge tool request');
    if (typeof value.toolName !== 'string' || value.toolName.length < 1 || value.toolName.length > 64)
        throw new SchedulerStateError('input_invalid', 'Bridge tool name is invalid');
    if (typeof value.toolCallId !== 'string' ||
        value.toolCallId.length < 1 ||
        Buffer.byteLength(value.toolCallId) > 4_096)
        throw new SchedulerStateError('input_invalid', 'Bridge tool call ID is invalid');
    if (!isRecord(value.input))
        throw new SchedulerStateError('input_invalid', 'Bridge tool input must be an object');
    let parentContext;
    if (value.parentContext !== undefined) {
        if (!isRecord(value.parentContext) ||
            Object.keys(value.parentContext).some((key) => key !== 'messages' && key !== 'selectedToolCallId') ||
            !Array.isArray(value.parentContext.messages) ||
            typeof value.parentContext.selectedToolCallId !== 'string' ||
            value.parentContext.selectedToolCallId !== value.toolCallId ||
            value.parentContext.selectedToolCallId.length < 1 ||
            Buffer.byteLength(value.parentContext.selectedToolCallId) > 4_096)
            throw new SchedulerStateError('input_invalid', 'Bridge parent context is invalid');
        parentContext = {
            messages: value.parentContext.messages,
            selectedToolCallId: value.parentContext.selectedToolCallId,
        };
    }
    return {
        v: 1,
        action,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        input: value.input,
        ...(parentContext ? { parentContext } : {}),
    };
}
function rejectUnknownFields(value, allowed, label) {
    const expected = new Set(allowed);
    for (const key of Object.keys(value))
        if (!expected.has(key))
            throw new SchedulerStateError('input_invalid', `${label} contains unknown field '${key}'`);
}
function uncertainToolOutcome(error) {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`Managed ${LUMINARIES_IDENTITY.label} tool response failed after dispatch; the outcome is uncertain and the semantic input must not be replayed. Inspect current ${LUMINARIES_IDENTITY.label} state before continuing. ${detail}`, { cause: error });
}
export async function sendLuminariesToolCall(options) {
    const url = new URL(options.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== TOOL_PATH)
        throw new Error('Peer bridge URL must be the issued 127.0.0.1 endpoint');
    const body = JSON.stringify({
        v: 1,
        action: 'tool',
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        input: options.input,
        ...(options.parentContext ? { parentContext: options.parentContext } : {}),
    });
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted)
        abort();
    else
        options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Managed ${LUMINARIES_IDENTITY.label} tool response timed out; the outcome is uncertain.`)), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                redirect: 'manual',
                headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
                body,
            });
        }
        catch (error) {
            throw uncertainToolOutcome(error);
        }
        if (isRedirect(response.status))
            throw uncertainToolOutcome(new Error(`Managed ${LUMINARIES_IDENTITY.label} tool endpoint redirected`));
        let text;
        try {
            text = await readBoundedResponse(response, MAX_TOOL_RESPONSE_BYTES, `Managed ${LUMINARIES_IDENTITY.label} tool response`);
        }
        catch (error) {
            throw uncertainToolOutcome(error);
        }
        let value;
        try {
            value = JSON.parse(text);
        }
        catch (error) {
            throw uncertainToolOutcome(error);
        }
        if (!response.ok) {
            const code = isRecord(value) && typeof value.code === 'string' ? value.code : String(response.status);
            const message = isRecord(value) && typeof value.message === 'string' ? value.message : 'no detail';
            if (code === 'bridge_response_bound')
                throw uncertainToolOutcome(new Error(`Managed ${LUMINARIES_IDENTITY.label} tool result exceeded its response bound`));
            throw new Error(`${LUMINARIES_IDENTITY.label} refused the tool call (${code}): ${message}`);
        }
        if (!isRecord(value) || value.v !== 1 || value.ok !== true || value.toolCallId !== options.toolCallId)
            throw uncertainToolOutcome(new Error(`${LUMINARIES_IDENTITY.label} returned an invalid tool receipt`));
        try {
            return parseLuminariesReceipt(value.result);
        }
        catch (error) {
            throw uncertainToolOutcome(error);
        }
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
    }
}
function parseLuminariesReceipt(value) {
    if (!isRecord(value))
        throw new Error(`${LUMINARIES_IDENTITY.label} returned an invalid tool receipt`);
    rejectUnknownFields(value, ['message', 'details', 'terminate'], 'Bridge tool receipt');
    if (typeof value.message !== 'string' ||
        !isRecord(value.details) ||
        (value.terminate !== undefined && value.terminate !== true))
        throw new Error('Peer bridge returned an invalid tool receipt');
    return {
        message: value.message,
        details: value.details,
        ...(value.terminate === true ? { terminate: true } : {}),
    };
}
export async function sendLuminariesBuildIdentity(options) {
    const value = await bridgeFetch(options.url, options.token, { v: 1, action: 'build', buildId: options.buildId });
    if (!isRecord(value) || value.v !== 1 || value.ok !== true || value.buildId !== options.buildId)
        throw new Error('Peer bridge returned an invalid build binding');
}
async function bridgeFetch(urlInput, token, body) {
    const url = new URL(urlInput);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== TOOL_PATH)
        throw new Error('Peer bridge URL must be the issued 127.0.0.1 endpoint');
    const encoded = JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Peer bridge build binding timed out')), DEFAULT_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            redirect: 'manual',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: encoded,
        });
        if (isRedirect(response.status))
            throw new Error('Peer bridge endpoint redirected; outcome is uncertain');
        const text = await readBoundedResponse(response, MAX_TOOL_RESPONSE_BYTES, 'Peer bridge response');
        const value = JSON.parse(text);
        if (!response.ok) {
            const code = isRecord(value) && typeof value.code === 'string' ? value.code : String(response.status);
            const message = isRecord(value) && typeof value.message === 'string' ? value.message : 'no detail';
            throw new Error(`Peer bridge refused request (${code}): ${message}`);
        }
        return value;
    }
    finally {
        clearTimeout(timer);
    }
}
function isSha256(value) {
    if (typeof value !== 'string' || value.length !== 64)
        return false;
    for (const character of value)
        if (!'0123456789abcdef'.includes(character))
            return false;
    return true;
}
function isRedirect(status) {
    return status >= 300 && status < 400;
}
function bearer(value) {
    if (!value?.startsWith('Bearer '))
        return undefined;
    const token = value.slice(7);
    return token.length >= 32 && token.length <= 128 ? token : undefined;
}
async function readJson(request, signal) {
    const chunks = [];
    for await (const chunk of request) {
        if (signal.aborted)
            throw signal.reason instanceof Error ? signal.reason : new Error('Bridge request cancelled');
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buffer);
    }
    if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error('Bridge request cancelled');
    if (!chunks.length)
        throw new SchedulerStateError('input_invalid', 'Bridge request body is empty');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
