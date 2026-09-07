import { type CapabilityEnvelope, type CapabilityRequest } from './capability-policy.ts';
export { isLuminariesId, isLowercaseSha256, isPiSessionId } from './identifiers.ts';
export declare const DIRECT_CONTROL_STATES: Set<string>;
export declare const TERMINAL_DIRECT_CONTROL_STATES: Set<string>;
export declare const TERMINAL_PEER_EVENT_STATUSES: Set<string>;
export type AgentRuntimeState = 'starting' | 'idle' | 'running' | 'waiting' | 'runtime_parked' | 'failed' | 'needs_attention';
export type AgentRuntimePhase = Exclude<AgentRuntimeState, 'failed' | 'needs_attention'>;
export type AgentContextMode = 'fresh' | 'recent' | 'fork' | 'custom';
export interface AgentContextRecord {
    mode: AgentContextMode;
    requestedTokens?: number;
    effectiveTokens: number;
    estimatedTokens: number;
    transferredMessages: number;
    omittedMessages: number;
    targetContextWindow?: number;
    warning?: string;
}
export interface AgentLaunchRecord {
    noContextFiles: boolean;
    restrictSkills: boolean;
    restrictPromptTemplates: boolean;
    restrictThemes: boolean;
    systemPrompt?: string;
    extensionSources?: string[];
    extensions: string[];
    skills: string[];
    promptTemplates: string[];
    themes: string[];
}
export type ManagedExtensionState = 'always' | 'allow' | 'deny';
export type LuminariesServicePermission = 'spawn' | 'directory' | 'message' | 'watch' | 'steer' | 'follow_up' | 'interrupt' | 'close' | 'close_subtree' | 'resume' | 'set_model' | 'set_thinking' | 'set_extensions' | 'set_grants';
export type ActivationState = 'running' | 'settled' | 'aborted' | 'failed' | 'indeterminate';
export type PeerEventOrigin = 'agent' | 'operator' | 'service' | 'scheduler' | 'system';
export type MailboxLane = 'direct' | 'peer' | 'operator' | 'service' | 'system';
export type PeerEventMode = 'default' | 'follow_up' | 'notify_only';
export type SystemEventType = 'watch_activity' | 'request_timeout' | 'health_attention' | 'background_completion' | 'permission_decision' | 'control_failure' | 'routine';
export type PeerEventKind = 'message' | 'request' | 'reply' | 'cancel' | 'resolution' | 'system';
export type PeerEventStatus = 'accepted' | 'sending' | 'consumed' | 'settled' | 'aborted' | 'refused' | 'failed' | 'indeterminate';
export type PeerDeliveryKind = 'wake' | 'steer' | 'follow_up';
export type RequestResolutionCode = 'request_delivery_failed' | 'request_dispatch_indeterminate' | 'recipient_closed' | 'request_timeout';
export type DirectControlAction = 'interrupt';
export type DirectControlStatus = 'accepted' | 'sending' | 'aborted' | 'refused' | 'failed' | 'indeterminate';
export type CorrelatedRequestStatus = 'pending' | 'replied' | 'refused' | 'cancelled' | 'delivery_failed' | 'delivery_indeterminate' | 'timed_out';
export declare function isPeerEventStatus(value: unknown): value is PeerEventStatus;
export declare function isCorrelatedRequestStatus(value: unknown): value is CorrelatedRequestStatus;
export type DeclaredSource = 'spawn' | 'self' | 'owner' | 'operator';
export interface DeclaredField<T> {
    value: T;
    source: DeclaredSource;
    updatedAtMs: number;
}
export interface ExpertCard {
    role?: DeclaredField<string>;
    focus?: DeclaredField<string>;
    expertise?: DeclaredField<string[]>;
    publishedRefs?: DeclaredField<string[]>;
    lastUpdatedAtMs: number;
}
export type SchedulerPrincipal = {
    kind: 'operator';
} | {
    kind: 'agent';
    agentId: string;
};
export interface ExpertCardInput {
    role?: string;
    focus?: string;
    expertise?: string[];
    publishedRefs?: string[];
}
export interface AgentMetadataPatch {
    displayName?: string;
    assignment?: string;
    ownershipBoundary?: string;
    role?: string | null;
    focus?: string | null;
    expertise?: string[] | null;
    publishedRefs?: string[] | null;
}
export interface AgentConfigurationChange {
    changeId: string;
    kind: 'model' | 'thinking' | 'extensions';
    value?: string;
    provider?: string;
    thinking?: string;
    extensions?: string[];
    extensionSources?: string[];
    runtimeOwner: string;
    status: 'dispatching' | 'indeterminate';
    createdSeq: number;
}
export interface AgentRecord {
    agentId: string;
    parentId: string | null;
    segment: string;
    lifecycle: 'open' | 'closed';
    cwd: string;
    displayName: DeclaredField<string>;
    assignment: DeclaredField<string>;
    ownershipBoundary: DeclaredField<string>;
    expertCard: ExpertCard;
    sessionId?: string;
    sessionDir?: string;
    sessionFile?: string;
    provider?: string;
    model?: string;
    thinking?: string;
    completionMode?: 'default' | 'notify_only';
    spawnHash: string;
    context: AgentContextRecord;
    launch: AgentLaunchRecord;
    capabilities: CapabilityEnvelope;
    spawnGrant?: {
        spawn?: boolean;
        maxDepth?: number;
        extensions?: string[];
    };
    pendingConfiguration?: AgentConfigurationChange;
    runtimeOwner?: string;
    runtimePhase?: 'starting' | 'ready';
    runtimeManagerPid?: number;
    runtimeHostname?: string;
    runtimePid?: number;
    runtimeSeq?: number;
    attention?: {
        kind: 'failed' | 'needs_attention';
        code: string;
        seq: number;
    };
    continuedAfterSeq?: number;
    createdSeq: number;
    closedSeq?: number;
    archive?: {
        archived: boolean;
        seq: number;
    };
}
export interface ActivationRecord {
    activationId: string;
    agentId: string;
    leaseToken: string;
    state: ActivationState;
    inputKind: string;
    startedSeq: number;
    terminalSeq?: number;
}
export interface PeerEventRecord {
    lane: Exclude<MailboxLane, 'direct'>;
    eventId: string;
    bridgeRequestId: string;
    requestHash: string;
    origin: PeerEventOrigin;
    senderId: string;
    recipientId: string;
    traceId: string;
    causationId?: string;
    sourceActivationId?: string;
    targetActivationId?: string;
    afterControlId?: string;
    kind: PeerEventKind;
    requestId?: string;
    resolutionCode?: RequestResolutionCode;
    systemType?: SystemEventType;
    dedupeKey?: string;
    mode: PeerEventMode;
    message?: string;
    payloadHash?: string;
    payloadBytes?: number;
    status: PeerEventStatus;
    acceptedSeq: number;
    acceptedAtMs: number;
    attemptId?: string;
    activationId?: string;
    deliveryKind?: PeerDeliveryKind;
    attemptSeq?: number;
    consumedSeq?: number;
    terminalSeq?: number;
    outcomeCode?: string;
}
export interface CorrelatedRequestRecord {
    requestId: string;
    traceId: string;
    requesterId: string;
    recipientId: string;
    requestEventId: string;
    createdSeq: number;
    deadlineAtMs?: number;
    terminalEventId?: string;
}
export type WatchStatus = 'active' | 'triggered' | 'cancelled';
export interface WatchRecord {
    watchId: string;
    ownerId: string;
    requestHash: string;
    requestIds?: string[];
    agentIds?: string[];
    eventKinds?: PeerEventKind[];
    owned?: boolean;
    status: WatchStatus;
    createdSeq: number;
    createdAtMs?: number;
    registeringActivationId?: string;
    causalInputs?: string[];
    terminalSeq?: number;
    triggerEventId?: string;
}
export interface DirectControlRecord {
    lane: 'direct';
    controlId: string;
    requestId: string;
    requestHash: string;
    issuer: SchedulerPrincipal;
    targetId: string;
    activationId: string;
    action: 'interrupt';
    status: DirectControlStatus;
    acceptedSeq: number;
    attemptId?: string;
    deliveryKind?: 'interrupt';
    attemptSeq?: number;
    consumedSeq?: number;
    terminalSeq?: number;
    outcomeCode?: string;
}
export interface SchedulerState {
    version: 2;
    revision: number;
    nextSeq: number;
    updatedAtMs: number;
    root: {
        rootId: string;
        maxOpenAgents: number;
        maxOpenAgentsSource: 'startup' | 'operator-live';
        maxDepthSource?: 'startup' | 'operator-live';
        maxDepth: number;
        agentNames?: string[];
        agentExtensions: Record<string, ManagedExtensionState>;
        serviceGrant: LuminariesServicePermission[];
    };
    agents: Record<string, AgentRecord>;
    activations: Record<string, ActivationRecord>;
    mailbox: Record<string, MailboxRecord>;
    requests: Record<string, CorrelatedRequestRecord>;
    watches: Record<string, WatchRecord>;
}
export type MailboxRecord = PeerEventRecord | DirectControlRecord;
export declare function isPeerMailboxRecord(record: MailboxRecord | undefined): record is PeerEventRecord;
export declare function isDirectMailboxRecord(record: MailboxRecord | undefined): record is DirectControlRecord;
export declare function peerMailboxRecords(state: Readonly<SchedulerState>): PeerEventRecord[];
export declare function directMailboxRecords(state: Readonly<SchedulerState>): DirectControlRecord[];
/** Ephemeral per-snapshot lookup shape; rebuilt per commit or scan, never persisted. */
export interface SchedulerActivityIndex {
    peerByRecipient: Map<string, PeerEventRecord[]>;
    peerBySender: Map<string, PeerEventRecord[]>;
    directByTarget: Map<string, DirectControlRecord[]>;
    activationsByAgent: Map<string, ActivationRecord[]>;
}
export declare function buildActivityIndex(state: Readonly<SchedulerState>): SchedulerActivityIndex;
export declare function mailboxActivationIds(state: Readonly<SchedulerState>): Set<string>;
export declare function peerMailboxRecord(state: Readonly<SchedulerState>, eventId: string): PeerEventRecord | undefined;
export declare function isStartingInputEvent(state: Readonly<SchedulerState>, event: Pick<PeerEventRecord, 'recipientId' | 'senderId' | 'kind' | 'mode' | 'acceptedSeq'>): boolean;
export declare function directMailboxRecord(state: Readonly<SchedulerState>, controlId: string): DirectControlRecord | undefined;
export declare function openCollaboratorCount(state: Readonly<SchedulerState>): number;
export declare function agentDepth(state: Readonly<SchedulerState>, agentId: string): number;
export declare function agentPath(state: Readonly<SchedulerState>, agentId: string): string;
export declare function mailboxRecordSeq(record: Readonly<MailboxRecord>): number;
export declare function activationSeq(activation: Readonly<ActivationRecord>): number;
export declare function requestStatus(state: Readonly<SchedulerState>, request: Readonly<CorrelatedRequestRecord>): CorrelatedRequestStatus;
export declare function requestSeq(state: Readonly<SchedulerState>, request: Readonly<CorrelatedRequestRecord>): number;
export declare function watchSeq(watch: Readonly<WatchRecord>): number;
export declare function agentRuntimePhase(state: Readonly<SchedulerState>, agent: Readonly<AgentRecord>): AgentRuntimePhase;
export declare function canContinuePastIndeterminate(state: Readonly<SchedulerState>, agentId: string, additionalRecords?: readonly MailboxRecord[]): boolean;
export declare function indeterminateContinuationActivationId(state: Readonly<SchedulerState>, agentId: string): string | undefined;
export declare function isContinuableIndeterminateEvidence(record: Readonly<MailboxRecord>, agentId: string, boundary: number, activationId?: string): boolean;
export declare function agentRuntimeState(state: Readonly<SchedulerState>, agent: Readonly<AgentRecord>): AgentRuntimeState;
export declare function agentSeq(state: Readonly<SchedulerState>, agent: Readonly<AgentRecord>): number;
export interface SchedulerBootstrap {
    rootId: string;
    cwd: string;
    maxOpenAgents?: number;
    maxDepth?: number;
    agentNames?: string[];
    agentExtensions?: Record<string, ManagedExtensionState>;
    serviceGrant?: LuminariesServicePermission[];
    provider?: string;
    model?: string;
    thinking?: string;
    capabilities?: CapabilityEnvelope;
}
export interface AdmitAgentInput {
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
    expertCard?: ExpertCardInput;
    provider?: string;
    model?: string;
    thinking?: string;
    spawnHash?: string;
    context?: AgentContextRecord;
    launch?: AgentLaunchRecord;
    grants?: CapabilityRequest;
}
export interface SchedulerCommit<T> {
    value: T;
    revision: number;
    warnings: readonly string[];
    affectedRecipientIds: readonly string[];
}
export interface SchedulerStartup {
    created: boolean;
    staleActivations: readonly string[];
    staleMailbox: readonly string[];
    staleConfigurations: readonly string[];
    staleRuntimeOwners: readonly string[];
    warnings: readonly string[];
}
export interface AgentMailboxProjection {
    count: number;
    bytes: number;
}
export declare function projectAgentMailbox(state: Readonly<SchedulerState>, agentId: string): AgentMailboxProjection;
export declare class SchedulerStateError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: {
        cause?: unknown;
    });
}
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function normalizeAgentLaunch(value: unknown, label?: string): AgentLaunchRecord;
export declare function normalizeAgentContext(value: unknown, label?: string): AgentContextRecord;
export declare function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void;
export declare function integer(value: unknown, minimum: number, maximum: number, label: string): number;
export declare function text(value: unknown, label: string, maximum?: number): string;
export declare function nonemptyText(value: unknown, label: string): string;
export declare function id(value: unknown, label: string): string;
export declare function within(child: string, parent: string): boolean;
export declare function absolutePath(value: unknown, label: string): string;
export declare function optionalText(value: unknown, label: string, maximum?: number): string | undefined;
export declare function textList(value: unknown, label: string, itemMaximum: number): string[];
export declare function humanFacingText(value: unknown, label: string, maximum?: number): string;
export declare function humanFacingProse(value: unknown, label: string, maximum?: number): string;
export declare function humanFacingTextList(value: unknown, label: string, itemMaximum?: number): string[];
export declare function idList(value: unknown, label: string): string[];
export declare function normalizePrincipal(value: unknown): SchedulerPrincipal;
export declare function isStrictAncestor(state: SchedulerState, candidateId: string, targetId: string): boolean;
export declare function sha256(value: string | Uint8Array): string;
export declare function deepFreeze<T>(value: T): T;
export declare function nextSequence(state: SchedulerState): number;
export declare function startActivationState(state: SchedulerState, agentId: string, inputKind: string): {
    changed: true;
    value: ActivationRecord;
};
export declare function discardActivationBeforeWriteState(state: SchedulerState, activationId: string, leaseToken: string): {
    changed: boolean;
    value: ActivationRecord;
};
export declare function finishActivationState(state: SchedulerState, activationId: string, leaseToken: string, outcome: Exclude<ActivationState, 'running'>): {
    changed: boolean;
    value: ActivationRecord;
};
export declare function assertActivationLease(activation: ActivationRecord | undefined, leaseToken: string): asserts activation is ActivationRecord;
export declare function mailboxRecordId(record: Readonly<MailboxRecord>): string;
export declare function beginMailboxAttemptState(state: SchedulerState, records: readonly MailboxRecord[], input: {
    attemptId: string;
    activationId: string;
    deliveryKind: PeerDeliveryKind | 'interrupt';
}): number;
export declare function releaseMailboxAttemptState(state: SchedulerState, records: readonly MailboxRecord[], attemptId: string): {
    changed: boolean;
    value: MailboxRecord[];
};
export declare function consumeMailboxAtBoundaryState(state: SchedulerState, records: readonly MailboxRecord[], attemptId: string): {
    changed: boolean;
    value: MailboxRecord[];
};
export declare function terminalizeMailboxRecordState(state: SchedulerState, record: DirectControlRecord, status: 'aborted' | 'refused' | 'failed' | 'indeterminate', code: string): {
    changed: boolean;
    value: DirectControlRecord;
};
export declare function terminalizeMailboxRecordState(state: SchedulerState, record: PeerEventRecord, status: 'settled' | 'aborted' | 'refused' | 'failed' | 'indeterminate', code: string): {
    changed: boolean;
    value: PeerEventRecord;
};
export declare function assertSessionNamespaceAvailable(state: SchedulerState, sessionDir: string, sessionId: string, excludeAgentId?: string): void;
export declare function assertSessionFileAvailable(state: SchedulerState, sessionFile: string, excludeAgentId?: string): void;
export declare function referenceTargetsPrivateState(reference: string, state: SchedulerState, cwd: string, statePath?: string, extraSessionDir?: string): boolean;
export declare function bootstrapState(input: SchedulerBootstrap): SchedulerState;
