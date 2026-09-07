import { randomUUID } from 'node:crypto';
import { SchedulerStateError, id, nextSequence, nonemptyText, peerMailboxRecord, peerMailboxRecords, sha256, text, } from "./scheduler-state.js";
import { automaticCausesForActivation, directInputBoundarySeq, directOriginForActivation } from "./causal-policy.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { routeReceipt } from "./peer-event-policy.js";
const SYSTEM_EVENT_TYPES = new Set([
    'watch_activity',
    'request_timeout',
    'health_attention',
    'background_completion',
    'permission_decision',
    'control_failure',
    'routine',
]);
const WAKE_ALLOWLIST = new Set([
    'watch_activity',
    'request_timeout',
    'health_attention',
    'background_completion',
    'permission_decision',
    'control_failure',
]);
function systemEventType(value) {
    if (typeof value !== 'string' || !SYSTEM_EVENT_TYPES.has(value))
        throw new SchedulerStateError('input_invalid', 'System event type is invalid');
    switch (value) {
        case 'watch_activity':
        case 'request_timeout':
        case 'health_attention':
        case 'background_completion':
        case 'permission_decision':
        case 'control_failure':
        case 'routine':
            return value;
    }
    throw new SchedulerStateError('input_invalid', 'System event type is invalid');
}
export function acceptSystemEventState(state, input, allocateEventId = randomUUID) {
    const dedupeKey = text(input.dedupeKey, 'system dedupeKey', 128);
    const type = systemEventType(input.type);
    const senderId = id(input.senderId, 'system senderId');
    const recipientId = id(input.recipientId, 'system recipientId');
    const message = nonemptyText(input.message, 'system message');
    const payloadBytes = Buffer.byteLength(message);
    const requestedTraceId = input.traceId === undefined ? undefined : id(input.traceId, 'system traceId');
    const requestedCausationId = input.causationId === undefined ? undefined : id(input.causationId, 'system causationId');
    let traceId = requestedTraceId;
    let causationId = requestedCausationId;
    let cause = causationId ? peerMailboxRecord(state, causationId) : undefined;
    const sourceActivationId = input.sourceActivationId === undefined ? undefined : id(input.sourceActivationId, 'system sourceActivationId');
    if ((traceId === undefined) !== (causationId === undefined))
        throw new SchedulerStateError('input_invalid', 'System event trace and causation must be supplied together');
    if (traceId && causationId) {
        if (!cause || cause.traceId !== traceId)
            throw new SchedulerStateError('causation_invalid', 'System event causation is invalid');
    }
    const sender = state.agents[senderId];
    const recipient = state.agents[recipientId];
    if (!sender || !recipient)
        throw new SchedulerStateError('agent_unavailable', 'System event references an unavailable agent');
    const sourceActivation = sourceActivationId ? state.activations[sourceActivationId] : undefined;
    if (sourceActivationId) {
        if (!sourceActivation || sourceActivation.agentId !== senderId)
            throw new SchedulerStateError('state_invalid', 'System event source activation is inconsistent');
    }
    if (!traceId && sourceActivation) {
        const inferredCause = automaticCausesForActivation(state, sourceActivation).at(-1) ??
            directOriginForActivation(state, sourceActivation);
        if (inferredCause) {
            traceId = inferredCause.traceId;
            causationId = inferredCause.eventId;
            cause = inferredCause;
        }
        else if (directInputBoundarySeq(state, sourceActivation) === undefined)
            throw new SchedulerStateError('causation_required', `Derived work from activation '${sourceActivation.activationId}' cannot mint a system trace`);
    }
    if (!traceId && !sourceActivation)
        throw new SchedulerStateError('causation_required', `${type} must link its causal work`);
    if (input.wake !== undefined && typeof input.wake !== 'boolean')
        throw new SchedulerStateError('input_invalid', 'System event wake flag must be boolean');
    const wake = input.wake !== false && WAKE_ALLOWLIST.has(type);
    const mode = wake ? 'default' : 'notify_only';
    const requestHash = sha256(JSON.stringify({
        type,
        senderId,
        recipientId,
        message,
        mode,
        traceId: requestedTraceId ?? null,
        causationId: requestedCausationId ?? null,
        sourceActivationId: sourceActivationId ?? null,
    }));
    const duplicate = peerMailboxRecords(state).find((event) => event.origin === 'system' && event.dedupeKey === dedupeKey);
    if (duplicate) {
        if (duplicate.requestHash !== requestHash)
            throw new SchedulerStateError('command_id_reuse', `System dedupe key '${dedupeKey}' was reused`);
        return { changed: false, value: routeReceipt(state, duplicate, true) };
    }
    let refusal;
    if (mode === 'default' && recipient.lifecycle !== 'open')
        refusal = 'recipient_closed';
    const eventId = id(allocateEventId(), 'system eventId');
    if (peerMailboxRecord(state, eventId))
        throw new SchedulerStateError('event_exists', `System event '${eventId}' exists`);
    const seq = nextSequence(state);
    const effectiveTraceId = traceId ?? eventId;
    const event = {
        lane: 'system',
        eventId,
        bridgeRequestId: `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}system-${sha256(dedupeKey).slice(0, 40)}`,
        requestHash,
        origin: 'system',
        senderId,
        recipientId,
        traceId: effectiveTraceId,
        ...(sourceActivationId ? { sourceActivationId } : {}),
        ...(causationId ? { causationId } : {}),
        kind: 'system',
        systemType: type,
        dedupeKey,
        mode,
        message,
        payloadHash: sha256(message),
        payloadBytes,
        status: refusal ? 'refused' : mode === 'notify_only' ? 'settled' : 'accepted',
        acceptedSeq: seq,
        acceptedAtMs: Date.now(),
    };
    if (refusal) {
        event.terminalSeq = seq;
        event.outcomeCode = refusal;
    }
    else if (mode === 'notify_only') {
        event.terminalSeq = seq;
        event.outcomeCode = 'notify_only';
    }
    state.mailbox[eventId] = event;
    return { changed: true, value: routeReceipt(state, event, false) };
}
