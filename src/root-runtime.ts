import { ModelBoundaryTracker } from './model-boundary-tracker.ts';
import { applyAssistantStreamEvent, assistantSnapshotEvent, type AssistantStreamState } from './assistant-stream.ts';
import type { DeliveryPort, PiDeliveryAttempt, PiInterruptAttempt, PiTurnSettlement } from './peer-delivery.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { isRecord } from './scheduler-state.ts';
import {
  SchedulerStateError,
  type ActivationRecord,
  type PeerDispatchPlan,
  type SchedulerStore,
} from './scheduler-store.ts';

export interface RootTransport {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): void | Promise<void>;
  abort?(): void | Promise<void>;
}

interface RootRuntimeOptions {
  store: SchedulerStore;
  rootId: string;
  incarnation: string;
  transport: () => RootTransport | undefined;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function terminal(
  activation: ActivationRecord,
): activation is ActivationRecord & { state: Exclude<ActivationRecord['state'], 'running'> } {
  return (
    activation.state === 'settled' ||
    activation.state === 'aborted' ||
    activation.state === 'failed' ||
    activation.state === 'indeterminate'
  );
}

/** Stock parent-Pi transport adapter. The manager lease is the root runtime authority. */
export class RootRuntime {
  readonly agentId: string;
  readonly runtimeOwner: string;
  private readonly store: SchedulerStore;
  private readonly transportValue: () => RootTransport | undefined;
  private readonly boundaries = new ModelBoundaryTracker();
  private readonly settlements = new Map<string, Deferred<PiTurnSettlement>>();
  private readonly uiChangeListeners = new Set<(event: unknown) => void>();
  private readonly activeToolEvents = new Map<string, unknown>();
  private assistantStream?: AssistantStreamState;
  private activationId?: string;
  private nativeTurnSequence = 0;
  private nativeAbortSeen = false;
  private closing = false;

  constructor(options: RootRuntimeOptions) {
    this.store = options.store;
    this.agentId = options.rootId;
    this.runtimeOwner = options.incarnation;
    this.transportValue = options.transport;
  }

  deliveryPort(): DeliveryPort {
    this.assertOpen();
    if (!this.transportValue())
      throw new SchedulerStateError('root_delivery_unavailable', 'Parent Pi delivery is unavailable');
    const nativeTurnSequence = this.nativeTurnSequence;
    return {
      agentId: this.agentId,
      runtimeOwner: this.runtimeOwner,
      deliver: (plan) => this.deliverAtSequence(plan, nativeTurnSequence),
      interrupt: (inputId) => this.interrupt(inputId),
      close: () => this.close(),
    };
  }

  onUiChange(listener: (event: unknown) => void): () => void {
    this.uiChangeListeners.add(listener);
    return () => this.uiChangeListeners.delete(listener);
  }

  subscribeConversation(listener: (event: unknown) => void): {
    snapshot: readonly unknown[];
    unsubscribe: () => void;
  } {
    const assistant = assistantSnapshotEvent(this.assistantStream);
    const snapshot = [...(assistant === undefined ? [] : [assistant]), ...this.activeToolEvents.values()];
    this.uiChangeListeners.add(listener);
    return {
      snapshot,
      unsubscribe: () => this.uiChangeListeners.delete(listener),
    };
  }

  beforeAgentStartRequiresGate(): boolean {
    if (this.boundaries.hasPendingInput) return false;
    this.nativeTurnSequence++;
    return true;
  }

  async beforeAgentStart(_prompt: string): Promise<void> {
    this.assertOpen();
    const existing = this.liveActivation();
    if (existing) {
      this.activationId = existing.activationId;
      return;
    }
    await this.store.markAgentContinuedAfterIndeterminate(this.agentId, { kind: 'operator' });
    const activation = await this.store.startActivation(this.agentId, 'parent_prompt');
    this.activationId = activation.value.activationId;
  }

  messageStart(message: unknown): void {
    this.captureEvent({ type: 'message_start', message });
  }

  messageUpdate(event: unknown): void {
    this.captureEvent(event);
  }

  messageEnd(message: unknown): void {
    if (isRecord(message) && message.role === 'assistant') this.nativeAbortSeen = message.stopReason === 'aborted';
    this.captureEvent({ type: 'message_end', message });
  }

  agentSettled(outcome: PiTurnSettlement['outcome'] = 'settled'): PiTurnSettlement | undefined {
    const interruptSettled = this.captureEvent({ type: 'agent_settled' });
    const aborted = interruptSettled || this.nativeAbortSeen;
    this.nativeAbortSeen = false;
    const activation = this.currentActivation();
    if (!activation) return undefined;
    const settlement = {
      activationId: activation.activationId,
      leaseToken: activation.leaseToken,
      outcome: aborted && outcome === 'settled' ? 'aborted' : outcome,
    };
    const waiter = this.settlements.get(activation.activationId);
    waiter?.resolve(settlement);
    this.settlements.delete(activation.activationId);
    this.activationId = undefined;
    return waiter ? undefined : settlement;
  }

  private deliverAtSequence(plan: PeerDispatchPlan, nativeTurnSequence: number): PiDeliveryAttempt {
    this.assertOpen();
    if (nativeTurnSequence !== this.nativeTurnSequence)
      throw new SchedulerStateError('delivery_race', 'A native parent turn started before root input was written');
    if (plan.recipientId !== this.agentId || plan.targetRuntimeOwner !== this.runtimeOwner)
      throw new SchedulerStateError('runtime_owner', 'Root delivery plan has stale ownership');
    const transport = this.transportValue();
    if (!transport) throw new SchedulerStateError('root_delivery_unavailable', 'Parent Pi delivery is unavailable');
    const boundary = this.boundaries.observe(plan.attemptId);
    const settlement = this.settlements.get(plan.activationId) ?? deferred<PiTurnSettlement>();
    this.settlements.set(plan.activationId, settlement);
    if (plan.deliveryKind === 'wake') this.activationId = plan.activationId;
    let accepted: Promise<void>;
    try {
      accepted = Promise.resolve(
        transport.sendMessage(
          {
            customType: LUMINARIES_IDENTITY.namespace.protocolMessageType,
            content: plan.prompt,
            display: true,
            details: {
              lines: plan.presentationLines,
              content: plan.presentationContent,
              ...(plan.presentationLines.length === 1 ? { source: plan.source } : {}),
              inputId: boundary.inputId,
              presentation: plan.presentation,
            },
          },
          plan.deliveryKind === 'steer'
            ? { deliverAs: 'steer', triggerTurn: true }
            : plan.deliveryKind === 'follow_up'
              ? { deliverAs: 'followUp', triggerTurn: true }
              : { triggerTurn: true },
        ),
      );
    } catch (error) {
      accepted = Promise.reject(error);
    }
    return {
      eventId: plan.eventId,
      deliveryKind: plan.deliveryKind,
      activationId: plan.activationId,
      accepted,
      consumed: boundary.promise,
      settled: settlement.promise,
      cancelBoundary: (outcome) => {
        boundary.cancel();
        if (plan.deliveryKind !== 'wake') return;
        settlement.resolve({
          activationId: plan.activationId,
          leaseToken: plan.activationLeaseToken,
          outcome: outcome === 'known' ? 'failed' : 'indeterminate',
        });
        this.settlements.delete(plan.activationId);
        if (this.activationId === plan.activationId) this.activationId = undefined;
      },
    };
  }

  interrupt(inputId: string): PiInterruptAttempt {
    this.assertOpen();
    const transport = this.transportValue();
    const activation = this.currentActivation();
    if (activation?.state !== 'running' || !transport?.abort)
      throw new SchedulerStateError('runtime_unavailable', 'Root has no running turn to interrupt');
    const boundary = this.boundaries.observeInterrupt(inputId);
    const settlement = this.settlements.get(activation.activationId) ?? deferred<PiTurnSettlement>();
    this.settlements.set(activation.activationId, settlement);
    const accepted = Promise.resolve().then(() => transport.abort?.());
    return {
      accepted,
      settled: settlement.promise,
      aborted: boundary.promise,
      cancelBoundary: boundary.cancel,
    };
  }

  async close(): Promise<readonly PiTurnSettlement[]> {
    if (this.closing) return [];
    this.closing = true;
    const error = new SchedulerStateError(
      'manager_closed',
      `${LUMINARIES_IDENTITY.label} root runtime closed before boundary proof`,
    );
    this.boundaries.reject(error);
    const values: PiTurnSettlement[] = [];
    const waiterIds = new Set(this.settlements.keys());
    for (const [activationId, waiter] of this.settlements) {
      const activation = this.store.snapshot().activations[activationId];
      if (!activation) continue;
      const outcome = terminal(activation) ? activation.state : 'indeterminate';
      const settlement: PiTurnSettlement = {
        activationId,
        leaseToken: activation.leaseToken,
        outcome,
      };
      waiter.resolve(settlement);
    }
    const activation = this.currentActivation();
    if (activation && !waiterIds.has(activation.activationId))
      values.push({
        activationId: activation.activationId,
        leaseToken: activation.leaseToken,
        outcome: 'indeterminate',
      });
    this.settlements.clear();
    this.activationId = undefined;
    this.activeToolEvents.clear();
    this.assistantStream = undefined;
    this.uiChangeListeners.clear();
    return values;
  }

  private liveActivation(): ActivationRecord | undefined {
    return Object.values(this.store.snapshot().activations).find(
      (activation) => activation.agentId === this.agentId && activation.state === 'running',
    );
  }

  private currentActivation(): ActivationRecord | undefined {
    const selected = this.activationId ? this.store.snapshot().activations[this.activationId] : undefined;
    return selected && !terminal(selected) ? selected : this.liveActivation();
  }

  private assertOpen(): void {
    if (this.closing)
      throw new SchedulerStateError('manager_closed', `${LUMINARIES_IDENTITY.label} root runtime is closing`);
  }

  private captureEvent(event: unknown): boolean {
    this.assistantStream = applyAssistantStreamEvent(this.assistantStream, event).state;
    if (isRecord(event)) {
      if (
        (event.type === 'tool_execution_start' || event.type === 'tool_execution_update') &&
        typeof event.toolCallId === 'string'
      )
        // RPC events are freshly parsed per frame and never mutated downstream.
        this.activeToolEvents.set(event.toolCallId, event);
      else if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string')
        this.activeToolEvents.delete(event.toolCallId);
      else if (event.type === 'agent_settled' || event.type === 'agent_end') {
        this.activeToolEvents.clear();
        this.assistantStream = undefined;
      }
    }
    for (const listener of this.uiChangeListeners) listener(event);
    return this.boundaries.captureEvent(event);
  }
}
