import { type AgentHealth } from './health-policy.ts';
import { type AgentMetadataPatch, type AgentRecord, type DeclaredField, type SchedulerPrincipal, type SchedulerState } from './scheduler-state.ts';
export type DirectoryAccess = 'peer' | 'self' | 'owner' | 'operator';
export interface CompactDirectoryAgent {
    agentId: string;
    humanHandle: string;
    shortId?: string;
    parentId: string | null;
    path: string;
    depth: number;
    lifecycle: 'open' | 'closed';
    displayName: DeclaredField<string>;
    assignment: DeclaredField<string>;
    ownershipBoundary: DeclaredField<string>;
    expertCard: {
        role?: DeclaredField<string>;
        focus?: DeclaredField<string>;
        expertise?: DeclaredField<string[]>;
        expertiseCount: number;
        publishedRefCount: number;
        lastUpdatedAtMs: number;
    };
    activity: {
        state: 'starting' | 'working' | 'waiting' | 'idle' | 'closed';
        summary: string;
    };
    attention: {
        level: 'none' | 'warning' | 'critical';
        summary: string;
    };
}
export interface CompactAgentSummary extends CompactDirectoryAgent {
    mailbox: {
        count: number;
        bytes: number;
    };
    pending: {
        requests: number;
        watches: number;
        activations: number;
    };
    health: AgentHealth;
    capacity: {
        used: number;
        limit: number;
        available: number;
    };
}
export interface PolicyResult<T> {
    changed: boolean;
    value: T;
}
interface NormalizedPatch {
    displayName?: string;
    assignment?: string;
    ownershipBoundary?: string;
    role?: string | null;
    focus?: string | null;
    expertise?: string[] | null;
    publishedRefs?: string[] | null;
}
export declare function normalizeAgentMetadataPatch(patchInput: AgentMetadataPatch): NormalizedPatch;
export declare function updateAgentMetadata(state: SchedulerState, statePath: string, targetId: string, patch: NormalizedPatch, principal: SchedulerPrincipal): PolicyResult<AgentRecord>;
export declare function projectCompactDirectory(state: SchedulerState, callerId: string | undefined, includeClosed?: boolean): readonly CompactDirectoryAgent[];
export declare function projectCompactAgentSummary(state: SchedulerState, agent: Readonly<AgentRecord>, callerId: string | undefined): CompactAgentSummary;
export {};
