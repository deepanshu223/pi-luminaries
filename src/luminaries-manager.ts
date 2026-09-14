import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { deriveAgentHandles, deriveAgentShortIds, resolveAgentReference } from './agent-identity.ts';
import { readdir, realpath, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import {
  CapabilityError,
  THINKING_LEVELS,
  capabilityAllowsCwd,
  normalizeCapabilityRequest,
  sameCapabilityCwd,
  type CapabilityEnvelope,
  type CapabilityRequest,
} from './capability-policy.ts';
import { AgentConfigurationCoordinator } from './configuration-runtime.ts';
import { planContextLaunch, type ParentContextSnapshot } from './context-session.ts';
import { appendSpawnCallContext } from './parent-context.ts';
import type { PiSessionChoice, PiSessionHost, PiSessionInfo } from './pi-session-host.ts';
import { RequestDeadlineCoordinator } from './request-deadlines.ts';
import { SupervisionCoordinator } from './supervision.ts';
import {
  resolveSpawnConfiguration,
  type EffectiveSpawnConfiguration,
  type ModelDescriptor,
} from './spawn-configuration.ts';
import { dirname, join, resolve } from 'node:path';
import { LuminariesActorPool } from './actor-pool.ts';
import type { AcceptedBuild } from './accepted-build.ts';
import {
  AgentConversationStreams,
  type LuminariesConversationReset,
  type LuminariesConversationUpdate,
} from './agent-conversations.ts';
import { DurablePiActor } from './actor-runtime.ts';
import { projectCompactAgentSummary, projectCompactDirectory, type CompactDirectoryAgent } from './agent-directory.ts';
import {
  projectCommandCenter,
  projectTranscriptInspection,
  type LuminariesCommandCenterAgent,
  type LuminariesCommandCenterProjection,
} from './command-center-projection.ts';
import {
  buildBytePage,
  decodeProjectionCursor,
  PUBLIC_RESULT_BYTES,
  type ProjectionCursorScope,
} from './public-pagination.ts';
import { PeerBridgeServer, type PeerBridgeBinding, type PeerBridgeToolCall } from './peer-bridge.ts';
import { RecipientDrain, waitForPiEvidence, type DeliveryPort, type PiInterruptAttempt } from './peer-delivery.ts';
import type { PeerEventAuth, PeerRouteReceipt } from './peer-event-policy.ts';
import {
  SchedulerStateError,
  SchedulerStore,
  type ActivationRecord,
  type AgentRecord,
  type DirectControlRecord,
  type SchedulerPrincipal,
} from './scheduler-store.ts';
import {
  directMailboxRecords,
  deepFreeze,
  agentRuntimeState,
  agentSeq,
  mailboxRecordSeq,
  openCollaboratorCount,
  requestSeq,
  requestStatus,
  watchSeq,
  isLuminariesId,
  isRecord,
  isStrictAncestor,
  isDirectMailboxRecord,
  humanFacingProse,
  humanFacingText,
  humanFacingTextList,
  nonemptyText,
  peerMailboxRecords,
  referenceTargetsPrivateState,
  sha256,
  TERMINAL_PEER_EVENT_STATUSES,
  type PeerEventRecord,
  type SchedulerState,
} from './scheduler-state.ts';
import {
  formatLuminariesToolResult,
  normalizeLuminariesToolCommand,
  type LuminariesDirectoryRequest,
  type LuminariesAwaitRequest,
  type LuminariesControlRequest,
  type LuminariesMessageRequest,
  type LuminariesSpawnRequest,
  type LuminariesToolCommand,
  type LuminariesToolHost,
  type LuminariesToolName,
  type LuminariesReceipt,
  type LuminariesToolResult,
} from './luminaries-tools.ts';
import { PiRpcCommandError, type PiInvocation } from './pi-rpc.ts';
import { preparePrivateDisplayPaths, sanitizePreparedDisplayText } from './display-sanitizer.ts';
import { RootRuntime, type RootTransport } from './root-runtime.ts';
import {
  selectedManagedExtensionSpecifiers,
  type ManagedExtensionHost,
  type ManagedExtensionPolicy,
  type ManagedExtensionSource,
  type LuminariesServicePermission,
  type RootConfigurationSnapshot,
} from './root-configuration.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { processAlive } from './process-liveness.ts';
import { LuminariesAttachmentServer } from './attachment.ts';
import { hasUnsafeHumanFacingControl, isUuid } from './identifiers.ts';
import { projectAgentHealth } from './health-policy.ts';
import { assertPhysicalReferencesPublic, validatePhysicalSessionNamespace } from './private-path-policy.ts';
import { admissionDisplayName } from './tree-policy.ts';

const TOOL = LUMINARIES_IDENTITY.tools;
const PRODUCT = LUMINARIES_IDENTITY.label;
const DEFAULT_MAX_OPEN_AGENTS = 10;
const DEFAULT_MAX_DEPTH = 1;
const MAX_RESULT_BYTES = PUBLIC_RESULT_BYTES;
const CHILD_SESSION_ROOT = 'sessions';

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
  parentContextSnapshot?: (
    mode: 'recent' | 'fork',
    requestId: string,
    toolCallId?: string,
  ) => Promise<ParentContextSnapshot> | ParentContextSnapshot;
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
export type LuminariesCaller =
  LuminariesParentCaller | LuminariesChildCaller | LuminariesServiceCaller | LuminariesOperatorCaller;

export interface LuminariesRootSummary {
  revision: number;
  rootId: string;
  openAgents: number;
  workingAgents: number;
  waitingAgents: number;
  attentionAgents: number;
}

interface PreparedSpawn {
  cwd: string;
  provider?: string;
  model?: string;
  thinking?: string;
  context: AgentRecord['context'];
  launch: AgentRecord['launch'];
  grants?: CapabilityRequest;
  seededSessionFile: string;
}
interface SpawnReceipt {
  fingerprint: string;
  displayName: string;
  promise: Promise<LuminariesReceipt>;
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

function standaloneSessionId(seed: string): string {
  const value = sha256(seed);
  const variant = ((Number.parseInt(value[16] ?? '0', 16) & 3) | 8).toString(16);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${variant}${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
export interface AdoptedSessionResult {
  sourceSessionFile: string;
  agentId: string;
  handle: string;
  sessionId: string;
}
export type AdoptionSessionPreview = Pick<PiSessionChoice, 'sessionFile' | 'sessionId' | 'cwd' | 'name'>;
interface DetachRequest {
  fingerprint: string;
  promise: Promise<DetachedSessionOutcome>;
}
interface AdoptRequest {
  fingerprint: string;
  promise: Promise<AdoptedSessionResult>;
}

async function canonicalLaunchResources(
  configuration: EffectiveSpawnConfiguration,
  capabilities: CapabilityEnvelope,
): Promise<EffectiveSpawnConfiguration> {
  const canonicalize = async (
    values: readonly string[] | undefined,
    allowed: readonly string[] | undefined,
    label: string,
  ): Promise<string[] | undefined> => {
    if (values === undefined) return undefined;
    const result: string[] = [];
    for (const value of values) {
      let canonical: string;
      try {
        canonical = resolve(await realpath(value));
      } catch (error) {
        throw new SchedulerStateError('resource_unavailable', `${label} '${value}' cannot be resolved`, {
          cause: error,
        });
      }
      if (allowed ? !allowed.includes(canonical) : !capabilityAllowsCwd(capabilities, canonical))
        throw new SchedulerStateError(
          'capability_denied',
          `${label} '${canonical}' is outside the physical allowed limits`,
        );
      result.push(canonical);
    }
    return [...new Set(result)].sort();
  };
  let cwd: string;
  try {
    cwd = resolve(await realpath(configuration.cwd));
  } catch (error) {
    throw new SchedulerStateError(
      'cwd_unavailable',
      `Working directory '${configuration.cwd}' does not exist. Choose an existing authorized directory or omit cwd to use the parent's working directory.`,
      { cause: error },
    );
  }
  if (!capabilityAllowsCwd(capabilities, cwd))
    throw new SchedulerStateError('capability_denied', `Working directory '${cwd}' is outside the authorized paths`);
  const extensions = await canonicalize(configuration.extensions, capabilities.extensions, 'Extension');
  const skills = await canonicalize(configuration.skills, capabilities.skills, 'Skill');
  const promptTemplates = await canonicalize(
    configuration.promptTemplates,
    capabilities.promptTemplates,
    'Prompt template',
  );
  const themes = await canonicalize(configuration.themes, capabilities.themes, 'Theme');
  return {
    ...configuration,
    cwd,
    ...(extensions === undefined ? {} : { extensions }),
    ...(skills === undefined ? {} : { skills }),
    ...(promptTemplates === undefined ? {} : { promptTemplates }),
    ...(themes === undefined ? {} : { themes }),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
function receiptWireBytes(
  toolCallId: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
  terminate = false,
): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        v: 1,
        ok: true,
        toolCallId,
        result: { message, details, ...(terminate ? { terminate: true } : {}) },
      }),
    ) + 1
  );
}
function isTerminalActivation(state: ActivationRecord['state']): boolean {
  return state === 'settled' || state === 'aborted' || state === 'failed' || state === 'indeterminate';
}
function isTerminalControlStatus(status: DirectControlRecord['status']): boolean {
  return status === 'aborted' || status === 'refused' || status === 'failed' || status === 'indeterminate';
}
function servicePermission(command: LuminariesToolCommand): LuminariesServicePermission {
  if (command.toolName === TOOL.spawn) return 'spawn';
  if (command.toolName === TOOL.directory) return 'directory';
  if (command.toolName === TOOL.message) return 'message';
  if (command.toolName === TOOL.await) return 'watch';
  const action = command.input.action;
  if (
    action === 'steer' ||
    action === 'follow_up' ||
    action === 'interrupt' ||
    action === 'close' ||
    action === 'close_subtree' ||
    action === 'resume' ||
    action === 'set_model' ||
    action === 'set_thinking' ||
    action === 'set_extensions' ||
    action === 'set_grants'
  )
    return action;
  throw new SchedulerStateError('authority_denied', `Waves service cannot use control action '${action}'`);
}
function idFrom(value: string, label: string): string {
  if (!isLuminariesId(value)) throw new SchedulerStateError('input_invalid', `${label} is invalid`);
  return value;
}
function unresolvedAgentReference(identities: readonly { agentId: string; displayName: string }[], reference: string) {
  const normalized = reference.trim().toLowerCase();
  const nameMatches = identities.filter((identity) => identity.displayName.trim().toLowerCase() === normalized);
  if (nameMatches.length > 1) {
    const handles = deriveAgentHandles(identities);
    const choices = nameMatches.map((identity) => handles.get(identity.agentId) ?? identity.agentId).join('; ');
    return new SchedulerStateError(
      'agent_ambiguous',
      `Luminary '${reference}' is ambiguous. Use an exact handle or stable ID: ${choices}`,
    );
  }
  return new SchedulerStateError(
    'agent_missing',
    `No luminary matches '${reference}'. Use Root, a short ID, a unique name, an exact Name · shortId handle, or a full stable ID.`,
  );
}
function publicId(prefix: string, input: string): string {
  return `${prefix}-${sha256(input).slice(0, 40)}`;
}
function luminariesRootIdForSession(input: Pick<LuminariesSessionBinding, 'sessionId'>): string {
  return publicId(`${LUMINARIES_IDENTITY.namespace.publicIdPrefix}root`, input.sessionId);
}
export function luminariesStatePathForSession(
  input: Pick<LuminariesSessionBinding, 'sessionId'> &
    Pick<LuminariesManagerOptions, 'statePath' | 'agentDir' | 'rootId'>,
): string {
  if (input.statePath) return resolve(input.statePath);
  const agentDir = input.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const rootId = input.rootId ? idFrom(input.rootId, 'rootId') : luminariesRootIdForSession(input);
  return resolve(
    agentDir,
    LUMINARIES_IDENTITY.namespace.stateDirectory,
    LUMINARIES_IDENTITY.namespace.rootsDirectory,
    rootId,
    'state.json',
  );
}
function mutationAgentReceipt(
  state: Readonly<SchedulerState>,
  agent: Readonly<AgentRecord>,
  status: string = agentRuntimeState(state, agent),
  identity?: { displayName: string; shortId?: string; humanHandle: string },
): Record<string, unknown> {
  return {
    agentId: agent.agentId,
    parentId: agent.parentId,
    durableSeq: agentSeq(state, agent),
    status,
    ...(identity ?? {}),
  };
}
function humanIdentityInState(
  state: Pick<SchedulerState, 'agents' | 'root'>,
  agentId: string,
): { displayName: string; shortId?: string; humanHandle: string } | undefined {
  const agent = state.agents[agentId];
  if (!agent) return undefined;
  if (agent.agentId === state.root.rootId) return { displayName: 'Root', humanHandle: 'Root' };
  const identities = Object.values(state.agents).map((candidate) => ({
    agentId: candidate.agentId,
    displayName: candidate.agentId === state.root.rootId ? 'Root' : candidate.displayName.value,
  }));
  const shortId = deriveAgentShortIds(identities.map((identity) => identity.agentId)).get(agentId) ?? agentId;
  const humanHandle = deriveAgentHandles(identities).get(agentId) ?? `${agent.displayName.value} · ${shortId}`;
  return { displayName: agent.displayName.value, shortId, humanHandle };
}
function collaboratorBootstrap(collaborator: string, spawner: string): string {
  return `You are ${collaborator}, a ${PRODUCT} collaborator spawned by ${spawner}. Your expert card is the public summary collaborators use to discover your current focus, expertise, and useful outputs; keep it current when those materially change.`;
}
function truncateBytes(value: string, maximum: number): { value: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(value);
  if (originalBytes <= maximum) return { value, truncated: false, originalBytes };
  let result = value.slice(0, maximum);
  while (Buffer.byteLength(result) > maximum) result = result.slice(0, -1);
  return { value: result, truncated: true, originalBytes };
}
function splitTextByBytes(value: string, maximum: number): string[] {
  if (Buffer.byteLength(value) <= maximum) return [value];
  const chunks: string[] = [];
  let parts: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (parts.length && bytes + characterBytes > maximum) {
      chunks.push(parts.join(''));
      parts = [];
      bytes = 0;
    }
    parts.push(character);
    bytes += characterBytes;
  }
  if (parts.length) chunks.push(parts.join(''));
  return chunks;
}
function receiptFacts(details: Readonly<Record<string, unknown>>, includeStatus = true): Record<string, unknown> {
  const keys = [
    'action',
    'view',
    'status',
    'agentId',
    'targetId',
    'controlId',
    'eventId',
    'traceId',
    'correlationId',
    'watchId',
    'durableSeq',
  ];
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === 'status' && !includeStatus) continue;
    const value = details[key];
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isSafeInteger(value))
    )
      result[key] = value;
  }
  return result;
}

function commandCenterActivityKey(event: unknown): string | undefined {
  if (!isRecord(event) || typeof event.type !== 'string') return undefined;
  if (event.type === 'thinking_start') return 'thinking';
  if (event.type === 'message_update' && isRecord(event.assistantMessageEvent))
    return event.assistantMessageEvent.type === 'thinking_start' ||
      event.assistantMessageEvent.type === 'thinking_delta' ||
      event.assistantMessageEvent.type === 'thinking_end'
      ? 'thinking'
      : 'writing';
  if (event.type === 'message_update' && isRecord(event.message) && event.message.role === 'assistant')
    return 'writing';
  if (event.type === 'message_end' && isRecord(event.message)) return `message:${String(event.message.role)}`;
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end')
    return `${event.type}:${typeof event.toolCallId === 'string' ? event.toolCallId : ''}`;
  if (event.type === 'agent_settled' || event.type === 'agent_end') return event.type;
  return undefined;
}

/** One session-scoped owner of Luminaries's Store, actors, bridge, and delivery fabric. */
export class LuminariesManager {
  private readonly options: LuminariesManagerOptions;
  private readonly generation: string;
  private state: ManagerState = 'new';
  private session?: LuminariesSessionBinding;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closeRequested = false;
  private storeValue?: SchedulerStore;
  private recipientDrainValue?: RecipientDrain;
  private bridgeValue?: PeerBridgeServer;
  private attachmentValue?: LuminariesAttachmentServer;
  private attachmentPathValue?: string;
  private actorPoolValue?: LuminariesActorPool;
  private configurationValue?: AgentConfigurationCoordinator;
  private managedExtensionsValue?: ManagedExtensionPolicy;
  private extensionPolicyOperation: Promise<void> = Promise.resolve();
  private readonly extensionPolicyAbort = new AbortController();
  private deadlinesValue?: RequestDeadlineCoordinator;
  private supervisionValue?: SupervisionCoordinator;
  private rootRuntimeValue?: RootRuntime;
  private rootTransport?: LuminariesParentTransport;
  private readonly spawnRequests = new Map<string, SpawnReceipt>();
  private readonly detachRequests = new Map<string, DetachRequest>();
  private readonly adoptRequests = new Map<string, AdoptRequest>();
  private conversationsValue?: AgentConversationStreams;
  private commandCenterProjectionValue?: LuminariesCommandCenterProjection;
  private commandCenterRevision = 0;
  private commandCenterProjectionPending?: NodeJS.Immediate;
  private commandCenterActivityVersion = 0;
  private lastProjectionScheduleKey?: string;
  private commandCenterStoreUnsubscribe?: () => void;
  private readonly commandCenterActorSubscriptions = new Map<
    string,
    { actor: DurablePiActor; unsubscribe: () => void; activityKey?: string }
  >();
  private readonly commandCenterListeners = new Set<(projection: LuminariesCommandCenterProjection) => void>();
  private readonly diagnosticsRing: string[] = [];

  constructor(options: LuminariesManagerOptions) {
    this.options = {
      ...options,
      ...(options.rootConfiguration
        ? { rootConfiguration: deepFreeze(structuredClone(options.rootConfiguration)) }
        : {}),
    };
    this.generation = options.generation ?? randomUUID();
    this.rootTransport = options.rootTransport;
  }

  get lifecycle(): ManagerState {
    return this.state;
  }
  get generationId(): string {
    return this.generation;
  }
  get store(): SchedulerStore {
    if (!this.storeValue) throw new Error(`${PRODUCT} manager has not started`);
    return this.storeValue;
  }
  get bridge(): PeerBridgeServer {
    if (!this.bridgeValue) throw new Error(`${PRODUCT} manager has not started`);
    return this.bridgeValue;
  }
  private get actorPool(): LuminariesActorPool {
    if (!this.actorPoolValue) throw new Error(`${PRODUCT} manager actor pool has not started`);
    return this.actorPoolValue;
  }
  private get recipientDrain(): RecipientDrain {
    if (!this.recipientDrainValue) throw new Error(`${PRODUCT} recipient drain has not started`);
    return this.recipientDrainValue;
  }
  private get configuration(): AgentConfigurationCoordinator {
    if (!this.configurationValue) throw new Error(`${PRODUCT} configuration coordinator has not started`);
    return this.configurationValue;
  }
  private get rootRuntime(): RootRuntime {
    if (!this.rootRuntimeValue) throw new Error(`${PRODUCT} root runtime has not started`);
    return this.rootRuntimeValue;
  }
  get actors(): ReadonlyMap<string, DurablePiActor> {
    return this.actorPoolValue?.actors ?? new Map();
  }
  get diagnostics(): readonly string[] {
    return [
      ...this.diagnosticsRing,
      ...(this.storeValue?.diagnostics ?? []),
      ...(this.recipientDrainValue?.diagnostics ?? []),
    ];
  }

  private hostFacts(): LuminariesHostFacts {
    return (
      this.options.currentHostFacts?.() ?? {
        ...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(this.options.thinking === undefined ? {} : { thinking: this.options.thinking }),
        models: this.options.models ?? [],
        startupPrompt: this.options.startupPrompt ?? '',
        activeToolTokens: this.options.activeToolTokens ?? 0,
      }
    );
  }

  async start(binding?: LuminariesSessionBinding): Promise<void> {
    if (this.state === 'running') {
      if (binding) this.assertSession(binding);
      return;
    }
    if (this.state === 'starting' && this.startPromise) return this.startPromise;
    if (this.state === 'closing' || this.state === 'closed') throw new Error(`${PRODUCT} manager is closed`);
    const selected = this.selectSession(binding);
    this.state = 'starting';
    this.startPromise = this.startImpl(selected).catch((error) => {
      if (!this.closeRequested) this.state = 'closed';
      throw error;
    });
    return this.startPromise;
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.state = 'closing';
    const pendingStart = this.startPromise;
    this.closePromise = (async () => {
      await pendingStart?.catch(() => undefined);
      await this.closeImpl();
    })().finally(() => {
      this.state = 'closed';
    });
    return this.closePromise;
  }

  setParentTransport(transport: LuminariesParentTransport | undefined): void {
    this.rootTransport = transport;
    if (this.state !== 'running') return;
    this.recipientDrainValue?.setDormant(this.rootId(), !transport);
    if (transport) this.recipientDrainValue?.hint(this.rootId());
  }

  async refreshRootHostFacts(): Promise<void> {
    this.assertRunning();
    if (!this.options.currentHostFacts) return;
    const facts = this.hostFacts();
    await this.store.reconcileRootHostFacts({
      provider: facts.provider,
      model: facts.model,
      thinking: facts.thinking,
    });
  }

  hostForParent(context: unknown): LuminariesToolHost {
    const caller = this.parentCaller(context);
    return {
      execute: (command, signal, toolCallId) => this.executeForCaller(caller, command, signal, toolCallId),
    };
  }
  hostForService(): LuminariesToolHost {
    const caller = this.serviceCaller();
    return {
      execute: (command, signal) => this.executeForCaller(caller, command, signal),
    };
  }
  hostForOperator(): LuminariesToolHost {
    const caller = this.operatorCaller();
    return {
      execute: (command, signal) => {
        if (
          command.toolName === TOOL.await ||
          (command.toolName === TOOL.message && command.input.action !== 'send' && command.input.action !== 'multicast')
        )
          return Promise.reject(
            new SchedulerStateError('authority_denied', 'The command center does not yield or own agent correlations'),
          );
        return this.executeForCaller(caller, command, signal);
      },
    };
  }
  async operatorExecute(
    toolName: LuminariesToolName,
    input: unknown,
    operationId?: string,
  ): Promise<LuminariesToolResult> {
    this.assertRunning();
    const requestId = this.operatorRequestId(operationId);
    const command = normalizeLuminariesToolCommand(toolName, input, requestId);
    return formatLuminariesToolResult(await this.hostForOperator().execute(command, undefined));
  }
  async operatorSetCapacity(capacity: number, operationId?: string): Promise<void> {
    this.assertRunning();
    await this.refreshRootHostFacts();
    this.operatorRequestId(operationId);
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new SchedulerStateError('input_invalid', 'Collaborator capacity must be a positive finite integer');
    await this.store.setRootCapacity(capacity);
  }
  async operatorSetDepth(depth: number, operationId?: string): Promise<void> {
    this.assertRunning();
    this.operatorRequestId(operationId);
    if (!Number.isSafeInteger(depth) || depth < 1)
      throw new SchedulerStateError('input_invalid', 'Nesting depth must be a positive finite integer');
    await this.store.setRootDepth(depth);
  }
  async operatorParkAll(_mode: 'safe' | 'now', operationId?: string): Promise<void> {
    this.assertRunning();
    this.operatorRequestId(operationId);
    await this.actorPool.parkAll(_mode);
  }
  async operatorDetachSession(agentIdInput: string, operationId?: string): Promise<DetachedSessionOutcome> {
    this.assertRunning();
    const requestId = this.operatorRequestId(operationId);
    const resolved = await this.resolveAttachmentAgent(agentIdInput);
    const agentId = resolved.agentId;
    const fingerprint = sha256(JSON.stringify({ agentId }));
    const active = this.detachRequests.get(requestId);
    if (active) {
      if (active.fingerprint !== fingerprint)
        throw new SchedulerStateError('command_id_reuse', `Detach operation '${requestId}' was reused`);
      return active.promise;
    }
    const promise = this.detachSessionOnce(agentId);
    const request = { fingerprint, promise };
    this.detachRequests.set(requestId, request);
    try {
      return await promise;
    } finally {
      if (this.detachRequests.get(requestId) === request) this.detachRequests.delete(requestId);
    }
  }

  private async detachSessionOnce(agentId: string): Promise<DetachedSessionOutcome> {
    const resolved = await this.resolveAttachmentAgent(agentId);
    const state = resolved.state;
    const agent = state.agents[agentId];
    if (!agent || agent.parentId === null || !agent.sessionFile)
      throw new SchedulerStateError('agent_unavailable', `Collaborator '${agentId}' cannot be detached`);
    if (
      agent.lifecycle === 'open' &&
      (Object.values(state.activations).some(
        (activation) => activation.agentId === agentId && activation.state === 'running',
      ) ||
        agent.pendingConfiguration ||
        peerMailboxRecords(state).some(
          (event) => event.recipientId === agentId && (event.status === 'sending' || event.status === 'consumed'),
        ) ||
        directMailboxRecords(state).some(
          (control) =>
            control.targetId === agentId &&
            control.status !== 'aborted' &&
            control.status !== 'refused' &&
            control.status !== 'failed' &&
            control.status !== 'indeterminate',
        ))
    )
      return {
        status: 'not_ready',
        message: `${this.humanIdentity(agentId)?.humanHandle ?? 'This expert'} is still working. Standalone handoff is available when it is Ready or Parked.`,
      };
    const sessionHost = this.options.sessionHost;
    if (!sessionHost) throw new SchedulerStateError('context_unavailable', 'Pi session handoff is unavailable');
    if (agent.lifecycle === 'open') {
      const closed = await this.store.closeAgent(agentId, { kind: 'operator' }, { subtree: false });
      await Promise.all(closed.value.map((id) => this.actorPool.closeAgent(id)));
    } else await this.actorPool.closeAgent(agentId);
    const retained = (await this.store.closedAgentLineage(agentId)).find((candidate) => candidate.agentId === agentId);
    if (!retained?.sessionFile || retained.closedSeq === undefined)
      throw new SchedulerStateError('state_invalid', `Closed collaborator '${agentId}' has no retained session`);
    if (retained.runtimeOwner)
      throw new SchedulerStateError(
        'recovery_required',
        `The closed collaborator's prior Pi writer is not proven stopped; resume the owning Root to finish cleanup before retrying detach`,
      );
    const handoffId = publicId(
      `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}handoff`,
      `${this.rootId()}:${agentId}:${retained.closedSeq}`,
    );
    let fork: Awaited<ReturnType<PiSessionHost['forkSession']>>;
    const sessionName = `${retained.displayName.value} · standalone`;
    try {
      fork = await sessionHost.forkSession({
        sourceFile: retained.sessionFile,
        targetCwd: retained.cwd,
        sessionId: standaloneSessionId(handoffId),
        operationId: handoffId,
        kind: 'detach',
        contextNote: `${retained.displayName.value} was detached from Luminaries. Earlier Luminaries identity and ownership messages are retained history; this is now an ordinary standalone Pi session.`,
        destinationName: sessionName,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SchedulerStateError(
        'session_handoff_failed',
        `The Luminaries source is closed with its history retained, but the standalone Pi fork was not completed: ${detail}. Open its actions and retry detach.`,
        { cause: error },
      );
    }
    const command = `pi --session ${fork.sessionId}`;
    return {
      sourceAgentId: agentId,
      sourceLifecycle: 'closed',
      sessionId: fork.sessionId,
      sessionFile: fork.sessionFile,
      sessionName,
      command,
    };
  }

  async operatorSessions(): Promise<readonly PiSessionChoice[]> {
    this.assertRunning();
    const sessionHost = this.options.sessionHost;
    if (!sessionHost) throw new SchedulerStateError('context_unavailable', 'Pi session discovery is unavailable');
    const state = this.store.snapshot();
    const root = state.agents[state.root.rootId];
    if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
    const current = this.requiredSession();
    return (await sessionHost.listSessions()).filter(
      (session) =>
        session.sessionId !== current.sessionId &&
        resolve(session.sessionFile) !== current.sessionFile &&
        !referenceTargetsPrivateState(session.sessionFile, state, root.cwd, this.store.statePath),
    );
  }

  async operatorAdoptSession(
    sessionReferenceInput: string,
    options: AdoptSessionOptions = {},
    operationId?: string,
  ): Promise<AdoptedSessionResult> {
    this.assertRunning();
    const requestId = this.operatorRequestId(operationId);
    const sourceFile = await this.resolveAdoptionReference(sessionReferenceInput);
    const normalized = {
      ...(options.name === undefined ? {} : { name: humanFacingText(options.name, 'name') }),
      assignment: humanFacingProse(options.assignment ?? 'Continue the adopted Pi session.', 'assignment'),
      ...(options.expertise === undefined ? {} : { expertise: humanFacingTextList(options.expertise, 'expertise') }),
    };
    const fingerprint = sha256(JSON.stringify({ sourceFile, normalized }));
    const active = this.adoptRequests.get(requestId);
    if (active) {
      if (active.fingerprint !== fingerprint)
        throw new SchedulerStateError('command_id_reuse', `Adopt operation '${requestId}' was reused`);
      return active.promise;
    }
    const promise = this.adoptSessionOnce(sourceFile, normalized, requestId);
    const request = { fingerprint, promise };
    this.adoptRequests.set(requestId, request);
    try {
      return await promise;
    } finally {
      if (this.adoptRequests.get(requestId) === request) this.adoptRequests.delete(requestId);
    }
  }

  async operatorInspectSessionReference(sessionReferenceInput: string): Promise<AdoptionSessionPreview> {
    this.assertRunning();
    const source = await this.inspectAdoptionSource(
      await this.resolveAdoptionReference(sessionReferenceInput),
      sessionReferenceInput,
    );
    return {
      sessionFile: source.sessionFile,
      sessionId: source.sessionId,
      cwd: source.cwd,
      ...(source.name ? { name: source.name } : {}),
    };
  }

  private async resolveAdoptionReference(sessionReferenceInput: string): Promise<string> {
    const root = this.store.snapshot().agents[this.rootId()];
    if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
    const reference = nonemptyText(sessionReferenceInput, 'session');
    if (reference.includes('/') || reference.includes('\\') || reference.endsWith('.jsonl'))
      return resolve(root.cwd, reference);
    const matches = (await this.operatorSessions()).filter((session) => session.sessionId === reference);
    if (matches.length > 1)
      throw new SchedulerStateError(
        'session_ambiguous',
        `Pi session '${reference}' is ambiguous; use its exact file path`,
      );
    const sourceFile = matches[0]?.sessionFile;
    if (!sourceFile)
      throw new SchedulerStateError(
        'session_missing',
        `Pi session '${reference}' is unavailable; choose it from the session list or enter an exact file path`,
      );
    return sourceFile;
  }

  private async inspectAdoptionSource(sourceFile: string, reference = sourceFile): Promise<PiSessionInfo> {
    const sessionHost = this.options.sessionHost;
    if (!sessionHost) throw new SchedulerStateError('context_unavailable', 'Pi session handoff is unavailable');
    const root = this.store.snapshot().agents[this.rootId()];
    if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
    if (referenceTargetsPrivateState(sourceFile, this.store.snapshot(), root.cwd, this.store.statePath))
      throw new SchedulerStateError(
        'private_reference',
        'Adopt requires an ordinary Pi session outside Luminaries state',
      );
    let source: PiSessionInfo;
    try {
      source = await sessionHost.inspectSession(sourceFile);
    } catch (error) {
      throw new SchedulerStateError(
        'session_missing',
        `Pi session '${reference}' could not be opened. Choose it from the session list or enter an existing session-file path.`,
        { cause: error },
      );
    }
    if (referenceTargetsPrivateState(source.sessionFile, this.store.snapshot(), root.cwd, this.store.statePath))
      throw new SchedulerStateError(
        'private_reference',
        'Adopt requires an ordinary Pi session outside Luminaries state',
      );
    return source;
  }

  private async adoptSessionOnce(
    sourceFile: string,
    options: { name?: string; assignment: string; expertise?: string[] },
    requestId: string,
  ): Promise<AdoptedSessionResult> {
    const root = this.store.snapshot().agents[this.rootId()];
    if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
    const sessionHost = this.options.sessionHost;
    if (!sessionHost) throw new SchedulerStateError('context_unavailable', 'Pi session handoff is unavailable');
    const source = await this.inspectAdoptionSource(sourceFile);
    const fingerprint = sha256(
      JSON.stringify({ sourceSessionFile: source.sessionFile, rootId: this.rootId(), options }),
    );
    const agentId = publicId(
      `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}agent`,
      `adopt:${this.rootId()}:${requestId}`,
    );
    const existing = this.store.snapshot().agents[agentId];
    if (existing) {
      if (existing.spawnHash !== fingerprint)
        throw new SchedulerStateError('command_id_reuse', `Adopt operation '${requestId}' was reused`);
      const identity = this.humanIdentity(agentId);
      if (!identity)
        throw new SchedulerStateError('state_invalid', `Adopted collaborator '${agentId}' has no identity`);
      return {
        sourceSessionFile: source.sessionFile,
        agentId,
        handle: identity.humanHandle,
        sessionId: existing.sessionId ?? '',
      };
    }
    const model = source.model ? `${source.model.provider}/${source.model.modelId}` : undefined;
    const thinking = THINKING_LEVELS.find((level) => level === source.thinking);
    const configuration = await canonicalLaunchResources(
      resolveSpawnConfiguration({
        input: { context: 'fresh', ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) },
        parentCapabilities: root.capabilities,
        parentCwd: root.cwd,
        parentProvider: root.provider,
        parentModel: root.model,
        parentThinking: root.thinking,
        models: this.hostFacts().models,
        managedExtensions: this.managedExtensions(),
      }),
      root.capabilities,
    );
    const sessionId = publicId(`${LUMINARIES_IDENTITY.namespace.publicIdPrefix}session`, `adopt:${requestId}`);
    const sessionDir = join(this.childSessionRoot(), agentId);
    const displayName = admissionDisplayName(this.store.snapshot(), options.name ?? source.name);
    let forked = false;
    try {
      const fork = await sessionHost.forkSession({
        sourceFile: source.sessionFile,
        targetCwd: root.cwd,
        targetSessionDir: sessionDir,
        sessionId,
        operationId: requestId,
        kind: 'adopt',
        contextNote: `This Pi session was adopted into Luminaries as ${displayName}, owned by Root. Current mandate: ${options.assignment}`,
        destinationName: displayName,
      });
      forked = true;
      const estimate = Math.ceil(Buffer.byteLength(JSON.stringify(source.messages)) / 4);
      await this.store.admitAgent(
        {
          agentId,
          parentId: root.agentId,
          segment: publicId('agent', `adopt:${requestId}:segment`).slice(0, 48),
          cwd: configuration.cwd,
          sessionId,
          sessionDir,
          sessionFile: fork.sessionFile,
          displayName,
          assignment: options.assignment,
          ownershipBoundary: 'Continue this session as a Luminaries collaborator under Root.',
          expertCard: options.expertise ? { expertise: options.expertise } : undefined,
          provider: configuration.provider,
          model: configuration.model,
          thinking: configuration.thinking,
          spawnHash: fingerprint,
          context: {
            mode: 'fork',
            effectiveTokens: estimate,
            estimatedTokens: estimate,
            transferredMessages: source.messages.length,
            omittedMessages: 0,
            ...(configuration.contextWindow ? { targetContextWindow: configuration.contextWindow } : {}),
          },
          launch: {
            noContextFiles: false,
            restrictSkills: false,
            restrictPromptTemplates: false,
            restrictThemes: false,
            extensionSources: [],
            extensions: configuration.extensions ?? [],
            skills: [],
            promptTemplates: [],
            themes: [],
          },
          grants: configuration.grants,
        },
        { kind: 'operator' },
      );
      const identity = this.humanIdentity(agentId);
      if (!identity)
        throw new SchedulerStateError('state_invalid', `Adopted collaborator '${agentId}' has no identity`);
      return {
        sourceSessionFile: source.sessionFile,
        agentId,
        handle: identity.humanHandle,
        sessionId,
      };
    } catch (error) {
      if (forked && !this.store.snapshot().agents[agentId])
        await rm(sessionDir, { recursive: true, force: true }).catch((failure) => this.addDiagnostic(failure));
      throw error;
    }
  }
  async operatorClosedHistory(): Promise<{
    revision: number;
    agents: readonly LuminariesCommandCenterAgent[];
    archivedCount: number;
  }> {
    this.assertRunning();
    const history = this.store.closedCatalogSnapshot();
    const snapshot = this.stateWithAgents(this.store.snapshot(), history.agents);
    const projection = this.projectCommandCenter(snapshot);
    return { revision: history.revision, agents: projection.closedAgents, archivedCount: projection.archivedCount };
  }
  async operatorSetArchived(agentId: string, archived: boolean, operationId?: string): Promise<void> {
    this.assertRunning();
    this.operatorRequestId(operationId);
    await this.store.setAgentArchived(agentId, archived, { kind: 'operator' });
  }
  async operatorResume(agentId: string, operationId?: string): Promise<void> {
    this.assertRunning();
    this.operatorRequestId(operationId);
    const target =
      this.store.snapshot().agents[agentId] ??
      (await this.store.closedAgentLineage(agentId)).find((agent) => agent.agentId === agentId);
    if (target?.lifecycle === 'open') return;
    if (target?.archive?.archived === true) await this.store.resumeArchivedAgent(agentId, { kind: 'operator' });
    else await this.store.resumeAgent(agentId, { kind: 'operator' });
    await this.store.reconcileManagedExtensionSelections(this.managedExtensions().entries);
  }
  attachmentInvocation(): string {
    return `pi --${LUMINARIES_IDENTITY.flags.attach}`;
  }
  operatorModels(): readonly ModelDescriptor[] {
    this.assertRunning();
    const models = this.hostFacts().models;
    const allowed = this.store.snapshot().agents[this.rootId()]?.capabilities.models;
    return allowed === undefined ? models : models.filter((model) => allowed.includes(`${model.provider}/${model.id}`));
  }
  operatorThinkingLevels(): readonly string[] {
    this.assertRunning();
    return this.store.snapshot().agents[this.rootId()]?.capabilities.thinking ?? THINKING_LEVELS;
  }
  operatorSelectableExtensions(): readonly { specifier: string; source: string }[] {
    this.assertRunning();
    return this.managedExtensions()
      .entries.filter((entry) => entry.state === 'allow')
      .map((entry) => ({ specifier: entry.specifier, source: entry.source }));
  }
  operatorExtensionSources(): readonly ManagedExtensionSource[] {
    this.assertRunning();
    return this.options.managedExtensionHost?.sources() ?? [];
  }
  async operatorApproveExtension(
    specifier: string,
    scope: ManagedExtensionSource['scope'],
    install: boolean,
    operationId?: string,
  ): Promise<void> {
    this.assertRunning();
    this.operatorRequestId(operationId);
    const operation = this.extensionPolicyOperation.then(async () => {
      this.assertSignalActive(this.extensionPolicyAbort.signal);
      const host = this.options.managedExtensionHost;
      if (!host) throw new SchedulerStateError('resource_unavailable', 'Pi extension source management is unavailable');
      const approved = await host.approve(specifier, scope, install);
      this.assertSignalActive(this.extensionPolicyAbort.signal);
      const nextPolicy = await host.resolve({
        ...this.store.snapshot().root.agentExtensions,
        [approved.specifier]: 'allow',
      });
      this.assertSignalActive(this.extensionPolicyAbort.signal);
      await this.store.approveRootExtension(approved.specifier, approved.paths, this.extensionPolicyAbort.signal);
      this.managedExtensionsValue = nextPolicy;
      this.scheduleCommandCenterProjection();
    });
    this.extensionPolicyOperation = operation.catch(() => undefined);
    return operation;
  }
  commandCenterProjection(): LuminariesCommandCenterProjection {
    this.assertRunning();
    const projection = this.commandCenterProjectionValue;
    if (!projection) throw new Error(`${PRODUCT} command-center projection is unavailable`);
    return projection;
  }
  private projectCommandCenter(snapshot: Readonly<SchedulerState>): LuminariesCommandCenterProjection {
    const openAgentIds = Object.values(snapshot.agents)
      .filter((agent) => agent.lifecycle === 'open')
      .map((agent) => agent.agentId);
    return projectCommandCenter(
      snapshot,
      this.actors,
      ++this.commandCenterRevision,
      this.rootConfigurationForProjection(),
      this.storeValue?.closedCatalogRevision ?? snapshot.revision,
      this.storeValue?.indeterminateEvidenceSnapshot(openAgentIds) ?? [],
    );
  }

  private rootConfigurationForProjection(): RootConfigurationSnapshot | undefined {
    const configuration = this.options.rootConfiguration;
    if (!configuration) return undefined;
    return { ...configuration, extensions: this.managedExtensions() };
  }
  onCommandCenterChange(listener: (projection: LuminariesCommandCenterProjection) => void): () => void {
    this.assertRunning();
    this.commandCenterListeners.add(listener);
    return () => {
      if (!this.commandCenterListeners.delete(listener) || this.commandCenterListeners.size || this.state !== 'running')
        return;
      void this.store.retireSurfacedNotifications().catch((error) => this.addDiagnostic(error));
    };
  }
  rootSummary(): LuminariesRootSummary {
    this.assertRunning();
    const snapshot = this.store.snapshot();
    const open = Object.values(snapshot.agents).filter((agent) => agent.lifecycle === 'open');
    const collaborators = open.filter((agent) => agent.agentId !== snapshot.root.rootId);
    const waitingIds = new Set(
      Object.values(snapshot.requests)
        .filter((request) => requestStatus(snapshot, request) === 'pending')
        .map((request) => request.requesterId),
    );
    for (const event of peerMailboxRecords(snapshot))
      if (event.status === 'accepted' || event.status === 'sending') waitingIds.add(event.recipientId);
    return {
      revision: snapshot.revision,
      rootId: snapshot.root.rootId,
      openAgents: openCollaboratorCount(snapshot),
      workingAgents: collaborators.filter((agent) => {
        const state = agentRuntimeState(snapshot, agent);
        return state === 'running' || state === 'starting';
      }).length,
      waitingAgents: collaborators.filter(
        (agent) => agentRuntimeState(snapshot, agent) === 'waiting' || waitingIds.has(agent.agentId),
      ).length,
      attentionAgents: open.filter((agent) => projectAgentHealth(snapshot, agent).attention !== 'none').length,
    };
  }
  onRootSummaryChange(listener: (summary: LuminariesRootSummary) => void): () => void {
    this.assertRunning();
    return this.store.onChange(() => listener(this.rootSummary()));
  }
  onAgentConversationChange(
    agentIdInput: string,
    listener: (update: LuminariesConversationUpdate) => void,
  ): () => void {
    this.assertRunning();
    const agentId = idFrom(agentIdInput, 'agentId');
    const conversations = this.conversationsValue;
    if (!conversations) throw new Error(`${PRODUCT} conversation publication has not started`);
    return conversations.subscribe(agentId, listener);
  }
  agentConversationSnapshot(agentIdInput: string): LuminariesConversationReset {
    this.assertRunning();
    const agentId = idFrom(agentIdInput, 'agentId');
    const conversations = this.conversationsValue;
    if (!conversations) throw new Error(`${PRODUCT} conversation publication has not started`);
    return conversations.snapshot(agentId);
  }
  private bindCommandCenterActor(actor: DurablePiActor): void {
    this.conversationsValue?.bindActor(actor);
    const prior = this.commandCenterActorSubscriptions.get(actor.agentId);
    if (prior?.actor === actor) return;
    prior?.unsubscribe();
    const subscription: { actor: DurablePiActor; unsubscribe: () => void; activityKey?: string } = {
      actor,
      unsubscribe: () => undefined,
    };
    subscription.unsubscribe = actor.onUiChange((event) => {
      const activityKey = commandCenterActivityKey(event);
      if (!activityKey || activityKey === subscription.activityKey) return;
      subscription.activityKey = activityKey;
      this.commandCenterActivityVersion++;
      this.scheduleCommandCenterProjection();
    });
    this.commandCenterActorSubscriptions.set(actor.agentId, subscription);
    this.commandCenterActivityVersion++;
    this.scheduleCommandCenterProjection();
  }
  private scheduleCommandCenterProjection(): void {
    if (this.state !== 'running' || this.commandCenterProjectionPending) return;
    // Identical revision-plus-activity keys mean nothing visible changed; skip the rebuild.
    const scheduleKey = `${this.storeValue?.snapshot().revision ?? 0}:${this.commandCenterActivityVersion}`;
    if (scheduleKey === this.lastProjectionScheduleKey) return;
    this.lastProjectionScheduleKey = scheduleKey;
    this.commandCenterProjectionPending = setImmediate(() => {
      this.commandCenterProjectionPending = undefined;
      this.publishCommandCenterProjection();
    });
    this.commandCenterProjectionPending.unref?.();
  }
  private publishCommandCenterProjection(): void {
    if (this.state !== 'running' || !this.storeValue) return;
    for (const [agentId, subscription] of this.commandCenterActorSubscriptions) {
      if (this.actors.get(agentId) === subscription.actor) continue;
      subscription.unsubscribe();
      this.commandCenterActorSubscriptions.delete(agentId);
    }
    const projection = this.projectCommandCenter(this.storeValue.snapshot());
    this.commandCenterProjectionValue = projection;
    for (const listener of this.commandCenterListeners) {
      try {
        listener(projection);
      } catch (error) {
        this.addDiagnostic(error);
      }
    }
  }
  async operatorInput(
    targetIdInput: string,
    messageInput: string,
    mode: 'auto' | 'follow_up',
    operationId?: string,
  ): Promise<'woken' | 'steered' | 'follow_up_queued'> {
    this.assertRunning();
    const targetId = idFrom(targetIdInput, 'targetId');
    const message = nonemptyText(messageInput, 'message');
    const requestId = this.operatorRequestId(operationId);
    const agent = this.store.snapshot().agents[targetId];
    if (!agent || agent.lifecycle !== 'open')
      throw new SchedulerStateError('agent_unavailable', `Collaborator '${targetId}' has no open conversation`);
    const activation = this.liveActivation(targetId);
    if (mode === 'follow_up' && activation?.state !== 'running')
      throw new SchedulerStateError(
        'runtime_unavailable',
        `Collaborator '${targetId}' has no running turn; send an ordinary message instead`,
      );
    const route = await this.store.admitOperatorInput(
      this.auth(this.operatorCaller()),
      {
        bridgeRequestId: requestId,
        recipientId: targetId,
        message,
        mode: mode === 'follow_up' ? 'follow_up' : 'default',
      },
      mode === 'follow_up' ? activation?.activationId : undefined,
    );
    if (route.value.event.status === 'refused')
      throw new SchedulerStateError(
        route.value.event.outcomeCode ?? 'delivery_refused',
        `Input to '${targetId}' was refused${route.value.event.outcomeCode ? ` (${route.value.event.outcomeCode})` : ''}`,
      );
    if (
      route.value.disposition === 'woken' ||
      route.value.disposition === 'steered' ||
      route.value.disposition === 'follow_up_queued'
    )
      return route.value.disposition;
    throw new SchedulerStateError('state_invalid', `Input to '${targetId}' lost its admitted lane disposition`);
  }
  async operatorInterrupt(targetIdInput: string, operationId?: string): Promise<'interrupted' | 'already_finished'> {
    this.assertRunning();
    const targetId = idFrom(targetIdInput, 'targetId');
    const target = this.store.snapshot().agents[targetId];
    if (!target || target.lifecycle !== 'open')
      throw new SchedulerStateError('agent_unavailable', `Collaborator '${targetId}' is unavailable`);
    let control: DirectControlRecord;
    try {
      control = await this.interruptInGate(targetId, { kind: 'operator' }, this.operatorRequestId(operationId));
    } catch (error) {
      const current = this.store.snapshot().agents[targetId];
      if (
        error instanceof SchedulerStateError &&
        error.code === 'runtime_unavailable' &&
        current?.lifecycle === 'open' &&
        !current.attention &&
        !this.liveActivation(targetId)
      )
        return 'already_finished';
      throw error;
    }
    if (control.status !== 'aborted')
      throw new SchedulerStateError(
        control.status === 'indeterminate' ? 'delivery_indeterminate' : 'runtime_unavailable',
        `Interrupt for '${targetId}' ended as ${control.status}`,
      );
    return 'interrupted';
  }

  /** Callback used by the authenticated child bridge; caller identity is binding-derived. */
  async handleBridgeTool(
    binding: Readonly<PeerBridgeBinding>,
    call: PeerBridgeToolCall,
    signal: AbortSignal,
  ): Promise<LuminariesReceipt> {
    this.assertRunning();
    const caller = this.childCaller(binding);
    if (!isLuminariesToolName(call.toolName))
      throw new SchedulerStateError('input_invalid', `Unknown ${PRODUCT} tool '${call.toolName}'`);
    const command = normalizeLuminariesToolCommand(call.toolName, call.input, call.toolCallId);
    let parentContext: ParentContextSnapshot | undefined;
    if (
      command.toolName === TOOL.spawn &&
      (command.input.context === 'recent' || command.input.context === 'fork') &&
      call.parentContext
    ) {
      parentContext = call.parentContext;
    }
    return this.executeForCaller(caller, command, signal, call.toolCallId, parentContext);
  }

  async parentBeforeAgentStart(prompt: string): Promise<void> {
    this.assertRunning();
    if (this.rootRuntime.beforeAgentStartRequiresGate())
      await this.recipientDrain.runRoot(() => this.rootRuntime.beforeAgentStart(prompt));
    else await this.rootRuntime.beforeAgentStart(prompt);
  }
  async parentAgentStart(): Promise<void> {
    this.assertRunning();
    this.recipientDrain.hint(this.rootId());
  }
  async parentMessageStart(message: unknown): Promise<void> {
    this.assertRunning();
    this.rootRuntime.messageStart(message);
  }
  parentMessageUpdate(event: unknown): void {
    if (this.state === 'running') this.rootRuntime.messageUpdate(event);
  }
  parentMessageEnd(message: unknown): void {
    if (this.state === 'running') this.rootRuntime.messageEnd(message);
  }
  async parentAgentSettled(outcome: 'settled' | 'aborted' | 'failed' | 'indeterminate' = 'settled'): Promise<void> {
    this.assertRunning();
    const settlement = this.rootRuntime.agentSettled(outcome);
    if (settlement) await this.recipientDrain.settle(settlement);
  }
  async executeForCaller(
    caller: LuminariesCaller,
    command: LuminariesToolCommand,
    signal: AbortSignal | undefined,
    toolCallId?: string,
    parentContext?: ParentContextSnapshot,
  ): Promise<LuminariesReceipt> {
    this.assertCaller(caller);
    await this.assertServiceAccess(caller, command);
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error(`${PRODUCT} tool execution aborted`);
    try {
      if (command.toolName === TOOL.spawn) {
        return await this.spawn(caller, command.input, signal, toolCallId, parentContext);
      }
      if (command.toolName === TOOL.directory) {
        return await this.directory(caller, command.input, signal);
      }
      if (command.toolName === TOOL.message) {
        if (command.input.action === 'request' || command.input.action === 'request_many')
          this.assertPersistentParent(caller, `${TOOL.message} ${command.input.action}`);
        return await this.message(caller, command.input, signal);
      }
      if (command.toolName === TOOL.control) {
        return await this.control(caller, command.input, signal);
      }
      if (command.input.action === 'wait') this.assertPersistentParent(caller, `${TOOL.await} wait`);
      return await this.awaitRequests(caller, command.input, signal);
    } catch (error) {
      await this.publishPermissionDecision(caller, command.toolName, command.input.requestId, error);
      throw error;
    }
  }

  private async startImpl(binding: LuminariesSessionBinding): Promise<void> {
    this.session = binding;
    const physicalCwd = resolve(await realpath(binding.cwd));
    const statePath = this.statePath(binding);
    const rootId = this.rootId();
    const hostFacts = this.hostFacts();
    const maxOpenAgents =
      this.options.rootConfiguration?.maxOpenAgents ?? this.options.maxOpenAgents ?? DEFAULT_MAX_OPEN_AGENTS;
    const maxDepth = this.options.rootConfiguration?.maxDepth ?? this.options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const agentNames = this.options.rootConfiguration?.agentNames
      ? [...this.options.rootConfiguration.agentNames]
      : this.options.agentNames;
    if (!Number.isSafeInteger(maxOpenAgents) || maxOpenAgents < 1)
      throw new SchedulerStateError('input_invalid', `${PRODUCT} maxOpenAgents must be a positive finite integer`);
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1)
      throw new SchedulerStateError('input_invalid', `${PRODUCT} maxDepth must be a positive finite integer`);
    const store = await SchedulerStore.open({
      statePath,
      bootstrap: {
        rootId,
        cwd: binding.cwd,
        maxOpenAgents,
        maxDepth,
        agentNames,
        provider: hostFacts.provider,
        model: hostFacts.model,
        thinking: hostFacts.thinking,
        capabilities: this.options.capabilities,
        agentExtensions: Object.fromEntries(
          (this.options.rootConfiguration?.extensions.entries ?? []).map((entry) => [entry.specifier, entry.state]),
        ),
        serviceGrant: [...(this.options.rootConfiguration?.serviceGrant ?? [])],
      },
    });
    this.storeValue = store;
    try {
      if (store.snapshot().root.rootId !== rootId)
        throw new SchedulerStateError(
          'session_conflict',
          `Persisted ${PRODUCT} root does not match the parent session binding`,
        );
      const openedState = store.snapshot();
      const openedRoot = openedState.agents[rootId];
      if (!openedRoot)
        throw new SchedulerStateError('state_invalid', `Persisted ${PRODUCT} root collaborator is unavailable`);
      this.managedExtensionsValue = await this.resolveManagedExtensions(openedState.root.agentExtensions);
      await this.cleanupOrphanSpawnArtifacts();
      const capacity = openedState.root.maxOpenAgents;
      const effectiveMaxDepth = openedState.root.maxDepth;
      const effectiveAgentNames = openedState.root.agentNames;
      const configuredCapabilities = this.options.capabilities ?? openedRoot.capabilities;
      const agentRoot = this.options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
      const retiredCwdRoot = resolve(agentRoot, LUMINARIES_IDENTITY.namespace.stateDirectory, 'scratch');
      const closedAgents = store.closedCatalogSnapshot().agents;
      const platformCapabilities = {
        ...configuredCapabilities,
        extensions: [...this.managedExtensionsValue.allowedPaths],
        cwdRoots: [
          ...new Set([
            ...(configuredCapabilities.cwdRoots ?? []).filter((cwd) => !sameCapabilityCwd(cwd, retiredCwdRoot)),
            openedRoot.cwd,
            binding.cwd,
            physicalCwd,
            ...Object.values(openedState.agents).map((agent) => agent.cwd),
            ...closedAgents.map((agent) => agent.cwd),
          ]),
        ],
      };
      await store.reconcileRootPolicy({
        capabilities: {
          ...platformCapabilities,
          spawn: effectiveMaxDepth > 0 && capacity > 0,
          maxDepth: effectiveMaxDepth,
        },
        retiredCwdRoot,
        cwd: binding.cwd,
        maxOpenAgents: capacity,
        maxOpenAgentsSource: openedState.root.maxOpenAgentsSource,
        maxDepth: effectiveMaxDepth,
        agentNames: effectiveAgentNames,
        agentExtensions: openedState.root.agentExtensions,
        serviceGrant: openedState.root.serviceGrant,
        provider: hostFacts.provider,
        model: hostFacts.model,
        thinking: hostFacts.thinking,
      });
      await store.reconcileManagedExtensionSelections(this.managedExtensionsValue.entries);
      await this.reconcileStartupEvidence();
      const rootRuntime = new RootRuntime({
        store,
        rootId,
        incarnation: this.generation,
        transport: () => this.rootTransport,
      });
      this.rootRuntimeValue = rootRuntime;
      const bridge = new PeerBridgeServer({ store, onDiagnostic: (error) => this.addDiagnostic(error) });
      await bridge.start();
      this.bridgeValue = bridge;
      let actorPool: LuminariesActorPool | undefined;
      const recipientDrain = new RecipientDrain({
        store,
        acquirePort: async (agentId): Promise<DeliveryPort> => {
          if (agentId === rootId) return rootRuntime.deliveryPort();
          const extensionChange = this.configurationValue?.extensionChange(agentId);
          if (extensionChange) await extensionChange;
          const agent = store.snapshot().agents[agentId];
          if (!agent || agent.lifecycle !== 'open')
            throw new SchedulerStateError('agent_unavailable', `Collaborator '${agentId}' is not open`);
          if (!actorPool) throw new SchedulerStateError('manager_closed', 'Actor pool is not ready');
          return actorPool.ensure(agent);
        },
        onRecipientIdle: (agentId) => actorPool?.armIdle(agentId),
        onDiagnostic: (error) => this.addDiagnostic(error),
      });
      this.recipientDrainValue = recipientDrain;
      recipientDrain.setDormant(rootId, !this.rootTransport);
      actorPool = new LuminariesActorPool({
        store,
        bridge,
        generation: this.generation,
        acceptedBuild: this.options.acceptedBuild,
        invocation: this.options.invocation,
        provider: hostFacts.provider,
        extension: this.options.childExtension,
        env: this.options.env,
        idleParkDelayMs: this.options.idleParkDelayMs,
        managerRunning: () => this.state === 'running',
        onActorReady: (actor) => this.bindCommandCenterActor(actor),
        onDiagnostic: (error) => this.addDiagnostic(error),
      });
      this.actorPoolValue = actorPool;
      bridge.setToolHandler((bridgeBinding, call, signal) => this.handleBridgeTool(bridgeBinding, call, signal));
      this.configurationValue = new AgentConfigurationCoordinator({
        store,
        actorPool,
        rootId,
        ...(this.options.setRootModel && this.options.setRootThinking
          ? {
              rootRuntime: {
                setModel: this.options.setRootModel,
                setThinking: this.options.setRootThinking,
              },
            }
          : {}),
        models: () => this.hostFacts().models,
        managedExtensions: () => this.managedExtensions(),
        onDiagnostic: (error) => this.addDiagnostic(error),
      });
      const sessionHost = this.options.sessionHost;
      this.conversationsValue = new AgentConversationStreams({
        store,
        epoch: this.generation,
        currentActor: (agentId) => actorPool?.actors.get(agentId),
        rootAgentId: rootId,
        currentRootEvents: (listener) => rootRuntime.subscribeConversation(listener),
        ...(sessionHost
          ? {
              readSession: async (agentId: string) => {
                let state: Readonly<SchedulerState> = this.store.snapshot();
                let agent = state.agents[agentId];
                let cold = false;
                if (!agent) {
                  const lineage = await this.store.closedAgentLineage(agentId);
                  if (lineage.length) {
                    state = this.stateWithAgents(state, lineage);
                    agent = state.agents[agentId];
                    cold = true;
                  }
                }
                if (!agent)
                  throw new SchedulerStateError('agent_unavailable', `Collaborator '${agentId}' is unavailable`);
                const session = agent.agentId === rootId ? this.requiredSession() : agent;
                if (!session.sessionFile)
                  throw new SchedulerStateError('history_unavailable', 'Conversation is unavailable');
                if (!session.sessionId)
                  throw new SchedulerStateError('history_unavailable', 'Conversation identity is unavailable');
                const history = await sessionHost.readContext(session.sessionFile, session.cwd, session.sessionId);
                return {
                  messages: history.messages,
                  ...(cold ? { state } : {}),
                };
              },
            }
          : {}),
        running: () => this.state === 'running',
        onDiagnostic: (error) => this.addDiagnostic(error),
      });
      if (this.closeRequested)
        throw new SchedulerStateError('manager_closed', `${PRODUCT} manager closed during startup`);
      this.state = 'running';
      this.commandCenterStoreUnsubscribe = store.onChange(() => {
        this.conversationsValue?.reconcile();
        this.scheduleCommandCenterProjection();
      });
      this.publishCommandCenterProjection();
      const attachmentPath = join(dirname(statePath), LUMINARIES_IDENTITY.namespace.attachmentFile);
      const attachment = new LuminariesAttachmentServer({
        host: this,
        bridge,
        descriptorPath: attachmentPath,
        rootId,
        epoch: this.generation,
        cwd: this.requiredSession().cwd,
        sessionId: this.requiredSession().sessionId,
        sessionLabel: `${PRODUCT} root ${this.requiredSession().sessionId.slice(0, 8)}`,
        resolveTarget: async (reference) => {
          const target = await this.resolveAttachmentAgent(reference);
          return {
            agentId: target.agentId,
            projection: this.projectCommandCenter(target.state),
          };
        },
      });
      this.attachmentValue = attachment;
      this.attachmentPathValue = attachmentPath;
      await attachment.start();
      this.deadlinesValue = new RequestDeadlineCoordinator(store, (error) => this.addDiagnostic(error));
      this.supervisionValue = new SupervisionCoordinator(store, (error) => this.addDiagnostic(error));
      recipientDrain.scanOnce();
    } catch (error) {
      if (!this.closeRequested) await this.closeImpl().catch((failure) => this.addDiagnostic(failure));
      throw error;
    }
  }

  private async closeImpl(): Promise<void> {
    this.extensionPolicyAbort.abort(
      new SchedulerStateError('manager_closed', 'Extension approval was cancelled because the manager is closing'),
    );
    this.commandCenterStoreUnsubscribe?.();
    this.commandCenterStoreUnsubscribe = undefined;
    if (this.commandCenterProjectionPending) clearImmediate(this.commandCenterProjectionPending);
    this.commandCenterProjectionPending = undefined;
    for (const subscription of this.commandCenterActorSubscriptions.values()) subscription.unsubscribe();
    this.commandCenterActorSubscriptions.clear();
    this.deadlinesValue?.close();
    this.supervisionValue?.close();
    await this.attachmentValue?.close().catch((error) => this.addDiagnostic(error));
    this.attachmentValue = undefined;
    this.attachmentPathValue = undefined;
    this.conversationsValue?.quiesce();
    this.commandCenterListeners.clear();
    this.commandCenterProjectionValue = undefined;

    await waitForPiEvidence(
      Promise.allSettled([
        ...[...this.spawnRequests.values()].map((receipt) => receipt.promise),
        ...[...this.detachRequests.values()].map((receipt) => receipt.promise),
        ...[...this.adoptRequests.values()].map((receipt) => receipt.promise),
      ]),
      'Session admission and handoff shutdown',
      30_000,
    ).catch((error) => this.addDiagnostic(error));
    this.bridgeValue?.setToolHandler(undefined);
    await this.bridgeValue?.close().catch((error) => this.addDiagnostic(error));
    this.recipientDrainValue?.quiesce();

    await this.actorPoolValue?.closeAll().catch((error) => this.addDiagnostic(error));
    await this.configurationValue?.settled().catch((error) => this.addDiagnostic(error));
    await this.deadlinesValue?.settled().catch((error) => this.addDiagnostic(error));
    await this.supervisionValue?.settled().catch((error) => this.addDiagnostic(error));
    await this.conversationsValue?.close().catch((error) => this.addDiagnostic(error));

    const rootSettlements = await this.rootRuntimeValue?.close().catch((error) => {
      this.addDiagnostic(error);
      return [];
    });
    for (const settlement of rootSettlements ?? [])
      await this.recipientDrainValue?.settle(settlement).catch((error) => this.addDiagnostic(error));
    await this.recipientDrainValue?.close().catch((error) => this.addDiagnostic(error));
    this.recipientDrainValue = undefined;
    this.actorPoolValue = undefined;
    this.configurationValue = undefined;
    this.managedExtensionsValue = undefined;
    this.deadlinesValue = undefined;
    this.supervisionValue = undefined;
    this.conversationsValue = undefined;
    this.bridgeValue = undefined;
    this.rootRuntimeValue = undefined;
    const store = this.storeValue;
    this.storeValue = undefined;
    await store?.close().catch((error) => this.addDiagnostic(error));
  }

  private async reconcileStartupEvidence(): Promise<void> {
    for (const agent of Object.values(this.store.snapshot().agents)) {
      if (agent.parentId === null || agent.lifecycle !== 'open') continue;
      try {
        await validatePhysicalSessionNamespace(this.store.snapshot(), agent.agentId, 'session_conflict');
        await assertPhysicalReferencesPublic(
          agent.expertCard.publishedRefs?.value ?? [],
          agent.cwd,
          agent.agentId,
          this.store.snapshot(),
          this.store.statePath,
        );
      } catch (error) {
        await this.store.setAgentAttention(
          agent.agentId,
          'needs_attention',
          error instanceof SchedulerStateError ? error.code : 'session_binding_invalid',
        );
      }
    }
    for (const recordId of this.store.startup.staleMailbox) {
      await this.store.applyMailboxIntent({ kind: 'reconcile_delivery', recordId });
      await this.store.removeDeliveryPayload(recordId).catch((error) => this.addDiagnostic(error));
    }
    for (const activationId of this.store.startup.staleActivations) {
      const activation = this.store.snapshot().activations[activationId];
      if (!activation || isTerminalActivation(activation.state)) continue;
      await this.store.finishActivation(activation.activationId, activation.leaseToken, 'indeterminate');
    }
    const staleExtensionChanges: string[] = [];
    for (const agentId of this.store.startup.staleConfigurations) {
      const change = this.store.snapshot().agents[agentId]?.pendingConfiguration;
      if (change?.status === 'dispatching' && change.kind === 'extensions') staleExtensionChanges.push(agentId);
      else if (change?.status === 'dispatching')
        await this.store.finishLiveConfiguration(agentId, change.changeId, 'indeterminate');
    }
    for (const agentId of this.store.startup.staleRuntimeOwners) {
      const agent = this.store.snapshot().agents[agentId];
      if (!agent?.runtimeOwner) continue;
      if (agent.runtimeHostname !== hostname() || !agent.runtimePid || processAlive(agent.runtimePid) !== false) {
        if (agent.lifecycle === 'open')
          await this.store.setAgentAttention(agentId, 'needs_attention', 'runtime_owner_unavailable');
        continue;
      }
      const currentState = agentRuntimeState(this.store.snapshot(), agent);
      const runtimeState =
        agent.lifecycle === 'closed'
          ? 'runtime_parked'
          : currentState === 'failed'
            ? 'failed'
            : currentState === 'running' || currentState === 'starting' || currentState === 'needs_attention'
              ? 'needs_attention'
              : 'runtime_parked';
      await this.store.releaseRuntime(agentId, agent.runtimeOwner, runtimeState, 'runtime_stale_reconciled');
    }
    for (const agentId of staleExtensionChanges) {
      const agent = this.store.snapshot().agents[agentId];
      const change = agent?.pendingConfiguration;
      if (change?.status !== 'dispatching' || change.kind !== 'extensions') continue;
      await this.store.finishLiveConfiguration(
        agentId,
        change.changeId,
        agent.runtimeOwner ? 'indeterminate' : 'applied',
      );
    }
  }

  private async parentContextForSpawn(
    caller: LuminariesCaller,
    mode: 'recent' | 'fork',
    requestId: string,
    toolCallId: string | undefined,
    callContext?: ParentContextSnapshot,
  ): Promise<ParentContextSnapshot> {
    if (caller.kind === 'parent') {
      const snapshot = this.options.parentContextSnapshot;
      if (!snapshot) throw new SchedulerStateError('context_unavailable', 'Parent spawn-call context is unavailable');
      return snapshot(mode, requestId, toolCallId);
    }
    if (caller.kind === 'operator' || caller.kind === 'service') {
      if (this.liveActivation(caller.agentId))
        throw new SchedulerStateError(
          'context_unavailable',
          'Interactive recent/fork context requires the parent to be at a settled boundary',
        );
      if (mode === 'recent') {
        const source = this.store.snapshot().agents[caller.agentId];
        const sessionHost = this.options.sessionHost;
        if (!source?.sessionFile || !source.sessionId || !sessionHost)
          throw new SchedulerStateError('context_unavailable', 'Bounded recent context is unavailable');
        const context = await sessionHost.readContext(source.sessionFile, source.cwd, source.sessionId);
        return {
          messages: context.messages,
          sourceSessionFile: source.sessionFile,
          selectedToolCallId: `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}recent-boundary`,
        };
      }
      const snapshot = this.options.operatorContextSnapshot;
      if (!snapshot) throw new SchedulerStateError('context_unavailable', 'Command-center context is unavailable');
      return snapshot();
    }
    if (caller.kind !== 'child')
      throw new SchedulerStateError('context_unavailable', 'The caller has no spawn-call context');
    const source = this.store.snapshot().agents[caller.agentId];
    if (!source?.sessionFile || !source.sessionId)
      throw new SchedulerStateError(
        'context_unavailable',
        `Collaborator '${caller.agentId}' has no conversation context`,
      );
    if (mode === 'recent') {
      const sessionHost = this.options.sessionHost;
      if (!sessionHost)
        throw new SchedulerStateError('context_unavailable', 'Bounded recent context is unavailable in this host');
      const context = await sessionHost.readContext(source.sessionFile, source.cwd, source.sessionId);
      if (!callContext)
        throw new SchedulerStateError('context_unavailable', 'Exact nested recent call context is unavailable');
      return {
        messages: appendSpawnCallContext(context.messages, callContext),
        sourceSessionFile: source.sessionFile,
        selectedToolCallId: `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}recent-boundary`,
      };
    }
    if (!callContext)
      throw new SchedulerStateError(
        'context_unavailable',
        'Exact nested fork context is unavailable; use recent, fresh, or custom',
      );
    return { ...callContext, sourceSessionFile: source.sessionFile };
  }

  private async prepareSpawn(
    caller: LuminariesCaller,
    input: LuminariesSpawnRequest,
    requestId: string,
    sessionId: string,
    sessionDir: string,
    startingMessage: string,
    toolCallId?: string,
    callContext?: ParentContextSnapshot,
  ): Promise<PreparedSpawn> {
    const parent = this.store.snapshot().agents[caller.agentId];
    if (!parent) throw new SchedulerStateError('parent_unavailable', `Parent '${caller.agentId}' is unavailable`);
    const hostFacts = this.hostFacts();
    const managedExtensions = this.managedExtensions();
    let configuration: EffectiveSpawnConfiguration;
    try {
      configuration = await canonicalLaunchResources(
        resolveSpawnConfiguration({
          input,
          parentCapabilities: parent.capabilities,
          parentCwd: parent.cwd,
          parentProvider: parent.provider,
          parentModel: parent.model,
          parentThinking: parent.thinking,
          models: hostFacts.models,
          managedExtensions,
        }),
        parent.capabilities,
      );
    } catch (error) {
      const code = error instanceof CapabilityError ? error.code : 'configuration_invalid';
      throw new SchedulerStateError(code, error instanceof Error ? error.message : String(error), { cause: error });
    }
    const snapshot =
      configuration.context === 'recent' || configuration.context === 'fork'
        ? await this.parentContextForSpawn(caller, configuration.context, requestId, toolCallId, callContext)
        : undefined;
    let contextPlan;
    try {
      const startupPrompt =
        configuration.context === 'custom'
          ? (configuration.systemPrompt ?? 'You are operating in an isolated Pi context. Follow the user message.')
          : hostFacts.startupPrompt;
      const overheadTokens =
        Math.ceil(
          Buffer.byteLength(
            JSON.stringify({
              startingMessage,
              systemPrompt: startupPrompt,
              resources: {
                extensions: configuration.extensions ?? [],
                skills: configuration.skills ?? [],
                promptTemplates: configuration.promptTemplates ?? [],
                themes: configuration.themes ?? [],
              },
            }),
          ) / 4,
        ) + hostFacts.activeToolTokens;
      const tokenEstimator = configuration.modelKey
        ? hostFacts.models.find((model) => `${model.provider}/${model.id}` === configuration.modelKey)?.tokenEstimator
        : undefined;
      contextPlan = planContextLaunch(configuration, snapshot, overheadTokens, tokenEstimator);
    } catch (error) {
      throw new SchedulerStateError('context_refused', error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    const grants: CapabilityRequest = {
      ...(configuration.grants ?? {}),
      ...(configuration.skills === undefined ? {} : { skills: configuration.skills }),
      ...(configuration.promptTemplates === undefined ? {} : { promptTemplates: configuration.promptTemplates }),
      ...(configuration.themes === undefined ? {} : { themes: configuration.themes }),
    };
    const normalizedGrants = normalizeCapabilityRequest(grants);
    let seededSessionFile: string;
    try {
      const sessionHost = this.options.sessionHost;
      if (!sessionHost)
        throw new SchedulerStateError(
          'context_unavailable',
          `Private sessions are unavailable in this ${PRODUCT} host`,
        );
      seededSessionFile = await sessionHost.createSeededSession({
        sessionId,
        sessionDir,
        cwd: configuration.cwd,
        parentSession: contextPlan.parentSession,
        messages: contextPlan.messages,
      });
    } catch (error) {
      await rm(sessionDir, { recursive: true, force: true }).catch((failure) => this.addDiagnostic(failure));
      throw error;
    }
    return {
      cwd: configuration.cwd,
      provider: configuration.provider,
      model: configuration.model,
      thinking: configuration.thinking,
      context: contextPlan.receipt,
      launch: {
        noContextFiles: contextPlan.noContextFiles,
        restrictSkills: contextPlan.noContextFiles || configuration.skills !== undefined,
        restrictPromptTemplates: contextPlan.noContextFiles || configuration.promptTemplates !== undefined,
        restrictThemes: contextPlan.noContextFiles || configuration.themes !== undefined,
        ...(contextPlan.systemPrompt ? { systemPrompt: contextPlan.systemPrompt } : {}),
        extensionSources: [...(input.extensions ?? [])],
        extensions: configuration.extensions ?? [],
        skills: configuration.skills ?? [],
        promptTemplates: configuration.promptTemplates ?? [],
        themes: configuration.themes ?? [],
      },
      grants: normalizedGrants,
      seededSessionFile,
    };
  }

  private async resolveManagedExtensions(
    settings: Readonly<Record<string, 'always' | 'allow' | 'deny'>>,
  ): Promise<ManagedExtensionPolicy> {
    if (this.options.managedExtensionHost) return this.options.managedExtensionHost.resolve(settings);
    const configuredExtensions = this.options.rootConfiguration?.extensions;
    const entries = Object.entries(settings).map(([specifier, state]) => {
      const configured = configuredExtensions?.entries.find((entry) => entry.specifier === specifier);
      if (state !== 'deny' && (!configured || !configured.paths.length))
        throw new SchedulerStateError(
          'resource_unavailable',
          `Persisted Pi extension '${specifier}' is unavailable in this root process`,
        );
      return {
        specifier,
        state,
        source: configured?.source ?? ('built-in' as const),
        paths: configured?.paths ?? [],
      };
    });
    return {
      entries,
      allowedPaths: [...new Set(entries.filter((entry) => entry.state !== 'deny').flatMap((entry) => entry.paths))],
    };
  }

  private managedExtensions(): ManagedExtensionPolicy {
    if (!this.managedExtensionsValue)
      throw new SchedulerStateError('resource_unavailable', 'Managed extension policy is unavailable');
    return this.managedExtensionsValue;
  }

  private selectedExtensions(agent: Readonly<AgentRecord>): string[] {
    return selectedManagedExtensionSpecifiers(
      this.managedExtensions(),
      agent.launch.extensions,
      agent.launch.extensionSources,
    );
  }

  private async spawn(
    caller: LuminariesCaller,
    input: LuminariesSpawnRequest,
    signal: AbortSignal | undefined,
    toolCallId?: string,
    parentContext?: ParentContextSnapshot,
  ): Promise<LuminariesReceipt> {
    const requestId = this.operationId(caller, 'spawn', input.requestId);
    const fingerprint = sha256(JSON.stringify(input));
    const existing = this.spawnRequests.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new SchedulerStateError('command_id_reuse', `Spawn request '${requestId}' was reused`);
      return existing.promise;
    }
    const agentId = publicId(`${LUMINARIES_IDENTITY.namespace.publicIdPrefix}agent`, `${caller.agentId}:${requestId}`);
    const displayName = admissionDisplayName(
      this.store.snapshot(),
      input.name,
      [...this.spawnRequests.values()].map((request) => request.displayName),
    );
    const promise = this.spawnOnce(
      caller,
      input,
      signal,
      toolCallId,
      parentContext,
      requestId,
      fingerprint,
      agentId,
      displayName,
    );
    const receipt: SpawnReceipt = { fingerprint, displayName, promise };
    this.spawnRequests.set(requestId, receipt);
    try {
      return await promise;
    } finally {
      if (this.spawnRequests.get(requestId) === receipt) this.spawnRequests.delete(requestId);
    }
  }

  private async spawnOnce(
    caller: LuminariesCaller,
    input: LuminariesSpawnRequest,
    signal: AbortSignal | undefined,
    toolCallId: string | undefined,
    parentContext: ParentContextSnapshot | undefined,
    requestId: string,
    fingerprint: string,
    agentId: string,
    displayName: string,
  ): Promise<LuminariesReceipt> {
    const principal = this.principal(caller);
    const startingRequestId = this.operationId(caller, 'spawn-prompt', requestId);
    const existingAgent = this.store.snapshot().agents[agentId];
    if (existingAgent) {
      if (existingAgent.parentId !== caller.agentId || existingAgent.spawnHash !== fingerprint)
        throw new SchedulerStateError('command_id_reuse', `Spawn request '${requestId}' was reused`);
      this.recipientDrain.hint(agentId);
      return this.spawnReceiptResult(requestId, agentId, true);
    }
    if (
      caller.kind === 'operator' &&
      (input.context === 'recent' || input.context === 'fork') &&
      this.liveActivation(caller.agentId)
    )
      return this.result(
        requestId,
        false,
        'Root is working. Recent and Fork are available when its current turn finishes.',
        {
          action: 'spawn',
          status: 'not_ready',
        },
      );
    const sourceActivation = principal.kind === 'agent' ? this.liveActivation(caller.agentId) : undefined;
    if (principal.kind === 'agent' && !sourceActivation)
      throw new SchedulerStateError(
        'sender_activation_missing',
        `Spawn principal '${caller.agentId}' has no live activation`,
      );
    const segment = publicId('agent', `${caller.agentId}:${requestId}:segment`).slice(0, 48);
    const sessionId = publicId(`${LUMINARIES_IDENTITY.namespace.publicIdPrefix}session`, `${caller.rootId}:${agentId}`);
    const sessionDir = join(this.childSessionRoot(), agentId);
    const preAdmissionState = this.store.snapshot();
    const identities = Object.values(preAdmissionState.agents).map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.agentId === preAdmissionState.root.rootId ? 'Root' : agent.displayName.value,
    }));
    identities.push({ agentId, displayName });
    const handles = deriveAgentHandles(identities);
    const collaborator = handles.get(agentId);
    const spawner = caller.agentId === preAdmissionState.root.rootId ? 'Root' : handles.get(caller.agentId);
    if (!collaborator || !spawner)
      throw new SchedulerStateError('agent_unavailable', 'Spawn identities are unavailable for startup');
    const startingMessage = `${collaboratorBootstrap(collaborator, spawner)}\n\n${input.assignment}`;
    let preparedSpawn: PreparedSpawn | undefined;
    try {
      if (signal?.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error('Spawn aborted before admission');
      const prepared = await this.prepareSpawn(
        caller,
        input,
        requestId,
        sessionId,
        sessionDir,
        startingMessage,
        toolCallId,
        parentContext,
      );
      preparedSpawn = prepared;
      if (signal?.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error('Spawn aborted before admission');
      this.assertCaller(caller);
      const admitted = await this.store.admitAgentWithStartingInput(
        {
          agentId,
          parentId: caller.agentId,
          segment,
          cwd: prepared.cwd,
          sessionId,
          sessionDir,
          sessionFile: prepared.seededSessionFile,
          displayName,
          assignment: input.assignment,
          ownershipBoundary: input.ownershipBoundary,
          expertCard: input.expertCard,
          provider: prepared.provider,
          model: prepared.model,
          thinking: prepared.thinking,
          spawnHash: fingerprint,
          context: prepared.context,
          launch: prepared.launch,
          grants: prepared.grants,
        },
        principal,
        this.auth(caller),
        {
          bridgeRequestId: startingRequestId,
          recipientId: agentId,
          mode: 'default',
        },
        () => startingMessage,
        signal,
      );
      return this.spawnReceiptResult(requestId, agentId, admitted.value.duplicate);
    } catch (error) {
      if (!this.store.snapshot().agents[agentId] && preparedSpawn) {
        await rm(sessionDir, { recursive: true, force: true }).catch((failure) => this.addDiagnostic(failure));
      }
      throw error;
    }
  }

  private async directory(
    caller: LuminariesCaller,
    input: LuminariesDirectoryRequest,
    signal?: AbortSignal,
  ): Promise<LuminariesReceipt> {
    const principal = this.principal(caller);
    const inspectedTarget =
      input.action === 'inspect' && input.agentId ? await this.resolveAttachmentAgent(input.agentId) : undefined;
    const targetId = inspectedTarget?.agentId ?? (input.agentId ? this.resolveAgentId(input.agentId) : caller.agentId);
    if (input.action === 'update') {
      const commit = await this.store.updateAgentMetadata(targetId, input.patch ?? {}, principal, signal);
      const clearedFields = Object.entries(input.patch ?? {})
        .filter(([, value]) => value === null)
        .map(([field]) => field);
      return this.result(
        input.requestId,
        false,
        clearedFields.length ? `Collaborator card cleared: ${clearedFields.join(', ')}.` : 'Collaborator card updated.',
        {
          action: input.action,
          status: 'updated',
          agent: mutationAgentReceipt(
            this.store.snapshot(),
            commit.value,
            'updated',
            this.humanIdentity(commit.value.agentId),
          ),
          ...(clearedFields.length ? { clearedFields } : {}),
        },
      );
    }
    let snapshot: Readonly<SchedulerState> = inspectedTarget?.state ?? this.store.snapshot();
    if (input.action === 'list' && input.includeClosed === true) snapshot = this.snapshotWithClosedAgents();
    const callerId = caller.kind === 'operator' ? undefined : caller.agentId;
    const callerKey = callerId ?? 'operator';
    const selected = input.action === 'inspect' ? snapshot.agents[targetId] : undefined;
    const ownsSelected =
      !!selected &&
      (caller.kind === 'operator' ||
        caller.agentId === selected.agentId ||
        isStrictAncestor(snapshot, caller.agentId, selected.agentId));
    const canSeeSummary = !!selected && selected.lifecycle === 'open';
    if (input.action === 'inspect' && (!selected || (!canSeeSummary && !ownsSelected)))
      throw new SchedulerStateError('authority_denied', `Collaborator '${targetId}' is unavailable to this caller`);
    if (input.action === 'list') {
      const entries = projectCompactDirectory(snapshot, callerId, input.includeClosed === true);
      const resultMessage = `${PRODUCT} directory page ready.`;
      const scope: ProjectionCursorScope = {
        rootId: snapshot.root.rootId,
        callerId: callerKey,
        view: 'directory',
        filter: sha256(JSON.stringify({ includeClosed: input.includeClosed === true })),
        revision: 0,
      };
      const afterKey = decodeProjectionCursor(input.cursor, scope);
      const page = buildBytePage<CompactDirectoryAgent>({
        items: entries,
        afterKey,
        keyOf: (entry) => entry.path,
        requestedLimit: input.limit ?? Math.max(1, entries.length),
        scope,
        buildDetails: (items, nextCursor, remaining) => ({
          action: input.action,
          view: 'directory',
          capacity: {
            used: Math.min(openCollaboratorCount(snapshot), snapshot.root.maxOpenAgents),
            limit: snapshot.root.maxOpenAgents,
          },
          entries: items,
          page: {
            returned: items.length,
            remaining,
            ...(nextCursor ? { nextCursor } : {}),
          },
        }),
        measureDetails: (details) =>
          receiptWireBytes(input.requestId, resultMessage, {
            requestId: input.requestId,
            duplicate: false,
            ...details,
          }),
      });
      return this.result(input.requestId, false, resultMessage, {
        action: input.action,
        view: 'directory',
        capacity: {
          used: Math.min(openCollaboratorCount(snapshot), snapshot.root.maxOpenAgents),
          limit: snapshot.root.maxOpenAgents,
        },
        entries: page.items,
        page: {
          returned: page.returned,
          remaining: page.remaining,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      });
    }
    if (!selected) throw new SchedulerStateError('agent_unavailable', `Collaborator '${targetId}' is unavailable`);
    const view = input.view ?? 'summary';
    if (view !== 'summary' && view !== 'card' && !ownsSelected)
      throw new SchedulerStateError(
        'authority_denied',
        `Inspect view '${view}' is owner-only for '${selected.agentId}'`,
      );
    if (view === 'summary') {
      return this.result(input.requestId, false, `${PRODUCT} summary for '${selected.agentId}' is ready.`, {
        action: input.action,
        view,
        agent: projectCompactAgentSummary(snapshot, selected, callerId),
      });
    }
    if (view === 'card') {
      const fields = [
        ...(selected.expertCard.role ? [{ key: 'role:0000000000', field: 'role', ...selected.expertCard.role }] : []),
        ...(selected.expertCard.focus
          ? [{ key: 'focus:0000000000', field: 'focus', ...selected.expertCard.focus }]
          : []),
        ...(selected.expertCard.expertise?.value ?? []).map((value, index) => ({
          key: `expertise:${String(index).padStart(10, '0')}`,
          field: 'expertise',
          value,
          source: selected.expertCard.expertise?.source,
          updatedAtMs: selected.expertCard.expertise?.updatedAtMs,
        })),
        ...(selected.expertCard.publishedRefs?.value ?? []).map((value, index) => ({
          key: `publishedRefs:${String(index).padStart(10, '0')}`,
          field: 'publishedRefs',
          value,
          source: selected.expertCard.publishedRefs?.source,
          updatedAtMs: selected.expertCard.publishedRefs?.updatedAtMs,
        })),
      ];
      const entries = fields.flatMap((entry) => {
        const chunks = splitTextByBytes(entry.value, Math.floor(MAX_RESULT_BYTES / 8));
        return chunks.map((value, part) => ({
          ...entry,
          key: `${entry.key}:${String(part).padStart(10, '0')}`,
          value,
          ...(chunks.length > 1 ? { part: part + 1, parts: chunks.length } : {}),
        }));
      });
      const resultMessage = `${PRODUCT} public card for '${selected.agentId}' is ready.`;
      const scope: ProjectionCursorScope = {
        rootId: snapshot.root.rootId,
        callerId: callerKey,
        view,
        filter: sha256(selected.agentId),
        revision: snapshot.revision,
      };
      const page = buildBytePage({
        items: entries,
        afterKey: decodeProjectionCursor(input.cursor, scope),
        keyOf: (entry) => entry.key,
        requestedLimit: input.limit ?? Math.max(1, entries.length),
        scope,
        buildDetails: (items, nextCursor, remaining) => ({
          action: input.action,
          view,
          agentId: selected.agentId,
          entries: items.map(({ key: _key, ...entry }) => entry),
          page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
        }),
        measureDetails: (details) =>
          receiptWireBytes(input.requestId, resultMessage, {
            requestId: input.requestId,
            duplicate: false,
            ...details,
          }),
      });
      return this.result(input.requestId, false, resultMessage, {
        action: input.action,
        view,
        agentId: selected.agentId,
        entries: page.items.map(({ key: _key, ...entry }) => entry),
        page: {
          returned: page.returned,
          remaining: page.remaining,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      });
    }
    if (view === 'capabilities') {
      const extensionPolicy = this.managedExtensions();
      const entries = (
        [
          ['capability', 'models', selected.capabilities.models],
          ['capability', 'thinking', selected.capabilities.thinking],
          ['capability', 'tools', selected.capabilities.tools],
          ['capability', 'extensions', selected.capabilities.extensions],
          ['capability', 'skills', selected.capabilities.skills],
          ['capability', 'promptTemplates', selected.capabilities.promptTemplates],
          ['capability', 'themes', selected.capabilities.themes],
          ['capability', 'cwdRoots', selected.capabilities.cwdRoots],
          ['launch', 'extensions', selected.launch.extensions],
          ['launch', 'skills', selected.launch.skills],
          ['launch', 'promptTemplates', selected.launch.promptTemplates],
          ['launch', 'themes', selected.launch.themes],
        ] as const
      ).flatMap(([section, field, values]) =>
        (values ?? []).map((value, index) => ({
          key: `${section}:${field}:${String(index).padStart(10, '0')}`,
          section,
          field,
          value,
        })),
      );
      const base = {
        action: input.action,
        view,
        agentId: selected.agentId,
        effective: {
          model: selected.provider ? `${selected.provider}/${selected.model ?? 'inherited'}` : selected.model,
          thinking: selected.thinking,
          context: selected.context,
        },
        capabilities: {
          spawn: selected.capabilities.spawn,
          peerInterrupt: selected.capabilities.peerInterrupt,
          maxDepth: selected.capabilities.maxDepth,
        },
        launch: {
          noContextFiles: selected.launch.noContextFiles,
          restrictSkills: selected.launch.restrictSkills,
          restrictPromptTemplates: selected.launch.restrictPromptTemplates,
          restrictThemes: selected.launch.restrictThemes,
        },
        extensions: {
          selected: this.selectedExtensions(selected),
          always: extensionPolicy.entries.filter((entry) => entry.state === 'always').map((entry) => entry.specifier),
          available: extensionPolicy.entries.filter((entry) => entry.state === 'allow').map((entry) => entry.specifier),
          pending: selected.pendingConfiguration?.kind === 'extensions',
        },
      };
      const resultMessage = `${PRODUCT} capabilities for '${selected.agentId}' are ready.`;
      const scope: ProjectionCursorScope = {
        rootId: snapshot.root.rootId,
        callerId: callerKey,
        view,
        filter: sha256(selected.agentId),
        revision: snapshot.revision,
      };
      const page = buildBytePage({
        items: entries,
        afterKey: decodeProjectionCursor(input.cursor, scope),
        keyOf: (entry) => entry.key,
        requestedLimit: input.limit ?? Math.max(1, entries.length),
        scope,
        buildDetails: (items, nextCursor, remaining) => ({
          ...base,
          entries: items.map((entry) => ({ section: entry.section, field: entry.field, value: entry.value })),
          page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
        }),
        measureDetails: (details) =>
          receiptWireBytes(input.requestId, resultMessage, {
            requestId: input.requestId,
            duplicate: false,
            ...details,
          }),
      });
      return this.result(input.requestId, false, resultMessage, {
        ...base,
        entries: page.items.map((entry) => ({ section: entry.section, field: entry.field, value: entry.value })),
        page: {
          returned: page.returned,
          remaining: page.remaining,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      });
    }
    const related = (agentId: string): boolean =>
      agentId === selected.agentId || isStrictAncestor(snapshot, selected.agentId, agentId);
    const privatePaths = preparePrivateDisplayPaths(
      [
        this.store.statePath,
        this.attachmentPathValue,
        ...Object.values(snapshot.agents).flatMap((agent) => [agent.sessionFile, agent.sessionDir]),
      ].filter((value): value is string => !!value),
    );
    if (view === 'diagnostics') {
      const records: Array<{ key: string; seq: number; value: Record<string, unknown> }> = [];
      for (const event of peerMailboxRecords(snapshot))
        if (related(event.senderId) || related(event.recipientId)) {
          const seq = mailboxRecordSeq(event);
          records.push({
            key: `${String(seq).padStart(16, '0')}:event:${event.eventId}`,
            seq,
            value: {
              kind: 'event_evidence',
              eventId: event.eventId,
              origin: event.origin,
              eventKind: event.kind,
              ...(event.systemType ? { systemType: event.systemType } : {}),
              senderId: event.senderId,
              recipientId: event.recipientId,
              traceId: event.traceId,
              status: event.status,
              ...(event.outcomeCode ? { outcomeCode: event.outcomeCode } : {}),
              acceptedSeq: event.acceptedSeq,
              durableSeq: seq,
            },
          });
        }
      const diagnosticSources: Array<{ source: string; values: readonly string[] }> = [
        { source: 'manager', values: this.diagnostics },
      ];
      for (const [agentId, actor] of this.actors)
        if (related(agentId)) diagnosticSources.push({ source: `actor:${agentId}`, values: actor.diagnostics });
      for (const source of diagnosticSources)
        source.values.forEach((message, index) => {
          const fingerprint = sha256(`${source.source}:${message}`).slice(0, 16);
          records.push({
            key: `${String(snapshot.revision).padStart(16, '0')}:diagnostic:${source.source}:${String(index).padStart(4, '0')}:${fingerprint}`,
            seq: snapshot.revision,
            value: {
              kind: 'runtime_diagnostic',
              source: source.source,
              fingerprint,
              message: truncateBytes(sanitizePreparedDisplayText(message, privatePaths), 1_000).value,
            },
          });
        });
      records.sort((left, right) => left.key.localeCompare(right.key));
      const scope: ProjectionCursorScope = {
        rootId: snapshot.root.rootId,
        callerId: callerKey,
        view,
        filter: sha256(selected.agentId),
        revision: snapshot.revision,
      };
      const afterKey = decodeProjectionCursor(input.cursor, scope);
      const resultMessage = `${PRODUCT} diagnostics for '${selected.agentId}' are ready.`;
      const page = buildBytePage({
        items: records,
        afterKey,
        keyOf: (record) => record.key,
        requestedLimit: input.limit ?? 32,
        scope,
        buildDetails: (items, nextCursor, remaining) => ({
          action: input.action,
          view,
          agentId: selected.agentId,
          records: items.map((item) => item.value),
          page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
        }),
        measureDetails: (details) =>
          receiptWireBytes(input.requestId, resultMessage, {
            requestId: input.requestId,
            duplicate: false,
            ...details,
          }),
      });
      return this.result(input.requestId, false, resultMessage, {
        action: input.action,
        view,
        agentId: selected.agentId,
        records: page.items.map((item) => item.value),
        page: {
          returned: page.returned,
          remaining: page.remaining,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      });
    }
    if (view === 'transcript') {
      const sessionHost = this.options.sessionHost;
      if (!sessionHost || !selected.sessionFile || !selected.sessionId)
        throw new SchedulerStateError('history_unavailable', 'Conversation history is unavailable');
      const history = await sessionHost.readContext(selected.sessionFile, selected.cwd, selected.sessionId);
      const lastEntry = history.entries.at(-1);
      const contextId = isRecord(lastEntry) && typeof lastEntry.id === 'string' ? lastEntry.id : 'empty';
      const scope: ProjectionCursorScope = {
        rootId: snapshot.root.rootId,
        callerId: callerKey,
        view,
        filter: sha256(`${selected.agentId}:${selected.sessionId}:${contextId}`),
        revision: snapshot.revision,
      };
      const afterKey = decodeProjectionCursor(input.cursor, scope);
      const resultMessage = `${PRODUCT} transcript page for '${selected.agentId}' is ready.`;
      const rows = projectTranscriptInspection(history.messages, snapshot, selected.agentId).flatMap((row, index) => {
        const chunks = splitTextByBytes(row.text, Math.floor(MAX_RESULT_BYTES / 8));
        return chunks.map((text, part) => ({
          key: `${index}:${part}`,
          row: {
            ...row,
            text,
            ...(chunks.length > 1 ? { part: part + 1, parts: chunks.length } : {}),
          },
        }));
      });
      const page = buildBytePage({
        items: rows,
        ...(afterKey ? { afterKey } : {}),
        keyOf: (row) => row.key,
        requestedLimit: input.limit ?? 24,
        scope,
        buildDetails: (items, nextCursor, remaining) => ({
          action: input.action,
          view,
          agentId: selected.agentId,
          lifecycle: selected.lifecycle,
          transcript: items.map((item) => item.row),
          page: {
            returned: items.length,
            remaining,
            ...(nextCursor ? { nextCursor } : {}),
          },
        }),
        measureDetails: (details) =>
          receiptWireBytes(input.requestId, resultMessage, {
            requestId: input.requestId,
            duplicate: false,
            ...details,
          }),
      });
      return this.result(input.requestId, false, resultMessage, {
        action: input.action,
        view,
        agentId: selected.agentId,
        lifecycle: selected.lifecycle,
        transcript: page.items.map((item) => item.row),
        page: {
          returned: page.returned,
          remaining: page.remaining,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      });
    }
    const records: Array<{ key: string; seq: number; value: Record<string, unknown> }> = [];
    for (const request of Object.values(snapshot.requests))
      if (related(request.requesterId) || related(request.recipientId)) {
        const status = requestStatus(snapshot, request);
        const seq = requestSeq(snapshot, request);
        records.push({
          key: `${String(seq).padStart(16, '0')}:request:${request.requestId}`,
          seq,
          value: {
            kind: 'request',
            lifecycle: status === 'pending' ? 'live' : 'terminal',
            requestId: request.requestId,
            requesterId: request.requesterId,
            recipientId: request.recipientId,
            status,
          },
        });
      }
    for (const event of peerMailboxRecords(snapshot))
      if (related(event.senderId) || related(event.recipientId))
        records.push({
          key: `${String(mailboxRecordSeq(event)).padStart(16, '0')}:event:${event.eventId}`,
          seq: mailboxRecordSeq(event),
          value: {
            kind: 'event',
            lifecycle: TERMINAL_PEER_EVENT_STATUSES.has(event.status) ? 'terminal' : 'live',
            senderId: event.senderId,
            recipientId: event.recipientId,
            status: event.status,
            ...(event.message === undefined
              ? {}
              : { message: truncateBytes(sanitizePreparedDisplayText(event.message, privatePaths), 1_024).value }),
            outcomeCode: event.outcomeCode,
          },
        });
    for (const watch of Object.values(snapshot.watches))
      if (related(watch.ownerId)) {
        const seq = watchSeq(watch);
        records.push({
          key: `${String(seq).padStart(16, '0')}:watch:${watch.watchId}`,
          seq,
          value: {
            kind: 'watch',
            lifecycle: watch.status === 'active' ? 'live' : 'terminal',
            watchId: watch.watchId,
            ownerId: watch.ownerId,
            requestIds: watch.requestIds ?? [],
            agentIds: watch.agentIds ?? [],
            eventKinds: watch.eventKinds ?? [],
            status: watch.status,
          },
        });
      }
    for (const control of directMailboxRecords(snapshot))
      if (related(control.targetId)) {
        const seq = mailboxRecordSeq(control);
        records.push({
          key: `${String(seq).padStart(16, '0')}:control:${control.controlId}`,
          seq,
          value: {
            kind: 'control',
            lifecycle: isTerminalControlStatus(control.status) ? 'terminal' : 'live',
            targetId: control.targetId,
            action: control.action,
            status: control.status,
            outcomeCode: control.outcomeCode,
          },
        });
      }
    records.sort((left, right) => left.key.localeCompare(right.key));
    const scope: ProjectionCursorScope = {
      rootId: snapshot.root.rootId,
      callerId: callerKey,
      view,
      filter: sha256(selected.agentId),
      revision: snapshot.revision,
    };
    const afterKey = decodeProjectionCursor(input.cursor, scope);
    const resultMessage = `${PRODUCT} ${view} page for '${selected.agentId}' is ready.`;
    const page = buildBytePage({
      items: records,
      afterKey,
      keyOf: (record) => record.key,
      requestedLimit: input.limit ?? 24,
      scope,
      buildDetails: (items, nextCursor, remaining) => ({
        action: input.action,
        view,
        agentId: selected.agentId,
        records: items.map((item) => item.value),
        page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
      }),
      measureDetails: (details) =>
        receiptWireBytes(input.requestId, resultMessage, { requestId: input.requestId, duplicate: false, ...details }),
    });
    return this.result(input.requestId, false, resultMessage, {
      action: input.action,
      view,
      agentId: selected.agentId,
      records: page.items.map((item) => item.value),
      page: {
        returned: page.returned,
        remaining: page.remaining,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
    });
  }

  private async message(
    caller: LuminariesCaller,
    input: LuminariesMessageRequest,
    signal: AbortSignal | undefined,
  ): Promise<LuminariesReceipt> {
    const requestId = this.operationId(caller, 'message', input.requestId);
    const source =
      caller.kind === 'operator' || caller.kind === 'service'
        ? undefined
        : await this.ensureSourceActivation(caller, input.action);
    try {
      const auth = this.auth(caller);
      const identities = this.operationIdentityTables();
      if (input.action === 'send') {
        this.assertSignalActive(signal);
        const recipientId = identities.resolveId(requiredToolString(input.recipientId, 'recipientId'));
        const route = await this.store.admitPeerEvent(
          auth,
          {
            bridgeRequestId: requestId,
            recipientId,
            message: requiredToolString(input.message, 'message'),
            mode: input.mode,
          },
          undefined,
          undefined,
          signal,
        );
        await this.acknowledgeInputAfterIndeterminate(caller, route.value.event);
        return this.messageResult(input, route.value.event, route.value.duplicate, route.value.disposition, false);
      }
      if (input.action === 'multicast') {
        this.assertSignalActive(signal);
        const recipientIds = (input.recipientIds ?? []).map((recipientId) => identities.resolveId(recipientId));
        const route = await this.store.admitPeerMulticast(auth, {
          bridgeRequestId: requestId,
          recipientIds,
          message: requiredToolString(input.message, 'message'),
          mode: input.mode,
        });
        for (const leg of route.value) await this.acknowledgeInputAfterIndeterminate(caller, leg.event);
        const refused = route.value.filter((leg) => leg.event.status === 'refused').length;
        const failed = route.value.filter((leg) => leg.event.status === 'failed').length;
        const indeterminate = route.value.filter((leg) => leg.event.status === 'indeterminate').length;
        const accepted = route.value.length - refused - failed - indeterminate;
        const description = indeterminate
          ? `${indeterminate} multicast delivery outcome${indeterminate === 1 ? ' is' : 's are'} uncertain; inspect before continuing.`
          : failed
            ? `${accepted} multicast message${accepted === 1 ? '' : 's'} accepted; ${failed} failed.`
            : refused
              ? `${accepted} multicast message${accepted === 1 ? '' : 's'} accepted; ${refused} refused.`
              : input.mode === 'notify_only'
                ? `${accepted} notifications recorded; no model turns started.`
                : input.mode === 'follow_up'
                  ? `${accepted} follow-up${accepted === 1 ? '' : 's'} accepted for later turns.`
                  : `${accepted} message${accepted === 1 ? '' : 's'} accepted for delivery.`;
        return this.result(
          input.requestId,
          route.value.every((leg) => leg.duplicate),
          description,
          {
            action: input.action,
            mode: input.mode,
            legs: route.value.map((leg) => ({
              recipientId: leg.event.recipientId,
              recipient: identities.identityOf(leg.event.recipientId),
              eventId: leg.event.eventId,
              status: leg.event.status,
              disposition: leg.disposition,
              outcomeCode: leg.event.outcomeCode,
              duplicate: leg.duplicate,
            })),
          },
        );
      }
      if (input.action === 'request' || input.action === 'request_many') {
        const now = Date.now();
        if (input.deadlineMs !== undefined && input.deadlineMs > Number.MAX_SAFE_INTEGER - now)
          throw new SchedulerStateError('input_invalid', 'Request deadline is outside the supported clock range');
        const deadlineAtMs = input.deadlineMs === undefined ? undefined : now + input.deadlineMs;
        if (input.action === 'request') {
          this.assertSignalActive(signal);
          const recipientId = identities.resolveId(requiredToolString(input.recipientId, 'recipientId'));
          const route = await this.store.acceptCorrelatedRequest(
            auth,
            {
              bridgeRequestId: requestId,
              recipientId,
              message: requiredToolString(input.message, 'message'),
              mode: input.mode === 'follow_up' ? 'follow_up' : 'default',
              deadlineAtMs,
            },
            signal,
          );
          await this.acknowledgeInputAfterIndeterminate(caller, route.value.route.event);
          const status = requestStatus(this.store.snapshot(), route.value.request);
          const pending = status === 'pending';
          return this.messageResult(
            input,
            route.value.route.event,
            route.value.route.duplicate,
            route.value.route.disposition,
            pending,
            status,
            route.value.request.requestId,
          );
        }
        const recipientIds = (input.recipientIds ?? []).map((recipientId) => identities.resolveId(recipientId));
        this.assertSignalActive(signal);
        const routes = await this.store.acceptCorrelatedMulticast(auth, {
          bridgeRequestId: requestId,
          recipientIds,
          message: requiredToolString(input.message, 'message'),
          mode: input.mode === 'follow_up' ? 'follow_up' : 'default',
          deadlineAtMs,
        });
        for (const leg of routes.value) await this.acknowledgeInputAfterIndeterminate(caller, leg.route.event);
        const requestSnapshot = this.store.snapshot();
        const pending = routes.value.some((route) => requestStatus(requestSnapshot, route.request) === 'pending');
        const refused = routes.value.filter((route) => route.route.event.status === 'refused').length;
        const failed = routes.value.filter((route) => route.route.event.status === 'failed').length;
        const indeterminate = routes.value.filter((route) => route.route.event.status === 'indeterminate').length;
        const pendingCount = routes.value.filter(
          (route) => requestStatus(requestSnapshot, route.request) === 'pending',
        ).length;
        const description = indeterminate
          ? `${indeterminate} request delivery outcome${indeterminate === 1 ? ' is' : 's are'} uncertain; inspect before continuing.`
          : failed || refused
            ? `${pendingCount} requests pending; ${failed} failed and ${refused} refused.${pending ? ' This turn yields for pending replies.' : ''}`
            : pendingCount
              ? `${pendingCount} requests pending; this turn yields for their replies.`
              : 'All correlated requests are already terminal; this turn continues.';
        return this.result(
          input.requestId,
          routes.value.every((leg) => leg.route.duplicate),
          description,
          {
            action: input.action,
            legs: routes.value.map((leg) => ({
              recipientId: leg.request.recipientId,
              recipient: identities.identityOf(leg.request.recipientId),
              correlationId: leg.request.requestId,
              eventId: leg.route.event.eventId,
              status: leg.route.event.status,
              disposition: leg.route.disposition,
              requestStatus: requestStatus(requestSnapshot, leg.request),
              outcomeCode: leg.route.event.outcomeCode,
              deadlineAtMs: leg.request.deadlineAtMs,
              duplicate: leg.route.duplicate,
            })),
          },
          pending,
        );
      }
      if (input.action === 'reply') {
        this.assertSignalActive(signal);
        const correlationId = requiredToolString(input.correlationId, 'correlationId');
        const request = this.store.snapshot().requests[correlationId];
        if (!request) throw new SchedulerStateError('request_missing', `Request '${correlationId}' does not exist`);
        const route = await this.store.acceptCorrelatedReply(auth, {
          bridgeRequestId: requestId,
          requestId: correlationId,
          message: requiredToolString(input.message, 'message'),
        });
        const status = requestStatus(this.store.snapshot(), route.value.request);
        return this.messageResult(
          input,
          route.value.route.event,
          route.value.route.duplicate,
          route.value.route.disposition,
          false,
          status,
          route.value.request.requestId,
        );
      }
      const correlationId = requiredToolString(input.correlationId, 'correlationId');
      this.assertSignalActive(signal);
      const request = this.store.snapshot().requests[correlationId];
      if (!request) throw new SchedulerStateError('request_missing', `Request '${correlationId}' does not exist`);
      const route = await this.store.acceptCorrelatedCancel(auth, {
        bridgeRequestId: requestId,
        requestId: correlationId,
      });
      const status = requestStatus(this.store.snapshot(), route.value.request);
      return this.messageResult(
        input,
        route.value.route.event,
        route.value.route.duplicate,
        route.value.route.disposition,
        false,
        status,
        route.value.request.requestId,
      );
    } finally {
      if (source?.transient)
        await this.finishSourceActivation(source.activation, signal?.aborted ? 'indeterminate' : 'settled');
    }
  }

  private async control(
    caller: LuminariesCaller,
    input: LuminariesControlRequest,
    signal: AbortSignal | undefined,
  ): Promise<LuminariesReceipt> {
    this.assertSignalActive(signal);
    const principal = this.principal(caller);
    const requestedTargetId = input.agentId;
    if (!requestedTargetId) throw new SchedulerStateError('input_invalid', 'Control target is required');
    const targetId =
      input.action === 'resume'
        ? (await this.resolveAttachmentAgent(requestedTargetId)).agentId
        : this.resolveAgentId(requestedTargetId);
    if (input.action === 'set_model' || input.action === 'set_thinking' || input.action === 'set_extensions') {
      this.assertSignalActive(signal);
      return this.configurationControl(caller, input, principal, targetId, signal);
    }
    if (input.action === 'set_grants') {
      this.assertSignalActive(signal);
      return this.grantControl(input, principal, targetId, signal);
    }
    if (input.action === 'close' || input.action === 'close_subtree') {
      this.assertSignalActive(signal);
      return this.lifecycleControl(caller, input, principal, targetId, signal);
    }
    if (input.action === 'resume') {
      this.assertSignalActive(signal);
      await this.store.resumeAgent(targetId, principal, signal);
      await this.store.reconcileManagedExtensionSelections(this.managedExtensions().entries);
      return this.result(input.requestId, false, `Collaborator '${targetId}' resumed.`, {
        action: input.action,
        targetId,
        target: this.humanIdentity(targetId),
        status: 'admitted',
      });
    }
    if (principal.kind === 'agent' && !this.isDescendant(principal.agentId, targetId))
      throw new SchedulerStateError(
        'authority_denied',
        `Collaborator '${principal.agentId}' does not own '${targetId}'`,
      );
    const operationId = this.operationId(caller, 'control', `${input.requestId}:${targetId}`);
    if (input.action === 'steer' || input.action === 'follow_up') {
      this.assertSignalActive(signal);
      const activation = this.liveActivation(targetId);
      const route = await this.store
        .admitPeerEvent(
          this.auth(caller),
          {
            bridgeRequestId: operationId,
            recipientId: targetId,
            message: requiredToolString(input.message, 'message'),
            mode: input.action === 'follow_up' ? 'follow_up' : 'default',
          },
          activation?.activationId ?? targetId,
          undefined,
          signal,
        )
        .catch((error: unknown) => {
          if (activation || !(error instanceof SchedulerStateError) || error.code !== 'runtime_unavailable')
            throw error;
          throw new SchedulerStateError(
            'runtime_unavailable',
            `Collaborator '${targetId}' has no running turn; use ${TOOL.message} for ordinary input`,
          );
        });
      if (route.value.event.status !== 'refused')
        await this.store.markAgentContinuedAfterIndeterminate(targetId, principal);
      const handle = this.humanIdentity(targetId)?.humanHandle ?? targetId;
      const refused = route.value.event.status === 'refused';
      return this.result(
        input.requestId,
        route.value.duplicate,
        refused
          ? `${input.action === 'follow_up' ? 'Follow-up' : 'Steer'} to ${handle} was refused${route.value.event.outcomeCode ? ` (${route.value.event.outcomeCode})` : ''}.`
          : input.action === 'follow_up'
            ? `Follow-up for ${handle} was accepted for the next turn.`
            : `Message for ${handle} was accepted for the active turn.`,
        {
          action: input.action,
          targetId,
          target: this.humanIdentity(targetId),
          status: route.value.event.status,
          disposition: route.value.disposition,
        },
      );
    }
    if (input.action !== 'interrupt')
      throw new SchedulerStateError('input_invalid', `Control action '${input.action}' is unsupported`);
    {
      this.assertSignalActive(signal);
      let replacement: PeerRouteReceipt | undefined;
      const replacementMessage = input.message === undefined ? undefined : requiredToolString(input.message, 'message');
      const control = await this.interruptInGate(
        targetId,
        principal,
        operationId,
        signal,
        replacementMessage === undefined
          ? undefined
          : (controlId, attemptId) =>
              this.store
                .admitPeerEventAfterInterrupt(controlId, attemptId, this.auth(caller), {
                  bridgeRequestId: this.operationId(caller, 'control-replacement', `${input.requestId}:${targetId}`),
                  recipientId: targetId,
                  message: replacementMessage,
                  mode: 'default',
                })
                .then((commit) => {
                  replacement = commit.value.route;
                  return commit.value.control;
                }),
      );
      if (replacement && control.status === 'aborted') {
        if (replacement.event.status !== 'refused') {
          await this.store.markAgentContinuedAfterIndeterminate(targetId, principal);
        }
        return this.result(
          input.requestId,
          replacement.duplicate,
          replacement.event.status === 'refused'
            ? `Interrupted ${this.humanIdentity(targetId)?.humanHandle ?? targetId}; replacement input was refused${replacement.event.outcomeCode ? ` (${replacement.event.outcomeCode})` : ''}.`
            : `Interrupted ${this.humanIdentity(targetId)?.humanHandle ?? targetId}; replacement message was accepted to start the next turn.`,
          {
            action: input.action,
            targetId,
            target: this.humanIdentity(targetId),
            controlId: control.controlId,
            eventId: replacement.event.eventId,
            status: replacement.event.status,
            disposition: replacement.disposition,
          },
        );
      }
      return this.controlResult(input, control, false);
    }
  }

  private assertSignalActive(signal: AbortSignal | undefined): void {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : new Error(`${PRODUCT} tool execution aborted`);
  }

  private async interruptInGate(
    targetId: string,
    principal: SchedulerPrincipal,
    requestId: string,
    signal?: AbortSignal,
    completeBoundary?: (controlId: string, attemptId: string) => Promise<DirectControlRecord>,
  ): Promise<DirectControlRecord> {
    const existing = await this.store.directControlReceipt(requestId, 'interrupt', principal);
    if (existing) return existing;
    const activation = this.liveActivation(targetId);
    if (activation?.state !== 'running')
      throw new SchedulerStateError('runtime_unavailable', `Collaborator '${targetId}' has no running turn`);
    const port = this.deliveryPort(targetId);
    const admitted = await this.store.applyMailboxIntent(
      {
        kind: 'admit_direct',
        input: {
          requestId,
          targetId,
          sourceActivationId: activation.activationId,
          action: 'interrupt',
        },
        requestedBy: principal,
      },
      signal,
    );
    const control = admitted.value.control;
    if (admitted.value.duplicate) return control;
    const begun = await this.store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: control.controlId,
      runtimeOwner: port.runtimeOwner,
    });
    if (!begun.value || !('controlId' in begun.value) || !begun.value.attemptId)
      throw new SchedulerStateError('state_invalid', `Interrupt '${control.controlId}' lacks attempt identity`);
    const attemptId = begun.value.attemptId;
    let attempt: PiInterruptAttempt;
    try {
      attempt = port.interrupt(attemptId);
    } catch (error) {
      const failed = await this.store.applyMailboxIntent({
        kind: 'finish_delivery',
        recordId: control.controlId,
        attemptId,
        status: 'failed',
        outcomeCode: 'interrupt_not_written',
      });
      this.addDiagnostic(error);
      if (!isDirectMailboxRecord(failed.value))
        throw new SchedulerStateError('state_invalid', `Interrupt '${control.controlId}' changed mailbox lanes`);
      return failed.value;
    }
    this.recipientDrain.observeSettlement(attempt.settled);
    try {
      await waitForPiEvidence(attempt.accepted, `Pi acceptance for interrupt '${control.controlId}'`);
    } catch (error) {
      attempt.cancelBoundary(error instanceof PiRpcCommandError ? 'known' : 'indeterminate');
      const status = error instanceof PiRpcCommandError ? 'refused' : 'indeterminate';
      const failed = await this.store.applyMailboxIntent({
        kind: 'finish_delivery',
        recordId: control.controlId,
        attemptId,
        status,
        outcomeCode: status === 'refused' ? 'pi_refused_interrupt' : 'interrupt_write_indeterminate',
      });
      if (!isDirectMailboxRecord(failed.value))
        throw new SchedulerStateError('state_invalid', `Interrupt '${control.controlId}' changed mailbox lanes`);
      return failed.value;
    }
    let aborted: boolean;
    try {
      aborted = await waitForPiEvidence(attempt.aborted, `Exact Pi abort boundary for '${control.controlId}'`);
    } catch {
      attempt.cancelBoundary('indeterminate');
      const uncertain = await this.store.applyMailboxIntent({
        kind: 'finish_delivery',
        recordId: control.controlId,
        attemptId,
        status: 'indeterminate',
        outcomeCode: 'interrupt_boundary_indeterminate',
      });
      if (!isDirectMailboxRecord(uncertain.value))
        throw new SchedulerStateError('state_invalid', `Interrupt '${control.controlId}' changed mailbox lanes`);
      return uncertain.value;
    }
    const boundary =
      completeBoundary && aborted
        ? { value: await completeBoundary(control.controlId, attemptId) }
        : await this.store.applyMailboxIntent({
            kind: 'admit_boundary',
            recordId: control.controlId,
            attemptId,
            aborted,
          });
    if (!isDirectMailboxRecord(boundary.value))
      throw new SchedulerStateError('state_invalid', `Interrupt '${control.controlId}' changed mailbox lanes`);
    return boundary.value;
  }

  private deliveryPort(targetId: string): DeliveryPort {
    if (targetId === this.rootId()) return this.rootRuntime.deliveryPort();
    const actor = this.actorPool.actors.get(targetId);
    if (!actor) throw new SchedulerStateError('runtime_unavailable', `Collaborator '${targetId}' has no live runtime`);
    return actor;
  }

  private async configurationControl(
    caller: LuminariesCaller,
    input: LuminariesControlRequest,
    principal: SchedulerPrincipal,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<LuminariesReceipt> {
    const changeId = this.operationId(caller, 'configuration', `${input.requestId}:${targetId}`);
    const outcome = await this.configuration
      .apply(input, principal, targetId, caller.agentId, changeId, signal)
      .catch((error: unknown) => {
        const target = this.store.snapshot().agents[targetId];
        if (error instanceof SchedulerStateError && error.code === 'writer_busy' && target?.parentId !== null)
          throw new SchedulerStateError(
            'writer_busy',
            `${this.humanIdentity(targetId)?.humanHandle ?? 'This expert'} is working. Model and thinking changes are available when it is Ready or Parked.`,
            { cause: error },
          );
        throw error;
      });
    const content =
      outcome.status === 'not_ready'
        ? `${this.humanIdentity(targetId)?.humanHandle ?? 'This expert'} is working. Model and thinking changes are available when it is Ready or Parked.`
        : input.action === 'set_extensions'
          ? outcome.status === 'pending'
            ? 'Extension selection saved. The collaborator will finish its current turn and park before the change takes effect.'
            : outcome.status === 'saved'
              ? 'Extension selection saved. The parked collaborator will load it on its next message.'
              : `Extension selection is ${outcome.status}.`
          : outcome.duplicate
            ? `${PRODUCT} ${input.action} is already effective.`
            : `${PRODUCT} ${input.action} is ${outcome.status}.`;
    const snapshot = this.store.snapshot();
    const effective = outcome.status === 'applied' ? outcome.agent : undefined;
    return this.result(input.requestId, outcome.duplicate, content, {
      action: input.action,
      targetId,
      target: this.humanIdentity(targetId),
      status: outcome.status,
      ...(outcome.agent
        ? {
            agent: mutationAgentReceipt(
              snapshot,
              outcome.agent,
              outcome.status,
              this.humanIdentity(outcome.agent.agentId),
            ),
          }
        : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(effective
        ? {
            effectiveConfiguration: {
              model: effective.model
                ? effective.provider
                  ? `${effective.provider}/${effective.model}`
                  : effective.model
                : null,
              thinking: effective.thinking ?? null,
              ...(input.action === 'set_extensions'
                ? {
                    extensions:
                      outcome.status === 'pending' ? [...(input.extensions ?? [])] : this.selectedExtensions(effective),
                  }
                : {}),
            },
          }
        : {}),
    });
  }

  private async grantControl(
    input: LuminariesControlRequest,
    principal: SchedulerPrincipal,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<LuminariesReceipt> {
    if (!input.grants) throw new SchedulerStateError('input_invalid', 'Grant change requires grants');
    const grants = input.grants;
    const commit = await this.store.setAgentCapabilities(targetId, grants, principal, signal);
    return this.result(input.requestId, false, `${PRODUCT} capabilities updated for '${targetId}'.`, {
      action: input.action,
      targetId,
      target: this.humanIdentity(targetId),
      status: 'applied',
      capabilities: commit.value.capabilities,
    });
  }

  private async lifecycleControl(
    caller: LuminariesCaller,
    input: LuminariesControlRequest,
    principal: SchedulerPrincipal,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<LuminariesReceipt> {
    const snapshot = this.store.snapshot();
    const open = snapshot.agents[targetId];
    if (targetId === this.rootId())
      throw new SchedulerStateError('root_control_denied', `The ${PRODUCT} root cannot be closed`);
    if (!open || open.lifecycle !== 'open')
      throw new SchedulerStateError('agent_unavailable', `Collaborator '${targetId}' is not open`);
    if (caller.kind === 'child' && !this.isDescendant(caller.agentId, targetId))
      throw new SchedulerStateError('authority_denied', `Collaborator '${caller.agentId}' does not own '${targetId}'`);
    const descendants = Object.values(snapshot.agents).filter(
      (agent) => agent.lifecycle === 'open' && this.isDescendant(targetId, agent.agentId),
    );
    if (input.action === 'close' && descendants.length)
      throw new SchedulerStateError(
        'descendants_open',
        `Collaborator '${targetId}' owns ${descendants.length} open descendants; use close_subtree to close them together`,
      );
    const targetIdentity = humanIdentityInState(snapshot, targetId);
    const closed = await this.store.closeAgent(
      targetId,
      principal,
      {
        subtree: input.action === 'close_subtree',
      },
      signal,
    );
    void Promise.all(closed.value.map((id) => this.actorPool.closeAgent(id))).catch((error) =>
      this.addDiagnostic(error),
    );
    return this.result(
      input.requestId,
      false,
      input.action === 'close_subtree'
        ? `Closed collaborator '${targetId}' and its open descendants.`
        : `Closed collaborator '${targetId}'.`,
      {
        action: input.action,
        targetId,
        target: targetIdentity,
        status: 'admitted',
        closedIds: closed.value,
      },
    );
  }

  private async awaitRequests(
    caller: LuminariesCaller,
    input: LuminariesAwaitRequest,
    signal?: AbortSignal,
  ): Promise<LuminariesReceipt> {
    const principal = this.principal(caller);
    if (input.action === 'cancel') {
      if (!input.watchId) throw new SchedulerStateError('input_invalid', 'Watch cancellation requires watchId');
      const cancelled = await this.store.cancelWatch(input.watchId, principal, signal);
      return this.result(input.requestId, false, `${PRODUCT} watch ${cancelled.value.watchId} cancelled.`, {
        action: input.action,
        status: cancelled.value.status,
        watchId: cancelled.value.watchId,
        durableSeq: watchSeq(cancelled.value),
      });
    }
    const hasGenericSelector = !!input.agentIds?.length || !!input.eventKinds?.length || input.owned !== undefined;
    if (input.watchId || hasGenericSelector) {
      const existing = input.watchId ? this.store.snapshot().watches[input.watchId] : undefined;
      if (input.watchId && !existing)
        throw new SchedulerStateError(
          'watch_missing',
          `Watch '${input.watchId}' is no longer active. Inspect the current activity or register a new watch with selectors.`,
        );
      if (input.watchId && existing?.ownerId !== caller.agentId)
        throw new SchedulerStateError(
          'authority_denied',
          `Watch '${input.watchId}' is not owned by '${caller.agentId}'`,
        );
      const commit = existing
        ? { value: existing, revision: this.store.snapshot().revision }
        : await this.store.registerWatch(
            {
              watchId: this.operationId(caller, 'watch', input.requestId),
              requestIds: input.requestIds,
              agentIds: input.agentIds?.map((reference) => this.resolveAgentId(reference)),
              eventKinds: input.eventKinds,
              owned: input.owned,
              registeringActivationId: this.liveActivation(caller.agentId)?.activationId,
            },
            principal,
            signal,
          );
      const pending = commit.value.status === 'active';
      return this.result(
        input.requestId,
        !!existing,
        pending
          ? `${PRODUCT} watch registered; yield at the Pi boundary.`
          : `${PRODUCT} watch is ${commit.value.status}.`,
        {
          action: input.action,
          status: commit.value.status,
          watchId: commit.value.watchId,
          durableSeq: watchSeq(commit.value),
          ...(commit.value.triggerEventId ? { triggerEventId: commit.value.triggerEventId } : {}),
        },
        pending,
      );
    }
    const snapshot = this.store.snapshot();
    const all = Object.values(snapshot.requests).filter((request) => request.requesterId === caller.agentId);
    const selected = input.requestIds
      ? input.requestIds.map((requestId) => {
          const request = snapshot.requests[requestId];
          if (!request)
            throw new SchedulerStateError(
              'request_missing',
              `Request '${requestId}' is no longer active or is unavailable. Inspect incoming replies and current activity before waiting again.`,
            );
          if (request.requesterId !== caller.agentId)
            throw new SchedulerStateError(
              'authority_denied',
              `Request '${requestId}' is not owned by '${caller.agentId}'`,
            );
          return request;
        })
      : all;
    const pending = selected.filter((request) => requestStatus(snapshot, request) === 'pending');
    return this.result(
      input.requestId,
      false,
      pending.length
        ? `${PRODUCT} requests remain pending; yield at the Pi boundary.`
        : `No selected ${PRODUCT} requests remain pending.`,
      {
        action: input.action,
        status: pending.length ? 'pending' : 'settled',
        requests: selected.map((request) => ({
          requestId: request.requestId,
          recipientId: request.recipientId,
          status: requestStatus(snapshot, request),
          deadlineAtMs: request.deadlineAtMs,
        })),
      },
      pending.length > 0,
    );
  }

  private async assertServiceAccess(caller: LuminariesCaller, command: LuminariesToolCommand): Promise<void> {
    if (caller.kind !== 'service') return;
    const denied = (reason: string): never => {
      throw new SchedulerStateError('authority_denied', `Waves service '${caller.serviceId}' ${reason}`);
    };
    const required = servicePermission(command);
    const grant = this.store.snapshot().root.serviceGrant;
    if (!grant.includes(required)) denied(`is not granted '${required}'`);
    if (command.toolName === TOOL.directory) {
      const request = command.input;
      if (request.includeClosed === true) denied('cannot inspect closed history');
      if (request.view === 'diagnostics' || request.view === 'transcript') denied(`cannot inspect ${request.view}`);
      if (request.agentId) {
        let targetId: string;
        try {
          targetId = this.resolveAgentId(request.agentId);
        } catch (error) {
          if ((await this.store.closedAgentLineage(request.agentId)).length) denied('cannot inspect closed history');
          throw error;
        }
        if (this.store.snapshot().agents[targetId]?.lifecycle !== 'open') denied('cannot inspect closed history');
      }
      return;
    }
  }

  private humanIdentity(agentId: string): { displayName: string; shortId?: string; humanHandle: string } | undefined {
    return humanIdentityInState(this.store.snapshot(), agentId);
  }

  /** Derived once per operation; multicast legs reuse the same identity tables. */
  private operationIdentityTables(): {
    identities: { agentId: string; displayName: string }[];
    shortIds: ReadonlyMap<string, string>;
    handles: ReadonlyMap<string, string>;
    identityOf: (agentId: string) => { displayName: string; shortId?: string; humanHandle: string } | undefined;
    resolveId: (reference: string) => string;
  } {
    const snapshot = this.store.snapshot();
    const identities = Object.values(snapshot.agents).map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.agentId === snapshot.root.rootId ? 'Root' : agent.displayName.value,
    }));
    const shortIds = deriveAgentShortIds(identities.map((identity) => identity.agentId));
    const handles = deriveAgentHandles(identities);
    const identityOf = (agentId: string) => {
      const agent = snapshot.agents[agentId];
      if (!agent) return undefined;
      if (agent.agentId === snapshot.root.rootId) return { displayName: 'Root', humanHandle: 'Root' };
      const shortId = shortIds.get(agentId);
      return {
        displayName: agent.displayName.value,
        ...(shortId ? { shortId } : {}),
        humanHandle: handles.get(agentId) ?? agent.displayName.value,
      };
    };
    const resolveId = (reference: string): string => {
      if (hasUnsafeHumanFacingControl(reference))
        throw new SchedulerStateError('input_invalid', 'Collaborator reference contains a presentation control');
      if (reference.trim().toLowerCase() === 'root') return snapshot.root.rootId;
      const agentId = resolveAgentReference(identities, reference);
      if (!agentId) throw unresolvedAgentReference(identities, reference);
      return agentId;
    };
    return { identities, shortIds, handles, identityOf, resolveId };
  }

  private stateWithAgents(
    snapshot: Readonly<SchedulerState>,
    agents: readonly Readonly<AgentRecord>[],
  ): SchedulerState {
    // Published scheduler images and catalog records are frozen; a shallow agent-map
    // merge shares them safely with the read-only projection path.
    const merged = { ...snapshot.agents };
    for (const agent of agents) merged[agent.agentId] = agent;
    return deepFreeze({ ...snapshot, agents: merged });
  }

  private snapshotWithClosedAgents(): SchedulerState {
    return this.stateWithAgents(this.store.snapshot(), this.store.closedCatalogSnapshot().agents);
  }

  private async resolveAttachmentAgent(reference: string): Promise<{ agentId: string; state: SchedulerState }> {
    if (hasUnsafeHumanFacingControl(reference))
      throw new SchedulerStateError('input_invalid', 'Collaborator reference contains a presentation control');
    const value = reference.trim();
    const hot = this.store.snapshot();
    if (value.toLowerCase() === 'root') return { agentId: hot.root.rootId, state: hot };
    if (hot.agents[value]) return { agentId: value, state: hot };
    if (isLuminariesId(value)) {
      const lineage = await this.store.closedAgentLineage(value);
      if (lineage.length) return { agentId: value, state: this.stateWithAgents(hot, lineage) };
    }
    const state = this.snapshotWithClosedAgents();
    const agentId = resolveAgentReference(
      Object.values(state.agents).map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.agentId === state.root.rootId ? 'Root' : agent.displayName.value,
      })),
      value,
    );
    if (!agentId)
      throw unresolvedAgentReference(
        Object.values(state.agents).map((agent) => ({
          agentId: agent.agentId,
          displayName: agent.agentId === state.root.rootId ? 'Root' : agent.displayName.value,
        })),
        reference,
      );
    return { agentId, state };
  }

  private resolveAgentId(reference: string): string {
    if (hasUnsafeHumanFacingControl(reference))
      throw new SchedulerStateError('input_invalid', 'Collaborator reference contains a presentation control');
    const snapshot = this.store.snapshot();
    if (reference.trim().toLowerCase() === 'root') return snapshot.root.rootId;
    const identities = Object.values(snapshot.agents).map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.agentId === snapshot.root.rootId ? 'Root' : agent.displayName.value,
    }));
    const agentId = resolveAgentReference(identities, reference);
    if (!agentId) throw unresolvedAgentReference(identities, reference);
    return agentId;
  }

  private messageResult(
    input: LuminariesMessageRequest,
    event: PeerEventRecord,
    duplicate: boolean,
    disposition: PeerRouteReceipt['disposition'],
    terminate: boolean,
    requestStatus?: string,
    correlationId?: string,
  ): LuminariesReceipt {
    const recipient = this.humanIdentity(event.recipientId);
    const handle = recipient?.humanHandle ?? event.recipientId;
    const deliveryMode = input.action === 'send' || input.action === 'multicast' ? input.mode : undefined;
    let description: string;
    if (input.action === 'send') {
      if (event.status === 'refused') description = `Message to ${handle} was not delivered.`;
      else if (event.status === 'failed') description = `Message delivery to ${handle} failed.`;
      else if (event.status === 'indeterminate')
        description = `Message to ${handle} has an uncertain delivery outcome; inspect before continuing.`;
      else if (deliveryMode === 'notify_only')
        description = `Notification recorded for ${handle}. No model turn started.`;
      else if (deliveryMode === 'follow_up') description = `Follow-up for ${handle} was accepted for the next turn.`;
      else if (disposition === 'steered') description = `Message for ${handle} was accepted for the active turn.`;
      else description = `Message for ${handle} was accepted to start the next turn.`;
    } else if (input.action === 'request')
      description =
        event.status === 'refused'
          ? `Request to ${handle} was not delivered.`
          : event.status === 'failed'
            ? `Request delivery to ${handle} failed.`
            : event.status === 'indeterminate'
              ? `Request delivery to ${handle} has an uncertain outcome; inspect before continuing.`
              : terminate
                ? `Request accepted for ${handle}. This turn yields for the reply.`
                : `Request to ${handle} is already ${(requestStatus ?? event.status).split('_').join(' ')}; this turn continues.`;
    else if (input.action === 'reply')
      description =
        event.status === 'indeterminate'
          ? 'Reply delivery has an uncertain outcome; inspect before continuing.'
          : `Reply ${event.status === 'settled' ? 'delivered' : event.status.split('_').join(' ')}.`;
    else if (input.action === 'cancel')
      description =
        event.status === 'indeterminate'
          ? 'Request cancellation has an uncertain outcome; inspect before continuing.'
          : `Request cancel ${event.status === 'settled' ? 'recorded' : event.status.split('_').join(' ')}.`;
    else description = `${PRODUCT} ${input.action} ${event.status.split('_').join(' ')}.`;
    return this.result(
      input.requestId,
      duplicate,
      description,
      {
        action: input.action,
        eventId: event.eventId,
        ...(correlationId ? { correlationId } : {}),
        status: event.status,
        disposition,
        ...(deliveryMode ? { mode: deliveryMode } : {}),
        ...(requestStatus ? { requestStatus } : {}),
        ...(recipient ? { recipient } : {}),
        outcomeCode: event.outcomeCode,
      },
      terminate,
    );
  }

  private controlResult(
    input: LuminariesControlRequest,
    control: DirectControlRecord,
    duplicate: boolean,
  ): LuminariesReceipt {
    const target = this.humanIdentity(control.targetId);
    const handle = target?.humanHandle ?? control.targetId;
    const status = control.status.split('_').join(' ');
    return this.result(
      input.requestId,
      duplicate,
      `${PRODUCT} ${input.action.replaceAll('_', ' ')} for ${handle}: ${status}.`,
      {
        action: input.action,
        targetId: control.targetId,
        ...(target ? { target } : {}),
        controlId: control.controlId,
        status: control.status,
        outcomeCode: control.outcomeCode,
      },
    );
  }

  private spawnReceiptResult(requestId: string, agentId: string, duplicate: boolean): LuminariesReceipt {
    const snapshot = this.store.snapshot();
    const agent = snapshot.agents[agentId];
    if (!agent) throw new SchedulerStateError('agent_missing', `Spawned collaborator '${agentId}' disappeared`);
    const runtimeState = agentRuntimeState(snapshot, agent);
    const startingInput = peerMailboxRecords(snapshot).find(
      (event) => event.recipientId === agentId && event.acceptedSeq === agent.createdSeq + 1,
    );
    const startupState =
      runtimeState === 'failed' || runtimeState === 'needs_attention'
        ? runtimeState
        : startingInput &&
            (startingInput.status === 'aborted' ||
              startingInput.status === 'failed' ||
              startingInput.status === 'indeterminate' ||
              startingInput.status === 'refused')
          ? 'needs_attention'
          : runtimeState === 'starting' || startingInput?.status === 'accepted' || startingInput?.status === 'sending'
            ? 'starting'
            : this.liveActivation(agentId)
              ? 'running'
              : 'settled';
    const identity = this.humanIdentity(agent.agentId);
    const handle = identity?.humanHandle ?? agent.agentId;
    const message = duplicate
      ? `${handle} already exists.`
      : startupState === 'failed' || startupState === 'needs_attention'
        ? `${handle} joined the constellation, but the first turn needs review. Open it to see what happened.`
        : startupState === 'settled'
          ? `${handle} joined the constellation. The first turn completed.`
          : `${handle} joined the constellation. Starting the first turn.`;
    return this.result(requestId, duplicate, message, {
      agent: mutationAgentReceipt(snapshot, agent, duplicate ? 'already_known' : 'admitted', identity),
      admitted: true,
      startupState,
      effectiveConfiguration: {
        model: agent.model ? (agent.provider ? `${agent.provider}/${agent.model}` : agent.model) : null,
        thinking: agent.thinking ?? null,
        contextMode: agent.context.mode,
        cwd: agent.cwd,
        resources: {
          extensions: this.selectedExtensions(agent),
          skills: [...agent.launch.skills],
          promptTemplates: [...agent.launch.promptTemplates],
          themes: [...agent.launch.themes],
        },
      },
    });
  }

  private async publishPermissionDecision(
    caller: LuminariesCaller,
    toolName: LuminariesToolName,
    requestId: string,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof SchedulerStateError)) return;
    if (
      error.code !== 'authority_denied' &&
      error.code !== 'capability_denied' &&
      error.code !== 'capability_escalation'
    )
      return;
    const callerAgent = this.store.snapshot().agents[caller.agentId];
    if (!callerAgent?.parentId) return;
    const sourceActivationId = this.liveActivation(caller.agentId)?.activationId;
    if (!sourceActivationId) return;
    await this.store
      .admitSystemEvent({
        dedupeKey: `permission:${sha256(`${requestId}:${error.code}`).slice(0, 64)}`,
        type: 'permission_decision',
        senderId: caller.agentId,
        recipientId: callerAgent.parentId,
        message: `${callerAgent.displayName.value} was refused ${toolName} by ${PRODUCT} policy. Inspect its intent before changing grants.`,
        wake: true,
        sourceActivationId,
      })
      .catch((failure) => this.addDiagnostic(failure));
  }

  private result(
    requestId: string,
    duplicate: boolean,
    content: string,
    details: Record<string, unknown>,
    terminate = false,
  ): LuminariesReceipt {
    const bounded: Record<string, unknown> = { requestId, duplicate, ...details };
    const message = content.slice(0, 1_000);
    const receipt = { message, details: bounded, ...(terminate ? { terminate: true } : {}) };
    const measuredBytes = receiptWireBytes(requestId, message, bounded, terminate);
    if (measuredBytes > MAX_RESULT_BYTES) {
      const status = typeof details.status === 'string' ? details.status : 'result_bound';
      const pagedRead = details.action === 'list' || details.action === 'inspect';
      const fallback: Record<string, unknown> = {
        requestId,
        duplicate,
        ...receiptFacts(details, false),
        status,
        resultBound: {
          measuredBytes,
          limitBytes: MAX_RESULT_BYTES,
          view:
            typeof details.view === 'string'
              ? details.view
              : typeof details.action === 'string'
                ? details.action
                : 'unknown',
          actionCompleted: !pagedRead,
          retry: pagedRead
            ? 'Use the returned cursor or request a narrower view.'
            : 'This action already executed, but its receipt was truncated. It must not be replayed; inspect current state instead.',
        },
      };
      return {
        message,
        details: fallback,
        ...(terminate ? { terminate: true } : {}),
      };
    }
    return receipt;
  }

  private async acknowledgeInputAfterIndeterminate(
    caller: LuminariesCaller,
    event: Readonly<PeerEventRecord>,
  ): Promise<void> {
    if (event.mode === 'notify_only' || event.status === 'refused') return;
    if (
      caller.kind !== 'operator' &&
      caller.kind !== 'service' &&
      caller.agentId !== event.recipientId &&
      !this.isDescendant(caller.agentId, event.recipientId)
    )
      return;
    try {
      await this.store.markAgentContinuedAfterIndeterminate(event.recipientId, this.principal(caller));
    } catch (error) {
      this.addDiagnostic(error);
    }
  }

  private async ensureSourceActivation(
    caller: LuminariesCaller,
    inputKind: string,
  ): Promise<{ activation: ActivationRecord; transient: boolean }> {
    const existing = this.liveActivation(caller.agentId);
    if (existing) return { activation: existing, transient: false };
    if (caller.kind === 'child')
      throw new SchedulerStateError(
        'sender_activation_missing',
        `Authenticated sender '${caller.agentId}' has no live activation`,
      );
    const activation = await this.store.startActivation(caller.agentId, `parent_${inputKind}`);
    return { activation: activation.value, transient: true };
  }

  private async finishSourceActivation(
    activation: ActivationRecord,
    outcome: 'settled' | 'indeterminate',
  ): Promise<void> {
    await this.store.finishActivationIfRunning(activation.activationId, activation.leaseToken, outcome);
  }

  private liveActivation(agentId: string): ActivationRecord | undefined {
    return Object.values(this.store.snapshot().activations).find(
      (activation) => activation.agentId === agentId && activation.state === 'running',
    );
  }
  private parentCaller(context: unknown): LuminariesParentCaller {
    this.assertRunning();
    const session = this.requiredSession();
    if (!isRecord(context) || typeof context.cwd !== 'string')
      throw new SchedulerStateError('session_stale', 'Parent tool context is invalid');
    const mode = context.mode;
    if (mode !== 'tui' && mode !== 'rpc' && mode !== 'json' && mode !== 'print')
      throw new SchedulerStateError('session_stale', 'Parent tool context has an invalid Pi host mode');
    const manager = context.sessionManager;
    if (
      !isRecord(manager) ||
      typeof manager.getSessionId !== 'function' ||
      typeof manager.getSessionFile !== 'function'
    )
      throw new SchedulerStateError('session_stale', 'Parent tool context lacks a session identity');
    const sessionId = manager.getSessionId();
    const sessionFile = manager.getSessionFile();
    if (
      sessionId !== session.sessionId ||
      typeof sessionFile !== 'string' ||
      resolve(sessionFile) !== session.sessionFile ||
      resolve(context.cwd) !== session.cwd
    )
      throw new SchedulerStateError('session_stale', 'Parent tool context is from another Pi session');
    return {
      kind: 'parent',
      mode,
      agentId: this.rootId(),
      rootId: this.rootId(),
      runtimeOwner: this.requiredRootRuntimeOwner(),
      generation: this.generation,
      sessionId,
      sessionFile,
      cwd: session.cwd,
    };
  }
  private childCaller(binding: Readonly<PeerBridgeBinding>): LuminariesChildCaller {
    const agent = this.store.snapshot().agents[binding.agentId];
    if (
      !agent ||
      agent.lifecycle !== 'open' ||
      agent.runtimeOwner !== binding.runtimeOwner ||
      agent.runtimePhase !== 'ready' ||
      binding.rootId !== this.rootId() ||
      binding.generation !== this.generation ||
      (this.options.acceptedBuild !== undefined && binding.buildId !== this.options.acceptedBuild.id) ||
      !binding.sessionId ||
      binding.sessionId !== agent.sessionId
    )
      throw new SchedulerStateError('bridge_auth', 'Child bridge binding is stale or forged');
    return {
      kind: 'child',
      agentId: agent.agentId,
      rootId: this.rootId(),
      runtimeOwner: binding.runtimeOwner,
      generation: this.generation,
      ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
    };
  }
  private assertPersistentParent(caller: LuminariesCaller, action: string): void {
    if (caller.kind !== 'parent' || (caller.mode !== 'print' && caller.mode !== 'json')) return;
    throw new SchedulerStateError(
      'host_mode_unsupported',
      `${action} needs a persistent Pi parent session. Pi ${caller.mode} mode exits when this turn ends; use ${TOOL.message} send/multicast and continue, or run Pi in TUI/RPC mode.`,
    );
  }
  private assertCaller(caller: LuminariesCaller): void {
    this.assertRunning();
    if (caller.generation !== this.generation || caller.rootId !== this.rootId())
      throw new SchedulerStateError('session_stale', `${PRODUCT} caller generation is stale`);
    const agent = this.store.snapshot().agents[caller.agentId];
    if (
      !agent ||
      agent.lifecycle !== 'open' ||
      (agent.parentId === null
        ? caller.runtimeOwner !== this.requiredRootRuntimeOwner()
        : agent.runtimeOwner !== caller.runtimeOwner || agent.runtimePhase !== 'ready')
    )
      throw new SchedulerStateError('runtime_owner', `Caller '${caller.agentId}' does not own a ready runtime`);
    if (caller.kind === 'parent') {
      const session = this.requiredSession();
      if (
        caller.sessionId !== session.sessionId ||
        caller.sessionFile !== session.sessionFile ||
        caller.cwd !== session.cwd
      )
        throw new SchedulerStateError('session_stale', 'Parent caller session binding is stale');
    }
  }
  private auth(caller: LuminariesCaller): PeerEventAuth {
    return {
      agentId: caller.agentId,
      rootId: caller.rootId,
      runtimeOwner: caller.runtimeOwner,
      origin: caller.kind === 'operator' ? 'operator' : caller.kind === 'service' ? 'service' : 'agent',
    };
  }
  private principal(caller: LuminariesCaller): SchedulerPrincipal {
    return caller.kind === 'operator' || caller.kind === 'service'
      ? { kind: 'operator' }
      : { kind: 'agent', agentId: caller.agentId };
  }
  private serviceCaller(): LuminariesServiceCaller {
    this.assertRunning();
    return {
      kind: 'service',
      serviceId: LUMINARIES_IDENTITY.serviceId,
      agentId: this.rootId(),
      rootId: this.rootId(),
      runtimeOwner: this.requiredRootRuntimeOwner(),
      generation: this.generation,
    };
  }
  private operatorCaller(): LuminariesOperatorCaller {
    this.assertRunning();
    return {
      kind: 'operator',
      agentId: this.rootId(),
      rootId: this.rootId(),
      runtimeOwner: this.requiredRootRuntimeOwner(),
      generation: this.generation,
    };
  }

  private statePath(_binding: LuminariesSessionBinding): string {
    return luminariesStatePathForSession({
      ...this.requiredSession(),
      statePath: this.options.statePath,
      agentDir: this.options.agentDir,
      rootId: this.options.rootId,
    });
  }
  private childSessionRoot(): string {
    return join(dirname(this.store.statePath), CHILD_SESSION_ROOT);
  }
  private async cleanupOrphanSpawnArtifacts(): Promise<void> {
    const referenced = new Set([
      ...Object.keys(this.store.snapshot().agents),
      ...this.store.closedCatalogSnapshot().agents.map((agent) => agent.agentId),
    ]);
    const root = this.childSessionRoot();
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith(`${LUMINARIES_IDENTITY.namespace.publicIdPrefix}agent-`) ||
        !isLuminariesId(entry.name) ||
        referenced.has(entry.name)
      )
        continue;
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
  private rootId(): string {
    const session = this.session ?? this.options;
    if (this.options.rootId) return idFrom(this.options.rootId, 'rootId');
    const sessionId = session.sessionId;
    if (!sessionId) throw new SchedulerStateError('session_invalid', 'A persistent parent session binding is required');
    return luminariesRootIdForSession({ sessionId });
  }
  private requiredRootRuntimeOwner(): string {
    return this.rootRuntime.runtimeOwner;
  }
  private requiredSession(): LuminariesSessionBinding {
    if (!this.session) throw new Error(`${PRODUCT} manager has no session binding`);
    return this.session;
  }
  private selectSession(binding?: LuminariesSessionBinding): LuminariesSessionBinding {
    const candidate = binding ?? {
      sessionId: this.options.sessionId,
      sessionFile: this.options.sessionFile,
      cwd: this.options.cwd,
      generation: this.options.generation ?? this.generation,
    };
    if (!candidate.sessionId || !candidate.sessionFile || !candidate.cwd)
      throw new SchedulerStateError('session_invalid', 'A persistent parent session ID, file, and cwd are required');
    const selected = {
      sessionId: candidate.sessionId,
      sessionFile: resolve(candidate.sessionFile),
      cwd: resolve(candidate.cwd),
      generation: candidate.generation ?? this.generation,
    };
    this.assertSession(selected);
    return selected;
  }
  private assertSession(binding: LuminariesSessionBinding): void {
    if (!binding || binding.generation !== this.generation)
      throw new SchedulerStateError('session_stale', `${PRODUCT} session generation is stale`);
    if (!binding.sessionId || !binding.sessionFile || !binding.cwd)
      throw new SchedulerStateError('session_invalid', `${PRODUCT} session binding is incomplete`);
    if (
      this.session &&
      (this.session.sessionId !== binding.sessionId ||
        this.session.sessionFile !== resolve(binding.sessionFile) ||
        this.session.cwd !== resolve(binding.cwd))
    )
      throw new SchedulerStateError('session_stale', `${PRODUCT} session binding differs from the active manager`);
  }
  private operationId(caller: LuminariesCaller, operation: string, requestId: string): string {
    return publicId(LUMINARIES_IDENTITY.settingsKey, `${caller.rootId}:${caller.agentId}:${operation}:${requestId}`);
  }
  private operatorRequestId(operationId?: string): string {
    if (operationId !== undefined && !isUuid(operationId))
      throw new SchedulerStateError('input_invalid', 'Attachment operation identity is invalid');
    return publicId(`${LUMINARIES_IDENTITY.namespace.publicIdPrefix}ui`, operationId ?? randomUUID());
  }
  private isDescendant(parentId: string, targetId: string): boolean {
    const state = this.store.snapshot();
    let current = state.agents[targetId];
    while (current?.parentId) {
      if (current.parentId === parentId) return true;
      current = state.agents[current.parentId];
    }
    return false;
  }
  private assertRunning(): void {
    if (this.state !== 'running')
      throw new SchedulerStateError('manager_closed', `${PRODUCT} manager is ${this.state}`);
  }
  private addDiagnostic(error: unknown): void {
    this.diagnosticsRing.push(asError(error).message.slice(0, 500));
    if (this.diagnosticsRing.length > 64) this.diagnosticsRing.shift();
  }
}
function requiredToolString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new SchedulerStateError('input_invalid', `${PRODUCT} ${label} is required`);
  return value;
}

function isLuminariesToolName(value: string): value is LuminariesToolName {
  return LUMINARIES_IDENTITY.toolNames.some((name) => value === name);
}
