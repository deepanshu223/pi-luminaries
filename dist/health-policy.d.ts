import { type AgentRecord, type MailboxRecord, type SchedulerActivityIndex, type SchedulerState } from './scheduler-state.ts';
export type HealthLevel = 'ok' | 'warning' | 'critical';
export interface HealthObservation {
    code: string;
    level: Exclude<HealthLevel, 'ok'>;
    message: string;
}
export interface AgentHealth {
    level: HealthLevel;
    attention: 'none' | 'warning' | 'critical';
    summary: string;
    reasons: readonly string[];
    observations: readonly HealthObservation[];
}
/** Deterministic, transcript-free health projection. It diagnoses mechanics, never intent. */
export declare function projectAgentHealth(state: Readonly<SchedulerState>, agent: Readonly<AgentRecord>, activityIndex?: SchedulerActivityIndex, additionalRecords?: readonly MailboxRecord[]): AgentHealth;
