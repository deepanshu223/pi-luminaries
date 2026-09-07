import { DurablePiActor } from './actor-runtime.ts';
import type { AcceptedBuild } from './accepted-build.ts';
import { PeerBridgeServer, type PeerBridgeCredential } from './peer-bridge.ts';
import { waitForPiEvidence, type PiTurnSettlement } from './peer-delivery.ts';
import { resolvePiInvocation, type PiInvocation } from './pi-rpc.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { SchedulerStateError, SchedulerStore, type AgentRecord } from './scheduler-store.ts';
import { agentPath, directMailboxRecords, peerMailboxRecords, sha256 } from './scheduler-state.ts';

const CHILD_ENV = LUMINARIES_IDENTITY.childEnv;
const STARTUP_JOIN_TIMEOUT_MS = 35_000;
const CLEANUP_JOIN_TIMEOUT_MS = 10_000;
const IDLE_PARK_DELAY_MS = 5 * 60_000;

interface ActorPoolOptions {
  store: SchedulerStore;
  bridge: PeerBridgeServer;
  generation: string;
  acceptedBuild?: AcceptedBuild;
  invocation?: PiInvocation;
  provider?: string;
  extension?: string;
  env?: NodeJS.ProcessEnv;
  idleParkDelayMs?: number;
  managerRunning: () => boolean;
  onActorReady?: (actor: DurablePiActor) => void;
  onDiagnostic(error: unknown): void;
}

/** Owns disposable child processes; recipient ordering belongs to RecipientDrain. */
export class LuminariesActorPool {
  private readonly options: ActorPoolOptions;
  private readonly actorsValue = new Map<string, DurablePiActor>();
  private readonly starts = new Map<string, Promise<DurablePiActor>>();
  private readonly credentials = new Map<string, PeerBridgeCredential>();
  private readonly parking = new Map<string, { completion: Promise<void>; release: () => void }>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly cleanupByAgent = new Map<string, Promise<void>>();
  private readonly idleDeadlines = new Map<string, number>();
  private idleTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(options: ActorPoolOptions) {
    if (
      options.idleParkDelayMs !== undefined &&
      (!Number.isSafeInteger(options.idleParkDelayMs) || options.idleParkDelayMs < 1)
    )
      throw new RangeError('Idle park delay must be a positive safe integer');
    this.options = options;
  }

  get actors(): ReadonlyMap<string, DurablePiActor> {
    return this.actorsValue;
  }

  async ensure(agent: AgentRecord): Promise<DurablePiActor> {
    this.cancelIdle(agent.agentId);
    await this.cleanupByAgent.get(agent.agentId);
    await this.parking.get(agent.agentId)?.completion;
    const existing = this.actorsValue.get(agent.agentId);
    if (existing && this.isCurrent(existing)) return existing;
    const pending = this.starts.get(agent.agentId);
    if (pending) return pending;
    const start = (existing ? this.restart(existing, agent) : this.start(agent)).finally(() =>
      this.starts.delete(agent.agentId),
    );
    this.starts.set(agent.agentId, start);
    return start;
  }

  async closeAgent(agentId: string): Promise<void> {
    this.cancelIdle(agentId);
    const existingCleanup = this.cleanupByAgent.get(agentId);
    if (existingCleanup) return existingCleanup;
    const cleanup = this.closeAgentImpl(agentId).finally(() => {
      if (this.cleanupByAgent.get(agentId) === cleanup) this.cleanupByAgent.delete(agentId);
      this.cleanups.delete(cleanup);
    });
    this.cleanupByAgent.set(agentId, cleanup);
    this.cleanups.add(cleanup);
    return cleanup;
  }

  private async closeAgentImpl(agentId: string): Promise<void> {
    const pending = this.starts.get(agentId);
    if (pending) await pending.catch(() => undefined);
    const actor = this.actorsValue.get(agentId);
    this.options.bridge.revokeAgent(agentId);
    this.credentials.delete(agentId);
    if (!actor) return;
    this.actorsValue.delete(agentId);
    const settlements = await actor.close();
    for (const settlement of settlements) await this.settleIfLive(settlement);
    const agent = this.options.store.snapshot().agents[agentId];
    if (agent?.runtimeOwner === actor.runtimeOwner)
      await this.options.store.releaseRuntime(
        agentId,
        actor.runtimeOwner,
        actor.needsAttention ? 'needs_attention' : 'runtime_parked',
        actor.needsAttention ? 'runtime_recovery_required' : 'runtime_released',
      );
    else await this.options.store.releaseClosedRuntime(agentId, actor.runtimeOwner);
  }

  async closeAll(): Promise<void> {
    if (this.closing) {
      await this.join([...this.starts.values(), ...this.cleanups], CLEANUP_JOIN_TIMEOUT_MS);
      return;
    }
    this.closing = true;
    this.idleDeadlines.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    await this.join([...this.starts.values()], STARTUP_JOIN_TIMEOUT_MS);
    const ids = [...this.actorsValue.keys()];
    await Promise.allSettled(ids.map((agentId) => this.closeAgent(agentId).catch(this.options.onDiagnostic)));
    await this.join([...this.cleanups], CLEANUP_JOIN_TIMEOUT_MS);
    this.credentials.clear();
  }

  async parkAll(mode: 'safe' | 'now'): Promise<void> {
    const ids = Object.values(this.options.store.snapshot().agents)
      .filter((agent) => agent.parentId !== null && agent.lifecycle === 'open')
      .map((agent) => agent.agentId);
    const immediate: Promise<void>[] = [];
    for (const agentId of ids) {
      this.cancelIdle(agentId);
      const parking = this.beginParking(agentId);
      if (mode === 'safe' && this.actorsValue.get(agentId)?.requestParkAtNextSettlement(parking.release)) {
        void parking.completion.catch(this.options.onDiagnostic);
      } else {
        parking.release();
        immediate.push(parking.completion);
      }
    }
    await Promise.all(immediate);
  }

  async parkAgentAtSafeBoundary(agentId: string): Promise<void> {
    this.cancelIdle(agentId);
    const parking = this.beginParking(agentId);
    if (!this.actorsValue.get(agentId)?.requestParkAtNextSettlement(parking.release)) parking.release();
    await parking.completion;
  }

  armIdle(agentId: string): void {
    if (this.closing || !this.actorsValue.has(agentId) || this.parking.has(agentId)) return;
    this.idleDeadlines.set(agentId, Date.now() + (this.options.idleParkDelayMs ?? IDLE_PARK_DELAY_MS));
    this.scheduleIdleTimer();
  }

  cancelIdle(agentId: string): void {
    if (!this.idleDeadlines.delete(agentId)) return;
    this.scheduleIdleTimer();
  }

  private beginParking(agentId: string): { completion: Promise<void>; release: () => void } {
    const existing = this.parking.get(agentId);
    if (existing) return existing;
    let release: () => void = () => undefined;
    const start = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completion = Promise.resolve();
    completion = start
      .then(() => this.closeAgent(agentId))
      .finally(() => {
        if (this.parking.get(agentId)?.completion === completion) this.parking.delete(agentId);
      });
    const parking = { completion, release };
    this.parking.set(agentId, parking);
    return parking;
  }

  private scheduleIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.closing || !this.idleDeadlines.size) return;
    const next = Math.min(...this.idleDeadlines.values());
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined;
        void this.reapIdle().catch(this.options.onDiagnostic);
      },
      Math.max(0, next - Date.now()),
    );
    this.idleTimer.unref();
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const due = [...this.idleDeadlines].filter(([, deadline]) => deadline <= now).map(([agentId]) => agentId);
    for (const agentId of due) {
      this.idleDeadlines.delete(agentId);
      if (!this.safeToPark(agentId)) {
        const agent = this.options.store.snapshot().agents[agentId];
        if (agent?.pendingConfiguration)
          this.idleDeadlines.set(agentId, now + (this.options.idleParkDelayMs ?? IDLE_PARK_DELAY_MS));
        continue;
      }
      const parking = this.beginParking(agentId);
      parking.release();
      void parking.completion.catch(this.options.onDiagnostic);
    }
    this.scheduleIdleTimer();
  }

  private safeToPark(agentId: string): boolean {
    const actor = this.actorsValue.get(agentId);
    const state = this.options.store.snapshot();
    const agent = state.agents[agentId];
    if (
      !actor?.isUsable ||
      !agent ||
      agent.parentId === null ||
      agent.lifecycle !== 'open' ||
      agent.runtimeOwner !== actor.runtimeOwner ||
      agent.runtimePhase !== 'ready' ||
      agent.pendingConfiguration ||
      this.starts.has(agentId) ||
      this.cleanupByAgent.has(agentId) ||
      this.parking.has(agentId)
    )
      return false;
    if (
      Object.values(state.activations).some(
        (activation) => activation.agentId === agentId && activation.state === 'running',
      )
    )
      return false;
    if (
      peerMailboxRecords(state).some(
        (event) =>
          event.recipientId === agentId &&
          (event.status === 'sending' ||
            event.status === 'consumed' ||
            (event.status === 'accepted' && event.mode !== 'follow_up')),
      )
    )
      return false;
    return !directMailboxRecords(state).some(
      (control) =>
        control.targetId === agentId &&
        control.status !== 'aborted' &&
        control.status !== 'refused' &&
        control.status !== 'failed' &&
        control.status !== 'indeterminate',
    );
  }

  private async join(operations: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
    if (!operations.length) return;
    await waitForPiEvidence(Promise.allSettled(operations), 'Actor pool shutdown', timeoutMs).catch(
      this.options.onDiagnostic,
    );
  }

  private isCurrent(actor: DurablePiActor): boolean {
    if (!actor.isUsable) return false;
    const agent = this.options.store.snapshot().agents[actor.agentId];
    return agent?.lifecycle === 'open' && agent.runtimeOwner === actor.runtimeOwner && agent.runtimePhase === 'ready';
  }

  private async restart(existing: DurablePiActor, agent: AgentRecord): Promise<DurablePiActor> {
    await this.closeAgent(existing.agentId);
    return this.start(agent);
  }

  private async start(agent: AgentRecord): Promise<DurablePiActor> {
    if (this.closing || !this.options.managerRunning())
      throw new SchedulerStateError('manager_closed', `${LUMINARIES_IDENTITY.label} actor pool is closing`);
    const state = this.options.store.snapshot();
    const current = state.agents[agent.agentId];
    if (!current || current.lifecycle !== 'open')
      throw new SchedulerStateError('agent_unavailable', `Agent '${agent.agentId}' is not open`);
    try {
      await this.options.acceptedBuild?.verify();
    } catch (error) {
      throw new SchedulerStateError(
        'runtime_build_mismatch',
        `The ${LUMINARIES_IDENTITY.label} package changed after this root started; restart the root before starting another collaborator`,
        { cause: error },
      );
    }
    const credential = this.options.bridge.issue(current.agentId, {
      sessionId: current.sessionId,
      generation: this.options.generation,
      buildId: this.options.acceptedBuild?.id,
    });
    this.credentials.set(current.agentId, credential);
    let actor: DurablePiActor | undefined;
    try {
      actor = await DurablePiActor.start({
        store: this.options.store,
        agentId: current.agentId,
        invocation: this.options.invocation ?? resolvePiInvocation(),
        provider: current.provider ?? this.options.provider,
        extension: this.options.extension,
        env: {
          ...this.options.env,
          [CHILD_ENV.url]: credential.url,
          [CHILD_ENV.token]: credential.token,
          [CHILD_ENV.agentId]: current.agentId,
          [CHILD_ENV.rootId]: state.root.rootId,
          [CHILD_ENV.sessionId]: current.sessionId,
          [CHILD_ENV.generation]: this.options.generation,
          ...(this.options.acceptedBuild ? { [CHILD_ENV.buildId]: this.options.acceptedBuild.id } : {}),
          [CHILD_ENV.parentId]: current.parentId ?? state.root.rootId,
          [CHILD_ENV.path]: agentPath(state, current.agentId),
          [CHILD_ENV.outbox]: this.options.store.deliveryPayloadDirectory,
        },
        allowRecovery: true,
        onDiagnostic: this.options.onDiagnostic,
        onUnavailable: (unavailable, error) => this.scheduleUnavailable(unavailable, error),
        onExtensionUiBlocked: (source, notice, sourceActivationId) => {
          void (async () => {
            const ownerId = this.options.store.snapshot().agents[source.agentId]?.parentId;
            if (!ownerId) return;
            await this.options.store.admitSystemEvent({
              dedupeKey: `extension-ui:${sha256(`${source.agentId}:${notice.id}`).slice(0, 48)}`,
              type: 'routine',
              senderId: source.agentId,
              recipientId: ownerId,
              message: `${this.options.store.snapshot().agents[source.agentId]?.displayName.value ?? 'Collaborator'} could not open ${notice.method} UI '${notice.title}' in its managed headless session.`,
              wake: false,
              sourceActivationId,
            });
          })().catch(this.options.onDiagnostic);
        },
      });
      const ready = this.options.store.snapshot().agents[current.agentId];
      if (this.closing || !this.options.managerRunning() || !ready || ready.lifecycle !== 'open')
        throw new SchedulerStateError(
          'delivery_deferred',
          `Agent '${current.agentId}' changed lifecycle during runtime startup`,
        );
      this.actorsValue.set(current.agentId, actor);
      this.options.bridge.bind(credential, actor);
      this.options.onActorReady?.(actor);
      return actor;
    } catch (error) {
      this.options.bridge.revoke(credential);
      this.credentials.delete(current.agentId);
      this.actorsValue.delete(current.agentId);
      if (actor) {
        const settlements = await actor.close().catch((failure) => {
          this.options.onDiagnostic(failure);
          return [];
        });
        for (const settlement of settlements) await this.settleIfLive(settlement);
        const claimed = this.options.store.snapshot().agents[current.agentId];
        if (claimed?.lifecycle === 'open' && claimed.runtimeOwner === actor.runtimeOwner)
          await this.options.store
            .releaseRuntime(current.agentId, actor.runtimeOwner, 'needs_attention', 'runtime_start_failed')
            .catch(this.options.onDiagnostic);
      }
      throw error;
    }
  }

  private scheduleUnavailable(actor: DurablePiActor, error: Error): void {
    if (this.actorsValue.get(actor.agentId) !== actor) {
      this.options.onDiagnostic(error);
      return;
    }
    let cleanup: Promise<void>;
    cleanup = Promise.resolve()
      .then(async () => {
        if (this.actorsValue.get(actor.agentId) !== actor) return;
        this.options.onDiagnostic(error);
        await this.closeAgent(actor.agentId);
      })
      .catch(this.options.onDiagnostic)
      .finally(() => this.cleanups.delete(cleanup));
    this.cleanups.add(cleanup);
  }

  private async settleIfLive(settlement: PiTurnSettlement): Promise<void> {
    await this.options.store.finishActivationIfRunning(
      settlement.activationId,
      settlement.leaseToken,
      settlement.outcome,
    );
  }
}
