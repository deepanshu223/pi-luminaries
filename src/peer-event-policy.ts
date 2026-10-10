import { randomUUID } from 'node:crypto';
import {
  TERMINAL_PEER_EVENT_STATUSES,
  SchedulerStateError,
  agentRuntimeState,
  beginMailboxAttemptState,
  consumeMailboxAtBoundaryState,
  discardActivationBeforeWriteState,
  finishActivationState,
  peerMailboxRecord,
  peerMailboxRecords,
  id,
  isRecord,
  isStartingInputEvent,
  isStrictAncestor,
  nonemptyText,
  releaseMailboxAttemptState,
  requestStatus,
  sha256,
  startActivationState,
  terminalizeMailboxRecordState,
  nextSequence,
  text,
  type ActivationRecord,
  type ActivationState,
  type PeerDeliveryKind,
  type PeerEventKind,
  type PeerEventMode,
  type PeerEventRecord,
  type RequestResolutionCode,
  type SchedulerState,
} from './scheduler-state.ts';
import { automaticCausesForActivation, directInputBoundarySeq, directOriginForActivation } from './causal-policy.ts';
import { formatPeerPrompt, peerPresentationDetails, peerSource } from './peer-prompt.ts';
import { hasDirectInputFence } from './direct-control-policy.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

const RESERVED_AGENT_BRIDGE_PREFIXES = [
  `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}resolution-`,
  `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}cancel-`,
  `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}timeout-`,
] as const;

export interface PeerEventAuth {
  agentId: string;
  rootId: string;
  runtimeOwner: string;
  origin?: 'agent' | 'operator' | 'service';
}
export interface PeerEventRequest {
  bridgeRequestId: string;
  recipientId: string;
  message: string;
  mode?: PeerEventMode;
  targetRootId?: string;
  causationId?: string;
}
export interface NormalizedPeerEventRequest {
  bridgeRequestId: string;
  recipientId: string;
  message: string;
  mode: PeerEventMode;
  targetRootId?: string;
  payloadBytes: number;
  requestHash: string;
  kind: PeerEventKind;
  requestId?: string;
  traceId?: string;
  causationId?: string;
  deadlineAtMs?: number;
}
export interface SchedulerCorrelatedEventInput {
  bridgeRequestId: string;
  kind: 'resolution' | 'cancel';
  requestId: string;
  senderId: string;
  recipientId: string;
  message: string;
  traceId: string;
  causationId: string;
  mode: PeerEventMode;
  resolutionCode?: RequestResolutionCode;
}
export interface PeerRouteReceipt {
  event: PeerEventRecord;
  duplicate: boolean;
  disposition: 'woken' | 'steered' | 'follow_up_queued' | 'notify_only' | 'refused';
}
export interface PeerDispatchPlan {
  eventId: string;
  attemptId: string;
  recipientId: string;
  senderId: string;
  traceId: string;
  deliveryKind: PeerDeliveryKind;
  activationId: string;
  activationLeaseToken: string;
  targetRuntimeOwner: string;
  prompt: string;
  payloadHash: string;
  source: string;
  correlationId?: string;
  startingInput: boolean;
  presentationLines: readonly string[];
  presentationContent: string;
  /** Human-rendering kind for this delivery: system mechanics stay muted; everything else shows full text. */
  presentation: 'message' | 'notice';
}
export interface PeerEventPolicyResult<T> {
  changed: boolean;
  value: T;
}

export function routeReceipt(
  state: Readonly<SchedulerState>,
  event: PeerEventRecord,
  duplicate: boolean,
): PeerRouteReceipt {
  let disposition: PeerRouteReceipt['disposition'];
  if (event.status === 'refused') disposition = 'refused';
  else if (event.mode === 'notify_only') disposition = 'notify_only';
  else if (event.mode === 'follow_up') disposition = 'follow_up_queued';
  else if (event.targetActivationId) disposition = 'steered';
  else if (event.deliveryKind === 'steer') disposition = 'steered';
  else if (event.deliveryKind === 'wake') disposition = 'woken';
  else {
    const runningAtAdmission = Object.values(state.activations).some(
      (activation) =>
        activation.agentId === event.recipientId &&
        activation.startedSeq < event.acceptedSeq &&
        (activation.terminalSeq === undefined || activation.terminalSeq > event.acceptedSeq),
    );
    disposition = runningAtAdmission ? 'steered' : 'woken';
  }
  return { event, duplicate, disposition };
}

export function normalizePeerEventRequest(input: PeerEventRequest): NormalizedPeerEventRequest {
  if (!isRecord(input)) throw new SchedulerStateError('input_invalid', 'Peer event request must be an object');
  for (const key of Object.keys(input))
    if (!['bridgeRequestId', 'recipientId', 'message', 'mode', 'targetRootId', 'causationId'].includes(key))
      throw new SchedulerStateError('input_invalid', `Peer event request contains unknown field '${key}'`);
  return normalizePeerEventEnvelope({ ...input, kind: 'message' });
}
export function normalizePeerEventEnvelope(
  input: PeerEventRequest & {
    kind: Exclude<PeerEventKind, 'resolution'>;
    requestId?: string;
    traceId?: string;
    causationId?: string;
    deadlineAtMs?: number;
  },
): NormalizedPeerEventRequest {
  const bridgeRequestId = id(input.bridgeRequestId, 'bridgeRequestId');
  const recipientId = id(input.recipientId, 'recipientId');
  const message = nonemptyText(input.message, 'message');
  const payloadBytes = Buffer.byteLength(message);
  const mode = input.mode ?? 'default';
  if (mode !== 'default' && mode !== 'follow_up' && mode !== 'notify_only')
    throw new SchedulerStateError('input_invalid', `Peer event mode '${String(mode)}' is invalid`);
  if (input.kind !== 'message' && input.kind !== 'request' && input.kind !== 'reply' && input.kind !== 'cancel')
    throw new SchedulerStateError('input_invalid', 'Peer event kind is invalid');
  const requestId = input.requestId === undefined ? undefined : id(input.requestId, 'requestId');
  if ((input.kind === 'message' && requestId) || (input.kind !== 'message' && !requestId))
    throw new SchedulerStateError('input_invalid', 'Peer event request correlation is invalid');
  const traceId = input.traceId === undefined ? undefined : id(input.traceId, 'traceId');
  const causationId = input.causationId === undefined ? undefined : id(input.causationId, 'causationId');
  if (traceId !== undefined && causationId === undefined)
    throw new SchedulerStateError('input_invalid', 'An inherited trace requires immediate causation');
  if (
    input.deadlineAtMs !== undefined &&
    (input.kind !== 'request' || !Number.isSafeInteger(input.deadlineAtMs) || input.deadlineAtMs < 1)
  )
    throw new SchedulerStateError('input_invalid', 'deadlineAtMs is invalid');
  const targetRootId = input.targetRootId === undefined ? undefined : id(input.targetRootId, 'targetRootId');
  const requestHash = sha256(
    JSON.stringify({
      recipientId,
      message,
      mode,
      targetRootId: targetRootId ?? null,
      kind: input.kind,
      requestId: requestId ?? null,
      traceId: traceId ?? null,
      causationId: causationId ?? null,
      deadlineAtMs: input.deadlineAtMs ?? null,
    }),
  );
  return {
    bridgeRequestId,
    recipientId,
    message,
    mode,
    targetRootId,
    payloadBytes,
    requestHash,
    kind: input.kind,
    requestId,
    traceId,
    causationId,
    deadlineAtMs: input.deadlineAtMs,
  };
}

export function acceptPeerEventState(
  state: SchedulerState,
  auth: PeerEventAuth,
  request: NormalizedPeerEventRequest,
  allocateEventId: () => string,
  _structural = false,
  expectedRecipientActivationId?: string,
  afterControlId?: string,
): PeerEventPolicyResult<PeerRouteReceipt> {
  const senderId = id(auth.agentId, 'authenticated.agentId');
  const rootId = id(auth.rootId, 'authenticated.rootId');
  const runtimeOwner = id(auth.runtimeOwner, 'authenticated.runtimeOwner');
  const origin = auth.origin ?? 'agent';
  if (origin !== 'agent' && origin !== 'operator' && origin !== 'service')
    throw new SchedulerStateError('input_invalid', 'Authenticated event origin is invalid');
  if (RESERVED_AGENT_BRIDGE_PREFIXES.some((prefix) => request.bridgeRequestId.startsWith(prefix)))
    throw new SchedulerStateError('input_invalid', 'Agent bridge request ID uses a scheduler-reserved namespace');
  const duplicate = peerMailboxRecords(state).find((event) => event.bridgeRequestId === request.bridgeRequestId);
  if (duplicate) {
    if (
      duplicate.requestHash !== request.requestHash ||
      duplicate.senderId !== senderId ||
      rootId !== state.root.rootId ||
      duplicate.origin !== origin
    )
      throw new SchedulerStateError(
        'command_id_reuse',
        `Bridge request '${request.bridgeRequestId}' was already used for another immutable route`,
      );
    return { changed: false, value: routeReceipt(state, duplicate, true) };
  }
  const expectedActivationId =
    expectedRecipientActivationId && expectedRecipientActivationId !== request.recipientId
      ? id(expectedRecipientActivationId, 'expectedRecipientActivationId')
      : undefined;
  if (expectedRecipientActivationId === request.recipientId)
    throw new SchedulerStateError(
      'runtime_unavailable',
      `Collaborator '${request.recipientId}' no longer has the expected running turn`,
    );
  if (expectedActivationId) {
    const activation = state.activations[expectedActivationId];
    if (!activation || activation.state !== 'running' || activation.agentId !== request.recipientId)
      throw new SchedulerStateError(
        'runtime_unavailable',
        `Collaborator '${request.recipientId}' no longer has the expected running turn`,
      );
  }
  const sender = state.agents[senderId];
  if (!sender || rootId !== state.root.rootId || sender.lifecycle !== 'open')
    throw new SchedulerStateError(
      'sender_unavailable',
      `Authenticated sender '${senderId}' is not an open agent in this root`,
    );
  if (sender.parentId !== null && (sender.runtimeOwner !== runtimeOwner || sender.runtimePhase !== 'ready'))
    throw new SchedulerStateError(
      'sender_runtime_stale',
      `Authenticated sender '${senderId}' does not own a ready runtime`,
    );
  const sourceActivation =
    origin === 'agent'
      ? Object.values(state.activations).find(
          (activation) => activation.agentId === senderId && activation.state === 'running',
        )
      : undefined;
  if (origin === 'agent' && !sourceActivation)
    throw new SchedulerStateError(
      'sender_activation_missing',
      `Authenticated sender '${senderId}' has no live actor activation`,
    );
  if (origin !== 'agent' && senderId !== state.root.rootId)
    throw new SchedulerStateError(
      'authority_denied',
      `External event origins must act through the ${LUMINARIES_IDENTITY.label} root`,
    );

  const targetRootId = request.targetRootId ?? rootId;
  const recipient = state.agents[request.recipientId];
  let refusal: string | undefined;
  if (targetRootId !== rootId) refusal = 'cross_root_denied';
  else if (!recipient) refusal = 'recipient_missing';
  else if (request.kind === 'request' && recipient.agentId === senderId) refusal = 'self_request_denied';
  else if (recipient.lifecycle !== 'open') refusal = 'recipient_closed';
  else if (
    request.mode === 'follow_up' &&
    !Object.values(state.activations).some(
      (activation) => activation.agentId === recipient.agentId && activation.state === 'running',
    )
  )
    refusal = 'runtime_unavailable';

  let causationId = request.causationId;
  let traceId = request.traceId;
  const automaticCauses = sourceActivation ? automaticCausesForActivation(state, sourceActivation) : [];
  const directOrigin = sourceActivation ? directOriginForActivation(state, sourceActivation) : undefined;
  if (!causationId && sourceActivation) {
    const implicit = automaticCauses.at(-1) ?? directOrigin;
    causationId = implicit?.eventId;
    traceId = implicit?.traceId;
  }
  if (causationId) {
    const cause = peerMailboxRecord(state, causationId);
    const correlationCarriesCausation = request.kind === 'reply' || request.kind === 'cancel';
    const emittedMulticastCause =
      cause?.senderId === senderId &&
      cause.traceId === traceId &&
      (origin !== 'agent' ? cause.origin === origin : cause.sourceActivationId === sourceActivation?.activationId);
    const eligibleLiveCause =
      automaticCauses.some((candidate) => candidate.eventId === causationId) || directOrigin?.eventId === causationId;
    if (!cause || (!correlationCarriesCausation && !emittedMulticastCause && (!sourceActivation || !eligibleLiveCause)))
      throw new SchedulerStateError(
        'causation_invalid',
        `Causation event '${causationId}' is outside agent '${senderId}' current activation`,
      );
    if (traceId && cause.traceId !== traceId)
      throw new SchedulerStateError('causation_invalid', 'Inherited peer event causation does not match its trace');
    traceId ??= cause.traceId;
  }

  if (causationId) {
    if (!traceId) throw new SchedulerStateError('causation_invalid', 'Inherited peer event has no trace');
    const inheritedTraceId = traceId;
    const cause = peerMailboxRecord(state, causationId);
    if (!cause || cause.traceId !== inheritedTraceId)
      throw new SchedulerStateError('causation_invalid', 'Inherited peer event causation is invalid');
  }
  if (!causationId && sourceActivation && directInputBoundarySeq(state, sourceActivation) === undefined)
    throw new SchedulerStateError(
      'causation_required',
      `Activation '${sourceActivation.activationId}' cannot originate automatic work`,
    );
  const acceptedAtMs = Date.now();
  const eventId = id(allocateEventId(), 'allocated eventId');
  if (peerMailboxRecord(state, eventId))
    throw new SchedulerStateError('event_exists', `Peer event '${eventId}' already exists`);
  traceId ??= eventId;
  const event: PeerEventRecord = {
    lane: origin === 'agent' ? 'peer' : origin,
    eventId,
    bridgeRequestId: request.bridgeRequestId,
    requestHash: request.requestHash,
    origin,
    senderId,
    recipientId: request.recipientId,
    traceId,
    causationId,
    ...(sourceActivation ? { sourceActivationId: sourceActivation.activationId } : {}),
    ...(expectedActivationId ? { targetActivationId: expectedActivationId } : afterControlId ? { afterControlId } : {}),
    kind: request.kind,
    requestId: request.requestId,
    mode: request.mode,
    payloadHash: sha256(request.message),
    payloadBytes: request.payloadBytes,
    status: 'accepted',
    acceptedSeq: state.nextSeq,
    acceptedAtMs,
    message: request.message,
  };
  const seq = nextSequence(state);
  event.status = refusal ? 'refused' : request.mode === 'notify_only' ? 'settled' : 'accepted';
  if (refusal) {
    delete event.message;
    event.terminalSeq = seq;
    event.outcomeCode = refusal;
  } else {
    if (request.mode === 'notify_only') {
      event.terminalSeq = seq;
      event.outcomeCode = 'notify_only';
    } else {
      if (!recipient)
        throw new SchedulerStateError('state_invalid', 'Admitted peer event lost its validated recipient');
    }
  }
  state.mailbox[eventId] = event;
  return { changed: true, value: routeReceipt(state, event, false) };
}

/** Scheduler-originated request resolution/cancellation. It never accepts child-supplied identity. */
export function acceptSchedulerCorrelatedEventState(
  state: SchedulerState,
  input: SchedulerCorrelatedEventInput,
  allocateEventId: () => string,
): PeerEventPolicyResult<PeerRouteReceipt> {
  const bridgeRequestId = id(input.bridgeRequestId, 'scheduler bridgeRequestId');
  const requestId = id(input.requestId, 'scheduler requestId');
  const senderId = id(input.senderId, 'scheduler senderId');
  const recipientId = id(input.recipientId, 'scheduler recipientId');
  const traceId = id(input.traceId, 'scheduler traceId');
  const causationId = id(input.causationId, 'scheduler causationId');
  const message = nonemptyText(input.message, 'scheduler message');
  const payloadBytes = Buffer.byteLength(message);
  if (input.kind !== 'resolution' && input.kind !== 'cancel')
    throw new SchedulerStateError('input_invalid', 'Scheduler correlated event kind is invalid');
  if (input.mode !== 'default' && input.mode !== 'follow_up' && input.mode !== 'notify_only')
    throw new SchedulerStateError('input_invalid', 'Scheduler correlated event mode is invalid');
  if ((input.kind === 'resolution') !== !!input.resolutionCode)
    throw new SchedulerStateError('input_invalid', 'Scheduler resolution code is inconsistent');
  const duplicate = peerMailboxRecords(state).find((event) => event.bridgeRequestId === bridgeRequestId);
  const requestHash = sha256(
    JSON.stringify({
      origin: 'scheduler',
      senderId,
      recipientId,
      traceId,
      causationId,
      kind: input.kind,
      requestId,
      resolutionCode: input.resolutionCode ?? null,
      message,
      mode: input.mode,
    }),
  );
  if (duplicate) {
    if (duplicate.requestHash !== requestHash || duplicate.origin !== 'scheduler')
      throw new SchedulerStateError(
        'command_id_reuse',
        `Scheduler event '${bridgeRequestId}' was already used for another immutable route`,
      );
    return { changed: false, value: routeReceipt(state, duplicate, true) };
  }
  const sender = state.agents[senderId];
  const recipient = state.agents[recipientId];
  const cause = peerMailboxRecord(state, causationId);
  if (!sender || !recipient || !cause || cause.traceId !== traceId)
    throw new SchedulerStateError('state_invalid', 'Scheduler correlated event references unavailable causal state');
  if (input.mode === 'default' && recipient.lifecycle !== 'open')
    throw new SchedulerStateError('recipient_closed', `Scheduler resolution recipient '${recipientId}' is closed`);
  const eventId = id(allocateEventId(), 'allocated scheduler eventId');
  const seq = nextSequence(state);
  const event: PeerEventRecord = {
    lane: 'system',
    eventId,
    bridgeRequestId,
    requestHash,
    origin: 'scheduler',
    senderId,
    recipientId,
    traceId,
    causationId,
    kind: input.kind,
    requestId,
    resolutionCode: input.resolutionCode,
    mode: input.mode,
    message,
    payloadHash: sha256(message),
    payloadBytes,
    status: input.mode === 'notify_only' ? 'settled' : 'accepted',
    acceptedSeq: seq,
    acceptedAtMs: Date.now(),
  };
  if (input.mode === 'notify_only') {
    event.terminalSeq = seq;
    event.outcomeCode = 'notify_only';
  }
  state.mailbox[eventId] = event;
  return { changed: true, value: routeReceipt(state, event, false) };
}

export function beginPeerDeliveryState(
  state: SchedulerState,
  eventId: string,
  targetRuntimeOwner: string,
): PeerEventPolicyResult<PeerDispatchPlan | undefined> {
  const event = peerMailboxRecord(state, eventId);
  if (!event) throw new SchedulerStateError('event_missing', `Peer event '${eventId}' does not exist`);
  if (event.status !== 'accepted') return { changed: false, value: undefined };
  const recipient = state.agents[event.recipientId];
  if (!recipient || recipient.lifecycle !== 'open')
    throw new SchedulerStateError('recipient_unavailable', `Peer event recipient '${event.recipientId}' is not open`);
  if (
    recipient.parentId !== null &&
    (recipient.runtimeOwner !== targetRuntimeOwner || recipient.runtimePhase !== 'ready')
  )
    throw new SchedulerStateError(
      'runtime_owner',
      `Peer event recipient '${event.recipientId}' runtime owner does not match`,
    );
  if (recipient.pendingConfiguration) return { changed: false, value: undefined };
  if (hasDirectInputFence(state, event.recipientId)) return { changed: false, value: undefined };
  if (event.afterControlId) {
    const control = state.mailbox[event.afterControlId];
    if (!control || control.lane !== 'direct' || control.status !== 'aborted')
      return { changed: false, value: undefined };
  }
  if (event.targetActivationId) {
    const intended = state.activations[event.targetActivationId];
    if (!intended || intended.agentId !== event.recipientId || intended.state !== 'running') {
      terminalizeMailboxRecordState(state, event, 'refused', 'target_activation_unavailable');
      return { changed: true, value: undefined };
    }
    const deliveryKind = event.mode === 'follow_up' ? 'follow_up' : 'steer';
    beginMailboxAttemptState(state, [event], {
      attemptId: randomUUID(),
      activationId: intended.activationId,
      deliveryKind,
    });
    return { changed: true, value: planFor(state, event, targetRuntimeOwner) };
  }
  const queue = eligiblePeerEventsForRecipient(state, event.recipientId);
  if (queue[0]?.eventId !== event.eventId) return { changed: false, value: undefined };
  const live = Object.values(state.activations).find(
    (candidate) => candidate.agentId === recipient.agentId && candidate.state === 'running',
  );
  const runtimeState = agentRuntimeState(state, recipient);
  let activation: ActivationRecord | undefined;
  let deliveryKind: PeerDeliveryKind | undefined;
  if (event.afterControlId) {
    activation = startActivationState(state, recipient.agentId, 'peer_event').value;
    deliveryKind = 'wake';
  } else if (runtimeState === 'running' && correlatedOutcomeMustWaitForOrigin(state, event))
    return { changed: false, value: undefined };
  const selected = queue[0];
  if (!selected) return { changed: false, value: undefined };
  const batch = [selected];
  if (!event.afterControlId && (runtimeState === 'idle' || runtimeState === 'waiting')) {
    activation = startActivationState(state, recipient.agentId, 'peer_event').value;
    deliveryKind = 'wake';
  } else if (!event.afterControlId && runtimeState === 'running' && selected.mode === 'follow_up') {
    if (live?.state !== 'running') return { changed: false, value: undefined };
    activation = live;
    deliveryKind = 'follow_up';
  } else if (!event.afterControlId && runtimeState === 'running') {
    if (live?.state !== 'running') return { changed: false, value: undefined };
    activation = live;
    deliveryKind = 'steer';
  } else if (!event.afterControlId) return { changed: false, value: undefined };
  if (!activation || !deliveryKind) return { changed: false, value: undefined };
  beginMailboxAttemptState(state, batch, {
    attemptId: randomUUID(),
    activationId: activation.activationId,
    deliveryKind,
  });
  return { changed: true, value: planFor(state, event, targetRuntimeOwner) };
}

export function requeuePeerEventBeforeWriteState(
  state: SchedulerState,
  eventId: string,
  attemptId: string,
): PeerEventPolicyResult<PeerEventRecord> & { discardedWakeActivation?: ActivationRecord } {
  const event = attemptedEvent(state, eventId, attemptId);
  const activation = requiredDeliveryActivation(state, event);
  const ownsActivation = event.deliveryKind === 'wake' && activation.nativeInputSeq === undefined;
  const batch = deliveryBatch(state, event);
  if (batch.some((candidate) => candidate.consumedSeq !== undefined)) {
    for (const candidate of batch)
      terminalizeMailboxRecordState(state, candidate, 'indeterminate', 'prewrite_failure_after_model_boundary');
    if (ownsActivation && activation.state === 'running')
      finishActivationState(state, activation.activationId, activation.leaseToken, 'indeterminate');
    return { changed: true, value: event };
  }
  releaseMailboxAttemptState(state, batch, attemptId);
  const discardedWakeActivation = ownsActivation && activation.state === 'running' ? activation : undefined;
  if (discardedWakeActivation) discardActivationBeforeWriteState(state, activation.activationId, activation.leaseToken);
  return {
    changed: true,
    value: event,
    ...(discardedWakeActivation ? { discardedWakeActivation } : {}),
  };
}

export function admitPeerAtModelBoundaryState(
  state: SchedulerState,
  eventId: string,
  attemptId: string,
): PeerEventPolicyResult<PeerEventRecord[]> {
  const event = attemptedEvent(state, eventId, attemptId);
  const batch = deliveryBatch(state, event);
  if (batch.every((candidate) => candidate.consumedSeq !== undefined)) return { changed: false, value: batch };
  if (batch.some((candidate) => candidate.consumedSeq !== undefined))
    throw new SchedulerStateError(
      'event_transition',
      `Peer steer batch '${event.activationId}' has partial model-boundary consumption`,
    );
  const result = consumeMailboxAtBoundaryState(state, batch, attemptId);
  return { changed: result.changed, value: batch };
}

export function settleQueuedPeerEventNotifyState(
  state: SchedulerState,
  eventId: string,
  code: string,
): PeerEventPolicyResult<PeerEventRecord> {
  const event = peerMailboxRecord(state, eventId);
  if (!event || event.status !== 'accepted')
    throw new SchedulerStateError('event_transition', `Peer event '${eventId}' is not safely waiting before dispatch`);
  event.mode = 'notify_only';
  return terminalizeMailboxRecordState(state, event, 'settled', text(code, 'peer notify outcome code', 64));
}

export function finishPeerDeliveryState(
  state: SchedulerState,
  eventId: string,
  attemptId: string,
  outcome: 'refused' | 'failed' | 'indeterminate',
  code: string,
): PeerEventPolicyResult<PeerEventRecord[]> {
  const event = attemptedEvent(state, eventId, attemptId);
  const terminal = deliveryBatch(state, event).map(
    (candidate) =>
      terminalizeMailboxRecordState(state, candidate, outcome, text(code, 'peer steer outcome code', 64)).value,
  );
  return { changed: true, value: terminal };
}

export function preparePeerEventsForActivationFinishState(
  state: SchedulerState,
  activationId: string,
  outcome: Exclude<ActivationState, 'running'>,
): PeerEventRecord[] {
  const terminal: PeerEventRecord[] = [];
  for (const event of peerMailboxRecords(state)) {
    if (event.mode === 'follow_up' && event.status === 'accepted' && event.targetActivationId === activationId) {
      delete event.targetActivationId;
      continue;
    }
    if (event.activationId !== activationId || TERMINAL_PEER_EVENT_STATUSES.has(event.status)) continue;
    const batch = deliveryBatch(state, event);
    const consumed = batch.every((candidate) => candidate.consumedSeq !== undefined);
    const status =
      outcome === 'settled'
        ? consumed
          ? 'settled'
          : 'failed'
        : outcome === 'indeterminate'
          ? 'indeterminate'
          : outcome;
    const code =
      outcome === 'settled'
        ? consumed
          ? 'recipient_settled_after_peer_consumption'
          : 'peer_input_not_observed_at_model_boundary'
        : consumed
          ? `recipient_${outcome}_after_peer_consumption`
          : `recipient_${outcome}_before_peer_consumption`;
    for (const candidate of batch) terminal.push(terminalizeMailboxRecordState(state, candidate, status, code).value);
  }
  return terminal;
}

export function reconcilePeerEventState(
  state: SchedulerState,
  eventId: string,
): PeerEventPolicyResult<PeerEventRecord> {
  const event = peerMailboxRecord(state, eventId);
  if (!event) throw new SchedulerStateError('event_missing', `Peer event '${eventId}' does not exist`);
  if (TERMINAL_PEER_EVENT_STATUSES.has(event.status) || event.status === 'accepted')
    return { changed: false, value: event };
  const activation = requiredDeliveryActivation(state, event);
  const batch = deliveryBatch(state, event);
  const ownsActivation = event.deliveryKind === 'wake';
  for (const candidate of batch)
    terminalizeMailboxRecordState(state, candidate, 'indeterminate', 'dispatch_unconfirmed_after_restart');
  if (ownsActivation && activation.state === 'running')
    finishActivationState(state, activation.activationId, activation.leaseToken, 'indeterminate');
  return { changed: true, value: event };
}

export function closeQueuedPeerEventsState(
  state: SchedulerState,
  closedAgentIds: readonly string[],
): PeerEventRecord[] {
  const closed = new Set(closedAgentIds);
  const terminal: PeerEventRecord[] = [];
  for (const event of peerMailboxRecords(state)) {
    if (event.status !== 'accepted' && event.status !== 'sending' && event.status !== 'consumed') continue;
    const targetClosed = closed.has(event.recipientId);
    const ownerClosedSource =
      event.status !== 'consumed' &&
      closed.has(event.senderId) &&
      isStrictAncestor(state, event.recipientId, event.senderId);
    if (!targetClosed && !ownerClosedSource) continue;
    if (ownerClosedSource && !targetClosed && event.origin === 'system' && event.systemType === 'health_attention') {
      terminal.push(terminalizeMailboxRecordState(state, event, 'aborted', 'health_notice_source_closed').value);
      continue;
    }
    const inFlight = event.status === 'sending' || event.status === 'consumed';
    terminal.push(
      terminalizeMailboxRecordState(
        state,
        event,
        inFlight ? 'indeterminate' : 'failed',
        inFlight
          ? 'close_delivery_boundary_indeterminate'
          : targetClosed
            ? 'target_closed_before_delivery'
            : 'source_closed_before_owner_delivery',
      ).value,
    );
  }
  for (const activation of Object.values(state.activations)) {
    if (activation.state !== 'running' || !closed.has(activation.agentId)) continue;
    finishActivationState(state, activation.activationId, activation.leaseToken, 'indeterminate');
  }
  return terminal;
}

function correlatedOutcomeMustWaitForOrigin(state: SchedulerState, event: PeerEventRecord): boolean {
  if ((event.kind !== 'reply' && event.kind !== 'resolution') || !event.requestId) return false;
  const request = state.requests[event.requestId];
  if (!request || requestStatus(state, request) !== 'pending') return false;
  const origin = peerMailboxRecord(state, request.requestEventId);
  const source = origin?.sourceActivationId ? state.activations[origin.sourceActivationId] : undefined;
  return source?.state === 'running';
}

function lanePriority(event: PeerEventRecord): number {
  if (event.lane === 'operator') return 0;
  if (event.lane === 'service') return 1;
  if (event.lane === 'system') return 2;
  return 3;
}

export function eligiblePeerEventsForRecipient(state: SchedulerState, recipientId: string): PeerEventRecord[] {
  const hasRunningTurn = Object.values(state.activations).some(
    (activation) => activation.agentId === recipientId && activation.state === 'running',
  );
  return peerMailboxRecords(state)
    .filter((event) => event.recipientId === recipientId && event.status === 'accepted')
    .sort(
      (left, right) =>
        Number(isStartingInputEvent(state, right)) - Number(isStartingInputEvent(state, left)) ||
        Number(left.mode === 'follow_up' && !hasRunningTurn) - Number(right.mode === 'follow_up' && !hasRunningTurn) ||
        lanePriority(left) - lanePriority(right) ||
        left.acceptedSeq - right.acceptedSeq,
    );
}

function deliveryBatch(state: SchedulerState, event: PeerEventRecord): PeerEventRecord[] {
  const attemptId = event.attemptId;
  if (!attemptId)
    throw new SchedulerStateError('state_invalid', `Peer event '${event.eventId}' has no delivery attempt`);
  return peerMailboxRecords(state)
    .filter((candidate) => candidate.recipientId === event.recipientId && candidate.attemptId === attemptId)
    .sort((left, right) => left.acceptedSeq - right.acceptedSeq);
}
function attemptedEvent(state: SchedulerState, eventId: string, attemptId: string): PeerEventRecord {
  const event = peerMailboxRecord(state, eventId);
  if (!event) throw new SchedulerStateError('event_missing', `Peer event '${eventId}' does not exist`);
  if (event.attemptId !== attemptId)
    throw new SchedulerStateError('event_attempt', `Peer event '${eventId}' attempt identity is invalid`);
  if (event.status !== 'sending' && event.status !== 'consumed')
    throw new SchedulerStateError('event_transition', `Peer event '${eventId}' cannot transition from ${event.status}`);
  return event;
}
function requiredDeliveryActivation(state: SchedulerState, event: PeerEventRecord): ActivationRecord {
  const activationId = event.activationId;
  if (!activationId)
    throw new SchedulerStateError('state_invalid', `Peer event '${event.eventId}' has no delivery activation`);
  const activation = state.activations[activationId];
  if (!activation)
    throw new SchedulerStateError('state_invalid', `Peer event '${event.eventId}' delivery activation is missing`);
  return activation;
}

function planFor(state: SchedulerState, event: PeerEventRecord, targetRuntimeOwner: string): PeerDispatchPlan {
  const activation = requiredDeliveryActivation(state, event);
  const attemptId = event.attemptId;
  const eventMessage = event.message;
  const deliveryKind = event.deliveryKind;
  if (!attemptId || eventMessage === undefined || !event.payloadHash || !deliveryKind)
    throw new SchedulerStateError('state_invalid', `Peer event '${event.eventId}' has incomplete dispatch fields`);
  const events = deliveryBatch(state, event);
  const prompt = isStartingInputEvent(state, event) ? eventMessage : formatPeerPrompt(events, state);
  const presentation = peerPresentationDetails(events, state);
  return {
    eventId: event.eventId,
    attemptId,
    recipientId: event.recipientId,
    senderId: event.senderId,
    traceId: event.traceId,
    deliveryKind,
    activationId: activation.activationId,
    activationLeaseToken: activation.leaseToken,
    targetRuntimeOwner,
    prompt,
    payloadHash: event.payloadHash,
    source: peerSource(event, state),
    ...(event.requestId ? { correlationId: event.requestId } : {}),
    startingInput: isStartingInputEvent(state, event),
    presentationLines: presentation.lines,
    presentationContent: presentation.content,
    presentation: event.origin === 'system' || event.origin === 'scheduler' ? 'notice' : 'message',
  };
}
