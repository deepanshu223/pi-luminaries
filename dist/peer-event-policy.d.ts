import { type ActivationRecord, type ActivationState, type PeerDeliveryKind, type PeerEventKind, type PeerEventMode, type PeerEventRecord, type RequestResolutionCode, type SchedulerState } from './scheduler-state.ts';
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
export declare function routeReceipt(state: Readonly<SchedulerState>, event: PeerEventRecord, duplicate: boolean): PeerRouteReceipt;
export declare function normalizePeerEventRequest(input: PeerEventRequest): NormalizedPeerEventRequest;
export declare function normalizePeerEventEnvelope(input: PeerEventRequest & {
    kind: Exclude<PeerEventKind, 'resolution'>;
    requestId?: string;
    traceId?: string;
    causationId?: string;
    deadlineAtMs?: number;
}): NormalizedPeerEventRequest;
export declare function acceptPeerEventState(state: SchedulerState, auth: PeerEventAuth, request: NormalizedPeerEventRequest, allocateEventId: () => string, _structural?: boolean, expectedRecipientActivationId?: string, afterControlId?: string): PeerEventPolicyResult<PeerRouteReceipt>;
/** Scheduler-originated request resolution/cancellation. It never accepts child-supplied identity. */
export declare function acceptSchedulerCorrelatedEventState(state: SchedulerState, input: SchedulerCorrelatedEventInput, allocateEventId: () => string): PeerEventPolicyResult<PeerRouteReceipt>;
export declare function beginPeerDeliveryState(state: SchedulerState, eventId: string, targetRuntimeOwner: string): PeerEventPolicyResult<PeerDispatchPlan | undefined>;
export declare function requeuePeerEventBeforeWriteState(state: SchedulerState, eventId: string, attemptId: string): PeerEventPolicyResult<PeerEventRecord> & {
    discardedWakeActivation?: ActivationRecord;
};
export declare function admitPeerAtModelBoundaryState(state: SchedulerState, eventId: string, attemptId: string): PeerEventPolicyResult<PeerEventRecord[]>;
export declare function settleQueuedPeerEventNotifyState(state: SchedulerState, eventId: string, code: string): PeerEventPolicyResult<PeerEventRecord>;
export declare function finishPeerDeliveryState(state: SchedulerState, eventId: string, attemptId: string, outcome: 'refused' | 'failed' | 'indeterminate', code: string): PeerEventPolicyResult<PeerEventRecord[]>;
export declare function preparePeerEventsForActivationFinishState(state: SchedulerState, activationId: string, outcome: Exclude<ActivationState, 'running'>): PeerEventRecord[];
export declare function reconcilePeerEventState(state: SchedulerState, eventId: string): PeerEventPolicyResult<PeerEventRecord>;
export declare function closeQueuedPeerEventsState(state: SchedulerState, closedAgentIds: readonly string[]): PeerEventRecord[];
export declare function eligiblePeerEventsForRecipient(state: SchedulerState, recipientId: string): PeerEventRecord[];
