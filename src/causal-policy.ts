import {
  peerMailboxRecords,
  type ActivationRecord,
  type PeerEventRecord,
  type SchedulerState,
} from './scheduler-state.ts';

export function directInputBoundarySeq(
  _state: Readonly<SchedulerState>,
  activation: Readonly<ActivationRecord>,
): number | undefined {
  return activation.inputKind.startsWith('peer_') ? undefined : activation.startedSeq;
}

export function automaticCausesForActivation(
  state: Readonly<SchedulerState>,
  activation: Readonly<ActivationRecord>,
): PeerEventRecord[] {
  return peerMailboxRecords(state)
    .filter(
      (event) =>
        event.recipientId === activation.agentId &&
        event.activationId === activation.activationId &&
        event.consumedSeq !== undefined,
    )
    .sort((left, right) => left.acceptedSeq - right.acceptedSeq);
}

export function directOriginForActivation(
  state: Readonly<SchedulerState>,
  activation: Readonly<ActivationRecord>,
): PeerEventRecord | undefined {
  const boundary = directInputBoundarySeq(state, activation);
  if (boundary === undefined) return undefined;
  return peerMailboxRecords(state)
    .filter(
      (event) =>
        event.sourceActivationId === activation.activationId &&
        event.causationId === undefined &&
        event.traceId === event.eventId &&
        event.acceptedSeq > boundary,
    )
    .sort((left, right) => left.acceptedSeq - right.acceptedSeq)
    .at(0);
}
