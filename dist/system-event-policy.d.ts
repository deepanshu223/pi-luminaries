import { type SchedulerState, type SystemEventType } from './scheduler-state.ts';
import { type PeerEventPolicyResult, type PeerRouteReceipt } from './peer-event-policy.ts';
export interface SystemEventInput {
    dedupeKey: string;
    type: SystemEventType;
    senderId: string;
    recipientId: string;
    message: string;
    wake?: boolean;
    traceId?: string;
    causationId?: string;
    sourceActivationId?: string;
}
export declare function acceptSystemEventState(state: SchedulerState, input: SystemEventInput, allocateEventId?: () => string): PeerEventPolicyResult<PeerRouteReceipt>;
