import { randomUUID } from 'node:crypto';
import {
  SchedulerStateError,
  agentRuntimeState,
  agentSeq,
  id,
  idList,
  isStrictAncestor,
  peerMailboxRecord,
  peerMailboxRecords,
  nextSequence,
  requestSeq,
  requestStatus,
  sha256,
  type PeerEventKind,
  type PeerEventRecord,
  type SchedulerPrincipal,
  type SchedulerState,
  type WatchRecord,
} from './scheduler-state.ts';
import { acceptSystemEventState } from './system-event-policy.ts';
import type { PeerEventPolicyResult } from './peer-event-policy.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { automaticCausesForActivation, directOriginForActivation } from './causal-policy.ts';
import { deriveAgentHandles } from './agent-identity.ts';

const EVENT_KINDS = new Set<PeerEventKind>(['message', 'request', 'reply', 'cancel', 'resolution', 'system']);

export interface WatchInput {
  watchId: string;
  requestIds?: readonly string[];
  agentIds?: readonly string[];
  eventKinds?: readonly PeerEventKind[];
  owned?: boolean;
  registeringActivationId?: string;
  causalInputs?: readonly string[];
}

function ownerId(state: SchedulerState, principal: SchedulerPrincipal): string {
  return principal.kind === 'operator' ? state.root.rootId : id(principal.agentId, 'watch owner');
}

function authorized(state: SchedulerState, owner: string, target: string): boolean {
  return owner === target || isStrictAncestor(state, owner, target);
}

function ownedTarget(state: SchedulerState, owner: string, target: string): boolean {
  return owner === target || isStrictAncestor(state, owner, target);
}

function normalizeKinds(values: readonly PeerEventKind[] | undefined): PeerEventKind[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => !EVENT_KINDS.has(value)))
    throw new SchedulerStateError('input_invalid', 'Watch event kinds are invalid');
  return [...new Set(values)];
}

function assertWatchAuthority(state: SchedulerState, watch: WatchRecord): void {
  for (const requestId of watch.requestIds ?? []) {
    const request = state.requests[requestId];
    if (!request)
      throw new SchedulerStateError(
        'request_missing',
        `Request '${requestId}' is no longer active or is unavailable. Inspect incoming replies and current activity before waiting again.`,
      );
    if (
      !authorized(state, watch.ownerId, request.requesterId) &&
      !authorized(state, watch.ownerId, request.recipientId)
    )
      throw new SchedulerStateError(
        'authority_denied',
        `Await only requests you created or descendants you own; finish this turn and let incoming messages wake you`,
      );
  }
  for (const agentId of watch.agentIds ?? [])
    if (!state.agents[agentId] || !authorized(state, watch.ownerId, agentId))
      throw new SchedulerStateError(
        'authority_denied',
        `Await only requests you created or descendants you own; finish this turn and let incoming messages wake you`,
      );
}

export function registerWatchState(
  state: SchedulerState,
  input: WatchInput,
  principal: SchedulerPrincipal,
  allocateEventId: () => string = randomUUID,
): PeerEventPolicyResult<WatchRecord> {
  const watchId = id(input.watchId, 'watchId');
  const owner = ownerId(state, principal);
  const requestIds = idList(input.requestIds ?? [], 'watch.requestIds');
  const agentIds = idList(input.agentIds ?? [], 'watch.agentIds');
  const eventKinds = normalizeKinds(input.eventKinds);
  const owned = input.owned === true;
  if (owned && !Object.values(state.agents).some((agent) => isStrictAncestor(state, owner, agent.agentId)))
    throw new SchedulerStateError(
      'authority_denied',
      `You have no descendants to await; finish this turn and let incoming messages wake you`,
    );
  if (!requestIds.length && !agentIds.length && !eventKinds.length && !owned)
    throw new SchedulerStateError(
      'input_invalid',
      `A ${LUMINARIES_IDENTITY.label} watch needs at least one request, agent, event-kind, or owned:true selector`,
    );
  const registeringActivationId =
    input.registeringActivationId === undefined
      ? undefined
      : id(input.registeringActivationId, 'watch registeringActivationId');
  if (registeringActivationId) {
    const activation = state.activations[registeringActivationId];
    if (!activation || activation.agentId !== owner)
      throw new SchedulerStateError('authority_denied', 'Watch registration activation is not owned by its caller');
  }
  const registeringActivation = registeringActivationId ? state.activations[registeringActivationId] : undefined;
  const directOrigin = registeringActivation ? directOriginForActivation(state, registeringActivation) : undefined;
  const inferredCausalInputs = registeringActivation
    ? [...automaticCausesForActivation(state, registeringActivation), ...(directOrigin ? [directOrigin] : [])]
        .sort((left, right) => left.acceptedSeq - right.acceptedSeq)
        .map((event) => event.eventId)
    : [];
  const causalInputs = idList(input.causalInputs ?? inferredCausalInputs, 'watch.causalInputs');
  for (const eventId of causalInputs) {
    const event = peerMailboxRecord(state, eventId);
    if (!event) throw new SchedulerStateError('causation_invalid', `Watch input '${eventId}' is unavailable`);
    if (!authorized(state, owner, event.senderId) && !authorized(state, owner, event.recipientId))
      throw new SchedulerStateError('authority_denied', `Watch cannot retain causal input '${eventId}'`);
  }
  const requestHash = sha256(
    JSON.stringify({ requestIds, agentIds, eventKinds, owned, registeringActivationId, causalInputs }),
  );
  const existing = state.watches[watchId];
  if (existing) {
    if (existing.ownerId !== owner || existing.requestHash !== requestHash)
      throw new SchedulerStateError('command_id_reuse', `Watch '${watchId}' was reused`);
    return { changed: false, value: existing };
  }
  const seq = nextSequence(state);
  const watch: WatchRecord = {
    watchId,
    ownerId: owner,
    requestHash,
    requestIds,
    agentIds,
    eventKinds,
    owned,
    status: 'active',
    createdSeq: seq,
    createdAtMs: Date.now(),
    ...(registeringActivationId ? { registeringActivationId } : {}),
    causalInputs,
  };
  assertWatchAuthority(state, watch);
  state.watches[watchId] = watch;
  const triggered = triggerWatchIfReadyState(state, watchId, allocateEventId, false);
  return { changed: true, value: triggered.value ?? watch };
}

function matchingFacts(
  state: SchedulerState,
  watch: WatchRecord,
): { facts: string[]; cause: PeerEventRecord | undefined; foregroundMessageMatches: boolean } {
  const requestIds = watch.requestIds ?? [];
  const agentIds = watch.agentIds ?? [];
  const eventKinds = watch.eventKinds ?? [];
  const owned = watch.owned === true;
  const facts: string[] = [];
  const matchedEvents = new Map<string, PeerEventRecord>();
  const handles = deriveAgentHandles(
    Object.values(state.agents).map((agent) => ({ agentId: agent.agentId, displayName: agent.displayName.value })),
  );
  const laterEvents = peerMailboxRecords(state).filter(
    (event) =>
      event.acceptedSeq > watch.createdSeq &&
      event.systemType !== 'watch_activity' &&
      !(event.systemType === 'background_completion' && event.sourceActivationId === watch.registeringActivationId) &&
      (authorized(state, watch.ownerId, event.senderId) || authorized(state, watch.ownerId, event.recipientId)),
  );
  const ownedEvents = laterEvents.filter((event) => ownedTarget(state, watch.ownerId, event.senderId));
  const eligibleEvents = owned ? ownedEvents : laterEvents;
  const familyFacts: string[][] = [];
  const requestFacts: string[] = [];
  for (const requestId of requestIds) {
    const request = state.requests[requestId];
    const status = request ? requestStatus(state, request) : undefined;
    if (
      request &&
      requestSeq(state, request) > watch.createdSeq &&
      (!owned || ownedTarget(state, watch.ownerId, request.requesterId)) &&
      status !== 'pending'
    ) {
      requestFacts.push(`request ${requestId} is ${status}`);
      const terminal = request.terminalEventId ? peerMailboxRecord(state, request.terminalEventId) : undefined;
      if (terminal) matchedEvents.set(terminal.eventId, terminal);
      continue;
    }
    const event = eligibleEvents.find((candidate) => candidate.requestId === requestId);
    if (event) {
      requestFacts.push(`request ${requestId} has new activity`);
      matchedEvents.set(event.eventId, event);
    }
  }
  if (requestIds.length) familyFacts.push(requestFacts);
  const agentFacts: string[] = [];
  for (const agentId of agentIds) {
    const agent = state.agents[agentId];
    const handle = handles.get(agentId) ?? 'Selected collaborator';
    const runtimeState = agent ? agentRuntimeState(state, agent) : undefined;
    if (agent && agentSeq(state, agent) > watch.createdSeq) {
      if (agent.lifecycle === 'closed') agentFacts.push(`${handle} is closed`);
      else if (runtimeState === 'failed' || runtimeState === 'needs_attention')
        agentFacts.push(`${handle} needs attention`);
    }
    for (const event of eligibleEvents)
      if (event.senderId === agentId || event.recipientId === agentId) {
        agentFacts.push(`${handle} has new ${event.kind} activity`);
        matchedEvents.set(event.eventId, event);
      }
  }
  if (agentIds.length) familyFacts.push([...new Set(agentFacts)]);
  if (eventKinds.length) {
    const events = laterEvents
      .filter((event) => eligibleEvents.includes(event))
      .filter((event) => eventKinds.includes(event.kind));
    for (const event of events) matchedEvents.set(event.eventId, event);
    familyFacts.push(events.map((event) => `new ${event.kind} activity`));
  }
  if (owned) {
    for (const event of ownedEvents) matchedEvents.set(event.eventId, event);
    familyFacts.push(ownedEvents.map((event) => `owned ${event.kind} activity`));
  }
  if (familyFacts.some((family) => family.length === 0))
    return { facts: [], cause: undefined, foregroundMessageMatches: false };
  for (const family of familyFacts) facts.push(...family);
  const retained = (watch.causalInputs ?? [])
    .map((eventId) => peerMailboxRecord(state, eventId))
    .filter((event): event is PeerEventRecord => event !== undefined);
  const cause = [...matchedEvents.values(), ...retained]
    .sort((left, right) => left.acceptedSeq - right.acceptedSeq)
    .at(-1);
  const foregroundMessageMatches = eligibleEvents.some(
    (event) =>
      event.kind === 'message' &&
      event.recipientId === watch.ownerId &&
      event.mode !== 'notify_only' &&
      (event.status === 'accepted' || event.status === 'sending') &&
      (!requestIds.length || (!!event.requestId && requestIds.includes(event.requestId))) &&
      (!agentIds.length || agentIds.includes(event.senderId) || agentIds.includes(event.recipientId)) &&
      (!eventKinds.length || eventKinds.includes(event.kind)) &&
      (!owned || ownedTarget(state, watch.ownerId, event.senderId)),
  );
  return { facts, cause, foregroundMessageMatches };
}

interface ReadyWatch {
  watchId: string;
  facts: readonly string[];
  traceId: string;
  causationId: string;
  wake: boolean;
}

function triggerReadyWatchState(
  state: SchedulerState,
  ready: ReadyWatch,
  allocateEventId: () => string,
): PeerEventPolicyResult<WatchRecord | undefined> {
  const watch = state.watches[ready.watchId];
  if (!watch || watch.status !== 'active') return { changed: false, value: watch };
  const route = acceptSystemEventState(
    state,
    {
      dedupeKey: `watch:${watch.watchId}`,
      type: 'watch_activity',
      senderId: watch.ownerId,
      recipientId: watch.ownerId,
      message: `This wait has finished: ${ready.facts.join('; ')}`,
      wake: ready.wake,
      ...(watch.registeringActivationId ? { sourceActivationId: watch.registeringActivationId } : {}),
      traceId: ready.traceId,
      causationId: ready.causationId,
    },
    allocateEventId,
  ).value;
  const seq = nextSequence(state);
  watch.status = 'triggered';
  watch.triggerEventId = route.event.eventId;
  watch.terminalSeq = seq;
  contractTerminalWatch(watch);
  return { changed: true, value: watch };
}

export function resolveReadyWatchesState(
  state: SchedulerState,
  allocateEventId: () => string = randomUUID,
): readonly string[] {
  const ready: ReadyWatch[] = [];
  const active = Object.values(state.watches)
    .filter((watch) => watch.status === 'active')
    .sort((left, right) => left.createdSeq - right.createdSeq);
  const runningOwners = new Set(
    Object.values(state.activations)
      .filter((activation) => activation.state === 'running')
      .map((activation) => activation.agentId),
  );
  for (const watch of active) {
    const registration = watch.registeringActivationId ? state.activations[watch.registeringActivationId] : undefined;
    // A yielded turn owns its watch until another turn resumes it or the turn is interrupted.
    // Requests and watches registered independently of a turn retain their own lifetime.
    if (
      registration &&
      registration.state !== 'running' &&
      (registration.state !== 'settled' || runningOwners.has(watch.ownerId))
    ) {
      cancelActiveWatchState(state, watch);
      continue;
    }
    const match = matchingFacts(state, watch);
    if (!match.facts.length || !match.cause) continue;
    ready.push({
      watchId: watch.watchId,
      facts: match.facts,
      traceId: match.cause.traceId,
      causationId: match.cause.eventId,
      wake: !match.foregroundMessageMatches,
    });
  }
  const recipients = new Set<string>();
  for (const match of ready) {
    const watch = triggerReadyWatchState(state, match, allocateEventId).value;
    const event = watch?.triggerEventId ? peerMailboxRecord(state, watch.triggerEventId) : undefined;
    if (event?.status === 'accepted') recipients.add(event.recipientId);
  }
  return [...recipients];
}

export function triggerWatchIfReadyState(
  state: SchedulerState,
  watchIdInput: string,
  allocateEventId: () => string = randomUUID,
  wake = true,
): PeerEventPolicyResult<WatchRecord | undefined> {
  const watchId = id(watchIdInput, 'watchId');
  const watch = state.watches[watchId];
  if (!watch || watch.status !== 'active') return { changed: false, value: watch };
  const match = matchingFacts(state, watch);
  if (!match.facts.length || !match.cause) return { changed: false, value: undefined };
  return triggerReadyWatchState(
    state,
    {
      watchId,
      facts: match.facts,
      traceId: match.cause.traceId,
      causationId: match.cause.eventId,
      wake: wake && !match.foregroundMessageMatches,
    },
    allocateEventId,
  );
}

export function cancelWatchState(
  state: SchedulerState,
  watchIdInput: string,
  principal: SchedulerPrincipal,
): PeerEventPolicyResult<WatchRecord> {
  const watchId = id(watchIdInput, 'watchId');
  const watch = state.watches[watchId];
  if (!watch) throw new SchedulerStateError('watch_missing', `Watch '${watchId}' does not exist`);
  const caller = ownerId(state, principal);
  if (!authorized(state, caller, watch.ownerId))
    throw new SchedulerStateError('authority_denied', `Caller cannot cancel watch '${watchId}'`);
  if (watch.status === 'cancelled') return { changed: false, value: watch };
  if (watch.status === 'triggered')
    throw new SchedulerStateError('watch_terminal', `Watch '${watchId}' already triggered`);
  return cancelActiveWatchState(state, watch);
}

export function cancelActiveWatchState(state: SchedulerState, watch: WatchRecord): PeerEventPolicyResult<WatchRecord> {
  const seq = nextSequence(state);
  watch.status = 'cancelled';
  watch.terminalSeq = seq;
  contractTerminalWatch(watch);
  return { changed: true, value: watch };
}

function contractTerminalWatch(watch: WatchRecord): void {
  delete watch.requestIds;
  delete watch.agentIds;
  delete watch.eventKinds;
  delete watch.owned;
  delete watch.createdAtMs;
  delete watch.registeringActivationId;
  delete watch.causalInputs;
}
