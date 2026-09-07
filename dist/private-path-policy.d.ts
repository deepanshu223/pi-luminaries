import { type SchedulerState } from './scheduler-state.ts';
export declare function canonicalizeSessionDirectory(input: string): Promise<string>;
export declare function canonicalizeSessionFile(input: string, sessionDirectory: string): Promise<string>;
export declare function validatePhysicalSessionNamespace(state: Readonly<SchedulerState>, agentId: string, failureCode: 'session_conflict' | 'state_invalid'): Promise<void>;
export declare function assertPhysicalReferencesPublic(references: readonly string[], cwd: string, agentId: string, state: Readonly<SchedulerState>, statePath: string): Promise<void>;
export declare function validatePhysicalPublishedReferences(state: Readonly<SchedulerState>, statePath: string): Promise<void>;
