import { type ActivationRecord, type PeerEventRecord, type SchedulerState } from './scheduler-state.ts';
export declare function directInputBoundarySeq(_state: Readonly<SchedulerState>, activation: Readonly<ActivationRecord>): number | undefined;
export declare function automaticCausesForActivation(state: Readonly<SchedulerState>, activation: Readonly<ActivationRecord>): PeerEventRecord[];
export declare function directOriginForActivation(state: Readonly<SchedulerState>, activation: Readonly<ActivationRecord>): PeerEventRecord | undefined;
