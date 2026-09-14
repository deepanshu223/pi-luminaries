import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CapabilityRequest } from './capability-policy.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { emitActivationCompletionState } from './completion-policy.ts';
import {
  applyOfflineConfigurationState,
  beginLiveConfigurationState,
  finishLiveConfigurationState,
  type ConfigurationInput,
} from './configuration-policy.ts';
import {
  ControlLog,
  type ControlLogCommit,
  type ControlLogNoReplayRecord,
  type ControlLogStateCollection,
} from './control-log.ts';
import {
  SchedulerStateError,
  assertActivationLease,
  absolutePath,
  buildActivityIndex,
  canContinuePastIndeterminate,
  finishActivationState,
  humanFacingText,
  mailboxRecordId,
  mailboxRecordSeq,
  indeterminateContinuationActivationId,
  isContinuableIndeterminateEvidence,
  nextSequence,
  startActivationState,
  assertSessionFileAvailable,
  bootstrapState,
  deepFreeze,
  directMailboxRecords,
  id,
  integer,
  mailboxActivationIds,
  normalizePrincipal,
  peerMailboxRecord,
  peerMailboxRecords,
  releaseMailboxAttemptState,
  requestStatus,
  sha256,
  text,
  type ActivationRecord,
  type ActivationState,
  type DirectControlAction,
  type DirectControlRecord,
  type DirectControlStatus,
  type AdmitAgentInput,
  type AgentConfigurationChange,
  type AgentMetadataPatch,
  type AgentRecord,
  type AgentRuntimeState,
  type PeerEventMode,
  type PeerEventRecord,
  type SchedulerBootstrap,
  type SchedulerCommit,
  type SchedulerPrincipal,
  type SchedulerStartup,
  type SchedulerState,
  type WatchRecord,
  type MailboxRecord,
} from './scheduler-state.ts';
import { normalizeAgentMetadataPatch, updateAgentMetadata } from './agent-directory.ts';
import {
  admitAgent,
  approveRootExtensionCapability,
  closeAgent,
  normalizeAdmission,
  reconcileRootPolicy,
  resumeAgent,
  setAgentArchived,
  setAgentCapabilities,
  type RootPolicyInput,
} from './tree-policy.ts';
import {
  assertPhysicalReferencesPublic,
  canonicalizeSessionDirectory,
  canonicalizeSessionFile,
  validatePhysicalPublishedReferences,
  validatePhysicalSessionNamespace,
} from './private-path-policy.ts';
import { acceptSystemEventState, type SystemEventInput } from './system-event-policy.ts';
import {
  cancelActiveWatchState,
  cancelWatchState,
  registerWatchState,
  resolveReadyWatchesState,
  triggerWatchIfReadyState,
  type WatchInput,
} from './watch-policy.ts';
import {
  acceptPeerEventState,
  beginPeerDeliveryState,
  closeQueuedPeerEventsState,
  finishPeerDeliveryState,
  admitPeerAtModelBoundaryState,
  normalizePeerEventEnvelope,
  normalizePeerEventRequest,
  preparePeerEventsForActivationFinishState,
  reconcilePeerEventState,
  requeuePeerEventBeforeWriteState,
  type PeerDispatchPlan,
  type PeerEventAuth,
  type PeerEventRequest,
  type PeerRouteReceipt,
} from './peer-event-policy.ts';
import {
  admitDirectControlState,
  beginDirectControlAttemptState,
  finishDirectControlState,
  markDirectInterruptBoundaryState,
  normalizeDirectControlInput,
  prepareDirectControlsForActivationFinishState,
  reconcileDirectControlState,
  type DirectControlAdmission,
  type DirectControlInput,
} from './direct-control-policy.ts';
import {
  acceptCorrelatedCancelState,
  acceptCorrelatedReplyState,
  acceptCorrelatedRequestState,
  applyTerminalEventToRequestState,
  closeCorrelatedRequestsState,
  normalizeCorrelatedCancel,
  normalizeCorrelatedReply,
  normalizeCorrelatedRequest,
  timeoutCorrelatedRequestState,
  type CorrelatedCancelInput,
  type CorrelatedReplyInput,
  type CorrelatedRequestInput,
  type CorrelatedRequestReceipt,
} from './request-policy.ts';

export { SchedulerStateError } from './scheduler-state.ts';
export { validateSchedulerState } from './scheduler-state-validation.ts';
export type {
  ActivationRecord,
  ActivationState,
  AdmitAgentInput,
  AgentMetadataPatch,
  AgentRecord,
  AgentRuntimeState,
  CorrelatedRequestRecord,
  CorrelatedRequestStatus,
  DirectControlAction,
  DirectControlRecord,
  DirectControlStatus,
  DeclaredField,
  DeclaredSource,
  ExpertCard,
  ExpertCardInput,
  PeerDeliveryKind,
  PeerEventKind,
  PeerEventMode,
  PeerEventOrigin,
  PeerEventRecord,
  PeerEventStatus,
  RequestResolutionCode,
  SchedulerBootstrap,
  SchedulerCommit,
  SchedulerPrincipal,
  SchedulerStartup,
  SchedulerState,
  SystemEventType,
  WatchRecord,
  WatchStatus,
} from './scheduler-state.ts';
export type { DirectControlAdmission, DirectControlInput } from './direct-control-policy.ts';
export type { PeerDispatchPlan, PeerEventAuth, PeerEventRequest, PeerRouteReceipt } from './peer-event-policy.ts';
export type {
  CorrelatedCancelInput,
  CorrelatedReplyInput,
  CorrelatedRequestInput,
  CorrelatedRequestReceipt,
} from './request-policy.ts';

const MAX_DIAGNOSTICS = 32;
const MAX_RECENT_INTERACTION_EVENTS = 5;
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

export type SchedulerMailboxIntent =
  | { kind: 'admit_direct'; input: DirectControlInput; requestedBy: SchedulerPrincipal }
  | { kind: 'begin_delivery'; recordId: string; runtimeOwner: string }
  | {
      kind: 'release_delivery';
      recordId: string;
      attemptId: string;
      settlement?: {
        activationId: string;
        leaseToken: string;
        outcome: Exclude<ActivationState, 'running'>;
      };
    }
  | { kind: 'admit_boundary'; recordId: string; attemptId: string; aborted?: boolean }
  | {
      kind: 'finish_delivery';
      recordId: string;
      attemptId: string;
      status: Extract<DirectControlStatus, 'refused' | 'failed' | 'indeterminate'>;
      outcomeCode: string;
    }
  | { kind: 'reconcile_delivery'; recordId: string };

type SchedulerMailboxIntentResult =
  DirectControlAdmission | DirectControlRecord | PeerDispatchPlan | PeerEventRecord | undefined;
function multicastRecipients(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1)
    throw new SchedulerStateError('input_invalid', 'Multicast recipients must be a nonempty array');
  const recipients = values.map((value) => id(value, 'recipientId'));
  if (new Set(recipients).size !== recipients.length)
    throw new SchedulerStateError('input_invalid', 'Multicast recipients contain duplicates');
  return recipients;
}
function multicastLegId(parentId: string, recipientId: string, index: number): string {
  return `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}multicast-${sha256(`${parentId}\u0000${recipientId}\u0000${index}`).slice(0, 40)}`;
}

function affectAcceptedRecipient(affectedRecipientIds: Set<string>, event: PeerEventRecord): void {
  if (event.status === 'accepted') affectedRecipientIds.add(event.recipientId);
}

function settleActivationState(
  draft: SchedulerState,
  activationId: string,
  leaseToken: string,
  outcome: Exclude<ActivationState, 'running'>,
  affectedRecipientIds: Set<string>,
) {
  prepareDirectControlsForActivationFinishState(draft, activationId);
  const terminal = preparePeerEventsForActivationFinishState(draft, activationId, outcome);
  for (const event of terminal) {
    const generated = applyTerminalEventToRequestState(draft, event, randomUUID);
    if (generated?.status === 'accepted') affectedRecipientIds.add(generated.recipientId);
  }
  const result = finishActivationState(draft, activationId, leaseToken, outcome);
  if (result.changed) {
    affectedRecipientIds.add(result.value.agentId);
    for (const event of emitActivationCompletionState(draft, result.value, outcome, randomUUID).events)
      if (event.status === 'accepted') affectedRecipientIds.add(event.recipientId);
  }
  return result;
}
function outboxRequired(event: PeerEventRecord): boolean {
  return (
    event.status === 'accepted' ||
    event.status === 'sending' ||
    (event.mode === 'notify_only' && event.status === 'settled')
  );
}

function assertStoreOperationActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new SchedulerStateError('bridge_cancelled', 'The bridge operation was cancelled before admission');
}

function mailboxOperationId(record: Readonly<MailboxRecord>): string {
  return record.lane === 'direct' ? record.requestId : record.bridgeRequestId;
}

type MutationChanges = {
  root: boolean;
  records: Record<ControlLogStateCollection, Set<string>>;
};

type MutationMarker =
  | { kind: 'root' }
  | { kind: 'collection'; collection: ControlLogStateCollection }
  | { kind: 'record'; collection: ControlLogStateCollection; key: string };

type TrackedDraft = {
  draft: SchedulerState;
  changes: MutationChanges;
  unwrap<T>(value: T): T;
  restore(): SchedulerState;
};

interface MutationCatalogs {
  closed: Map<string, AgentRecord>;
  noReplay: Map<string, ControlLogNoReplayRecord>;
}

interface MutationPublication {
  publish(): void;
  reject(error: unknown): void;
}

interface MutationBatch extends MutationCatalogs {
  state: SchedulerState;
  commits: ControlLogCommit[];
  publications: MutationPublication[];
}

type PendingMutation = (batch: MutationBatch) => Promise<void>;

const TRACKED_COLLECTIONS: readonly ControlLogStateCollection[] = [
  'agents',
  'activations',
  'mailbox',
  'requests',
  'watches',
];

function createMutationChanges(): MutationChanges {
  return {
    root: false,
    records: Object.fromEntries(TRACKED_COLLECTIONS.map((name) => [name, new Set<string>()])) as Record<
      ControlLogStateCollection,
      Set<string>
    >,
  };
}

function createTrackedDraft(previous: SchedulerState): TrackedDraft {
  const raw = structuredClone(previous);
  const changes = createMutationChanges();
  const proxyTargets = new WeakMap<object, object>();
  const proxyCache = new WeakMap<object, Map<string, object>>();

  const unwrap = <T>(value: T): T => {
    const seen = new WeakMap<object, object>();
    const strip = (candidate: unknown): unknown => {
      if (candidate === null || typeof candidate !== 'object') return candidate;
      const target = proxyTargets.get(candidate) ?? candidate;
      const known = seen.get(target);
      if (known) return known;
      if (Array.isArray(target)) {
        const result: unknown[] = [];
        seen.set(target, result);
        for (const item of target) result.push(strip(item));
        return result;
      }
      const result: Record<string, unknown> = {};
      seen.set(target, result);
      for (const [key, item] of Object.entries(target)) result[key] = strip(item);
      return result;
    };
    return strip(value) as T;
  };

  const mark = (marker: MutationMarker, property?: PropertyKey): void => {
    if (marker.kind === 'root') {
      changes.root = true;
      return;
    }
    if (marker.kind === 'collection') {
      if (typeof property === 'string') changes.records[marker.collection].add(property);
      return;
    }
    changes.records[marker.collection].add(marker.key);
  };

  const wrap = (value: unknown, marker: MutationMarker): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const target = proxyTargets.get(value) ?? value;
    const cacheKey =
      marker.kind === 'root'
        ? 'root'
        : marker.kind === 'collection'
          ? `collection:${marker.collection}`
          : `record:${marker.collection}:${marker.key}`;
    let cached = proxyCache.get(target)?.get(cacheKey);
    if (cached) return cached;
    const handler: ProxyHandler<object> = {
      get(current, property, receiver) {
        const child = Reflect.get(current, property, receiver);
        if (marker.kind === 'root' && typeof property === 'string') {
          if (property === 'root') return wrap(child, { kind: 'root' });
          if (TRACKED_COLLECTIONS.includes(property as ControlLogStateCollection))
            return wrap(child, { kind: 'collection', collection: property as ControlLogStateCollection });
          return child;
        }
        if (
          marker.kind === 'collection' &&
          typeof property === 'string' &&
          Object.prototype.hasOwnProperty.call(current, property)
        )
          return wrap(child, { kind: 'record', collection: marker.collection, key: property });
        if (marker.kind === 'collection') return child;
        return wrap(child, marker);
      },
      set(current, property, next) {
        mark(marker, property);
        return Reflect.set(current, property, unwrap(next), current);
      },
      deleteProperty(current, property) {
        mark(marker, property);
        return Reflect.deleteProperty(current, property);
      },
      defineProperty(current, property, descriptor) {
        mark(marker, property);
        if ('value' in descriptor) descriptor.value = unwrap(descriptor.value);
        return Reflect.defineProperty(current, property, descriptor);
      },
    };
    cached = new Proxy(target, handler);
    proxyTargets.set(cached, target);
    let entries = proxyCache.get(target);
    if (!entries) {
      entries = new Map();
      proxyCache.set(target, entries);
    }
    entries.set(cacheKey, cached);
    return cached;
  };

  const draft = wrap(raw, { kind: 'root' }) as SchedulerState;
  return {
    draft,
    changes,
    unwrap,
    restore: () => raw,
  };
}

/** Shared continuation transition: clears needs_attention once newer indeterminate evidence exists. */
function continuePastIndeterminateState(draft: SchedulerState, agentId: string, catalogs: MutationCatalogs): boolean {
  const agent = draft.agents[agentId];
  const cold = [...catalogs.noReplay.values()].map((item) => item.record);
  if (!agent || !canContinuePastIndeterminate(draft, agentId, cold)) return false;
  agent.continuedAfterSeq = nextSequence(draft);
  if (agent.attention?.kind === 'needs_attention') delete agent.attention;
  return true;
}

function causationCrossesClosedAgent(
  state: Readonly<SchedulerState>,
  eventsById: ReadonlyMap<string, Readonly<PeerEventRecord>>,
  event: Readonly<PeerEventRecord>,
): boolean {
  const seen = new Set<string>();
  let current: Readonly<PeerEventRecord> | undefined = event;
  while (current && !seen.has(current.eventId)) {
    seen.add(current.eventId);
    if (
      state.agents[current.senderId]?.lifecycle === 'closed' ||
      state.agents[current.recipientId]?.lifecycle === 'closed'
    )
      return true;
    current = current.causationId ? eventsById.get(current.causationId) : undefined;
  }
  return false;
}

function retireCurrentFacts(state: SchedulerState, surfacedNotifications?: ReadonlySet<string>): void {
  const activityIndex = buildActivityIndex(state);
  for (const [requestId, request] of Object.entries(state.requests))
    if (requestStatus(state, request) !== 'pending') delete state.requests[requestId];
  for (const [watchId, watch] of Object.entries(state.watches))
    if (watch.status !== 'active') delete state.watches[watchId];

  const runningActivations = new Set<string>();
  const attentionActivations = new Set<string>();
  for (const activation of Object.values(state.activations)) {
    if (activation.state === 'running') runningActivations.add(activation.activationId);
    else if (
      activation.terminalSeq !== undefined &&
      state.agents[activation.agentId]?.attention?.seq === activation.terminalSeq
    )
      attentionActivations.add(activation.activationId);
  }
  const events = peerMailboxRecords(state);
  const retainedEvents = new Set<string>();
  const causallyRetainedEvents = new Set<string>();
  for (const request of Object.values(state.requests)) {
    retainedEvents.add(request.requestEventId);
    causallyRetainedEvents.add(request.requestEventId);
    if (request.terminalEventId) retainedEvents.add(request.terminalEventId);
    if (request.terminalEventId) causallyRetainedEvents.add(request.terminalEventId);
  }
  for (const watch of Object.values(state.watches))
    for (const eventId of watch.causalInputs ?? []) {
      retainedEvents.add(eventId);
      causallyRetainedEvents.add(eventId);
    }
  const recentInteractionEvents = new Set<string>();
  const recentInteractionCounts = new Map<string, number>();
  for (const event of events.slice().sort((left, right) => mailboxRecordSeq(right) - mailboxRecordSeq(left))) {
    if (event.status !== 'settled' || !event.message || event.systemType === 'background_completion') continue;
    const participants = [...new Set([event.senderId, event.recipientId])];
    if (participants.some((agentId) => state.agents[agentId]?.lifecycle !== 'open')) continue;
    if (!participants.some((agentId) => (recentInteractionCounts.get(agentId) ?? 0) < MAX_RECENT_INTERACTION_EVENTS))
      continue;
    retainedEvents.add(event.eventId);
    recentInteractionEvents.add(event.eventId);
    for (const agentId of participants)
      recentInteractionCounts.set(agentId, (recentInteractionCounts.get(agentId) ?? 0) + 1);
  }
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  const latestCompletionByAgent = new Map<string, PeerEventRecord>();
  for (const event of events) {
    if (event.systemType !== 'background_completion') continue;
    const latest = latestCompletionByAgent.get(event.senderId);
    if (!latest || latest.acceptedSeq < event.acceptedSeq) latestCompletionByAgent.set(event.senderId, event);
  }
  for (const event of events) {
    const current =
      event.status === 'accepted' ||
      event.status === 'sending' ||
      event.status === 'consumed' ||
      event.status === 'indeterminate' ||
      (!surfacedNotifications?.has(event.eventId) &&
        event.mode === 'notify_only' &&
        event.status === 'settled' &&
        (event.systemType !== 'background_completion' || latestCompletionByAgent.get(event.senderId) === event) &&
        state.agents[event.senderId]?.lifecycle === 'open' &&
        state.agents[event.recipientId]?.lifecycle === 'open' &&
        !causationCrossesClosedAgent(state, eventsById, event)) ||
      (event.sourceActivationId !== undefined &&
        (runningActivations.has(event.sourceActivationId) || attentionActivations.has(event.sourceActivationId))) ||
      (event.activationId !== undefined &&
        (runningActivations.has(event.activationId) || attentionActivations.has(event.activationId)));
    if (current) {
      retainedEvents.add(event.eventId);
      causallyRetainedEvents.add(event.eventId);
    }
  }
  const pending = [...causallyRetainedEvents];
  for (let index = 0; index < pending.length; index++) {
    const cause = eventsById.get(pending[index])?.causationId;
    if (cause && !causallyRetainedEvents.has(cause)) {
      retainedEvents.add(cause);
      causallyRetainedEvents.add(cause);
      pending.push(cause);
    }
  }

  const controlsWithReplacement = new Set(
    events.map((event) => event.afterControlId).filter((controlId): controlId is string => controlId !== undefined),
  );
  for (const [recordId, record] of Object.entries(state.mailbox)) {
    if (record.lane === 'direct') {
      // Dependent-replacement and issuer-running checks against the shared index
      // keep this retirement pass linear in changed-work size.
      const hasDependentReplacement = controlsWithReplacement.has(record.controlId);
      const issuerAgentId = record.issuer.kind === 'agent' ? record.issuer.agentId : undefined;
      const issuerRunning =
        issuerAgentId !== undefined &&
        (activityIndex.activationsByAgent.get(issuerAgentId) ?? []).some(
          (activation) => activation.state === 'running',
        );
      if (
        record.status !== 'accepted' &&
        record.status !== 'sending' &&
        record.status !== 'indeterminate' &&
        !issuerRunning &&
        !hasDependentReplacement
      )
        delete state.mailbox[recordId];
      continue;
    }
    if (record.status !== 'consumed' && !outboxRequired(record) && !recentInteractionEvents.has(record.eventId))
      delete record.message;
    if (!retainedEvents.has(record.eventId)) delete state.mailbox[recordId];
  }
  const referencedActivations = mailboxActivationIds(state);
  for (const activationId of attentionActivations) referencedActivations.add(activationId);
  for (const [activationId, activation] of Object.entries(state.activations))
    if (activation.state !== 'running' && !referencedActivations.has(activationId))
      delete state.activations[activationId];
}

function currentState(state: SchedulerState): SchedulerState {
  const current = state;
  const retainedCausations = new Set<string>();
  for (const event of peerMailboxRecords(current))
    if (event.status !== 'indeterminate' && event.causationId) retainedCausations.add(event.causationId);
  for (const request of Object.values(current.requests)) {
    retainedCausations.add(request.requestEventId);
    if (request.terminalEventId) retainedCausations.add(request.terminalEventId);
  }
  for (const watch of Object.values(current.watches))
    for (const eventId of watch.causalInputs ?? []) retainedCausations.add(eventId);
  const pendingCausations = [...retainedCausations];
  for (let index = 0; index < pendingCausations.length; index++) {
    const cause = peerMailboxRecord(current, pendingCausations[index])?.causationId;
    if (cause && !retainedCausations.has(cause)) {
      retainedCausations.add(cause);
      pendingCausations.push(cause);
    }
  }
  for (const [recordId, record] of Object.entries(current.mailbox))
    if (record.status === 'indeterminate' && !retainedCausations.has(recordId)) {
      delete current.mailbox[recordId];
    }
  const referencedActivations = mailboxActivationIds(current);
  for (const activation of Object.values(current.activations))
    if (
      activation.terminalSeq !== undefined &&
      current.agents[activation.agentId]?.attention?.seq === activation.terminalSeq
    )
      referencedActivations.add(activation.activationId);
  for (const [activationId, activation] of Object.entries(current.activations)) {
    if (activation.state === 'running') referencedActivations.add(activationId);
    else if (!referencedActivations.has(activationId)) delete current.activations[activationId];
  }
  const retainedAgentIds = new Set(
    Object.values(current.agents)
      .filter((agent) => agent.lifecycle === 'open' || agent.runtimeOwner !== undefined)
      .map((agent) => agent.agentId),
  );
  for (const record of Object.values(current.mailbox)) {
    if (record.lane === 'direct') {
      retainedAgentIds.add(record.targetId);
      if (record.issuer.kind === 'agent') retainedAgentIds.add(record.issuer.agentId);
    } else {
      retainedAgentIds.add(record.senderId);
      retainedAgentIds.add(record.recipientId);
    }
  }
  for (const activation of Object.values(current.activations)) retainedAgentIds.add(activation.agentId);
  for (const watch of Object.values(current.watches)) {
    retainedAgentIds.add(watch.ownerId);
    for (const agentId of watch.agentIds ?? []) retainedAgentIds.add(agentId);
  }
  const pending = [...retainedAgentIds];
  for (let index = 0; index < pending.length; index++) {
    const parentId = current.agents[pending[index]]?.parentId;
    if (parentId && !retainedAgentIds.has(parentId)) {
      retainedAgentIds.add(parentId);
      pending.push(parentId);
    }
  }
  for (const [agentId, agent] of Object.entries(current.agents))
    if (agent.lifecycle === 'closed' && !retainedAgentIds.has(agentId)) delete current.agents[agentId];
  return current;
}

/** Serialized durable persistence facade. Tree and directory policy live in dedicated pure modules. */
export class SchedulerStore {
  readonly statePath: string;
  readonly startup: SchedulerStartup;
  readonly deliveryPayloadDirectory: string;
  private readonly log: ControlLog;
  private state: SchedulerState;
  private readonly closedCatalog: Map<string, AgentRecord>;
  private readonly noReplayCatalog: Map<string, ControlLogNoReplayRecord>;
  private closedCatalogRevisionValue: number;
  private operations: Promise<void> = Promise.resolve();
  private readonly pendingMutations: PendingMutation[] = [];
  private resourceClosing = false;
  private readonly diagnosticsRing: string[] = [];
  private readonly changeListeners = new Set<(revision: number, affectedRecipientIds: readonly string[]) => void>();

  private constructor(
    log: ControlLog,
    image: {
      state: SchedulerState;
      closed: ReadonlyMap<string, AgentRecord>;
      noReplay: ReadonlyMap<string, ControlLogNoReplayRecord>;
    },
    startup: SchedulerStartup,
  ) {
    this.log = log;
    this.statePath = log.statePath;
    this.deliveryPayloadDirectory = log.deliveryPayloadDirectory;
    this.state = deepFreeze(image.state);
    this.closedCatalog = new Map(image.closed);
    this.noReplayCatalog = new Map(image.noReplay);
    this.closedCatalogRevisionValue = image.state.revision;
    this.startup = deepFreeze(startup);
  }

  static async open(options: { statePath: string; bootstrap?: SchedulerBootstrap }): Promise<SchedulerStore> {
    const bootstrap = options.bootstrap ? bootstrapState(options.bootstrap) : undefined;
    const log = await ControlLog.open({ statePath: options.statePath, ...(bootstrap ? { bootstrap } : {}) });
    try {
      const image = log.image();
      const state = image.state;
      await validatePhysicalPublishedReferences(state, log.statePath);
      const staleActivations = Object.values(state.activations)
        .filter((item) => item.state === 'running')
        .map((item) => item.activationId);
      const staleMailbox = Object.values(state.mailbox)
        .filter(
          (item) =>
            item.status === 'sending' ||
            item.status === 'consumed' ||
            (item.lane === 'direct' && item.status === 'accepted'),
        )
        .map((item) => (item.lane === 'direct' ? item.controlId : item.eventId));
      const staleConfigurations = Object.values(state.agents)
        .filter((agent) => agent.pendingConfiguration?.status === 'dispatching')
        .map((agent) => agent.agentId);
      const staleRuntimeOwners = Object.values(state.agents)
        .filter((agent) => agent.runtimeOwner !== undefined)
        .map((agent) => agent.agentId);
      return new SchedulerStore(log, image, {
        created: log.created,
        staleActivations,
        staleMailbox,
        staleConfigurations,
        staleRuntimeOwners,
        warnings: log.warnings,
      });
    } catch (error) {
      await log.close().catch(() => false);
      throw error;
    }
  }

  snapshot(): Readonly<SchedulerState> {
    return this.state;
  }
  get diagnostics(): readonly string[] {
    return [...this.diagnosticsRing, ...this.log.diagnostics].slice(-MAX_DIAGNOSTICS);
  }
  get closedCatalogRevision(): number {
    return this.closedCatalogRevisionValue;
  }
  closedCatalogSnapshot(): { revision: number; agents: readonly AgentRecord[] } {
    const agents = [...this.closedCatalog.values()].map((agent) => structuredClone(agent));
    for (const agent of Object.values(this.state.agents))
      if (agent.lifecycle === 'closed' && !this.closedCatalog.has(agent.agentId)) agents.push(structuredClone(agent));
    return deepFreeze({ revision: this.closedCatalogRevisionValue, agents });
  }
  indeterminateEvidenceSnapshot(agentIds: readonly string[]): readonly MailboxRecord[] {
    const requested = new Set(agentIds);
    const activationIds = new Map(
      agentIds.map((agentId) => [agentId, indeterminateContinuationActivationId(this.state, agentId)]),
    );
    const latest = new Map<string, MailboxRecord>();
    const matching = new Map<string, MailboxRecord>();
    for (const item of this.noReplayCatalog.values()) {
      const record = item.record;
      const targetId = record.lane === 'direct' ? record.targetId : record.recipientId;
      const agent = requested.has(targetId) ? this.state.agents[targetId] : undefined;
      if (!agent || !isContinuableIndeterminateEvidence(record, targetId, agent.continuedAfterSeq ?? 0)) continue;
      const current = latest.get(targetId);
      if (!current || mailboxRecordSeq(current) < mailboxRecordSeq(record)) latest.set(targetId, record);
      const activationId = activationIds.get(targetId);
      if (
        !activationId ||
        !isContinuableIndeterminateEvidence(record, targetId, agent.continuedAfterSeq ?? 0, activationId)
      )
        continue;
      const currentMatch = matching.get(targetId);
      if (!currentMatch || mailboxRecordSeq(currentMatch) < mailboxRecordSeq(record)) matching.set(targetId, record);
    }
    const records = new Map<string, MailboxRecord>();
    for (const record of [...latest.values(), ...matching.values()]) records.set(mailboxRecordId(record), record);
    return deepFreeze([...records.values()].map((record) => structuredClone(record)));
  }
  onChange(listener: (revision: number, affectedRecipientIds: readonly string[]) => void): () => void {
    if (this.resourceClosing) throw new Error('Scheduler store is closing or closed');
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async releaseClosedRuntime(agentIdInput: string, runtimeOwnerInput: string): Promise<void> {
    const agentId = id(agentIdInput, 'agentId');
    const runtimeOwner = id(runtimeOwnerInput, 'runtimeOwner');
    await this.mutate((draft, _affectedRecipientIds, catalogs) => {
      const agent = this.hydrateClosedLineage(draft, agentId, catalogs.closed)[0];
      if (!agent || agent.runtimeOwner !== runtimeOwner) return { changed: false, value: undefined };
      delete agent.runtimeOwner;
      delete agent.runtimePhase;
      delete agent.runtimeManagerPid;
      delete agent.runtimeHostname;
      delete agent.runtimePid;
      delete agent.runtimeSeq;
      nextSequence(draft);
      return { changed: true, value: undefined };
    });
  }

  async closedAgentLineage(agentIdInput: string): Promise<readonly AgentRecord[]> {
    const agentId = id(agentIdInput, 'agentId');
    const state = structuredClone(this.state);
    return deepFreeze(this.hydrateClosedLineage(state, agentId));
  }

  async directControlReceipt(
    requestIdInput: string,
    action: DirectControlAction,
    requestedBy: SchedulerPrincipal,
  ): Promise<Readonly<DirectControlRecord> | undefined> {
    const requestId = id(requestIdInput, 'direct control requestId');
    const principal = normalizePrincipal(requestedBy);
    const hot = directMailboxRecords(this.state).find((candidate) => candidate.requestId === requestId);
    const cold = hot ? undefined : this.noReplayCatalog.get(requestId)?.record;
    const control = hot ?? (cold?.lane === 'direct' ? cold : undefined);
    if (!control) return undefined;
    const sameIssuer =
      control.issuer.kind === principal.kind &&
      (control.issuer.kind === 'operator' ||
        (principal.kind === 'agent' && control.issuer.agentId === principal.agentId));
    if (control.action !== action || !sameIssuer)
      throw new SchedulerStateError('command_id_reuse', `Direct-control request '${requestId}' was reused`);
    return deepFreeze(control);
  }

  async reconcileRootPolicy(input: RootPolicyInput): Promise<SchedulerCommit<AgentRecord>> {
    return this.mutate((draft, _affectedRecipientIds, catalogs) => {
      this.hydrateAllClosed(draft, catalogs.closed);
      return reconcileRootPolicy(draft, input);
    });
  }

  async reconcileRootHostFacts(
    input: Pick<RootPolicyInput, 'provider' | 'model' | 'thinking'>,
  ): Promise<SchedulerCommit<AgentRecord>> {
    return this.mutate((draft) => {
      const root = draft.agents[draft.root.rootId];
      if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
      return reconcileRootPolicy(draft, {
        capabilities: root.capabilities,
        cwd: root.cwd,
        maxOpenAgents: draft.root.maxOpenAgents,
        maxOpenAgentsSource: draft.root.maxOpenAgentsSource,
        maxDepth: draft.root.maxDepth,
        agentNames: draft.root.agentNames,
        agentExtensions: draft.root.agentExtensions,
        serviceGrant: draft.root.serviceGrant,
        ...input,
      });
    });
  }

  async setRootCapacity(capacity: number): Promise<SchedulerCommit<AgentRecord>> {
    return this.setRootLimits({ capacity });
  }

  async setRootDepth(depth: number): Promise<SchedulerCommit<AgentRecord>> {
    return this.setRootLimits({ depth });
  }

  async approveRootExtension(
    specifierInput: string,
    pathsInput: readonly string[],
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const specifier = humanFacingText(specifierInput, 'extension source', 4096);
    const paths = [...new Set(pathsInput.map((path, index) => absolutePath(path, `extension paths[${index}]`)))];
    if (!paths.length)
      throw new SchedulerStateError('resource_unavailable', 'Approved extension has no loadable paths');
    return this.mutate(
      (draft) => {
        const root = draft.agents[draft.root.rootId];
        if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
        const before = JSON.stringify([draft.root.agentExtensions[specifier], root.capabilities.extensions]);
        draft.root.agentExtensions[specifier] = 'allow';
        approveRootExtensionCapability(draft, paths);
        if (before === JSON.stringify([draft.root.agentExtensions[specifier], root.capabilities.extensions]))
          return { changed: false, value: root };
        nextSequence(draft);
        return { changed: true, value: root };
      },
      true,
      signal,
    );
  }

  async reconcileManagedExtensionSelections(
    entriesInput: readonly {
      specifier: string;
      state: 'always' | 'allow' | 'deny';
      paths: readonly string[];
    }[],
  ): Promise<SchedulerCommit<AgentRecord>> {
    const entries = entriesInput.map((entry, entryIndex) => ({
      specifier: humanFacingText(entry.specifier, `entries[${entryIndex}].specifier`, 4096),
      state: entry.state,
      paths: entry.paths.map((path, pathIndex) => absolutePath(path, `entries[${entryIndex}].paths[${pathIndex}]`)),
    }));
    const alwaysPaths = entries.filter((entry) => entry.state === 'always').flatMap((entry) => entry.paths);
    const allowedPaths = new Set(entries.filter((entry) => entry.state !== 'deny').flatMap((entry) => entry.paths));
    return this.mutate((draft) => {
      const root = draft.agents[draft.root.rootId];
      if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
      let changed = false;
      for (const agent of Object.values(draft.agents)) {
        if (agent.parentId === null) continue;
        const selectedSources =
          agent.launch.extensionSources ??
          entries
            .filter(
              (entry) =>
                entry.state === 'allow' &&
                entry.paths.length > 0 &&
                entry.paths.every((path) => agent.launch.extensions.includes(path)),
            )
            .map((entry) => entry.specifier);
        const extensionSources = selectedSources.filter((specifier) => {
          const entry = entries.find((candidate) => candidate.specifier === specifier);
          return (
            entry?.state === 'allow' &&
            (agent.capabilities.extensions === undefined ||
              entry.paths.every((path) => agent.capabilities.extensions?.includes(path)))
          );
        });
        const selectedPaths = extensionSources.flatMap(
          (specifier) => entries.find((entry) => entry.specifier === specifier)?.paths ?? [],
        );
        const recordedSources =
          agent.launch.extensionSources === undefined && !extensionSources.length ? undefined : extensionSources;
        const extensions = [...new Set([...alwaysPaths, ...selectedPaths])]
          .filter((path) => allowedPaths.has(path))
          .sort();
        if (
          extensions.length === agent.launch.extensions.length &&
          extensions.every((path, index) => path === agent.launch.extensions[index]) &&
          recordedSources?.length === agent.launch.extensionSources?.length &&
          recordedSources?.every((specifier, index) => specifier === agent.launch.extensionSources?.[index]) !== false
        )
          continue;
        agent.launch.extensions = extensions;
        if (recordedSources) agent.launch.extensionSources = recordedSources;
        else delete agent.launch.extensionSources;
        changed = true;
      }
      if (!changed) return { changed: false, value: root };
      nextSequence(draft);
      return { changed: true, value: root };
    });
  }

  private async setRootLimits(limits: { capacity?: number; depth?: number }): Promise<SchedulerCommit<AgentRecord>> {
    return this.mutate((draft, _affected, catalogs) => {
      if (limits.depth !== undefined) this.hydrateAllClosed(draft, catalogs.closed);
      const root = draft.agents[draft.root.rootId];
      if (!root) throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
      const capacity = limits.capacity ?? draft.root.maxOpenAgents;
      const depth = limits.depth ?? draft.root.maxDepth;
      return reconcileRootPolicy(draft, {
        capabilities: {
          ...root.capabilities,
          spawn: depth > 0 && capacity > 0,
          maxDepth: depth,
        },
        cwd: root.cwd,
        maxOpenAgents: capacity,
        maxOpenAgentsSource: limits.capacity === undefined ? draft.root.maxOpenAgentsSource : 'operator-live',
        maxDepth: depth,
        ...(limits.depth !== undefined ? { maxDepthSource: 'operator-live' } : {}),
        agentNames: draft.root.agentNames,
        agentExtensions: draft.root.agentExtensions,
        serviceGrant: draft.root.serviceGrant,
        provider: root.provider,
        model: root.model,
        thinking: root.thinking,
      });
    });
  }

  async setAgentCapabilities(
    targetIdInput: string,
    request: CapabilityRequest,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const targetId = id(targetIdInput, 'targetId');
    const principal = normalizePrincipal(requestedBy);
    return this.mutate((draft) => setAgentCapabilities(draft, targetId, request, principal), true, signal);
  }

  async applyOfflineConfiguration(
    input: ConfigurationInput,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const principal = normalizePrincipal(requestedBy);
    return this.mutate((draft) => applyOfflineConfigurationState(draft, input, principal), true, signal);
  }

  async beginLiveConfiguration(
    input: ConfigurationInput,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentConfigurationChange | undefined>> {
    const principal = normalizePrincipal(requestedBy);
    return this.mutate((draft) => beginLiveConfigurationState(draft, input, principal), true, signal);
  }

  async finishLiveConfiguration(
    targetId: string,
    changeId: string,
    outcome: 'applied' | 'refused' | 'indeterminate',
  ): Promise<SchedulerCommit<AgentRecord>> {
    return this.mutate((draft, affectedRecipientIds) => {
      const result = finishLiveConfigurationState(draft, targetId, changeId, outcome);
      if (result.changed) affectedRecipientIds.add(result.value.agentId);
      return result;
    });
  }

  async updateAgentMetadata(
    targetIdInput: string,
    patchInput: AgentMetadataPatch,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const targetId = id(targetIdInput, 'targetId');
    const principal = normalizePrincipal(requestedBy);
    const patch = normalizeAgentMetadataPatch(patchInput);
    return this.mutate(
      async (draft) => {
        const currentPublishedRefs = draft.agents[targetId]?.expertCard.publishedRefs?.value;
        const outcome = updateAgentMetadata(draft, this.statePath, targetId, patch, principal);
        if (patch.publishedRefs && !isDeepStrictEqual(currentPublishedRefs, patch.publishedRefs)) {
          const target = draft.agents[targetId];
          if (!target) throw new SchedulerStateError('agent_unavailable', `Agent '${targetId}' is unavailable`);
          await assertPhysicalReferencesPublic(patch.publishedRefs, target.cwd, target.agentId, draft, this.statePath);
        }
        return outcome;
      },
      true,
      signal,
    );
  }

  async closeAgent(
    targetIdInput: string,
    requestedBy: SchedulerPrincipal,
    options: { subtree?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<readonly string[]>> {
    const targetId = id(targetIdInput, 'targetId');
    const principal = normalizePrincipal(requestedBy);
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'subtree')
    )
      throw new SchedulerStateError('input_invalid', 'Close options are invalid');
    if (options.subtree !== undefined && typeof options.subtree !== 'boolean')
      throw new SchedulerStateError('input_invalid', 'subtree must be boolean');
    return this.mutate(
      (draft, affectedRecipientIds) => {
        const result = closeAgent(draft, targetId, principal, options.subtree === true);
        const closing = new Set(result.value);
        for (const control of directMailboxRecords(draft))
          if (closing.has(control.targetId)) prepareDirectControlsForActivationFinishState(draft, control.activationId);
        for (const watch of Object.values(draft.watches))
          if (watch.status === 'active' && closing.has(watch.ownerId)) cancelActiveWatchState(draft, watch);
        for (const event of closeCorrelatedRequestsState(draft, result.value, randomUUID))
          if (event.status === 'accepted') affectedRecipientIds.add(event.recipientId);
        const terminal = closeQueuedPeerEventsState(draft, result.value);
        for (const event of terminal) {
          const generated = applyTerminalEventToRequestState(draft, event, randomUUID);
          if (generated?.status === 'accepted') affectedRecipientIds.add(generated.recipientId);
        }
        for (const watch of Object.values(draft.watches)) {
          const agentIds = watch.agentIds ?? [];
          if (watch.status !== 'active' || closing.has(watch.ownerId) || !agentIds.length) continue;
          const remainingAgentIds = agentIds.filter((agentId) => !closing.has(agentId));
          if (remainingAgentIds.length === agentIds.length) continue;
          if (remainingAgentIds.length) {
            watch.agentIds = remainingAgentIds;
            watch.requestHash = sha256(
              JSON.stringify({
                requestIds: watch.requestIds ?? [],
                agentIds: remainingAgentIds,
                eventKinds: watch.eventKinds ?? [],
                owned: watch.owned,
                registeringActivationId: watch.registeringActivationId,
                causalInputs: watch.causalInputs ?? [],
              }),
            );
            continue;
          }
          triggerWatchIfReadyState(draft, watch.watchId, randomUUID);
          const trigger = watch.triggerEventId ? peerMailboxRecord(draft, watch.triggerEventId) : undefined;
          if (trigger?.status === 'accepted') affectedRecipientIds.add(trigger.recipientId);
          if (watch.status === 'active') cancelActiveWatchState(draft, watch);
        }
        return result;
      },
      true,
      signal,
    );
  }

  async resumeAgent(
    targetIdInput: string,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const targetId = id(targetIdInput, 'targetId');
    const principal = normalizePrincipal(requestedBy);
    return this.mutate(
      (draft, _affectedRecipientIds, catalogs) => {
        this.hydrateClosedLineage(draft, targetId, catalogs.closed);
        return resumeAgent(draft, targetId, principal);
      },
      true,
      signal,
    );
  }

  async resumeArchivedAgent(
    targetIdInput: string,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const targetId = id(targetIdInput, 'targetId');
    const principal = normalizePrincipal(requestedBy);
    return this.mutate(
      (draft, _affectedRecipientIds, catalogs) => {
        this.hydrateClosedLineage(draft, targetId, catalogs.closed);
        return resumeAgent(draft, targetId, principal, true);
      },
      true,
      signal,
    );
  }

  async setAgentArchived(
    targetIdInput: string,
    archived: boolean,
    requestedBy: SchedulerPrincipal,
  ): Promise<SchedulerCommit<readonly string[]>> {
    const targetId = id(targetIdInput, 'targetId');
    if (typeof archived !== 'boolean') throw new SchedulerStateError('input_invalid', 'archived must be boolean');
    const principal = normalizePrincipal(requestedBy);
    return this.mutate((draft, _affectedRecipientIds, catalogs) => {
      this.hydrateAllClosed(draft, catalogs.closed);
      return setAgentArchived(draft, targetId, archived, principal);
    });
  }

  async admitAgent(input: AdmitAgentInput, requestedBy: SchedulerPrincipal): Promise<SchedulerCommit<AgentRecord>> {
    const principal = normalizePrincipal(requestedBy);
    const normalized = normalizeAdmission(input);
    return this.mutate(async (draft, _affectedRecipientIds, catalogs) => {
      this.hydrateClosedLineage(draft, normalized.agentId, catalogs.closed);
      const outcome = admitAgent(draft, this.statePath, normalized, principal);
      if (!outcome.changed) return outcome;
      const sessionDir = outcome.value.sessionDir;
      if (!sessionDir)
        throw new SchedulerStateError(
          'state_invalid',
          `Admitted agent '${outcome.value.agentId}' lacks a session directory`,
        );
      outcome.value.sessionDir = await canonicalizeSessionDirectory(sessionDir);
      if (outcome.value.sessionFile)
        outcome.value.sessionFile = await canonicalizeSessionFile(outcome.value.sessionFile, outcome.value.sessionDir);
      await validatePhysicalSessionNamespace(draft, outcome.value.agentId, 'session_conflict');
      await assertPhysicalReferencesPublic(
        outcome.value.expertCard.publishedRefs?.value ?? [],
        outcome.value.cwd,
        outcome.value.agentId,
        draft,
        this.statePath,
      );
      return outcome;
    });
  }

  async admitAgentWithStartingInput(
    input: AdmitAgentInput,
    requestedBy: SchedulerPrincipal,
    auth: PeerEventAuth,
    startingInput: Omit<PeerEventRequest, 'message'>,
    startingMessage: (agent: Readonly<AgentRecord>, state: Readonly<SchedulerState>) => string,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<AgentStartingInputReceipt>> {
    const principal = normalizePrincipal(requestedBy);
    const normalized = normalizeAdmission(input);
    if (startingInput.recipientId !== normalized.agentId)
      throw new SchedulerStateError('input_invalid', 'Starting input recipient does not match its collaborator');
    return this.mutate<AgentStartingInputReceipt>(
      async (draft, affectedRecipientIds, catalogs) => {
        this.hydrateClosedLineage(draft, normalized.agentId, catalogs.closed);
        const existing = draft.agents[normalized.agentId];
        if (existing) {
          if (
            existing.parentId !== normalized.parentId ||
            existing.spawnHash !== normalized.spawnHash ||
            existing.sessionId !== normalized.sessionId
          )
            throw new SchedulerStateError('command_id_reuse', `Spawn admission '${normalized.agentId}' was reused`);
          return { changed: false, value: { agent: existing, duplicate: true } };
        }
        const admitted = admitAgent(draft, this.statePath, normalized, principal);
        const sessionDir = admitted.value.sessionDir;
        if (!sessionDir)
          throw new SchedulerStateError(
            'state_invalid',
            `Admitted agent '${admitted.value.agentId}' lacks a session directory`,
          );
        admitted.value.sessionDir = await canonicalizeSessionDirectory(sessionDir);
        if (admitted.value.sessionFile) {
          admitted.value.sessionFile = await canonicalizeSessionFile(
            admitted.value.sessionFile,
            admitted.value.sessionDir,
          );
          assertSessionFileAvailable(draft, admitted.value.sessionFile, admitted.value.agentId);
        }
        await validatePhysicalSessionNamespace(draft, admitted.value.agentId, 'session_conflict');
        await assertPhysicalReferencesPublic(
          admitted.value.expertCard.publishedRefs?.value ?? [],
          admitted.value.cwd,
          admitted.value.agentId,
          draft,
          this.statePath,
        );
        const normalizedEvent = normalizePeerEventRequest({
          ...startingInput,
          message: startingMessage(admitted.value, draft),
        });
        const route = acceptPeerEventState(draft, auth, normalizedEvent, randomUUID, true);
        if (route.value.event.status === 'accepted') affectedRecipientIds.add(route.value.event.recipientId);
        return {
          changed: true,
          value: { agent: admitted.value, duplicate: false },
        };
      },
      true,
      signal,
    );
  }

  async bindSession(agentIdInput: string, sessionFileInput: string): Promise<SchedulerCommit<AgentRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const requestedSessionFile = absolutePath(sessionFileInput, 'sessionFile');
    return this.mutate(async (draft) => {
      const agent = draft.agents[agentId];
      if (!agent || !agent.sessionDir)
        throw new SchedulerStateError('agent_unavailable', `Agent '${agentId}' has no private session directory`);
      const sessionFile = await canonicalizeSessionFile(requestedSessionFile, agent.sessionDir);
      assertSessionFileAvailable(draft, sessionFile, agentId);
      if (agent.sessionFile === sessionFile) return { changed: false, value: agent };
      if (agent.sessionFile)
        throw new SchedulerStateError(
          'session_conflict',
          `Agent '${agentId}' is already bound to another session file`,
        );
      const seq = nextSequence(draft);
      agent.sessionFile = sessionFile;
      agent.runtimeSeq = seq;
      await validatePhysicalSessionNamespace(draft, agentId, 'session_conflict');
      return { changed: true, value: agent };
    });
  }

  async claimRuntime(
    agentIdInput: string,
    managerPidInput: number,
    hostnameInput: string,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const managerPid = integer(managerPidInput, 1, 2_147_483_647, 'managerPid');
    const runtimeHostname = text(hostnameInput, 'runtimeHostname', 255);
    return this.mutate((draft) => {
      const agent = draft.agents[agentId];
      if (!agent || agent.lifecycle !== 'open')
        throw new SchedulerStateError('agent_unavailable', `Agent '${agentId}' is not open`);
      if (agent.runtimeOwner)
        throw new SchedulerStateError('runtime_owned', `Agent '${agentId}' already has a runtime owner`);
      const runtimeOwner = randomUUID();
      const seq = nextSequence(draft);
      agent.runtimeOwner = runtimeOwner;
      agent.runtimePhase = 'starting';
      agent.runtimeManagerPid = managerPid;
      agent.runtimeHostname = runtimeHostname;
      agent.runtimeSeq = seq;
      return { changed: true, value: agent };
    });
  }

  async markRuntimeSpawned(
    agentIdInput: string,
    runtimeOwnerInput: string,
    runtimePidInput: number,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const runtimeOwner = id(runtimeOwnerInput, 'runtimeOwner');
    const runtimePid = integer(runtimePidInput, 1, 2_147_483_647, 'runtimePid');
    return this.mutate((draft) => {
      const agent = draft.agents[agentId];
      if (!agent || agent.runtimeOwner !== runtimeOwner || agent.runtimePhase !== 'starting')
        throw new SchedulerStateError('runtime_owner', `Agent '${agentId}' runtime claim does not match`);
      if (agent.runtimePid === runtimePid) return { changed: false, value: agent };
      if (agent.runtimePid !== undefined)
        throw new SchedulerStateError('runtime_owner', `Agent '${agentId}' already recorded another runtime PID`);
      const seq = nextSequence(draft);
      agent.runtimePid = runtimePid;
      agent.runtimeSeq = seq;
      return { changed: true, value: agent };
    });
  }

  async markRuntimeReady(
    agentIdInput: string,
    runtimeOwnerInput: string,
    runtimePidInput: number,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const runtimeOwner = id(runtimeOwnerInput, 'runtimeOwner');
    const runtimePid = integer(runtimePidInput, 1, 2_147_483_647, 'runtimePid');
    return this.mutate((draft) => {
      const agent = draft.agents[agentId];
      if (
        !agent ||
        agent.runtimeOwner !== runtimeOwner ||
        agent.runtimePhase !== 'starting' ||
        agent.runtimePid !== runtimePid
      )
        throw new SchedulerStateError('runtime_owner', `Agent '${agentId}' runtime claim does not match`);
      const seq = nextSequence(draft);
      agent.runtimePhase = 'ready';
      if (agent.pendingConfiguration?.status === 'indeterminate') delete agent.pendingConfiguration;
      delete agent.attention;
      agent.runtimeSeq = seq;
      return { changed: true, value: agent };
    });
  }

  async releaseRuntime(
    agentIdInput: string,
    runtimeOwnerInput: string,
    runtimeState: Exclude<AgentRuntimeState, 'running' | 'waiting' | 'starting'>,
    kind = 'runtime_released',
  ): Promise<SchedulerCommit<AgentRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const runtimeOwner = id(runtimeOwnerInput, 'runtimeOwner');
    if (
      runtimeState !== 'idle' &&
      runtimeState !== 'runtime_parked' &&
      runtimeState !== 'failed' &&
      runtimeState !== 'needs_attention'
    )
      throw new SchedulerStateError('input_invalid', `Runtime release state '${String(runtimeState)}' is invalid`);
    text(kind, 'runtime transition kind', 64);
    return this.mutate((draft) => {
      const agent = draft.agents[agentId];
      if (!agent || agent.runtimeOwner !== runtimeOwner)
        throw new SchedulerStateError('runtime_owner', `Agent '${agentId}' runtime owner does not match`);
      if (Object.values(draft.activations).some((item) => item.agentId === agentId && item.state === 'running'))
        throw new SchedulerStateError('writer_busy', `Agent '${agentId}' has a live activation`);
      if (
        peerMailboxRecords(draft).some(
          (event) => event.recipientId === agentId && (event.status === 'sending' || event.status === 'consumed'),
        )
      )
        throw new SchedulerStateError('peer_delivery_busy', `Agent '${agentId}' has an in-flight peer delivery`);
      if (
        directMailboxRecords(draft).some(
          (control) =>
            control.targetId === agentId &&
            control.status !== 'aborted' &&
            control.status !== 'refused' &&
            control.status !== 'failed' &&
            control.status !== 'indeterminate',
        )
      )
        throw new SchedulerStateError('control_busy', `Agent '${agentId}' has an in-flight direct control`);
      const seq = nextSequence(draft);
      delete agent.runtimeOwner;
      delete agent.runtimePhase;
      delete agent.runtimeManagerPid;
      delete agent.runtimeHostname;
      delete agent.runtimePid;
      if (runtimeState === 'failed' || runtimeState === 'needs_attention') {
        if (agent.lifecycle === 'open') agent.attention = { kind: runtimeState, code: kind, seq };
      } else delete agent.attention;
      agent.runtimeSeq = seq;
      return { changed: true, value: agent };
    });
  }

  async markAgentContinuedAfterIndeterminate(
    agentIdInput: string,
    requestedBy: SchedulerPrincipal,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const principal = normalizePrincipal(requestedBy);
    return this.mutate((draft, affectedRecipientIds, catalogs) => {
      const agent = draft.agents[agentId];
      if (!agent || agent.lifecycle !== 'open')
        throw new SchedulerStateError('agent_unavailable', `Agent '${agentId}' is not open`);
      if (principal.kind === 'agent' && principal.agentId !== agentId) {
        let current = draft.agents[agentId];
        let owned = false;
        while (current.parentId) {
          if (current.parentId === principal.agentId) {
            owned = true;
            break;
          }
          current = draft.agents[current.parentId];
          if (!current) break;
        }
        if (!owned)
          throw new SchedulerStateError(
            'authority_denied',
            `Agent '${principal.agentId}' cannot continue '${agentId}' beyond indeterminate evidence`,
          );
      }
      if (agent.attention?.kind !== 'needs_attention') return { changed: false, value: agent };
      if (!continuePastIndeterminateState(draft, agentId, catalogs)) return { changed: false, value: agent };
      affectedRecipientIds.add(agentId);
      return { changed: true, value: agent };
    });
  }

  async setAgentAttention(
    agentIdInput: string,
    attention: 'failed' | 'needs_attention',
    code: string,
  ): Promise<SchedulerCommit<AgentRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const outcomeCode = text(code, 'attention code', 64);
    return this.mutate((draft) => {
      const agent = draft.agents[agentId];
      if (!agent || agent.lifecycle !== 'open')
        throw new SchedulerStateError('agent_unavailable', `Agent '${agentId}' is not open`);
      const seq = nextSequence(draft);
      agent.attention = { kind: attention, code: outcomeCode, seq };
      return { changed: true, value: agent };
    });
  }

  async startActivation(agentIdInput: string, inputKindInput: string): Promise<SchedulerCommit<ActivationRecord>> {
    const agentId = id(agentIdInput, 'agentId');
    const inputKind = text(inputKindInput, 'inputKind', 32);
    return this.mutate((draft) => startActivationState(draft, agentId, inputKind));
  }

  async finishActivation(
    activationIdInput: string,
    leaseTokenInput: string,
    outcome: Exclude<ActivationState, 'running'>,
  ): Promise<SchedulerCommit<ActivationRecord>> {
    const activationId = id(activationIdInput, 'activationId');
    const leaseToken = id(leaseTokenInput, 'leaseToken');
    return this.mutate((draft, affectedRecipientIds) =>
      settleActivationState(draft, activationId, leaseToken, outcome, affectedRecipientIds),
    );
  }

  async finishActivationIfRunning(
    activationIdInput: string,
    leaseTokenInput: string,
    outcome: Exclude<ActivationState, 'running'>,
  ): Promise<SchedulerCommit<ActivationRecord | undefined>> {
    const activationId = id(activationIdInput, 'activationId');
    const leaseToken = id(leaseTokenInput, 'leaseToken');
    return this.mutate((draft, affectedRecipientIds) => {
      if (draft.activations[activationId]?.state !== 'running')
        return { changed: false, value: draft.activations[activationId] };
      return settleActivationState(draft, activationId, leaseToken, outcome, affectedRecipientIds);
    });
  }

  async applyMailboxIntent(
    intent: Extract<SchedulerMailboxIntent, { kind: 'admit_direct' }>,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<DirectControlAdmission>>;
  async applyMailboxIntent(
    intent: Extract<SchedulerMailboxIntent, { kind: 'begin_delivery' }>,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<DirectControlRecord | PeerDispatchPlan | undefined>>;
  async applyMailboxIntent(
    intent: Extract<SchedulerMailboxIntent, { kind: 'release_delivery' }>,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<PeerEventRecord>>;
  async applyMailboxIntent(
    intent: Extract<SchedulerMailboxIntent, { kind: 'admit_boundary' }>,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<DirectControlRecord | PeerEventRecord>>;
  async applyMailboxIntent(
    intent: Extract<SchedulerMailboxIntent, { kind: 'finish_delivery' }>,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<DirectControlRecord | PeerEventRecord>>;
  async applyMailboxIntent(
    intent: Extract<SchedulerMailboxIntent, { kind: 'reconcile_delivery' }>,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<DirectControlRecord | PeerEventRecord>>;
  async applyMailboxIntent(
    intent: SchedulerMailboxIntent,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<SchedulerMailboxIntentResult>> {
    switch (intent.kind) {
      case 'admit_direct': {
        const normalized = normalizeDirectControlInput(intent.input);
        const principal = normalizePrincipal(intent.requestedBy);
        return this.mutate(
          async (draft, _affectedRecipientIds, catalogs) => {
            this.hydrateIndeterminate(draft, normalized.requestId, catalogs.noReplay);
            return admitDirectControlState(draft, normalized, principal, randomUUID);
          },
          true,
          signal,
        );
      }
      case 'begin_delivery': {
        const recordId = id(intent.recordId, 'recordId');
        const runtimeOwner = id(intent.runtimeOwner, 'runtimeOwner');
        return this.mutate<DirectControlRecord | PeerDispatchPlan | undefined>(
          async (draft) => {
            const record = draft.mailbox[recordId];
            if (!record) return { changed: false, value: undefined };
            return record.lane === 'direct'
              ? beginDirectControlAttemptState(draft, recordId, runtimeOwner)
              : beginPeerDeliveryState(draft, recordId, runtimeOwner);
          },
          true,
          signal,
        );
      }
      case 'release_delivery': {
        const recordId = id(intent.recordId, 'recordId');
        const attemptId = id(intent.attemptId, 'attemptId');
        const settlement = intent.settlement
          ? {
              activationId: id(intent.settlement.activationId, 'activationId'),
              leaseToken: id(intent.settlement.leaseToken, 'leaseToken'),
              outcome: intent.settlement.outcome,
            }
          : undefined;
        return this.mutate(
          (draft, affectedRecipientIds) => {
            if (draft.mailbox[recordId]?.lane === 'direct')
              throw new SchedulerStateError('mailbox_transition', 'An interrupt attempt cannot be requeued');
            const result = requeuePeerEventBeforeWriteState(draft, recordId, attemptId);
            if (settlement) {
              const followUps = peerMailboxRecords(draft).filter(
                (event) =>
                  event.mode === 'follow_up' &&
                  event.consumedSeq === undefined &&
                  ((event.status === 'accepted' && event.targetActivationId === settlement.activationId) ||
                    (event.status === 'sending' && event.activationId === settlement.activationId)),
              );
              for (const followUp of followUps) {
                if (followUp.attemptId) releaseMailboxAttemptState(draft, followUps, followUp.attemptId);
                delete followUp.targetActivationId;
                affectedRecipientIds.add(followUp.recipientId);
              }
              if (result.discardedWakeActivation?.activationId === settlement.activationId)
                assertActivationLease(result.discardedWakeActivation, settlement.leaseToken);
              else
                settleActivationState(
                  draft,
                  settlement.activationId,
                  settlement.leaseToken,
                  settlement.outcome,
                  affectedRecipientIds,
                );
            }
            if (result.changed && result.value.status === 'accepted')
              affectedRecipientIds.add(result.value.recipientId);
            return result;
          },
          true,
          signal,
        );
      }
      case 'admit_boundary': {
        const recordId = id(intent.recordId, 'recordId');
        const attemptId = id(intent.attemptId, 'attemptId');
        return this.mutate<DirectControlRecord | PeerEventRecord>(
          (draft, affectedRecipientIds) => {
            const record = draft.mailbox[recordId];
            if (!record)
              throw new SchedulerStateError('mailbox_missing', `Mailbox record '${recordId}' does not exist`);
            if (record.lane === 'direct') {
              if (typeof intent.aborted !== 'boolean')
                throw new SchedulerStateError('input_invalid', 'Direct interrupt boundary must be boolean');
              const result = markDirectInterruptBoundaryState(draft, recordId, attemptId, intent.aborted);
              if (result.changed && intent.aborted) affectedRecipientIds.add(result.value.targetId);
              return result;
            }
            if (intent.aborted !== undefined)
              throw new SchedulerStateError('input_invalid', 'Routed input has no interrupt boundary');
            const outcome = admitPeerAtModelBoundaryState(draft, recordId, attemptId);
            for (const event of outcome.value) {
              const generated = applyTerminalEventToRequestState(draft, event, randomUUID);
              if (generated?.status === 'accepted') affectedRecipientIds.add(generated.recipientId);
            }
            const event = outcome.value.find((candidate) => candidate.eventId === recordId);
            if (!event)
              throw new SchedulerStateError('state_invalid', `Peer event '${recordId}' disappeared after admission`);
            return { changed: outcome.changed, value: event };
          },
          true,
          signal,
        );
      }
      case 'finish_delivery': {
        const recordId = id(intent.recordId, 'recordId');
        const attemptId = id(intent.attemptId, 'attemptId');
        if (intent.status !== 'refused' && intent.status !== 'failed' && intent.status !== 'indeterminate')
          throw new SchedulerStateError(
            'input_invalid',
            `Mailbox terminal status '${String(intent.status)}' is invalid`,
          );
        const code = text(intent.outcomeCode, 'mailbox outcomeCode', 96);
        return this.mutate<DirectControlRecord | PeerEventRecord>(
          (draft, affectedRecipientIds) => {
            const record = draft.mailbox[recordId];
            if (!record)
              throw new SchedulerStateError('mailbox_missing', `Mailbox record '${recordId}' does not exist`);
            if (record.lane === 'direct') {
              return finishDirectControlState(draft, recordId, attemptId, intent.status, code);
            }
            const outcome = finishPeerDeliveryState(draft, recordId, attemptId, intent.status, code);
            for (const event of outcome.value) {
              const generated = applyTerminalEventToRequestState(draft, event, randomUUID);
              if (generated?.status === 'accepted') affectedRecipientIds.add(generated.recipientId);
            }
            const event = outcome.value.find((candidate) => candidate.eventId === recordId);
            if (!event)
              throw new SchedulerStateError('state_invalid', `Peer event '${recordId}' disappeared after settlement`);
            return { changed: outcome.changed, value: event };
          },
          true,
          signal,
        );
      }
      case 'reconcile_delivery': {
        const recordId = id(intent.recordId, 'recordId');
        return this.mutate<DirectControlRecord | PeerEventRecord>(
          (draft, affectedRecipientIds) => {
            const record = draft.mailbox[recordId];
            if (!record)
              throw new SchedulerStateError('mailbox_missing', `Mailbox record '${recordId}' does not exist`);
            if (record.lane === 'direct') {
              return reconcileDirectControlState(draft, recordId);
            }
            const batchIds = record.attemptId
              ? peerMailboxRecords(draft)
                  .filter((event) => event.attemptId === record.attemptId)
                  .map((event) => event.eventId)
              : [recordId];
            const result = reconcilePeerEventState(draft, recordId);
            for (const batchId of batchIds) {
              const event = peerMailboxRecord(draft, batchId);
              if (!event) continue;
              const generated = applyTerminalEventToRequestState(draft, event, randomUUID);
              if (generated?.status === 'accepted') affectedRecipientIds.add(generated.recipientId);
            }
            return result;
          },
          true,
          signal,
        );
      }
    }
  }

  async admitPeerEvent(
    auth: PeerEventAuth,
    request: PeerEventRequest,
    expectedActivationIdInput?: string,
    afterControlIdInput?: string,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<PeerRouteReceipt>> {
    const normalized = normalizePeerEventRequest(request);
    return this.mutate(
      async (draft, affectedRecipientIds, catalogs) => {
        this.hydrateIndeterminate(draft, normalized.bridgeRequestId, catalogs.noReplay);
        const result = acceptPeerEventState(
          draft,
          auth,
          normalized,
          randomUUID,
          false,
          expectedActivationIdInput,
          afterControlIdInput,
        );
        if (result.changed) affectAcceptedRecipient(affectedRecipientIds, result.value.event);
        return result;
      },
      true,
      signal,
    );
  }

  /**
   * One durable operator admission: peer-event acceptance plus continuation
   * clearing for the target in the same transaction. Operator authority is
   * enforced here; agents and services use the generic admission paths.
   */
  async admitOperatorInput(
    auth: PeerEventAuth,
    request: PeerEventRequest,
    expectedActivationIdInput?: string,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<PeerRouteReceipt>> {
    if (auth.origin !== 'operator')
      throw new SchedulerStateError('authority_denied', 'Operator input requires operator authority');
    const normalized = normalizePeerEventRequest(request);
    const agentId = normalized.recipientId;
    return this.mutate(
      async (draft, affectedRecipientIds, catalogs) => {
        this.hydrateIndeterminate(draft, normalized.bridgeRequestId, catalogs.noReplay);
        const result = acceptPeerEventState(draft, auth, normalized, randomUUID, false, expectedActivationIdInput);
        if (result.changed) affectAcceptedRecipient(affectedRecipientIds, result.value.event);
        if (result.value.event.status === 'refused') return result;
        if (result.changed && continuePastIndeterminateState(draft, agentId, catalogs))
          affectedRecipientIds.add(agentId);
        return result;
      },
      true,
      signal,
    );
  }

  async admitPeerEventAfterInterrupt(
    controlIdInput: string,
    attemptIdInput: string,
    auth: PeerEventAuth,
    request: PeerEventRequest,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<{ control: DirectControlRecord; route: PeerRouteReceipt }>> {
    const controlId = id(controlIdInput, 'controlId');
    const attemptId = id(attemptIdInput, 'attemptId');
    const normalized = normalizePeerEventRequest(request);
    return this.mutate(
      (draft, affectedRecipientIds) => {
        const control = draft.mailbox[controlId];
        if (!control || control.lane !== 'direct')
          throw new SchedulerStateError('mailbox_missing', `Interrupt '${controlId}' does not exist`);
        const boundary = markDirectInterruptBoundaryState(draft, controlId, attemptId, true);
        const route = acceptPeerEventState(draft, auth, normalized, randomUUID, false, undefined, controlId);
        if (route.changed) affectedRecipientIds.add(route.value.event.recipientId);
        return { changed: boundary.changed || route.changed, value: { control: boundary.value, route: route.value } };
      },
      true,
      signal,
    );
  }

  async admitSystemEvent(input: SystemEventInput): Promise<SchedulerCommit<PeerRouteReceipt>> {
    return this.mutate((draft, affectedRecipientIds) => {
      const result = acceptSystemEventState(draft, input, randomUUID);
      if (result.changed) affectAcceptedRecipient(affectedRecipientIds, result.value.event);
      return result;
    });
  }

  async admitPeerMulticast(
    auth: PeerEventAuth,
    input: PeerMulticastInput,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<readonly PeerRouteReceipt[]>> {
    const parentId = id(input.bridgeRequestId, 'bridgeRequestId');
    const recipients = multicastRecipients(input.recipientIds);
    return this.mutate(
      async (draft, affectedRecipientIds, catalogs) => {
        const receipts: PeerRouteReceipt[] = [];
        let traceId: string | undefined;
        let causationId: string | undefined;
        for (const [index, recipientId] of recipients.entries()) {
          const normalized = normalizePeerEventEnvelope({
            bridgeRequestId: multicastLegId(parentId, recipientId, index),
            recipientId,
            message: input.message,
            mode: input.mode,
            kind: 'message',
            traceId,
            causationId: index === 0 ? (input.causationId ?? causationId) : causationId,
          });
          this.hydrateIndeterminate(draft, normalized.bridgeRequestId, catalogs.noReplay);
          const receipt = acceptPeerEventState(draft, auth, normalized, randomUUID).value;
          receipts.push(receipt);
          if (!receipt.duplicate) affectAcceptedRecipient(affectedRecipientIds, receipt.event);
          traceId ??= receipt.event.traceId;
          causationId ??= receipt.event.eventId;
        }
        return { changed: receipts.some((receipt) => !receipt.duplicate), value: receipts };
      },
      true,
      signal,
    );
  }

  async acceptCorrelatedMulticast(
    auth: PeerEventAuth,
    input: CorrelatedMulticastInput,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<readonly CorrelatedRequestReceipt[]>> {
    const parentId = id(input.bridgeRequestId, 'bridgeRequestId');
    const recipients = multicastRecipients(input.recipientIds);
    return this.mutate(
      async (draft, affectedRecipientIds, catalogs) => {
        const receipts: CorrelatedRequestReceipt[] = [];
        let traceId: string | undefined;
        let causationId: string | undefined;
        for (const [index, recipientId] of recipients.entries()) {
          const requestId = multicastLegId(parentId, recipientId, index);
          const normalized = normalizePeerEventEnvelope({
            bridgeRequestId: requestId,
            recipientId,
            message: input.message,
            mode: input.mode,
            kind: 'request',
            requestId,
            traceId,
            causationId: index === 0 ? (input.causationId ?? causationId) : causationId,
            deadlineAtMs: input.deadlineAtMs,
          });
          this.hydrateIndeterminate(draft, normalized.bridgeRequestId, catalogs.noReplay);
          const receipt = acceptCorrelatedRequestState(draft, auth, normalized, randomUUID).value;
          receipts.push(receipt);
          if (!receipt.route.duplicate) affectAcceptedRecipient(affectedRecipientIds, receipt.route.event);
          traceId ??= receipt.route.event.traceId;
          causationId ??= receipt.route.event.eventId;
        }
        return { changed: receipts.some((receipt) => !receipt.route.duplicate), value: receipts };
      },
      true,
      signal,
    );
  }

  async acceptCorrelatedRequest(
    auth: PeerEventAuth,
    input: CorrelatedRequestInput,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<CorrelatedRequestReceipt>> {
    const normalized = normalizeCorrelatedRequest(input);
    return this.mutate(
      async (draft, affectedRecipientIds, catalogs) => {
        this.hydrateIndeterminate(draft, normalized.bridgeRequestId, catalogs.noReplay);
        const result = acceptCorrelatedRequestState(draft, auth, normalized, randomUUID);
        if (result.changed) affectAcceptedRecipient(affectedRecipientIds, result.value.route.event);
        return result;
      },
      true,
      signal,
    );
  }

  async timeoutCorrelatedRequest(
    requestId: string,
    nowMs = Date.now(),
  ): Promise<SchedulerCommit<CorrelatedRequestReceipt | undefined>> {
    return this.mutate((draft, affectedRecipientIds) => {
      const result = timeoutCorrelatedRequestState(draft, requestId, nowMs, randomUUID);
      if (result.changed && result.value) {
        affectedRecipientIds.add(result.value.request.recipientId);
        affectAcceptedRecipient(affectedRecipientIds, result.value.route.event);
      }
      return result;
    });
  }

  async acceptCorrelatedReply(
    auth: PeerEventAuth,
    input: CorrelatedReplyInput,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<CorrelatedRequestReceipt>> {
    const normalized = normalizeCorrelatedReply(input);
    return this.mutate(
      async (draft, affectedRecipientIds, catalogs) => {
        this.hydrateIndeterminate(draft, normalized.bridgeRequestId, catalogs.noReplay);
        const result = acceptCorrelatedReplyState(draft, auth, normalized, randomUUID);
        if (result.changed) affectAcceptedRecipient(affectedRecipientIds, result.value.route.event);
        return result;
      },
      true,
      signal,
    );
  }

  async acceptCorrelatedCancel(
    auth: PeerEventAuth,
    input: CorrelatedCancelInput,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<CorrelatedRequestReceipt>> {
    const normalized = normalizeCorrelatedCancel(input);
    return this.mutate(
      async (draft, affectedRecipientIds, catalogs) => {
        this.hydrateIndeterminate(draft, normalized.bridgeRequestId, catalogs.noReplay);
        const result = acceptCorrelatedCancelState(draft, auth, normalized, randomUUID);
        if (result.changed) {
          affectedRecipientIds.add(result.value.request.recipientId);
          affectAcceptedRecipient(affectedRecipientIds, result.value.route.event);
        }
        return result;
      },
      true,
      signal,
    );
  }

  async registerWatch(
    input: WatchInput,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<WatchRecord>> {
    const principal = normalizePrincipal(requestedBy);
    return this.mutate(
      (draft, affectedRecipientIds) => {
        const result = registerWatchState(draft, input, principal, randomUUID);
        const event = result.value.triggerEventId ? peerMailboxRecord(draft, result.value.triggerEventId) : undefined;
        if (result.changed && event) affectAcceptedRecipient(affectedRecipientIds, event);
        return result;
      },
      true,
      signal,
    );
  }

  async cancelWatch(
    watchId: string,
    requestedBy: SchedulerPrincipal,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<WatchRecord>> {
    const principal = normalizePrincipal(requestedBy);
    return this.mutate((draft) => cancelWatchState(draft, watchId, principal), true, signal);
  }

  async retireSurfacedNotifications(): Promise<SchedulerCommit<number>> {
    return this.mutate((draft) => {
      const surfaced = new Set(
        peerMailboxRecords(draft)
          .filter((event) => event.mode === 'notify_only' && event.status === 'settled')
          .map((event) => event.eventId),
      );
      if (!surfaced.size) return { changed: false, value: 0 };
      retireCurrentFacts(draft, surfaced);
      const retired = [...surfaced].filter((eventId) => !peerMailboxRecord(draft, eventId)).length;
      if (!retired) return { changed: false, value: 0 };
      nextSequence(draft);
      return { changed: true, value: retired };
    }, false);
  }

  async close(): Promise<boolean> {
    if (this.resourceClosing) return false;
    this.resourceClosing = true;
    await this.operations;
    this.changeListeners.clear();
    return this.log.close();
  }

  async materializeDeliveryPayload(eventIdInput: string): Promise<void> {
    const eventId = id(eventIdInput, 'eventId');
    const event = peerMailboxRecord(this.state, eventId);
    if (!event?.payloadHash || !outboxRequired(event))
      throw new SchedulerStateError('payload_missing', `Unresolved payload '${eventId}' is unavailable`);
    await this.log.materializeDeliveryPayload(eventId, event.payloadHash);
  }

  async removeDeliveryPayload(eventId: string): Promise<void> {
    await this.log.removeDeliveryPayload(eventId);
  }

  private hydrateClosedLineage(
    draft: SchedulerState,
    targetId: string,
    closedCatalog: ReadonlyMap<string, AgentRecord> = this.closedCatalog,
  ): AgentRecord[] {
    let agent = draft.agents[targetId] ?? closedCatalog.get(targetId);
    if (!agent || agent.lifecycle !== 'closed') return [];
    if (draft.agents[targetId] === undefined) agent = structuredClone(agent);
    const lineage: AgentRecord[] = [];
    const seen = new Set<string>();
    while (agent.lifecycle === 'closed') {
      if (seen.has(agent.agentId))
        throw new SchedulerStateError(
          'state_invalid',
          `Closed collaborator lineage for '${targetId}' contains a cycle`,
        );
      seen.add(agent.agentId);
      draft.agents[agent.agentId] = agent;
      lineage.push(agent);
      if (!agent.parentId) break;
      const existingParent = draft.agents[agent.parentId];
      const coldParent = existingParent ? undefined : closedCatalog.get(agent.parentId);
      const parent = existingParent ?? (coldParent ? structuredClone(coldParent) : undefined);
      if (!parent)
        throw new SchedulerStateError('state_invalid', `Closed collaborator '${targetId}' has no retained parent`);
      if (parent.lifecycle === 'open') break;
      agent = parent;
    }
    return lineage;
  }

  private hydrateAllClosed(
    draft: SchedulerState,
    closedCatalog: ReadonlyMap<string, AgentRecord> = this.closedCatalog,
  ): void {
    for (const agent of closedCatalog.values()) {
      if (draft.agents[agent.agentId]?.lifecycle === 'open') continue;
      draft.agents[agent.agentId] = structuredClone(agent);
    }
  }

  private hydrateIndeterminate(
    draft: SchedulerState,
    operationId: string,
    noReplayCatalog: ReadonlyMap<string, ControlLogNoReplayRecord> = this.noReplayCatalog,
  ): void {
    const existing = Object.values(draft.mailbox).some((record) => mailboxOperationId(record) === operationId);
    const item = noReplayCatalog.get(operationId);
    if (!item) return;
    if (!existing) {
      const record = structuredClone(item.record);
      draft.mailbox[mailboxRecordId(record)] = record;
    }
    if (item.request && !draft.requests[item.request.requestId]) {
      const request = structuredClone(item.request);
      draft.requests[request.requestId] = request;
    }
  }

  private mutate<T>(
    operation: (
      draft: SchedulerState,
      affectedRecipientIds: Set<string>,
      catalogs: MutationCatalogs,
    ) => { changed: boolean; value: T } | Promise<{ changed: boolean; value: T }>,
    processBackground = true,
    signal?: AbortSignal,
  ): Promise<SchedulerCommit<T>> {
    if (this.resourceClosing) return Promise.reject(new Error('Scheduler store is closing or closed'));
    const schedule = this.pendingMutations.length === 0;
    const result = new Promise<SchedulerCommit<T>>((resolvePromise, rejectPromise) => {
      this.pendingMutations.push(async (batch) => {
        try {
          assertStoreOperationActive(signal);
          const tracked = createTrackedDraft(batch.state);
          const draft = tracked.draft;
          const affectedRecipientIds = new Set<string>();
          const outcome = await operation(draft, affectedRecipientIds, batch);
          if (!outcome.changed) {
            const receipt = {
              value: deepFreeze(tracked.unwrap(outcome.value)),
              revision: batch.state.revision,
              warnings: [],
              affectedRecipientIds: [],
            };
            batch.publications.push({ publish: () => resolvePromise(receipt), reject: rejectPromise });
            return;
          }
          if (processBackground) {
            for (const recipientId of resolveReadyWatchesState(draft, randomUUID))
              affectedRecipientIds.add(recipientId);
          }
          const noReplayPuts = new Map<string, ControlLogNoReplayRecord>();
          for (const recordId of tracked.changes.records.mailbox) {
            const record = draft.mailbox[recordId];
            if (!record || record.status !== 'indeterminate') continue;
            const operationId = mailboxOperationId(record);
            if (batch.noReplay.has(operationId)) continue;
            const durableRecord = structuredClone(tracked.unwrap(record));
            if (durableRecord.lane !== 'direct') delete durableRecord.message;
            const request =
              durableRecord.lane !== 'direct' && durableRecord.requestId
                ? draft.requests[durableRecord.requestId]
                : undefined;
            const item = {
              record: durableRecord,
              ...(request ? { request: structuredClone(tracked.unwrap(request)) } : {}),
            };
            noReplayPuts.set(operationId, {
              ...item,
              recordHash: sha256(JSON.stringify(item)),
            });
          }
          retireCurrentFacts(draft);
          const closedPuts: AgentRecord[] = [];
          const closedDeletes: string[] = [];
          for (const agentId of tracked.changes.records.agents) {
            const agent = draft.agents[agentId];
            if (!agent) {
              if (batch.closed.has(agentId)) closedDeletes.push(agentId);
              continue;
            }
            if (agent.lifecycle === 'closed') {
              const previousClosed = batch.closed.get(agent.agentId);
              if (!previousClosed || !isDeepStrictEqual(previousClosed, tracked.unwrap(agent)))
                closedPuts.push(structuredClone(tracked.unwrap(agent)));
            } else if (batch.closed.has(agent.agentId)) closedDeletes.push(agent.agentId);
          }
          currentState(draft);
          const current = deepFreeze(tracked.restore());
          const affected = deepFreeze([...affectedRecipientIds].sort());
          const receipt = {
            value: deepFreeze(tracked.unwrap(outcome.value)),
            revision: current.revision,
            warnings: [],
            affectedRecipientIds: affected,
          };
          batch.commits.push({
            state: current,
            changes: tracked.changes,
            ...(closedPuts.length ? { closedPuts } : {}),
            ...(closedDeletes.length ? { closedDeletes } : {}),
            ...(noReplayPuts.size ? { noReplayPuts } : {}),
          });
          batch.state = current;
          for (const agent of closedPuts) batch.closed.set(agent.agentId, deepFreeze(agent));
          for (const agentId of closedDeletes) batch.closed.delete(agentId);
          for (const [operationId, item] of noReplayPuts) batch.noReplay.set(operationId, deepFreeze(item));
          batch.publications.push({
            publish: () => {
              for (const agent of closedPuts) this.closedCatalog.set(agent.agentId, agent);
              for (const agentId of closedDeletes) this.closedCatalog.delete(agentId);
              for (const [operationId, item] of noReplayPuts) this.noReplayCatalog.set(operationId, item);
              if (closedPuts.length || closedDeletes.length) this.closedCatalogRevisionValue = current.revision;
              this.state = current;
              if (this.changeListeners.size)
                queueMicrotask(() => {
                  for (const listener of this.changeListeners) {
                    try {
                      listener(current.revision, affected);
                    } catch (error) {
                      this.addDiagnostic(error instanceof Error ? error.message : String(error));
                    }
                  }
                });
              resolvePromise(receipt);
            },
            reject: rejectPromise,
          });
        } catch (error) {
          rejectPromise(error);
        }
      });
    });
    if (schedule) this.operations = this.operations.then(() => this.flushMutations());
    return result;
  }

  private async flushMutations(): Promise<void> {
    const pending = this.pendingMutations.splice(0);
    if (!pending.length) return;
    const batch: MutationBatch = {
      state: this.state,
      closed: new Map(this.closedCatalog),
      noReplay: new Map(this.noReplayCatalog),
      commits: [],
      publications: [],
    };
    for (const mutation of pending) await mutation(batch);
    try {
      await this.log.commit(batch.commits);
    } catch (error) {
      for (const publication of batch.publications) publication.reject(error);
      return;
    }
    for (const publication of batch.publications) {
      publication.publish();
      await Promise.resolve();
    }
  }
  private addDiagnostic(message: string): void {
    this.diagnosticsRing.push(message.slice(0, 500));
    if (this.diagnosticsRing.length > MAX_DIAGNOSTICS)
      this.diagnosticsRing.splice(0, this.diagnosticsRing.length - MAX_DIAGNOSTICS);
  }
}
