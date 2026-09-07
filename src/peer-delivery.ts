import { PiRpcCommandError } from './pi-rpc.ts';
import { SchedulerStateError, SchedulerStore, type PeerDispatchPlan } from './scheduler-store.ts';
import { peerMailboxRecord, peerMailboxRecords, type ActivationState } from './scheduler-state.ts';
import { eligiblePeerEventsForRecipient } from './peer-event-policy.ts';

const MAX_DIAGNOSTICS = 32;
const PI_EVIDENCE_TIMEOUT_MS = 120_000;
const SHUTDOWN_JOIN_TIMEOUT_MS = 10_000;

export interface PiTurnSettlement {
  activationId: string;
  leaseToken: string;
  outcome: Exclude<ActivationState, 'running'>;
}

export interface PiDeliveryAttempt {
  eventId: string;
  deliveryKind: PeerDispatchPlan['deliveryKind'];
  activationId: string;
  accepted: Promise<void>;
  consumed: Promise<boolean>;
  settled: Promise<PiTurnSettlement>;
  cancelBoundary(outcome?: 'known' | 'indeterminate'): void;
}

export interface PiInterruptAttempt {
  accepted: Promise<void>;
  settled: Promise<PiTurnSettlement>;
  aborted: Promise<boolean>;
  cancelBoundary(outcome?: 'known' | 'indeterminate'): void;
}

/** Private transport seam. Durable selection and current-turn truth stay outside it. */
export interface DeliveryPort {
  readonly agentId: string;
  readonly runtimeOwner: string;
  deliver(plan: PeerDispatchPlan): PiDeliveryAttempt;
  interrupt(inputId: string): PiInterruptAttempt;
  close(): Promise<readonly PiTurnSettlement[]>;
}

interface RecipientDrainOptions {
  store: SchedulerStore;
  acquirePort(agentId: string): Promise<DeliveryPort>;
  onRecipientIdle?(agentId: string): void;
  onDiagnostic(error: unknown): void;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function terminal(status: string): boolean {
  return (
    status === 'settled' ||
    status === 'aborted' ||
    status === 'refused' ||
    status === 'failed' ||
    status === 'indeterminate'
  );
}

export function waitForPiEvidence<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number | null = PI_EVIDENCE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              reject(new SchedulerStateError('delivery_indeterminate', `${label} exceeded its finite evidence wait`)),
            timeoutMs,
          );
    timer?.unref();
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One disposable per-recipient drain over the canonical Store inbox. */
export class RecipientDrain {
  private readonly options: RecipientDrainOptions;
  private rootGate: Promise<void> = Promise.resolve();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly pendingHints = new Set<string>();
  private readonly dormantRecipients = new Set<string>();
  private readonly quarantinedRecipients = new Set<string>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly pendingSettlements = new Map<string, PiTurnSettlement>();
  private readonly diagnosticsRing: string[] = [];
  private readonly unsubscribe: () => void;
  private closing = false;

  constructor(options: RecipientDrainOptions) {
    this.options = options;
    this.unsubscribe = options.store.onChange((_revision, affectedRecipientIds) => {
      for (const recipientId of affectedRecipientIds) this.hint(recipientId);
    });
  }

  get diagnostics(): readonly string[] {
    return [...this.diagnosticsRing];
  }

  hint(recipientId: string): void {
    if (this.closing || this.dormantRecipients.has(recipientId)) return;
    if (this.quarantinedRecipients.has(recipientId)) {
      if (!this.hasRecoveryInput(recipientId)) return;
      this.quarantinedRecipients.delete(recipientId);
    }
    if (this.pumps.has(recipientId)) {
      this.pendingHints.add(recipientId);
      return;
    }
    const pump = this.pump(recipientId).catch((error) => this.addDiagnostic(error));
    this.pumps.set(recipientId, pump);
    void pump.finally(() => {
      if (this.pumps.get(recipientId) !== pump) return;
      this.pumps.delete(recipientId);
      if (this.pendingHints.delete(recipientId) && !this.closing) setImmediate(() => this.hint(recipientId));
    });
  }

  setDormant(recipientId: string, dormant: boolean): void {
    if (dormant) this.dormantRecipients.add(recipientId);
    else this.dormantRecipients.delete(recipientId);
  }

  scanOnce(): void {
    const recipients = new Set(
      Object.values(this.options.store.snapshot().mailbox).flatMap((record) =>
        record.lane !== 'direct' && record.status === 'accepted' ? [record.recipientId] : [],
      ),
    );
    for (const recipientId of recipients) this.hint(recipientId);
  }

  runRoot<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.rootGate.then(operation, operation);
    this.rootGate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async settle(settlement: PiTurnSettlement): Promise<void> {
    const snapshot = this.options.store.snapshot();
    const activation = snapshot.activations[settlement.activationId];
    if (!activation || activation.state !== 'running') return;
    const attemptStillOpen = peerMailboxRecords(snapshot).some(
      (record) => record.activationId === settlement.activationId && record.status === 'sending',
    );
    if (attemptStillOpen) {
      this.pendingSettlements.set(settlement.activationId, settlement);
      return;
    }
    this.pendingSettlements.delete(settlement.activationId);
    const finished = await this.options.store.finishActivationIfRunning(
      settlement.activationId,
      settlement.leaseToken,
      settlement.outcome,
    );
    if ((settlement.outcome === 'settled' || settlement.outcome === 'aborted') && finished.value)
      this.options.onRecipientIdle?.(finished.value.agentId);
  }

  quiesce(): void {
    if (this.closing) return;
    this.closing = true;
    this.unsubscribe();
  }

  async drain(): Promise<void> {
    while (this.pumps.size || this.background.size) {
      try {
        await waitForPiEvidence(
          Promise.allSettled([...this.pumps.values(), ...this.background]),
          'Recipient drain shutdown',
          SHUTDOWN_JOIN_TIMEOUT_MS,
        );
      } catch (error) {
        this.addDiagnostic(error);
        return;
      }
    }
  }

  observeSettlement(settlement: Promise<PiTurnSettlement>): void {
    const eventual = settlement.then((value) => this.settle(value));
    void eventual.catch((error) => this.addDiagnostic(error));
    this.track(waitForPiEvidence(eventual, 'Pi turn settlement', null));
  }

  async close(): Promise<void> {
    this.quiesce();
    await this.drain();
    this.pendingHints.clear();
    this.dormantRecipients.clear();
    this.quarantinedRecipients.clear();
    this.pendingSettlements.clear();
    this.pumps.clear();
    this.background.clear();
  }

  private async pump(recipientId: string): Promise<void> {
    for (;;) {
      const progressed = await this.dispatchOne(recipientId);
      if (!progressed || this.closing) return;
    }
  }

  private async dispatchOne(recipientId: string): Promise<boolean> {
    const accepted = eligiblePeerEventsForRecipient(this.options.store.snapshot(), recipientId)[0];
    if (!accepted) return false;
    const agent = this.options.store.snapshot().agents[recipientId];
    if (agent?.attention?.kind === 'needs_attention' && !this.hasRecoveryInput(recipientId)) {
      this.quarantinedRecipients.add(recipientId);
      return false;
    }
    let port: DeliveryPort;
    try {
      port = await this.options.acquirePort(recipientId);
    } catch (error) {
      this.addDiagnostic(error);
      const agent = this.options.store.snapshot().agents[recipientId];
      if (agent?.parentId !== null && agent?.lifecycle === 'open')
        await this.options.store
          .setAgentAttention(
            recipientId,
            'needs_attention',
            error instanceof SchedulerStateError ? error.code.slice(0, 64) : 'runtime_start_failed',
          )
          .catch((failure) => this.addDiagnostic(failure));
      if (agent?.parentId !== null) this.quarantinedRecipients.add(recipientId);
      return false;
    }
    if (agent && agent.parentId !== null) {
      try {
        await this.options.store.materializeDeliveryPayload(accepted.eventId);
      } catch (error) {
        this.addDiagnostic(error);
        this.quarantinedRecipients.add(recipientId);
        await this.options.store
          .setAgentAttention(recipientId, 'needs_attention', 'payload_materialization_failed')
          .catch((failure) => this.addDiagnostic(failure));
        return false;
      }
    }
    const begun = await this.options.store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: accepted.eventId,
      runtimeOwner: port.runtimeOwner,
    });
    if (!begun.value || !('eventId' in begun.value)) {
      await this.removeDerivedPayload(accepted.eventId);
      this.options.onRecipientIdle?.(recipientId);
      return false;
    }
    const plan = begun.value;
    let attempt: PiDeliveryAttempt;
    try {
      attempt = port.deliver(plan);
    } catch (error) {
      await this.requeueBeforeBoundary(plan, errorOf(error));
      return false;
    }
    let settlementDeferred = false;
    try {
      try {
        await waitForPiEvidence(attempt.accepted, `Pi acceptance for '${plan.eventId}'`);
      } catch (error) {
        const deliveryRace = error instanceof SchedulerStateError && error.code === 'delivery_race';
        const known = deliveryRace || error instanceof PiRpcCommandError;
        attempt.cancelBoundary(known ? 'known' : 'indeterminate');
        if (deliveryRace) {
          await this.requeueBeforeBoundary(plan, error);
          return false;
        }
        await this.failAttempt(plan, errorOf(error), known);
        return true;
      }
      settlementDeferred = true;
      this.track(
        this.consumeLater(plan, attempt).finally(() => {
          this.observeSettlement(attempt.settled);
          this.track(
            attempt.settled.then(async (settlement) => {
              const pending = this.pendingSettlements.get(settlement.activationId);
              if (pending) await this.settle(pending);
            }),
          );
        }),
      );
      return true;
    } finally {
      if (!settlementDeferred) this.observeSettlement(attempt.settled);
    }
  }

  private async requeueBeforeBoundary(
    plan: PeerDispatchPlan,
    error?: Error,
    settlement?: PiTurnSettlement,
  ): Promise<void> {
    await this.options.store.applyMailboxIntent({
      kind: 'release_delivery',
      recordId: plan.eventId,
      attemptId: plan.attemptId,
      ...(settlement ? { settlement } : {}),
    });
    if (error) this.addDiagnostic(error);
  }

  private async consumeLater(plan: PeerDispatchPlan, attempt: PiDeliveryAttempt): Promise<void> {
    let evidence: boolean | Error;
    try {
      evidence = await waitForPiEvidence(attempt.consumed, `Exact follow-up boundary for '${plan.eventId}'`, null);
    } catch (error) {
      evidence = errorOf(error);
    }
    const settlement =
      evidence === false
        ? await waitForPiEvidence(attempt.settled, `Pi settlement after missed boundary for '${plan.eventId}'`, null)
        : undefined;
    const event = peerMailboxRecord(this.options.store.snapshot(), plan.eventId);
    if (!event) {
      await this.removeDerivedPayload(plan.eventId);
      return;
    }
    if (event.attemptId !== plan.attemptId) return;
    if (terminal(event.status) || event.consumedSeq !== undefined) {
      await this.removeDerivedPayload(plan.eventId);
      return;
    }
    if (evidence instanceof Error) {
      attempt.cancelBoundary('indeterminate');
      await this.failAttempt(plan, evidence, false);
      return;
    }
    if (!evidence) {
      if (
        settlement &&
        peerMailboxRecords(this.options.store.snapshot()).some(
          (candidate) =>
            candidate.mode === 'follow_up' &&
            candidate.status === 'sending' &&
            candidate.activationId === settlement.activationId &&
            candidate.consumedSeq === undefined &&
            candidate.acceptedSeq < event.acceptedSeq,
        )
      )
        return;
      attempt.cancelBoundary('known');
      await this.requeueBeforeBoundary(plan, undefined, settlement);
      return;
    }
    await this.options.store
      .applyMailboxIntent({
        kind: 'admit_boundary',
        recordId: plan.eventId,
        attemptId: plan.attemptId,
      })
      .catch((error: unknown) => {
        if (!(error instanceof SchedulerStateError && error.code === 'mailbox_missing')) throw error;
      });
    await this.removeDerivedPayload(plan.eventId);
  }

  private async failAttempt(plan: PeerDispatchPlan, error: Error, refused: boolean): Promise<void> {
    const event = peerMailboxRecord(this.options.store.snapshot(), plan.eventId);
    if (!event || terminal(event.status) || event.consumedSeq !== undefined) {
      await this.removeDerivedPayload(plan.eventId);
      return;
    }
    if (plan.deliveryKind === 'wake') {
      if (refused)
        await this.options.store.applyMailboxIntent({
          kind: 'finish_delivery',
          recordId: plan.eventId,
          attemptId: plan.attemptId,
          status: 'failed',
          outcomeCode: 'pi_refused_input',
        });
      const activation = this.options.store.snapshot().activations[plan.activationId];
      if (activation?.state === 'running')
        await this.options.store.finishActivationIfRunning(
          activation.activationId,
          activation.leaseToken,
          refused ? 'failed' : 'indeterminate',
        );
    } else {
      await this.options.store.applyMailboxIntent({
        kind: 'finish_delivery',
        recordId: plan.eventId,
        attemptId: plan.attemptId,
        status: refused ? 'failed' : 'indeterminate',
        outcomeCode: refused ? 'pi_refused_input' : 'pi_input_unconfirmed',
      });
    }
    await this.removeDerivedPayload(plan.eventId);
    this.addDiagnostic(error);
  }

  private async removeDerivedPayload(eventId: string): Promise<void> {
    await this.options.store.removeDeliveryPayload(eventId).catch((error) => this.addDiagnostic(error));
  }

  private track(operation: Promise<unknown>): void {
    const tracked = operation.catch((error) => this.addDiagnostic(error));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private hasRecoveryInput(recipientId: string): boolean {
    const snapshot = this.options.store.snapshot();
    const attention = snapshot.agents[recipientId]?.attention;
    if (attention?.kind !== 'needs_attention') return true;
    return Object.values(snapshot.mailbox).some(
      (record) =>
        record.lane !== 'direct' &&
        record.lane !== 'system' &&
        record.recipientId === recipientId &&
        record.status === 'accepted' &&
        record.acceptedSeq > attention.seq,
    );
  }

  private addDiagnostic(value: unknown): void {
    const error = errorOf(value);
    this.diagnosticsRing.push(error.message.slice(0, 500));
    if (this.diagnosticsRing.length > MAX_DIAGNOSTICS) this.diagnosticsRing.shift();
    this.options.onDiagnostic(error);
  }
}

export { formatPeerPrompt } from './peer-prompt.ts';
