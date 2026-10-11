import type { CapabilityRequest } from './capability-policy.ts';
import { type ConfigurationInput } from './configuration-policy.ts';
import { type ActivationRecord, type ActivationState, type DirectControlAction, type DirectControlRecord, type DirectControlStatus, type AdmitAgentInput, type AgentConfigurationChange, type AgentMetadataPatch, type AgentRecord, type AgentRuntimeState, type PeerEventMode, type PeerEventRecord, type SchedulerBootstrap, type SchedulerCommit, type SchedulerPrincipal, type SchedulerStartup, type SchedulerState, type WatchRecord, type MailboxRecord } from './scheduler-state.ts';
import { type RootPolicyInput } from './tree-policy.ts';
import { type SystemEventInput } from './system-event-policy.ts';
import { type WatchInput } from './watch-policy.ts';
import { type PeerDispatchPlan, type PeerEventAuth, type PeerEventRequest, type PeerRouteReceipt } from './peer-event-policy.ts';
import { type DirectControlAdmission, type DirectControlInput } from './direct-control-policy.ts';
import { type CorrelatedCancelInput, type CorrelatedReplyInput, type CorrelatedRequestInput, type CorrelatedRequestReceipt } from './request-policy.ts';
export { SchedulerStateError } from './scheduler-state.ts';
export { validateSchedulerState } from './scheduler-state-validation.ts';
export type { ActivationRecord, ActivationState, AdmitAgentInput, AgentMetadataPatch, AgentRecord, AgentRuntimeState, CorrelatedRequestRecord, CorrelatedRequestStatus, DirectControlAction, DirectControlRecord, DirectControlStatus, DeclaredField, DeclaredSource, ExpertCard, ExpertCardInput, PeerDeliveryKind, PeerEventKind, PeerEventMode, PeerEventOrigin, PeerEventRecord, PeerEventStatus, RequestResolutionCode, SchedulerBootstrap, SchedulerCommit, SchedulerPrincipal, SchedulerStartup, SchedulerState, SystemEventType, WatchRecord, WatchStatus, } from './scheduler-state.ts';
export type { DirectControlAdmission, DirectControlInput } from './direct-control-policy.ts';
export type { PeerDispatchPlan, PeerEventAuth, PeerEventRequest, PeerRouteReceipt } from './peer-event-policy.ts';
export type { CorrelatedCancelInput, CorrelatedReplyInput, CorrelatedRequestInput, CorrelatedRequestReceipt, } from './request-policy.ts';
export interface PeerMulticastInput {
    bridgeRequestId: string;
    recipientIds: readonly string[];
    message: string;
    mode?: PeerEventMode;
    causationId?: string;
}
export interface CorrelatedMulticastInput extends PeerMulticastInput {
    mode?: 'default' | 'follow_up';
    deadlineAtMs?: number;
}
export interface AgentStartingInputReceipt {
    agent: AgentRecord;
    duplicate: boolean;
}
export type SchedulerMailboxIntent = {
    kind: 'admit_direct';
    input: DirectControlInput;
    requestedBy: SchedulerPrincipal;
} | {
    kind: 'begin_delivery';
    recordId: string;
    runtimeOwner: string;
} | {
    kind: 'release_delivery';
    recordId: string;
    attemptId: string;
    settlement?: {
        activationId: string;
        leaseToken: string;
        outcome: Exclude<ActivationState, 'running'>;
    };
} | {
    kind: 'admit_boundary';
    recordId: string;
    attemptId: string;
    aborted?: boolean;
} | {
    kind: 'finish_delivery';
    recordId: string;
    attemptId: string;
    status: Extract<DirectControlStatus, 'refused' | 'failed' | 'indeterminate'>;
    outcomeCode: string;
} | {
    kind: 'reconcile_delivery';
    recordId: string;
};
/** Serialized durable persistence facade. Tree and directory policy live in dedicated pure modules. */
export declare class SchedulerStore {
    readonly statePath: string;
    readonly startup: SchedulerStartup;
    readonly deliveryPayloadDirectory: string;
    private readonly log;
    private state;
    private readonly closedCatalog;
    private readonly noReplayCatalog;
    private closedCatalogRevisionValue;
    private operations;
    private readonly pendingMutations;
    private resourceClosing;
    private readonly diagnosticsRing;
    private readonly changeListeners;
    private constructor();
    static open(options: {
        statePath: string;
        bootstrap?: SchedulerBootstrap;
    }): Promise<SchedulerStore>;
    snapshot(): Readonly<SchedulerState>;
    get diagnostics(): readonly string[];
    get closedCatalogRevision(): number;
    closedCatalogSnapshot(): {
        revision: number;
        agents: readonly AgentRecord[];
    };
    indeterminateEvidenceSnapshot(agentIds: readonly string[]): readonly MailboxRecord[];
    onChange(listener: (revision: number, affectedRecipientIds: readonly string[]) => void): () => void;
    releaseClosedRuntime(agentIdInput: string, runtimeOwnerInput: string): Promise<void>;
    closedAgentLineage(agentIdInput: string): Promise<readonly AgentRecord[]>;
    directControlReceipt(requestIdInput: string, action: DirectControlAction, requestedBy: SchedulerPrincipal): Promise<Readonly<DirectControlRecord> | undefined>;
    reconcileRootPolicy(input: RootPolicyInput): Promise<SchedulerCommit<AgentRecord>>;
    reconcileRootHostFacts(input: Pick<RootPolicyInput, 'provider' | 'model' | 'thinking'>): Promise<SchedulerCommit<AgentRecord>>;
    setRootCapacity(capacity: number): Promise<SchedulerCommit<AgentRecord>>;
    setRootDepth(depth: number): Promise<SchedulerCommit<AgentRecord>>;
    approveRootExtension(specifierInput: string, pathsInput: readonly string[], signal?: AbortSignal): Promise<SchedulerCommit<AgentRecord>>;
    reconcileManagedExtensionSelections(entriesInput: readonly {
        specifier: string;
        state: 'always' | 'allow' | 'deny';
        paths: readonly string[];
    }[]): Promise<SchedulerCommit<AgentRecord>>;
    private setRootLimits;
    setAgentCapabilities(targetIdInput: string, request: CapabilityRequest, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<AgentRecord>>;
    applyOfflineConfiguration(input: ConfigurationInput, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<AgentRecord>>;
    beginLiveConfiguration(input: ConfigurationInput, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<AgentConfigurationChange | undefined>>;
    finishLiveConfiguration(targetId: string, changeId: string, outcome: 'applied' | 'refused' | 'indeterminate'): Promise<SchedulerCommit<AgentRecord>>;
    updateAgentMetadata(targetIdInput: string, patchInput: AgentMetadataPatch, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<AgentRecord>>;
    closeAgent(targetIdInput: string, requestedBy: SchedulerPrincipal, options?: {
        subtree?: boolean;
    }, signal?: AbortSignal): Promise<SchedulerCommit<readonly string[]>>;
    resumeAgent(targetIdInput: string, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<AgentRecord>>;
    resumeArchivedAgent(targetIdInput: string, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<AgentRecord>>;
    setAgentArchived(targetIdInput: string, archived: boolean, requestedBy: SchedulerPrincipal): Promise<SchedulerCommit<readonly string[]>>;
    admitAgent(input: AdmitAgentInput, requestedBy: SchedulerPrincipal): Promise<SchedulerCommit<AgentRecord>>;
    admitAgentWithStartingInput(input: AdmitAgentInput, requestedBy: SchedulerPrincipal, auth: PeerEventAuth, startingInput: Omit<PeerEventRequest, 'message'>, startingMessage: (agent: Readonly<AgentRecord>, state: Readonly<SchedulerState>) => string, signal?: AbortSignal): Promise<SchedulerCommit<AgentStartingInputReceipt>>;
    bindSession(agentIdInput: string, sessionFileInput: string): Promise<SchedulerCommit<AgentRecord>>;
    claimRuntime(agentIdInput: string, managerPidInput: number, hostnameInput: string): Promise<SchedulerCommit<AgentRecord>>;
    markRuntimeSpawned(agentIdInput: string, runtimeOwnerInput: string, runtimePidInput: number): Promise<SchedulerCommit<AgentRecord>>;
    markRuntimeReady(agentIdInput: string, runtimeOwnerInput: string, runtimePidInput: number): Promise<SchedulerCommit<AgentRecord>>;
    releaseRuntime(agentIdInput: string, runtimeOwnerInput: string, runtimeState: Exclude<AgentRuntimeState, 'running' | 'waiting' | 'starting'>, kind?: string): Promise<SchedulerCommit<AgentRecord>>;
    markAgentContinuedAfterIndeterminate(agentIdInput: string, requestedBy: SchedulerPrincipal): Promise<SchedulerCommit<AgentRecord>>;
    setAgentAttention(agentIdInput: string, attention: 'failed' | 'needs_attention', code: string): Promise<SchedulerCommit<AgentRecord>>;
    startActivation(agentIdInput: string, inputKindInput: string): Promise<SchedulerCommit<ActivationRecord>>;
    markRootNativeInput(): Promise<SchedulerCommit<ActivationRecord | undefined>>;
    finishActivation(activationIdInput: string, leaseTokenInput: string, outcome: Exclude<ActivationState, 'running'>): Promise<SchedulerCommit<ActivationRecord>>;
    finishActivationIfRunning(activationIdInput: string, leaseTokenInput: string, outcome: Exclude<ActivationState, 'running'>, deferWhileSending?: boolean): Promise<SchedulerCommit<ActivationRecord | undefined>>;
    applyMailboxIntent(intent: Extract<SchedulerMailboxIntent, {
        kind: 'admit_direct';
    }>, signal?: AbortSignal): Promise<SchedulerCommit<DirectControlAdmission>>;
    applyMailboxIntent(intent: Extract<SchedulerMailboxIntent, {
        kind: 'begin_delivery';
    }>, signal?: AbortSignal): Promise<SchedulerCommit<DirectControlRecord | PeerDispatchPlan | undefined>>;
    applyMailboxIntent(intent: Extract<SchedulerMailboxIntent, {
        kind: 'release_delivery';
    }>, signal?: AbortSignal): Promise<SchedulerCommit<PeerEventRecord>>;
    applyMailboxIntent(intent: Extract<SchedulerMailboxIntent, {
        kind: 'admit_boundary';
    }>, signal?: AbortSignal): Promise<SchedulerCommit<DirectControlRecord | PeerEventRecord>>;
    applyMailboxIntent(intent: Extract<SchedulerMailboxIntent, {
        kind: 'finish_delivery';
    }>, signal?: AbortSignal): Promise<SchedulerCommit<DirectControlRecord | PeerEventRecord>>;
    applyMailboxIntent(intent: Extract<SchedulerMailboxIntent, {
        kind: 'reconcile_delivery';
    }>, signal?: AbortSignal): Promise<SchedulerCommit<DirectControlRecord | PeerEventRecord>>;
    admitPeerEvent(auth: PeerEventAuth, request: PeerEventRequest, expectedActivationIdInput?: string, afterControlIdInput?: string, signal?: AbortSignal): Promise<SchedulerCommit<PeerRouteReceipt>>;
    /**
     * One durable operator admission: peer-event acceptance plus continuation
     * clearing for the target in the same transaction. Operator authority is
     * enforced here; agents and services use the generic admission paths.
     */
    admitOperatorInput(auth: PeerEventAuth, request: PeerEventRequest, expectedActivationIdInput?: string, signal?: AbortSignal): Promise<SchedulerCommit<PeerRouteReceipt>>;
    admitPeerEventAfterInterrupt(controlIdInput: string, attemptIdInput: string, auth: PeerEventAuth, request: PeerEventRequest, signal?: AbortSignal): Promise<SchedulerCommit<{
        control: DirectControlRecord;
        route: PeerRouteReceipt;
    }>>;
    admitSystemEvent(input: SystemEventInput): Promise<SchedulerCommit<PeerRouteReceipt>>;
    admitPeerMulticast(auth: PeerEventAuth, input: PeerMulticastInput, signal?: AbortSignal): Promise<SchedulerCommit<readonly PeerRouteReceipt[]>>;
    acceptCorrelatedMulticast(auth: PeerEventAuth, input: CorrelatedMulticastInput, signal?: AbortSignal): Promise<SchedulerCommit<readonly CorrelatedRequestReceipt[]>>;
    acceptCorrelatedRequest(auth: PeerEventAuth, input: CorrelatedRequestInput, signal?: AbortSignal): Promise<SchedulerCommit<CorrelatedRequestReceipt>>;
    timeoutCorrelatedRequest(requestId: string, nowMs?: number): Promise<SchedulerCommit<CorrelatedRequestReceipt | undefined>>;
    acceptCorrelatedReply(auth: PeerEventAuth, input: CorrelatedReplyInput, signal?: AbortSignal): Promise<SchedulerCommit<CorrelatedRequestReceipt>>;
    acceptCorrelatedCancel(auth: PeerEventAuth, input: CorrelatedCancelInput, signal?: AbortSignal): Promise<SchedulerCommit<CorrelatedRequestReceipt>>;
    registerWatch(input: WatchInput, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<WatchRecord>>;
    cancelWatch(watchId: string, requestedBy: SchedulerPrincipal, signal?: AbortSignal): Promise<SchedulerCommit<WatchRecord>>;
    retireSurfacedNotifications(): Promise<SchedulerCommit<number>>;
    close(): Promise<boolean>;
    materializeDeliveryPayload(eventIdInput: string): Promise<void>;
    removeDeliveryPayload(eventId: string): Promise<void>;
    private hydrateClosedLineage;
    private hydrateAllClosed;
    private hydrateIndeterminate;
    private mutate;
    private flushMutations;
    private addDiagnostic;
}
