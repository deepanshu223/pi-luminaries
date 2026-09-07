import { type DirectControlRecord, type SchedulerPrincipal, type SchedulerState } from './scheduler-state.ts';
export interface DirectControlInput {
    requestId: string;
    targetId: string;
    sourceActivationId: string;
    action: 'interrupt';
}
export interface DirectControlAdmission {
    control: DirectControlRecord;
    duplicate: boolean;
}
export interface DirectControlPolicyResult<T> {
    changed: boolean;
    value: T;
}
type NormalizedDirectControlInput = DirectControlInput;
export declare function normalizeDirectControlInput(value: DirectControlInput): NormalizedDirectControlInput;
export declare function hasDirectInputFence(state: SchedulerState, targetId: string, activationId?: string): boolean;
export declare function admitDirectControlState(state: SchedulerState, input: NormalizedDirectControlInput, requestedBy: SchedulerPrincipal, randomId: () => string): DirectControlPolicyResult<DirectControlAdmission>;
export declare function beginDirectControlAttemptState(state: SchedulerState, controlId: string, runtimeOwner: string): DirectControlPolicyResult<DirectControlRecord>;
export declare function markDirectInterruptBoundaryState(state: SchedulerState, controlId: string, attemptId: string, aborted: boolean): DirectControlPolicyResult<DirectControlRecord>;
export declare function finishDirectControlState(state: SchedulerState, controlId: string, attemptId: string, status: 'refused' | 'failed' | 'indeterminate', outcomeCode: string): DirectControlPolicyResult<DirectControlRecord>;
export declare function prepareDirectControlsForActivationFinishState(state: SchedulerState, activationId: string): DirectControlRecord[];
export declare function reconcileDirectControlState(state: SchedulerState, controlId: string): DirectControlPolicyResult<DirectControlRecord>;
export {};
