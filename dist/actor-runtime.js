import { hostname } from 'node:os';
import { applyAssistantStreamEvent, assistantSnapshotEvent } from "./assistant-stream.js";
import { childInputCommand } from "./child-input.js";
import { ModelBoundaryTracker } from "./model-boundary-tracker.js";
import { PiRpcCommandError, PiRpcProcess, buildPrivateSessionLaunch, } from "./pi-rpc.js";
import { processAlive } from "./process-liveness.js";
import { validatePhysicalSessionNamespace } from "./private-path-policy.js";
import { SchedulerStateError, SchedulerStore } from "./scheduler-store.js";
import { agentRuntimeState, directMailboxRecords, isRecord } from "./scheduler-state.js";
const DEFAULT_TIMEOUT_MS = 120_000;
const CLOSE_DEADLINE_MS = 5_000;
const MAX_DIAGNOSTICS = 32;
const MAX_UI_NOTICES = 32;
function deferred() {
    let resolveValue = () => undefined;
    const promise = new Promise((resolve) => {
        resolveValue = resolve;
    });
    return { promise, resolve: resolveValue };
}
function errorOf(value) {
    return value instanceof Error ? value : new Error(String(value));
}
function recordOf(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}
function responseWasRefused(response) {
    return isRecord(response.data) && response.data.accepted === false;
}
function cancelledExtensionUiRequest(value) {
    const record = recordOf(value);
    if (!record || typeof record.id !== 'string' || typeof record.title !== 'string')
        return undefined;
    const method = record.method;
    if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor')
        return undefined;
    return { id: record.id, method, title: record.title };
}
/** One private Pi process. Store transitions are owned by the recipient drain. */
export class DurablePiActor {
    agentId;
    sessionFile;
    runtimeOwner;
    rpc;
    timeoutMs;
    boundaries = new ModelBoundaryTracker();
    activeToolEvents = new Map();
    assistantStream;
    diagnosticsRing = [];
    uiChangeListeners = new Set();
    seenUiNotices = new Set();
    current;
    closing = false;
    closePromise;
    failure;
    recoveryRequired = false;
    parkAfterSettlement;
    constructor(options, rpc, sessionFile, runtimeOwner) {
        this.agentId = options.agentId;
        this.rpc = rpc;
        this.sessionFile = sessionFile;
        this.runtimeOwner = runtimeOwner;
        this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        rpc.on('event', (event) => this.captureRpcEvent(event));
        rpc.on('failure', (error) => {
            const failure = errorOf(error);
            this.failure = failure;
            this.recoveryRequired = true;
            this.boundaries.reject(failure);
            this.rejectTurns(failure);
            try {
                options.onUnavailable?.(this, failure);
            }
            catch (callbackError) {
                this.addDiagnostic(errorOf(callbackError));
            }
        });
        rpc.on('extension_ui_cancelled', (value) => {
            const notice = cancelledExtensionUiRequest(value);
            if (!notice) {
                options.onDiagnostic?.(new Error('Pi RPC emitted an invalid extension UI notice'));
                return;
            }
            const sourceActivationId = this.current?.activationId;
            if (!sourceActivationId || this.seenUiNotices.has(notice.id))
                return;
            this.seenUiNotices.add(notice.id);
            while (this.seenUiNotices.size > MAX_UI_NOTICES) {
                const oldest = this.seenUiNotices.values().next().value;
                if (typeof oldest !== 'string')
                    break;
                this.seenUiNotices.delete(oldest);
            }
            try {
                options.onExtensionUiBlocked?.(this, notice, sourceActivationId);
            }
            catch (callbackError) {
                this.addDiagnostic(errorOf(callbackError));
            }
        });
    }
    static async start(options) {
        await validatePhysicalSessionNamespace(options.store.snapshot(), options.agentId, 'session_conflict');
        let snapshot = options.store.snapshot();
        let agent = snapshot.agents[options.agentId];
        if (!agent || agent.lifecycle !== 'open' || !agent.sessionDir || !agent.sessionId || !agent.sessionFile)
            throw new SchedulerStateError('agent_unavailable', `Agent '${options.agentId}' lacks a complete open private-session manifest`);
        if (Object.values(snapshot.activations).some((item) => item.agentId === options.agentId && item.state === 'running'))
            throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' has a stale running activation`);
        if (directMailboxRecords(snapshot).some((item) => item.targetId === options.agentId &&
            item.status !== 'aborted' &&
            item.status !== 'refused' &&
            item.status !== 'failed' &&
            item.status !== 'indeterminate'))
            throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' has a stale direct control`);
        if (agent.runtimeOwner) {
            if (!options.allowRecovery)
                throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' already owns a runtime`);
            if (agent.runtimeHostname !== hostname())
                throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' runtime is on another host`);
            const ownerPid = agent.runtimePid;
            if (!ownerPid || processAlive(ownerPid) !== false)
                throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' prior runtime is not gone`);
            await options.store.releaseRuntime(agent.agentId, agent.runtimeOwner, 'needs_attention', 'runtime_stale_reconciled');
            snapshot = options.store.snapshot();
            agent = snapshot.agents[options.agentId];
        }
        if (!agent?.sessionDir || !agent.sessionId || !agent.sessionFile)
            throw new SchedulerStateError('agent_unavailable', `Agent '${options.agentId}' lost its session manifest`);
        const runtimeState = agentRuntimeState(snapshot, agent);
        if ((runtimeState === 'failed' || runtimeState === 'needs_attention') && !options.allowRecovery)
            throw new SchedulerStateError('recovery_required', `Agent '${agent.agentId}' requires explicit recovery`);
        const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
            throw new RangeError('Actor request timeout must be a positive safe integer');
        const claim = await options.store.claimRuntime(agent.agentId, process.pid, hostname());
        const runtimeOwner = claim.value.runtimeOwner;
        if (!runtimeOwner)
            throw new SchedulerStateError('runtime_owner', `Agent '${agent.agentId}' runtime claim has no owner token`);
        let rpc;
        try {
            const launch = buildPrivateSessionLaunch({
                privateSessionDir: agent.sessionDir,
                sessionId: agent.sessionId,
                sessionFile: agent.sessionFile,
                cwd: agent.cwd,
                agentId: agent.agentId,
                model: agent.model,
                thinking: agent.thinking,
                provider: agent.provider ?? options.provider,
                extension: options.extension,
                tools: agent.capabilities.tools,
                extensions: agent.launch.extensions,
                skills: agent.launch.restrictSkills ? agent.launch.skills : undefined,
                promptTemplates: agent.launch.restrictPromptTemplates ? agent.launch.promptTemplates : undefined,
                themes: agent.launch.restrictThemes ? agent.launch.themes : undefined,
                noContextFiles: agent.launch.noContextFiles,
                systemPrompt: agent.launch.systemPrompt,
            }, options.invocation);
            rpc = new PiRpcProcess({
                invocation: launch.invocation,
                cwd: launch.cwd,
                env: options.env,
                unsetEnv: agent.launch.noContextFiles ? ['APPEND_SYSTEM', 'PI_APPEND_SYSTEM', 'PI_SYSTEM_PROMPT'] : undefined,
                limits: options.limits,
                requestTimeoutMs: timeoutMs,
            });
            rpc.start();
            const childPid = rpc.process?.pid;
            if (!childPid)
                throw new SchedulerStateError('runtime_start_failed', `Agent '${agent.agentId}' child PID is unavailable`);
            await options.store.markRuntimeSpawned(agent.agentId, runtimeOwner, childPid);
            const state = await rpc.getState({ sessionId: agent.sessionId, privateSessionDir: agent.sessionDir, sessionFile: agent.sessionFile }, timeoutMs);
            if (state.isStreaming === true)
                throw new SchedulerStateError('recovery_required', `Agent '${agent.agentId}' is already streaming`);
            if (state.sessionFile !== agent.sessionFile)
                throw new SchedulerStateError('session_invalid', `Agent '${agent.agentId}' opened a different private session`);
            await options.store.markRuntimeReady(agent.agentId, runtimeOwner, childPid);
            return new DurablePiActor(options, rpc, agent.sessionFile, runtimeOwner);
        }
        catch (error) {
            await rpc?.close(2_000).catch(() => undefined);
            await options.store
                .releaseRuntime(agent.agentId, runtimeOwner, 'needs_attention', 'runtime_start_failed')
                .catch(() => undefined);
            throw error;
        }
    }
    get activityEvents() {
        const assistant = assistantSnapshotEvent(this.assistantStream);
        return [...(assistant === undefined ? [] : [assistant]), ...this.activeToolEvents.values()];
    }
    get diagnostics() {
        return [...this.diagnosticsRing, ...this.rpc.diagnostics];
    }
    get process() {
        return this.rpc.process;
    }
    get isUsable() {
        return !this.closing && !this.failure && !this.recoveryRequired;
    }
    get runtimeIdentity() {
        return { agentId: this.agentId, runtimeOwner: this.runtimeOwner };
    }
    get needsAttention() {
        return this.recoveryRequired || this.failure !== undefined;
    }
    requestParkAtNextSettlement(onSettled) {
        const turn = this.current;
        if (!turn)
            return false;
        if (this.parkAfterSettlement)
            return true;
        this.parkAfterSettlement = onSettled;
        void turn.done.promise.then(() => {
            const callback = this.parkAfterSettlement;
            this.parkAfterSettlement = undefined;
            callback?.();
        });
        return true;
    }
    onUiChange(listener) {
        this.uiChangeListeners.add(listener);
        return () => this.uiChangeListeners.delete(listener);
    }
    subscribeConversation(listener) {
        const snapshot = this.activityEvents;
        this.uiChangeListeners.add(listener);
        return { snapshot, unsubscribe: () => this.uiChangeListeners.delete(listener) };
    }
    async setModel(provider, modelId) {
        if (this.current)
            throw new SchedulerStateError('writer_busy', `Agent '${this.agentId}' is active`);
        await this.request({ type: 'set_model', provider, modelId });
    }
    async setThinking(level) {
        if (this.current)
            throw new SchedulerStateError('writer_busy', `Agent '${this.agentId}' is active`);
        await this.request({ type: 'set_thinking_level', level });
    }
    requireRecovery() {
        this.recoveryRequired = true;
    }
    deliver(plan) {
        this.assertUsable();
        if (plan.recipientId !== this.agentId || plan.targetRuntimeOwner !== this.runtimeOwner)
            throw new SchedulerStateError('runtime_owner', `Delivery plan does not belong to '${this.agentId}'`);
        let turn;
        if (plan.deliveryKind === 'wake') {
            if (this.current)
                throw new SchedulerStateError('delivery_race', `Agent '${this.agentId}' already has a running turn`);
            turn = this.newTurn(plan);
            this.current = turn;
        }
        else {
            if (!this.current || this.current.activationId !== plan.activationId)
                throw new SchedulerStateError('delivery_race', `Agent '${this.agentId}' no longer owns the running turn`);
            turn = this.current;
        }
        const boundary = this.boundaries.observe(plan.attemptId);
        const response = this.request(this.managedInput(boundary.inputId, plan));
        const accepted = response.then((value) => {
            if (responseWasRefused(value))
                throw plan.deliveryKind === 'wake'
                    ? new PiRpcCommandError('prompt', 'Pi refused managed input')
                    : new SchedulerStateError('delivery_race', `Agent '${this.agentId}' settled before queued input admission`);
        });
        void accepted.catch((error) => {
            if (!(error instanceof PiRpcCommandError))
                return;
            boundary.cancel();
            if (plan.deliveryKind === 'wake') {
                if (this.current === turn)
                    this.current = undefined;
                turn.done.resolve({
                    activationId: turn.activationId,
                    leaseToken: turn.leaseToken,
                    outcome: 'failed',
                });
            }
        });
        return {
            eventId: plan.eventId,
            deliveryKind: plan.deliveryKind,
            activationId: plan.activationId,
            accepted,
            consumed: boundary.promise,
            settled: turn.done.promise,
            cancelBoundary: (outcome) => {
                boundary.cancel();
                if (outcome === 'indeterminate')
                    this.recoveryRequired = true;
            },
        };
    }
    interrupt(inputId) {
        this.assertUsable();
        const turn = this.current;
        if (!turn)
            throw new SchedulerStateError('runtime_unavailable', `Agent '${this.agentId}' has no running turn`);
        const boundary = this.boundaries.observeInterrupt(inputId);
        const response = this.request({ type: 'abort', id: inputId });
        const accepted = response.then((value) => {
            if (responseWasRefused(value))
                throw new PiRpcCommandError('abort', 'Pi refused interrupt');
        });
        return {
            accepted,
            settled: turn.done.promise,
            aborted: boundary.promise,
            cancelBoundary: (outcome) => {
                boundary.cancel();
                if (outcome === 'indeterminate')
                    this.recoveryRequired = true;
            },
        };
    }
    close() {
        this.closePromise ??= this.closeImpl();
        return this.closePromise;
    }
    newTurn(plan) {
        return {
            activationId: plan.activationId,
            leaseToken: plan.activationLeaseToken,
            done: deferred(),
            abortSeen: false,
        };
    }
    async closeImpl() {
        this.closing = true;
        const pending = this.current ? [this.current] : [];
        if (this.current)
            await this.request({ type: 'abort' }, Math.min(this.timeoutMs, CLOSE_DEADLINE_MS)).catch(() => undefined);
        if (this.current)
            await Promise.race([
                this.current.done.promise.catch(() => undefined),
                new Promise((resolve) => setTimeout(resolve, CLOSE_DEADLINE_MS)),
            ]);
        const closed = new SchedulerStateError('manager_closed', `Actor '${this.agentId}' closed before Pi settlement`);
        this.boundaries.reject(closed);
        for (const turn of pending)
            if (turn === this.current)
                turn.done.resolve({
                    activationId: turn.activationId,
                    leaseToken: turn.leaseToken,
                    outcome: turn.abortSeen ? 'aborted' : 'indeterminate',
                });
        this.current = undefined;
        await this.rpc.close(5_000);
        return Promise.all(pending.map((turn) => turn.done.promise.catch(() => ({
            activationId: turn.activationId,
            leaseToken: turn.leaseToken,
            outcome: 'indeterminate',
        }))));
    }
    captureRpcEvent(event) {
        this.captureActivity(event);
        for (const listener of this.uiChangeListeners) {
            try {
                listener(event);
            }
            catch (error) {
                this.addDiagnostic(errorOf(error));
            }
        }
        if (this.boundaries.captureEvent(event) && this.current)
            this.current.abortSeen = true;
        if (isRecord(event) && event.type === 'agent_settled')
            this.finishCurrent();
    }
    finishCurrent() {
        const turn = this.current;
        if (!turn)
            return;
        this.current = undefined;
        turn.done.resolve({
            activationId: turn.activationId,
            leaseToken: turn.leaseToken,
            outcome: turn.abortSeen ? 'aborted' : 'settled',
        });
    }
    rejectTurns(error) {
        if (this.current)
            this.current.done.resolve({
                activationId: this.current.activationId,
                leaseToken: this.current.leaseToken,
                outcome: 'indeterminate',
            });
        this.current = undefined;
        this.addDiagnostic(error);
    }
    managedInput(inputId, plan) {
        return {
            type: 'prompt',
            message: childInputCommand({
                inputId,
                payloadId: plan.eventId,
                delivery: plan.deliveryKind,
                payloadHash: plan.payloadHash,
                source: plan.source,
                ...(plan.correlationId ? { correlationId: plan.correlationId } : {}),
                startingInput: plan.startingInput,
                lines: plan.presentationLines,
                presentation: plan.presentation,
            }),
        };
    }
    async request(command, timeoutMs = this.timeoutMs) {
        return this.rpc.request(command, timeoutMs);
    }
    captureActivity(value) {
        if (!isRecord(value) || typeof value.type !== 'string')
            return;
        this.assistantStream = applyAssistantStreamEvent(this.assistantStream, value).state;
        if ((value.type === 'tool_execution_start' || value.type === 'tool_execution_update') &&
            typeof value.toolCallId === 'string')
            // RPC events are freshly parsed per frame and never mutated downstream.
            this.activeToolEvents.set(value.toolCallId, value);
        else if (value.type === 'tool_execution_end' && typeof value.toolCallId === 'string')
            this.activeToolEvents.delete(value.toolCallId);
        else if (value.type === 'agent_settled' || value.type === 'agent_end') {
            this.activeToolEvents.clear();
            this.assistantStream = undefined;
        }
    }
    addDiagnostic(error) {
        this.diagnosticsRing.push(error.message.slice(0, 500));
        if (this.diagnosticsRing.length > MAX_DIAGNOSTICS)
            this.diagnosticsRing.shift();
    }
    assertUsable() {
        if (this.closing)
            throw new SchedulerStateError('manager_closed', `Actor '${this.agentId}' is closing`);
        if (this.failure)
            throw this.failure;
        if (this.recoveryRequired)
            throw new SchedulerStateError('recovery_required', `Actor '${this.agentId}' requires recovery`);
    }
}
