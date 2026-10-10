import type { ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import { applyAssistantStreamEvent, assistantSnapshotEvent, type AssistantStreamState } from './assistant-stream.ts';
import { childInputCommand } from './child-input.ts';
import { ModelBoundaryTracker } from './model-boundary-tracker.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import {
  PiRpcCommandError,
  PiRpcProcess,
  buildPrivateSessionLaunch,
  type CancelledExtensionUiRequest,
  type PiInvocation,
  type PiRpcLimits,
  type RpcResponse,
} from './pi-rpc.ts';
import type { DeliveryPort, PiDeliveryAttempt, PiInterruptAttempt, PiTurnSettlement } from './peer-delivery.ts';
import { processAlive } from './process-liveness.ts';
import { validatePhysicalSessionNamespace } from './private-path-policy.ts';
import { SchedulerStateError, SchedulerStore, type PeerDispatchPlan } from './scheduler-store.ts';
import { agentRuntimeState, directMailboxRecords, isRecord } from './scheduler-state.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const CLOSE_DEADLINE_MS = 5_000;
const MAX_DIAGNOSTICS = 32;
const MAX_UI_NOTICES = 32;

export interface DurablePiActorOptions {
  store: SchedulerStore;
  agentId: string;
  invocation: PiInvocation;
  provider?: string;
  extension?: string;
  env?: NodeJS.ProcessEnv;
  limits?: PiRpcLimits;
  requestTimeoutMs?: number;
  allowRecovery?: boolean;
  onUnavailable?: (actor: DurablePiActor, error: Error) => void;
  onExtensionUiBlocked?: (
    actor: DurablePiActor,
    notice: CancelledExtensionUiRequest,
    sourceActivationId: string,
  ) => void;
  onDiagnostic?: (error: unknown) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface RuntimeTurn {
  activationId: string;
  leaseToken: string;
  done: Deferred<PiTurnSettlement>;
  abortSeen: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function cancelledExtensionUiRequest(value: unknown): CancelledExtensionUiRequest | undefined {
  const record = recordOf(value);
  if (!record || typeof record.id !== 'string' || typeof record.title !== 'string') return undefined;
  const method = record.method;
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return undefined;
  return { id: record.id, method, title: record.title };
}

/** One private Pi process. Store transitions are owned by the recipient drain. */
export class DurablePiActor implements DeliveryPort {
  readonly agentId: string;
  readonly sessionFile: string;
  readonly runtimeOwner: string;
  private readonly rpc: PiRpcProcess;
  private readonly timeoutMs: number;
  private readonly boundaries = new ModelBoundaryTracker();
  private readonly activeToolEvents = new Map<string, unknown>();
  private assistantStream?: AssistantStreamState;
  private compacting = false;
  private readonly diagnosticsRing: string[] = [];
  private readonly uiChangeListeners = new Set<(event: unknown) => void>();
  private readonly seenUiNotices = new Set<string>();
  private current?: RuntimeTurn;
  private closing = false;
  private closePromise?: Promise<readonly PiTurnSettlement[]>;
  private failure?: Error;
  private recoveryRequired = false;
  private parkAfterSettlement?: () => void;
  private pendingInput?: { response: Promise<RpcResponse>; failure?: PiRpcCommandError };
  private queueReset?: Promise<void>;

  private constructor(options: DurablePiActorOptions, rpc: PiRpcProcess, sessionFile: string, runtimeOwner: string) {
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
      } catch (callbackError) {
        this.addDiagnostic(errorOf(callbackError));
      }
    });
    rpc.on('extension_ui_cancelled', (value: unknown) => {
      const notice = cancelledExtensionUiRequest(value);
      if (!notice) {
        options.onDiagnostic?.(new Error('Pi RPC emitted an invalid extension UI notice'));
        return;
      }
      const sourceActivationId = this.current?.activationId;
      if (!sourceActivationId || this.seenUiNotices.has(notice.id)) return;
      this.seenUiNotices.add(notice.id);
      while (this.seenUiNotices.size > MAX_UI_NOTICES) {
        const oldest = this.seenUiNotices.values().next().value;
        if (typeof oldest !== 'string') break;
        this.seenUiNotices.delete(oldest);
      }
      try {
        options.onExtensionUiBlocked?.(this, notice, sourceActivationId);
      } catch (callbackError) {
        this.addDiagnostic(errorOf(callbackError));
      }
    });
  }

  static async start(options: DurablePiActorOptions): Promise<DurablePiActor> {
    await validatePhysicalSessionNamespace(options.store.snapshot(), options.agentId, 'session_conflict');
    let snapshot = options.store.snapshot();
    let agent = snapshot.agents[options.agentId];
    if (!agent || agent.lifecycle !== 'open' || !agent.sessionDir || !agent.sessionId || !agent.sessionFile)
      throw new SchedulerStateError(
        'agent_unavailable',
        `Agent '${options.agentId}' lacks a complete open private-session manifest`,
      );
    if (
      Object.values(snapshot.activations).some((item) => item.agentId === options.agentId && item.state === 'running')
    )
      throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' has a stale running activation`);
    if (
      directMailboxRecords(snapshot).some(
        (item) =>
          item.targetId === options.agentId &&
          item.status !== 'aborted' &&
          item.status !== 'refused' &&
          item.status !== 'failed' &&
          item.status !== 'indeterminate',
      )
    )
      throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' has a stale direct control`);
    if (agent.runtimeOwner) {
      if (!options.allowRecovery)
        throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' already owns a runtime`);
      if (agent.runtimeHostname !== hostname())
        throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' runtime is on another host`);
      const ownerPid = agent.runtimePid;
      if (!ownerPid || processAlive(ownerPid) !== false)
        throw new SchedulerStateError('recovery_required', `Agent '${options.agentId}' prior runtime is not gone`);
      await options.store.releaseRuntime(
        agent.agentId,
        agent.runtimeOwner,
        'needs_attention',
        'runtime_stale_reconciled',
      );
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
    let rpc: PiRpcProcess | undefined;
    try {
      const launch = buildPrivateSessionLaunch(
        {
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
        },
        options.invocation,
      );
      rpc = new PiRpcProcess({
        invocation: launch.invocation,
        cwd: launch.cwd,
        env: options.env,
        limits: options.limits,
        requestTimeoutMs: timeoutMs,
      });
      rpc.start();
      const childPid = rpc.process?.pid;
      if (!childPid)
        throw new SchedulerStateError('runtime_start_failed', `Agent '${agent.agentId}' child PID is unavailable`);
      await options.store.markRuntimeSpawned(agent.agentId, runtimeOwner, childPid);
      const state = await rpc.getState(
        { sessionId: agent.sessionId, privateSessionDir: agent.sessionDir, sessionFile: agent.sessionFile },
        timeoutMs,
      );
      if (state.isStreaming === true)
        throw new SchedulerStateError('recovery_required', `Agent '${agent.agentId}' is already streaming`);
      if (state.sessionFile !== agent.sessionFile)
        throw new SchedulerStateError('session_invalid', `Agent '${agent.agentId}' opened a different private session`);
      await options.store.markRuntimeReady(agent.agentId, runtimeOwner, childPid);
      return new DurablePiActor(options, rpc, agent.sessionFile, runtimeOwner);
    } catch (error) {
      await rpc?.close(2_000).catch(() => undefined);
      await options.store
        .releaseRuntime(agent.agentId, runtimeOwner, 'needs_attention', 'runtime_start_failed')
        .catch(() => undefined);
      throw error;
    }
  }

  get activityEvents(): readonly unknown[] {
    const assistant = assistantSnapshotEvent(this.assistantStream);
    return [
      ...(assistant === undefined ? [] : [assistant]),
      ...this.activeToolEvents.values(),
      ...(this.compacting ? [{ type: 'compaction_start' }] : []),
    ];
  }

  get diagnostics(): readonly string[] {
    return [...this.diagnosticsRing, ...this.rpc.diagnostics];
  }

  get process(): ChildProcess | undefined {
    return this.rpc.process;
  }

  get isUsable(): boolean {
    return !this.closing && !this.failure && !this.recoveryRequired;
  }

  get runtimeIdentity(): Readonly<{ agentId: string; runtimeOwner: string }> {
    return { agentId: this.agentId, runtimeOwner: this.runtimeOwner };
  }

  get needsAttention(): boolean {
    return this.recoveryRequired || this.failure !== undefined;
  }

  requestParkAtNextSettlement(onSettled: () => void): boolean {
    const turn = this.current;
    if (!turn) return false;
    if (this.parkAfterSettlement) return true;
    this.parkAfterSettlement = onSettled;
    void turn.done.promise.then(() => {
      const callback = this.parkAfterSettlement;
      this.parkAfterSettlement = undefined;
      callback?.();
    });
    return true;
  }

  onUiChange(listener: (event: unknown) => void): () => void {
    this.uiChangeListeners.add(listener);
    return () => this.uiChangeListeners.delete(listener);
  }

  subscribeConversation(listener: (event: unknown) => void): {
    snapshot: readonly unknown[];
    unsubscribe: () => void;
  } {
    const snapshot = this.activityEvents;
    this.uiChangeListeners.add(listener);
    return { snapshot, unsubscribe: () => this.uiChangeListeners.delete(listener) };
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (this.current) throw new SchedulerStateError('writer_busy', `Agent '${this.agentId}' is active`);
    await this.request({ type: 'set_model', provider, modelId });
  }

  async setThinking(level: string): Promise<void> {
    if (this.current) throw new SchedulerStateError('writer_busy', `Agent '${this.agentId}' is active`);
    await this.request({ type: 'set_thinking_level', level });
  }

  requireRecovery(): void {
    this.recoveryRequired = true;
  }

  deliver(plan: PeerDispatchPlan): PiDeliveryAttempt {
    this.assertUsable();
    if (this.queueReset)
      throw new SchedulerStateError(
        'delivery_race',
        `Agent '${this.agentId}' is withdrawing queued input before settlement`,
      );
    if (plan.recipientId !== this.agentId || plan.targetRuntimeOwner !== this.runtimeOwner)
      throw new SchedulerStateError('runtime_owner', `Delivery plan does not belong to '${this.agentId}'`);
    let turn: RuntimeTurn;
    if (plan.deliveryKind === 'wake') {
      if (this.current)
        throw new SchedulerStateError('delivery_race', `Agent '${this.agentId}' already has a running turn`);
      turn = this.newTurn(plan);
      this.current = turn;
    } else {
      if (!this.current || this.current.activationId !== plan.activationId)
        throw new SchedulerStateError('delivery_race', `Agent '${this.agentId}' no longer owns the running turn`);
      turn = this.current;
    }
    const boundary = this.boundaries.observe(plan.attemptId);
    const pending: { response: Promise<RpcResponse>; failure?: PiRpcCommandError } = {
      response: this.request(this.managedInput(boundary.inputId, plan)),
    };
    this.pendingInput = pending;
    const accepted = pending.response
      .then(() => {
        if (pending.failure) throw pending.failure;
      })
      .finally(() => {
        if (this.pendingInput === pending) this.pendingInput = undefined;
      });
    void accepted.catch((error) => {
      if (!(error instanceof PiRpcCommandError)) return;
      boundary.cancel();
      if (plan.deliveryKind === 'wake') {
        if (this.current === turn) this.current = undefined;
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
        if (outcome === 'indeterminate') this.recoveryRequired = true;
      },
    };
  }

  interrupt(inputId: string): PiInterruptAttempt {
    this.assertUsable();
    const turn = this.current;
    if (!turn) throw new SchedulerStateError('runtime_unavailable', `Agent '${this.agentId}' has no running turn`);
    const boundary = this.boundaries.observeInterrupt(inputId);
    const response = this.request({ type: 'abort', id: inputId });
    const accepted = response.then(() => undefined);
    return {
      accepted,
      settled: turn.done.promise,
      aborted: boundary.promise,
      cancelBoundary: (outcome) => {
        boundary.cancel();
        if (outcome === 'indeterminate') this.recoveryRequired = true;
      },
    };
  }

  close(): Promise<readonly PiTurnSettlement[]> {
    this.closePromise ??= this.closeImpl();
    return this.closePromise;
  }

  private newTurn(plan: PeerDispatchPlan): RuntimeTurn {
    return {
      activationId: plan.activationId,
      leaseToken: plan.activationLeaseToken,
      done: deferred<PiTurnSettlement>(),
      abortSeen: false,
    };
  }

  private async closeImpl(): Promise<readonly PiTurnSettlement[]> {
    this.closing = true;
    const pending = this.current ? [this.current] : [];
    if (this.current)
      await this.request({ type: 'abort' }, Math.min(this.timeoutMs, CLOSE_DEADLINE_MS)).catch(() => undefined);
    if (this.current)
      await Promise.race([
        this.current.done.promise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_DEADLINE_MS)),
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
    return Promise.all(
      pending.map((turn) =>
        turn.done.promise.catch(() => ({
          activationId: turn.activationId,
          leaseToken: turn.leaseToken,
          outcome: 'indeterminate' as const,
        })),
      ),
    );
  }

  private captureRpcEvent(event: unknown): void {
    if (
      isRecord(event) &&
      event.type === 'extension_error' &&
      event.event === 'command' &&
      event.extensionPath === `command:${LUMINARIES_IDENTITY.namespace.childInputCommand}` &&
      typeof event.error === 'string' &&
      this.pendingInput
    )
      this.pendingInput.failure = new PiRpcCommandError('prompt', event.error);
    this.captureActivity(event);
    for (const listener of this.uiChangeListeners) {
      try {
        listener(event);
      } catch (error) {
        this.addDiagnostic(errorOf(error));
      }
    }
    if (isRecord(event) && event.type === 'agent_settled' && this.boundaries.hasPendingInput) {
      const pending = this.pendingInput?.response;
      const reset = (async () => {
        // abort leaves custom messages queued; only a successful clear permits safe requeue.
        await pending?.catch(() => undefined);
        await this.request({ type: 'clear_queue' });
        if (this.boundaries.captureEvent(event, true) && this.current) this.current.abortSeen = true;
        this.finishCurrent();
      })();
      this.queueReset = reset;
      void reset
        .catch((error: unknown) => {
          this.recoveryRequired = true;
          this.boundaries.reject(errorOf(error));
          this.rejectTurns(errorOf(error));
        })
        .finally(() => {
          if (this.queueReset === reset) this.queueReset = undefined;
        });
    } else {
      if (this.boundaries.captureEvent(event, true) && this.current) this.current.abortSeen = true;
      if (isRecord(event) && event.type === 'agent_settled') this.finishCurrent();
    }
  }

  private finishCurrent(): void {
    const turn = this.current;
    if (!turn) return;
    this.current = undefined;
    turn.done.resolve({
      activationId: turn.activationId,
      leaseToken: turn.leaseToken,
      outcome: turn.abortSeen ? 'aborted' : 'settled',
    });
  }

  private rejectTurns(error: Error): void {
    if (this.current)
      this.current.done.resolve({
        activationId: this.current.activationId,
        leaseToken: this.current.leaseToken,
        outcome: 'indeterminate',
      });
    this.current = undefined;
    this.addDiagnostic(error);
  }

  private managedInput(inputId: string, plan: PeerDispatchPlan): Record<string, unknown> {
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

  private async request(
    command: Record<string, unknown>,
    timeoutMs: number | null = this.timeoutMs,
  ): Promise<RpcResponse> {
    return this.rpc.request(command, timeoutMs);
  }

  private captureActivity(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== 'string') return;
    if (value.type === 'compaction_start') {
      this.compacting = true;
      this.assistantStream = undefined;
    } else if (value.type === 'compaction_end' || value.type === 'agent_settled') this.compacting = false;
    this.assistantStream = applyAssistantStreamEvent(this.assistantStream, value).state;
    if (
      (value.type === 'tool_execution_start' || value.type === 'tool_execution_update') &&
      typeof value.toolCallId === 'string'
    )
      // RPC events are freshly parsed per frame and never mutated downstream.
      this.activeToolEvents.set(value.toolCallId, value);
    else if (value.type === 'tool_execution_end' && typeof value.toolCallId === 'string')
      this.activeToolEvents.delete(value.toolCallId);
    else if (value.type === 'agent_settled' || value.type === 'agent_end') {
      this.activeToolEvents.clear();
      this.assistantStream = undefined;
    }
  }

  private addDiagnostic(error: Error): void {
    this.diagnosticsRing.push(error.message.slice(0, 500));
    if (this.diagnosticsRing.length > MAX_DIAGNOSTICS) this.diagnosticsRing.shift();
  }

  private assertUsable(): void {
    if (this.closing) throw new SchedulerStateError('manager_closed', `Actor '${this.agentId}' is closing`);
    if (this.failure) throw this.failure;
    if (this.recoveryRequired)
      throw new SchedulerStateError('recovery_required', `Actor '${this.agentId}' requires recovery`);
  }
}
