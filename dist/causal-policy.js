import { peerMailboxRecords, } from "./scheduler-state.js";
export function directInputBoundarySeq(_state, activation) {
    return activation.inputKind.startsWith('peer_') ? undefined : activation.startedSeq;
}
export function automaticCausesForActivation(state, activation) {
    return peerMailboxRecords(state)
        .filter((event) => event.recipientId === activation.agentId &&
        event.activationId === activation.activationId &&
        event.consumedSeq !== undefined)
        .sort((left, right) => left.acceptedSeq - right.acceptedSeq);
}
export function directOriginForActivation(state, activation) {
    const boundary = directInputBoundarySeq(state, activation);
    if (boundary === undefined)
        return undefined;
    return peerMailboxRecords(state)
        .filter((event) => event.sourceActivationId === activation.activationId &&
        event.causationId === undefined &&
        event.traceId === event.eventId &&
        event.acceptedSeq > boundary)
        .sort((left, right) => left.acceptedSeq - right.acceptedSeq)
        .at(0);
}
