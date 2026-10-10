import type { DurablePiActor } from './actor-runtime.ts';
import { type RootConfigurationSnapshot, type RootSettingSource } from './root-configuration.ts';
import { type AgentHealth } from './health-policy.ts';
import { type AgentContextMode, type AgentRuntimePhase, type MailboxRecord, type SchedulerState } from './scheduler-state.ts';
export type LuminariesHumanState = 'working' | 'starting' | 'waiting' | 'idle' | 'closed';
export type LuminariesPiMessage = Readonly<{
    role: string;
} & Record<string, unknown>>;
export interface LuminariesCommandCenterAgent {
    agentId: string;
    parentId: string | null;
    depth: number;
    lifecycle: 'open' | 'closed';
    archived: boolean;
    name: string;
    shortId: string;
    handle: string;
    breadcrumb: readonly string[];
    role?: string;
    focus?: string;
    focusSource?: 'spawn' | 'self' | 'owner' | 'operator';
    assignment: string;
    ownershipBoundary: string;
    expertise: readonly string[];
    artifacts: readonly string[];
    state: AgentRuntimePhase | 'closed';
    humanState: LuminariesHumanState;
    runtimeResident: boolean;
    model?: string;
    thinking?: string;
    selectedExtensions: readonly string[];
    alwaysExtensions: readonly string[];
    extensionChangePending: boolean;
    canSpawn: boolean;
    canPeerInterrupt: boolean;
    maxDepth: number;
    contextMode: AgentContextMode;
    dependency?: string;
    canContinueWithMessage: boolean;
    active: boolean;
    attention: boolean;
    health: AgentHealth;
    activity: string;
    interactions: readonly string[];
    cwd: string;
    treePrefix: string;
}
export interface LuminariesCommandCenterAmbientRow {
    agent: LuminariesCommandCenterAgent;
    prefix: string;
    name: string;
}
export interface LuminariesCommandCenterProjection {
    revision: number;
    historyRevision: number;
    rootId: string;
    capacity: {
        used: number;
        limit: number;
        available: number;
    };
    configuration: {
        maxOpenAgents: number;
        maxDepth: number;
        namePoolSource: RootSettingSource | 'configured';
        sources: {
            maxOpenAgents: RootSettingSource | 'operator-live' | 'saved-policy';
            maxDepth: RootSettingSource | 'operator-live' | 'saved-policy';
            serviceGrant: RootSettingSource;
        };
        agentExtensions: readonly {
            specifier: string;
            state: 'always' | 'allow' | 'deny';
            source: RootSettingSource;
            available?: boolean;
        }[];
        serviceGrant: readonly string[];
    };
    agents: readonly LuminariesCommandCenterAgent[];
    closedAgents: readonly LuminariesCommandCenterAgent[];
    directory: readonly LuminariesCommandCenterAgent[];
    archivedCount: number;
    ambient: readonly LuminariesCommandCenterAmbientRow[];
    counts: {
        working: number;
        waiting: number;
        idle: number;
        attention: number;
    };
    visible: boolean;
}
/** Deterministically order projected rows as one rooted tree and derive rails for that exact row set. */
export declare function orderCommandCenterDirectory(rows: readonly LuminariesCommandCenterAgent[], rootId: string): readonly LuminariesCommandCenterAgent[];
interface TranscriptInspectionRow {
    kind: 'user' | 'assistant' | 'tool' | 'notice';
    text: string;
    label?: string;
    status?: 'running' | 'complete' | 'error';
}
export declare function projectConversationMessages(messages: readonly unknown[], state: Readonly<SchedulerState>, _targetAgentId: string): readonly LuminariesPiMessage[];
export declare function projectConversationEvent(event: unknown, state: Readonly<SchedulerState>, targetAgentId: string): readonly LuminariesPiMessage[];
/** Sanitized text projection used only by the explicit authorized transcript tool view. */
export declare function projectTranscriptInspection(messages: readonly unknown[], state: Readonly<SchedulerState>, targetAgentId?: string): readonly TranscriptInspectionRow[];
/** Pure projection over current scheduler truth and live actor activity. It performs no I/O. */
export declare function projectCommandCenter(state: Readonly<SchedulerState>, actors?: ReadonlyMap<string, DurablePiActor>, uiRevision?: number, rootConfiguration?: RootConfigurationSnapshot, historyRevision?: number, indeterminateEvidence?: readonly MailboxRecord[]): LuminariesCommandCenterProjection;
export {};
