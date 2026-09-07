import { type ActivationRecord, type ActivationState, type PeerEventRecord, type SchedulerState } from './scheduler-state.ts';
export interface CompletionPolicyResult {
    changed: boolean;
    events: readonly PeerEventRecord[];
}
/** Emit bounded owner-visible completion facts after one non-root actor turn reaches durable terminal state. */
export declare function emitActivationCompletionState(state: SchedulerState, activation: Readonly<ActivationRecord>, outcome: Exclude<ActivationState, 'running'>, allocateEventId: () => string): CompletionPolicyResult;
