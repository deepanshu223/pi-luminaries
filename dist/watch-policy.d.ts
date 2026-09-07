import { type PeerEventKind, type SchedulerPrincipal, type SchedulerState, type WatchRecord } from './scheduler-state.ts';
import type { PeerEventPolicyResult } from './peer-event-policy.ts';
export interface WatchInput {
    watchId: string;
    requestIds?: readonly string[];
    agentIds?: readonly string[];
    eventKinds?: readonly PeerEventKind[];
    owned?: boolean;
    registeringActivationId?: string;
    causalInputs?: readonly string[];
}
export declare function registerWatchState(state: SchedulerState, input: WatchInput, principal: SchedulerPrincipal, allocateEventId?: () => string): PeerEventPolicyResult<WatchRecord>;
export declare function resolveReadyWatchesState(state: SchedulerState, allocateEventId?: () => string): readonly string[];
export declare function triggerWatchIfReadyState(state: SchedulerState, watchIdInput: string, allocateEventId?: () => string, wake?: boolean): PeerEventPolicyResult<WatchRecord | undefined>;
export declare function cancelWatchState(state: SchedulerState, watchIdInput: string, principal: SchedulerPrincipal): PeerEventPolicyResult<WatchRecord>;
export declare function cancelActiveWatchState(state: SchedulerState, watch: WatchRecord): PeerEventPolicyResult<WatchRecord>;
