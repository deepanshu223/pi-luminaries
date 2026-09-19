import { TERMINAL_PEER_EVENT_STATUSES, SchedulerStateError, agentRuntimeState, peerMailboxRecord, peerMailboxRecords, projectAgentMailbox, requestStatus, exactKeys, id, isRecord, nonemptyText, sha256, } from "./scheduler-state.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { acceptPeerEventState, acceptSchedulerCorrelatedEventState, normalizePeerEventEnvelope, routeReceipt, settleQueuedPeerEventNotifyState, } from "./peer-event-policy.js";
export function normalizeCorrelatedRequest(input) {
    assertObject(input, ['bridgeRequestId', 'recipientId', 'message', 'mode', 'deadlineAtMs', 'causationId'], 'correlated request');
    const bridgeRequestId = id(input.bridgeRequestId, 'bridgeRequestId');
    return normalizePeerEventEnvelope({
        bridgeRequestId,
        recipientId: input.recipientId,
        message: input.message,
        mode: input.mode,
        kind: 'request',
        requestId: bridgeRequestId,
        deadlineAtMs: input.deadlineAtMs,
        causationId: input.causationId,
    });
}
export function normalizeCorrelatedReply(input) {
    assertObject(input, ['bridgeRequestId', 'requestId', 'message'], 'correlated reply');
    return {
        bridgeRequestId: id(input.bridgeRequestId, 'bridgeRequestId'),
        requestId: id(input.requestId, 'requestId'),
        message: nonemptyText(input.message, 'message'),
    };
}
export function normalizeCorrelatedCancel(input) {
    assertObject(input, ['bridgeRequestId', 'requestId'], 'correlated cancellation');
    return { bridgeRequestId: id(input.bridgeRequestId, 'bridgeRequestId'), requestId: id(input.requestId, 'requestId') };
}
export function acceptCorrelatedRequestState(state, auth, eventRequest, allocateEventId) {
    const route = acceptPeerEventState(state, auth, eventRequest, allocateEventId).value;
    if (route.duplicate) {
        const duplicateRequestId = route.event.requestId;
        if (!duplicateRequestId)
            throw new SchedulerStateError('state_invalid', `Duplicate request route '${route.event.eventId}' lost its ID`);
        const existing = state.requests[duplicateRequestId];
        if (!existing)
            throw new SchedulerStateError('state_invalid', `Duplicate request route '${route.event.eventId}' lost its correlation`);
        return { changed: false, value: { route, request: existing } };
    }
    const event = route.event;
    const requestId = event.requestId;
    if (!requestId)
        throw new SchedulerStateError('state_invalid', `Request route '${event.eventId}' lost its ID`);
    const request = {
        requestId,
        traceId: event.traceId,
        requesterId: event.senderId,
        recipientId: event.recipientId,
        requestEventId: event.eventId,
        createdSeq: event.acceptedSeq,
        ...(eventRequest.deadlineAtMs === undefined ? {} : { deadlineAtMs: eventRequest.deadlineAtMs }),
    };
    state.requests[requestId] = request;
    return { changed: true, value: { route, request } };
}
export function acceptCorrelatedReplyState(state, auth, input, allocateEventId) {
    const request = requiredRequest(state, input.requestId);
    assertCurrentRuntime(state, auth);
    if (auth.agentId !== request.recipientId)
        throw new SchedulerStateError('authority_denied', `Agent '${auth.agentId}' cannot reply to request '${request.requestId}'`);
    const duplicate = peerMailboxRecords(state).find((event) => event.bridgeRequestId === input.bridgeRequestId);
    if (duplicate) {
        if (duplicate.kind !== 'reply' || duplicate.requestId !== request.requestId || duplicate.senderId !== auth.agentId)
            throw new SchedulerStateError('command_id_reuse', `Bridge request '${input.bridgeRequestId}' was reused`);
        return { changed: false, value: { route: routeReceipt(state, duplicate, true), request } };
    }
    const status = requestStatus(state, request);
    const postCancellation = status === 'cancelled';
    const postTimeout = status === 'timed_out';
    const pendingOutcome = status === 'pending' ? pendingRequestOutcome(state, request) : undefined;
    const postIndeterminate = status === 'delivery_indeterminate' ||
        (pendingOutcome?.kind === 'resolution' && pendingOutcome.resolutionCode === 'request_dispatch_indeterminate');
    if (pendingOutcome && !postIndeterminate)
        throw new SchedulerStateError('request_resolved', `Request '${request.requestId}' already has a known reply or resolution in flight`);
    if (status !== 'pending' && !postCancellation && !postTimeout && !postIndeterminate)
        throw new SchedulerStateError('request_resolved', `Request '${request.requestId}' is already ${status}`);
    const envelope = normalizePeerEventEnvelope({
        bridgeRequestId: input.bridgeRequestId,
        recipientId: request.requesterId,
        message: input.message,
        mode: postCancellation || postTimeout ? 'notify_only' : 'default',
        kind: 'reply',
        requestId: request.requestId,
        traceId: request.traceId,
        causationId: request.requestEventId,
    });
    const route = acceptPeerEventState(state, auth, envelope, allocateEventId).value;
    if (!route.duplicate && status === 'pending' && !postIndeterminate)
        request.terminalEventId = route.event.eventId;
    return { changed: !route.duplicate, value: { route, request } };
}
export function acceptCorrelatedCancelState(state, auth, input, allocateEventId) {
    const request = requiredRequest(state, input.requestId);
    assertCurrentRuntime(state, auth);
    if (auth.agentId !== request.requesterId)
        throw new SchedulerStateError('authority_denied', `Agent '${auth.agentId}' cannot cancel request '${request.requestId}'`);
    const duplicate = peerMailboxRecords(state).find((event) => event.bridgeRequestId === input.bridgeRequestId);
    if (duplicate) {
        if (duplicate.kind !== 'cancel' || duplicate.requestId !== request.requestId)
            throw new SchedulerStateError('command_id_reuse', `Bridge request '${input.bridgeRequestId}' was reused`);
        return { changed: false, value: { route: routeReceipt(state, duplicate, true), request } };
    }
    const status = requestStatus(state, request);
    if (status !== 'pending')
        throw new SchedulerStateError('request_resolved', `Request '${request.requestId}' is already ${status}`);
    if (request.terminalEventId) {
        const resolution = pendingRequestOutcome(state, request);
        if (!resolution)
            throw new SchedulerStateError('state_invalid', `Request '${request.requestId}' lost its resolution`);
        if (resolution.status === 'accepted')
            settleQueuedPeerEventNotifyState(state, resolution.eventId, 'reply_post_cancellation');
    }
    const requestEvent = peerMailboxRecord(state, request.requestEventId);
    if (!requestEvent)
        throw new SchedulerStateError('state_invalid', `Request '${request.requestId}' lost its origin event`);
    if (requestEvent.status === 'accepted')
        settleQueuedPeerEventNotifyState(state, requestEvent.eventId, 'request_cancelled_before_delivery');
    const envelope = normalizePeerEventEnvelope({
        bridgeRequestId: input.bridgeRequestId,
        recipientId: request.recipientId,
        message: `Request ${request.requestId} was cancelled by its requester.`,
        mode: 'notify_only',
        kind: 'cancel',
        requestId: request.requestId,
        traceId: request.traceId,
        causationId: request.requestEventId,
    });
    const route = acceptPeerEventState(state, auth, envelope, allocateEventId).value;
    request.terminalEventId = route.event.eventId;
    return { changed: true, value: { route, request } };
}
export function timeoutCorrelatedRequestState(state, requestIdInput, nowMs, allocateEventId) {
    const requestId = id(requestIdInput, 'requestId');
    if (!Number.isSafeInteger(nowMs) || nowMs < 1)
        throw new SchedulerStateError('input_invalid', 'Timeout observation time is invalid');
    const request = requiredRequest(state, requestId);
    if (requestStatus(state, request) !== 'pending' ||
        request.terminalEventId !== undefined ||
        request.deadlineAtMs === undefined ||
        request.deadlineAtMs > nowMs)
        return { changed: false, value: undefined };
    const requestEvent = peerMailboxRecord(state, request.requestEventId);
    if (!requestEvent)
        throw new SchedulerStateError('state_invalid', `Request '${request.requestId}' lost its origin event`);
    if (requestEvent.status === 'accepted')
        settleQueuedPeerEventNotifyState(state, requestEvent.eventId, 'request_timed_out_before_delivery');
    const event = queueRequestResolution(state, request, 'request_timeout', requestEvent, allocateEventId);
    return { changed: true, value: { route: routeReceipt(state, event, false), request } };
}
/** Apply a model-boundary or terminal event fact to its correlated request. */
export function applyTerminalEventToRequestState(state, event, allocateEventId) {
    if (!event.requestId)
        return undefined;
    const request = state.requests[event.requestId];
    if (!request)
        return undefined;
    if (event.kind === 'reply' && request.terminalEventId === event.eventId) {
        if (event.consumedSeq === undefined &&
            (event.status === 'aborted' || event.status === 'failed' || event.status === 'indeterminate')) {
            delete request.terminalEventId;
            return queueRequestResolution(state, request, event.status === 'indeterminate' ? 'request_dispatch_indeterminate' : 'request_delivery_failed', event, allocateEventId);
        }
    }
    if (event.kind === 'request' &&
        request.terminalEventId === undefined &&
        (event.status === 'aborted' || event.status === 'failed' || event.status === 'indeterminate')) {
        return queueRequestResolution(state, request, event.status === 'indeterminate' ? 'request_dispatch_indeterminate' : 'request_delivery_failed', event, allocateEventId);
    }
    return undefined;
}
export function closeCorrelatedRequestsState(state, closedAgentIds, allocateEventId) {
    const closed = new Set(closedAgentIds);
    const generated = [];
    for (const request of Object.values(state.requests).sort((left, right) => left.createdSeq - right.createdSeq)) {
        if (requestStatus(state, request) !== 'pending')
            continue;
        if (closed.has(request.requesterId)) {
            if (request.terminalEventId) {
                const waiting = pendingRequestOutcome(state, request);
                if (waiting?.status === 'accepted')
                    settleQueuedPeerEventNotifyState(state, waiting.eventId, 'requester_closed');
            }
            const route = acceptSchedulerCorrelatedEventState(state, {
                bridgeRequestId: internalBridgeId('cancel', request.requestId),
                kind: 'cancel',
                requestId: request.requestId,
                senderId: request.requesterId,
                recipientId: request.recipientId,
                traceId: request.traceId,
                causationId: request.requestEventId,
                message: `Request ${request.requestId} was cancelled because its requester closed.`,
                mode: 'notify_only',
            }, allocateEventId).value;
            request.terminalEventId = route.event.eventId;
            generated.push(route.event);
            continue;
        }
        if (closed.has(request.recipientId)) {
            const requestEvent = peerMailboxRecord(state, request.requestEventId);
            if (!requestEvent)
                throw new SchedulerStateError('state_invalid', `Request '${request.requestId}' lost its origin event`);
            generated.push(queueRequestResolution(state, request, 'recipient_closed', requestEvent, allocateEventId));
        }
    }
    return generated;
}
function timeoutDetail(state, recipientId) {
    const recipient = state.agents[recipientId];
    if (!recipient)
        return 'The explicit deadline elapsed. Recipient status is unavailable; its work was not interrupted.';
    const declared = recipient.expertCard.focus?.value ?? recipient.assignment.value;
    const focus = declared.length > 512 ? `${declared.slice(0, 511)}…` : declared;
    const mailbox = projectAgentMailbox(state, recipientId);
    return `The explicit deadline elapsed. Recipient ${recipient.displayName.value} is ${agentRuntimeState(state, recipient)}, declares focus "${focus}", and has ${mailbox.count} queued event${mailbox.count === 1 ? '' : 's'}; its work was not interrupted. A reply from ongoing work can still be recorded as a notification without restarting this wait. Send a message to the recipient if that work is no longer wanted.`;
}
function queueRequestResolution(state, request, code, cause, allocateEventId) {
    const status = requestStatus(state, request);
    const terminalOrigin = cause.eventId === request.requestEventId &&
        ((code === 'request_delivery_failed' && status === 'delivery_failed') ||
            (code === 'request_dispatch_indeterminate' && status === 'delivery_indeterminate'));
    if ((!terminalOrigin && status !== 'pending') || request.terminalEventId !== undefined)
        throw new SchedulerStateError('request_transition', `Request '${request.requestId}' cannot queue a resolution from ${status}`);
    const requester = state.agents[request.requesterId];
    const mode = requester?.lifecycle === 'open' ? 'default' : 'notify_only';
    const detail = code === 'request_dispatch_indeterminate'
        ? 'Dispatch crossed an uncertain crash boundary. Do not replay it; inspect recipient state. A later reply remains correlated.'
        : code === 'recipient_closed'
            ? 'The recipient closed before replying.'
            : code === 'request_timeout'
                ? cause.outcomeCode === 'request_timed_out_before_delivery'
                    ? 'The wait expired before delivery; the queued request was withdrawn.'
                    : timeoutDetail(state, request.recipientId)
                : `Delivery failed with outcome ${cause.outcomeCode ?? cause.status}.`;
    const route = acceptSchedulerCorrelatedEventState(state, {
        bridgeRequestId: internalBridgeId('resolution', request.requestId),
        kind: 'resolution',
        requestId: request.requestId,
        senderId: request.recipientId,
        recipientId: request.requesterId,
        traceId: request.traceId,
        causationId: request.requestEventId,
        message: `Correlated request ${request.requestId} resolved without an answer. ${detail}`,
        mode,
        resolutionCode: code,
    }, allocateEventId).value;
    request.terminalEventId = route.event.eventId;
    return route.event;
}
function internalBridgeId(kind, requestId) {
    return `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}${kind}-${sha256(requestId).slice(0, 40)}`;
}
function pendingRequestOutcome(state, request) {
    if (!request.terminalEventId)
        return undefined;
    const event = peerMailboxRecord(state, request.terminalEventId);
    return event && !TERMINAL_PEER_EVENT_STATUSES.has(event.status) ? event : undefined;
}
function requiredRequest(state, requestId) {
    const request = state.requests[requestId];
    if (!request)
        throw new SchedulerStateError('request_missing', `Request '${requestId}' does not exist`);
    return request;
}
function assertCurrentRuntime(state, auth) {
    const agent = state.agents[auth.agentId];
    if (!agent ||
        auth.rootId !== state.root.rootId ||
        agent.lifecycle !== 'open' ||
        (agent.parentId !== null && (agent.runtimeOwner !== auth.runtimeOwner || agent.runtimePhase !== 'ready')))
        throw new SchedulerStateError('sender_runtime_stale', `Authenticated sender '${auth.agentId}' does not own a ready runtime`);
}
function assertObject(value, keys, label) {
    if (!isRecord(value))
        throw new SchedulerStateError('input_invalid', `${label} must be an object`);
    exactKeys(value, keys, label);
}
