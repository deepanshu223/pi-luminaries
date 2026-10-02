import { type CapabilityEnvelope } from './capability-policy.ts';
import { type ParentContextSnapshot } from './context-session.ts';
import { type PiSessionChoice, type PiSessionHost } from './pi-session-host.ts';
import { type ModelDescriptor } from './spawn-configuration.ts';
import type { AcceptedBuild } from './accepted-build.ts';
import { type LuminariesConversationReset, type LuminariesConversationUpdate } from './agent-conversations.ts';
import { DurablePiActor } from './actor-runtime.ts';
import { type LuminariesCommandCenterAgent, type LuminariesCommandCenterProjection } from './command-center-projection.ts';
import { PeerBridgeServer, type PeerBridgeBinding, type PeerBridgeToolCall } from './peer-bridge.ts';
import { SchedulerStore } from './scheduler-store.ts';
import { type LuminariesToolCommand, type LuminariesToolHost, type LuminariesToolName, type LuminariesReceipt, type LuminariesToolResult } from './luminaries-tools.ts';
import { type PiInvocation } from './pi-rpc.ts';
import { type RootTransport } from './root-runtime.ts';
import { type ManagedExtensionHost, type ManagedExtensionSource, type RootConfigurationSnapshot } from './root-configuration.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
type ManagerState = 'new' | 'starting' | 'running' | 'closing' | 'closed';
export interface LuminariesSessionBinding {
    sessionId: string;
    sessionFile: string;
    cwd: string;
    generation: string;
}
export interface LuminariesHostFacts {
    provider?: string;
    model?: string;
    thinking?: string;
    models: readonly ModelDescriptor[];
    startupPrompt: string;
    activeToolTokens: number;
}
export type LuminariesParentTransport = RootTransport;
export interface LuminariesManagerOptions extends Partial<LuminariesSessionBinding> {
    sessionId?: string;
    sessionFile?: string;
    cwd?: string;
    generation?: string;
    statePath?: string;
    agentDir?: string;
    rootId?: string;
    maxOpenAgents?: number;
    maxDepth?: number;
    agentNames?: string[];
    invocation?: PiInvocation;
    acceptedBuild?: AcceptedBuild;
    provider?: string;
    model?: string;
    thinking?: string;
    capabilities?: CapabilityEnvelope;
    rootConfiguration?: RootConfigurationSnapshot;
    managedExtensionHost?: ManagedExtensionHost;
    models?: readonly ModelDescriptor[];
    startupPrompt?: string;
    activeToolTokens?: number;
    currentHostFacts?: () => LuminariesHostFacts;
    setRootModel?: (provider: string, modelId: string) => Promise<boolean>;
    setRootThinking?: (level: string) => Promise<boolean>;
    sessionHost?: PiSessionHost;
    parentContextSnapshot?: (mode: 'recent' | 'fork', requestId: string, toolCallId?: string) => Promise<ParentContextSnapshot> | ParentContextSnapshot;
    operatorContextSnapshot?: () => Promise<ParentContextSnapshot> | ParentContextSnapshot;
    childExtension?: string;
    env?: NodeJS.ProcessEnv;
    rootTransport?: LuminariesParentTransport;
    idleParkDelayMs?: number;
}
export interface LuminariesParentCaller {
    kind: 'parent';
    mode: 'tui' | 'rpc' | 'json' | 'print';
    agentId: string;
    rootId: string;
    runtimeOwner: string;
    generation: string;
    sessionId: string;
    sessionFile: string;
    cwd: string;
}
export interface LuminariesChildCaller {
    kind: 'child';
    agentId: string;
    rootId: string;
    runtimeOwner: string;
    generation: string;
    sessionId?: string;
}
export interface LuminariesServiceCaller {
    kind: 'service';
    serviceId: typeof LUMINARIES_IDENTITY.serviceId;
    agentId: string;
    rootId: string;
    runtimeOwner: string;
    generation: string;
}
export interface LuminariesOperatorCaller {
    kind: 'operator';
    agentId: string;
    rootId: string;
    runtimeOwner: string;
    generation: string;
}
export type LuminariesCaller = LuminariesParentCaller | LuminariesChildCaller | LuminariesServiceCaller | LuminariesOperatorCaller;
export interface LuminariesRootSummary {
    revision: number;
    rootId: string;
    openAgents: number;
    workingAgents: number;
    waitingAgents: number;
    attentionAgents: number;
}
export interface AdoptSessionOptions {
    name?: string;
    assignment?: string;
    expertise?: string[];
}
export interface DetachedSessionResult {
    sourceAgentId: string;
    sourceLifecycle: 'closed';
    sessionId: string;
    sessionFile: string;
    sessionName: string;
    command: string;
}
export interface DetachedSessionNotReadyResult {
    status: 'not_ready';
    message: string;
}
export type DetachedSessionOutcome = DetachedSessionResult | DetachedSessionNotReadyResult;
export interface AdoptedSessionResult {
    sourceSessionFile: string;
    agentId: string;
    handle: string;
    sessionId: string;
}
export type AdoptionSessionPreview = Pick<PiSessionChoice, 'sessionFile' | 'sessionId' | 'cwd' | 'name'>;
export declare function luminariesStatePathForSession(input: Pick<LuminariesSessionBinding, 'sessionId'> & Pick<LuminariesManagerOptions, 'statePath' | 'agentDir' | 'rootId'>): string;
/** One session-scoped owner of Luminaries's Store, actors, bridge, and delivery fabric. */
export declare class LuminariesManager {
    private readonly options;
    private readonly generation;
    private state;
    private session?;
    private startPromise?;
    private closePromise?;
    private closeRequested;
    private storeValue?;
    private recipientDrainValue?;
    private bridgeValue?;
    private attachmentValue?;
    private attachmentPathValue?;
    private actorPoolValue?;
    private configurationValue?;
    private managedExtensionsValue?;
    private extensionPolicyOperation;
    private readonly extensionPolicyAbort;
    private deadlinesValue?;
    private supervisionValue?;
    private rootRuntimeValue?;
    private rootTransport?;
    private readonly spawnRequests;
    private readonly detachRequests;
    private readonly adoptRequests;
    private conversationsValue?;
    private commandCenterProjectionValue?;
    private commandCenterRevision;
    private commandCenterProjectionPending?;
    private commandCenterActivityVersion;
    private lastProjectionScheduleKey?;
    private commandCenterStoreUnsubscribe?;
    private readonly commandCenterActorSubscriptions;
    private readonly commandCenterListeners;
    private readonly diagnosticsRing;
    constructor(options: LuminariesManagerOptions);
    get lifecycle(): ManagerState;
    get generationId(): string;
    get store(): SchedulerStore;
    get bridge(): PeerBridgeServer;
    private get actorPool();
    private get recipientDrain();
    private get configuration();
    private get rootRuntime();
    get actors(): ReadonlyMap<string, DurablePiActor>;
    get diagnostics(): readonly string[];
    private hostFacts;
    start(binding?: LuminariesSessionBinding): Promise<void>;
    isRunning(): boolean;
    close(): Promise<void>;
    setParentTransport(transport: LuminariesParentTransport | undefined): void;
    refreshRootHostFacts(): Promise<void>;
    hostForParent(context: unknown): LuminariesToolHost;
    hostForService(): LuminariesToolHost;
    hostForOperator(): LuminariesToolHost;
    operatorExecute(toolName: LuminariesToolName, input: unknown, operationId?: string): Promise<LuminariesToolResult>;
    operatorSetCapacity(capacity: number, operationId?: string): Promise<void>;
    operatorSetDepth(depth: number, operationId?: string): Promise<void>;
    operatorParkAll(_mode: 'safe' | 'now', operationId?: string): Promise<void>;
    operatorDetachSession(agentIdInput: string, operationId?: string): Promise<DetachedSessionOutcome>;
    private detachSessionOnce;
    operatorSessions(): Promise<readonly PiSessionChoice[]>;
    operatorAdoptSession(sessionReferenceInput: string, options?: AdoptSessionOptions, operationId?: string): Promise<AdoptedSessionResult>;
    operatorInspectSessionReference(sessionReferenceInput: string): Promise<AdoptionSessionPreview>;
    private resolveAdoptionReference;
    private inspectAdoptionSource;
    private adoptSessionOnce;
    operatorClosedHistory(): Promise<{
        revision: number;
        agents: readonly LuminariesCommandCenterAgent[];
        archivedCount: number;
    }>;
    operatorSetArchived(agentId: string, archived: boolean, operationId?: string): Promise<void>;
    operatorResume(agentId: string, operationId?: string): Promise<void>;
    attachmentInvocation(): string;
    operatorModels(): readonly ModelDescriptor[];
    operatorThinkingLevels(): readonly string[];
    operatorSelectableExtensions(): readonly {
        specifier: string;
        source: string;
    }[];
    operatorExtensionSources(): readonly ManagedExtensionSource[];
    operatorApproveExtension(specifier: string, scope: ManagedExtensionSource['scope'], install: boolean, operationId?: string): Promise<void>;
    commandCenterProjection(): LuminariesCommandCenterProjection;
    private projectCommandCenter;
    private rootConfigurationForProjection;
    onCommandCenterChange(listener: (projection: LuminariesCommandCenterProjection) => void): () => void;
    rootSummary(): LuminariesRootSummary;
    onRootSummaryChange(listener: (summary: LuminariesRootSummary) => void): () => void;
    onAgentConversationChange(agentIdInput: string, listener: (update: LuminariesConversationUpdate) => void): () => void;
    agentConversationSnapshot(agentIdInput: string): LuminariesConversationReset;
    private bindCommandCenterActor;
    private scheduleCommandCenterProjection;
    private publishCommandCenterProjection;
    operatorInput(targetIdInput: string, messageInput: string, mode: 'auto' | 'follow_up', operationId?: string): Promise<'woken' | 'steered' | 'follow_up_queued'>;
    operatorInterrupt(targetIdInput: string, operationId?: string): Promise<'interrupted' | 'already_finished'>;
    /** Callback used by the authenticated child bridge; caller identity is binding-derived. */
    handleBridgeTool(binding: Readonly<PeerBridgeBinding>, call: PeerBridgeToolCall, signal: AbortSignal): Promise<LuminariesReceipt>;
    parentBeforeAgentStart(prompt: string): Promise<void>;
    parentAgentStart(): Promise<void>;
    parentMessageStart(message: unknown): Promise<void>;
    parentMessageUpdate(event: unknown): void;
    parentMessageEnd(message: unknown): void;
    parentAgentSettled(outcome?: 'settled' | 'aborted' | 'failed' | 'indeterminate'): Promise<void>;
    executeForCaller(caller: LuminariesCaller, command: LuminariesToolCommand, signal: AbortSignal | undefined, toolCallId?: string, parentContext?: ParentContextSnapshot): Promise<LuminariesReceipt>;
    private startImpl;
    private closeImpl;
    private reconcileStartupEvidence;
    private parentContextForSpawn;
    private prepareSpawn;
    private resolveManagedExtensions;
    private managedExtensions;
    private selectedExtensions;
    private spawn;
    private spawnOnce;
    private directory;
    private message;
    private control;
    private assertSignalActive;
    private interruptInGate;
    private deliveryPort;
    private configurationControl;
    private grantControl;
    private lifecycleControl;
    private awaitRequests;
    private assertServiceAccess;
    private humanIdentity;
    /** Derived once per operation; multicast legs reuse the same identity tables. */
    private operationIdentityTables;
    private stateWithAgents;
    private snapshotWithClosedAgents;
    private resolveAttachmentAgent;
    private resolveAgentId;
    private messageResult;
    private controlResult;
    private spawnReceiptResult;
    private publishPermissionDecision;
    private result;
    private acknowledgeInputAfterIndeterminate;
    private ensureSourceActivation;
    private finishSourceActivation;
    private liveActivation;
    private parentCaller;
    private childCaller;
    private assertPersistentParent;
    private assertCaller;
    private auth;
    private principal;
    private serviceCaller;
    private operatorCaller;
    private statePath;
    private childSessionRoot;
    private cleanupOrphanSpawnArtifacts;
    private rootId;
    private requiredRootRuntimeOwner;
    private requiredSession;
    private selectSession;
    private assertSession;
    private operationId;
    private operatorRequestId;
    private isDescendant;
    private assertRunning;
    private addDiagnostic;
}
export {};
