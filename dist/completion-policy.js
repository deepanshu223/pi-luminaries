import { acceptSystemEventState } from "./system-event-policy.js";
import { settleQueuedPeerEventNotifyState } from "./peer-event-policy.js";
import { automaticCausesForActivation, directInputBoundarySeq, directOriginForActivation } from "./causal-policy.js";
import { sha256, peerMailboxRecords, } from "./scheduler-state.js";
/** Emit bounded owner-visible completion facts after one non-root actor turn reaches durable terminal state. */
export function emitActivationCompletionState(state, activation, outcome, allocateEventId) {
    const agent = state.agents[activation.agentId];
    if (!agent?.parentId)
        return { changed: false, events: [] };
    const parent = state.agents[agent.parentId];
    if (!parent || parent.lifecycle !== 'open')
        return { changed: false, events: [] };
    const causes = distinctTraceCauses(state, activation);
    const events = [];
    const terminalBoundary = activation.terminalSeq ?? activation.startedSeq;
    for (const cause of causes) {
        const dedupeKey = sha256(`completion:${agent.parentId}:${activation.activationId}:${terminalBoundary}:${cause.traceId ?? 'direct'}`);
        const route = acceptSystemEventState(state, {
            dedupeKey: `completion:${dedupeKey}`,
            type: 'background_completion',
            senderId: agent.agentId,
            recipientId: parent.agentId,
            message: `${agent.displayName.value} finished a turn (${outcome}). Inspect its expert card or private conversation if the result matters.`,
            // Completions are durable card/UI state, never model work. Failed and
            // indeterminate outcomes wake through SupervisionCoordinator health episodes.
            wake: false,
            sourceActivationId: activation.activationId,
            ...(cause.traceId && cause.causationId ? { traceId: cause.traceId, causationId: cause.causationId } : {}),
        }, allocateEventId).value;
        if (!route.duplicate)
            events.push(route.event);
    }
    const completions = peerMailboxRecords(state)
        .filter((event) => event.systemType === 'background_completion' &&
        event.senderId === agent.agentId &&
        event.recipientId === parent.agentId)
        .sort((left, right) => left.acceptedSeq - right.acceptedSeq);
    const latest = completions.at(-1);
    for (const event of completions)
        if (event.eventId !== latest?.eventId && event.status === 'accepted')
            settleQueuedPeerEventNotifyState(state, event.eventId, 'completion_superseded');
    return { changed: events.length > 0, events };
}
function distinctTraceCauses(state, activation) {
    const automatic = automaticCausesForActivation(state, activation);
    const byTrace = new Map();
    for (const event of automatic)
        byTrace.set(event.traceId, event);
    if (automatic.length)
        return [...byTrace.values()].map((event) => ({ traceId: event.traceId, causationId: event.eventId }));
    const direct = directOriginForActivation(state, activation);
    if (direct)
        return [{ traceId: direct.traceId, causationId: direct.eventId }];
    return directInputBoundarySeq(state, activation) === undefined ? [] : [{}];
}
