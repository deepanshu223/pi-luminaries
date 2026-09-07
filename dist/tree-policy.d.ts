import { type CapabilityEnvelope, type CapabilityRequest } from './capability-policy.ts';
import { type AdmitAgentInput, type AgentRecord, type SchedulerPrincipal, type SchedulerState } from './scheduler-state.ts';
export interface TreePolicyResult<T> {
    changed: boolean;
    value: T;
}
export interface RootPolicyInput {
    capabilities: CapabilityEnvelope;
    retiredCwdRoot?: string;
    cwd: string;
    maxOpenAgents: number;
    maxOpenAgentsSource: 'startup' | 'operator-live';
    maxDepth: number;
    maxDepthSource?: 'startup' | 'operator-live';
    agentNames?: readonly string[];
    agentExtensions: SchedulerState['root']['agentExtensions'];
    serviceGrant: SchedulerState['root']['serviceGrant'];
    provider?: string;
    model?: string;
    thinking?: string;
}
export interface NormalizedAdmission {
    agentId: string;
    parentId: string;
    segment: string;
    cwd: string;
    sessionId: string;
    sessionDir: string;
    sessionFile?: string;
    displayName?: string;
    assignment: string;
    ownershipBoundary: string;
    role?: string;
    focus?: string;
    expertise?: string[];
    publishedRefs?: string[];
    provider?: string;
    model?: string;
    thinking?: string;
    spawnHash: string;
    context: AgentRecord['context'];
    launch: AgentRecord['launch'];
    grants?: CapabilityRequest;
}
export declare function admissionDisplayName(state: Readonly<SchedulerState>, requested?: string, reserved?: readonly string[]): string;
export declare function normalizeAdmission(input: AdmitAgentInput): NormalizedAdmission;
export declare function reconcileRootPolicy(state: SchedulerState, input: RootPolicyInput): TreePolicyResult<AgentRecord>;
export declare function approveRootExtensionCapability(state: SchedulerState, paths: readonly string[]): void;
export declare function setAgentCapabilities(state: SchedulerState, targetId: string, request: CapabilityRequest, principal: SchedulerPrincipal): TreePolicyResult<AgentRecord>;
export declare function admitAgent(state: SchedulerState, statePath: string, input: NormalizedAdmission, principal: SchedulerPrincipal): TreePolicyResult<AgentRecord>;
export declare function closeAgent(state: SchedulerState, targetId: string, principal: SchedulerPrincipal, subtree: boolean): TreePolicyResult<readonly string[]>;
export declare function setAgentArchived(state: SchedulerState, targetId: string, archived: boolean, principal: SchedulerPrincipal): TreePolicyResult<readonly string[]>;
export declare function resumeAgent(state: SchedulerState, targetId: string, principal: SchedulerPrincipal, restoreArchivedLineage?: boolean): TreePolicyResult<AgentRecord>;
