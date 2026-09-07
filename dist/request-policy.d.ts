import { type CorrelatedRequestRecord, type PeerEventRecord, type SchedulerState } from './scheduler-state.ts';
import { type NormalizedPeerEventRequest, type PeerEventAuth, type PeerEventPolicyResult, type PeerRouteReceipt } from './peer-event-policy.ts';
export interface CorrelatedRequestInput {
    bridgeRequestId: string;
    recipientId: string;
    message: string;
    mode?: 'default' | 'follow_up';
    deadlineAtMs?: number;
    causationId?: string;
}
export interface CorrelatedReplyInput {
    bridgeRequestId: string;
    requestId: string;
    message: string;
}
export interface CorrelatedCancelInput {
    bridgeRequestId: string;
    requestId: string;
}
export interface CorrelatedRequestReceipt {
    route: PeerRouteReceipt;
    request: CorrelatedRequestRecord;
}
export declare function normalizeCorrelatedRequest(input: CorrelatedRequestInput): NormalizedPeerEventRequest;
export declare function normalizeCorrelatedReply(input: CorrelatedReplyInput): {
    bridgeRequestId: string;
    requestId: string;
    message: string;
};
export declare function normalizeCorrelatedCancel(input: CorrelatedCancelInput): {
    bridgeRequestId: string;
    requestId: string;
};
export declare function acceptCorrelatedRequestState(state: SchedulerState, auth: PeerEventAuth, eventRequest: NormalizedPeerEventRequest, allocateEventId: () => string): PeerEventPolicyResult<CorrelatedRequestReceipt>;
export declare function acceptCorrelatedReplyState(state: SchedulerState, auth: PeerEventAuth, input: {
    bridgeRequestId: string;
    requestId: string;
    message: string;
}, allocateEventId: () => string): PeerEventPolicyResult<CorrelatedRequestReceipt>;
export declare function acceptCorrelatedCancelState(state: SchedulerState, auth: PeerEventAuth, input: {
    bridgeRequestId: string;
    requestId: string;
}, allocateEventId: () => string): PeerEventPolicyResult<CorrelatedRequestReceipt>;
export declare function timeoutCorrelatedRequestState(state: SchedulerState, requestIdInput: string, nowMs: number, allocateEventId: () => string): PeerEventPolicyResult<CorrelatedRequestReceipt | undefined>;
/** Apply a model-boundary or terminal event fact to its correlated request. */
export declare function applyTerminalEventToRequestState(state: SchedulerState, event: PeerEventRecord, allocateEventId: () => string): PeerEventRecord | undefined;
export declare function closeCorrelatedRequestsState(state: SchedulerState, closedAgentIds: readonly string[], allocateEventId: () => string): PeerEventRecord[];
