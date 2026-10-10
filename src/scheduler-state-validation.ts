import { resolve } from 'node:path';
import { normalizeCapabilityEnvelope, normalizeCapabilityRequest } from './capability-policy.ts';
import { isLowercaseSha256, isPiSessionId } from './identifiers.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import {
  DIRECT_CONTROL_STATES,
  LUMINARIES_SERVICE_PERMISSIONS,
  SchedulerStateError,
  TERMINAL_DIRECT_CONTROL_STATES,
  TERMINAL_PEER_EVENT_STATUSES,
  absolutePath,
  agentDepth,
  agentPath,
  exactKeys,
  humanFacingProse,
  humanFacingText,
  humanFacingTextList,
  id,
  idList,
  integer,
  isCorrelatedRequestStatus,
  isPeerEventStatus,
  isRecord,
  nonemptyText,
  isStrictAncestor,
  mailboxActivationIds,
  normalizeAgentContext,
  normalizeAgentLaunch,
  normalizePrincipal,
  openCollaboratorCount,
  peerMailboxRecord,
  peerMailboxRecords,
  referenceTargetsPrivateState,
  requestStatus,
  sha256,
  text,
  within,
  type AgentRecord,
  type DeclaredSource,
  type SchedulerState,
} from './scheduler-state.ts';

const EVENT_ORIGINS = new Set(['agent', 'operator', 'service', 'scheduler', 'system']);
const EVENT_KINDS = new Set(['message', 'request', 'reply', 'cancel', 'resolution', 'system']);
const EVENT_MODES = new Set(['default', 'follow_up', 'notify_only']);
const EVENT_TYPES = new Set([
  'watch_activity',
  'request_timeout',
  'health_attention',
  'background_completion',
  'permission_decision',
  'control_failure',
  'routine',
]);
const RESOLUTION_CODES = new Set([
  'request_delivery_failed',
  'request_dispatch_indeterminate',
  'recipient_closed',
  'request_timeout',
]);
const SERVICE_PERMISSIONS = new Set<string>(LUMINARIES_SERVICE_PERMISSIONS);

function optionalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : id(value, label);
}

function optionalSequence(value: unknown, minimum: number, nextSeq: number, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, minimum, nextSeq - 1, label);
}

function source(value: unknown, label: string): DeclaredSource {
  if (value !== 'spawn' && value !== 'self' && value !== 'owner' && value !== 'operator')
    throw new SchedulerStateError('state_invalid', `${label} source is invalid`);
  return value;
}

function declaredField(value: unknown, label: string, kind: 'text' | 'prose' | 'expertise' | 'refs'): void {
  if (!isRecord(value)) throw new SchedulerStateError('state_invalid', `${label} must be a declared field`);
  exactKeys(value, ['value', 'source', 'updatedAtMs'], label);
  source(value.source, label);
  integer(value.updatedAtMs, 0, Number.MAX_SAFE_INTEGER, `${label}.updatedAtMs`);
  if (kind === 'text') humanFacingText(value.value, `${label}.value`);
  else if (kind === 'prose') humanFacingProse(value.value, `${label}.value`);
  else humanFacingTextList(value.value, `${label}.value`);
}

function expertCard(value: unknown, label: string): void {
  if (!isRecord(value)) throw new SchedulerStateError('state_invalid', `${label} must be an expert card`);
  exactKeys(value, ['role', 'focus', 'expertise', 'publishedRefs', 'lastUpdatedAtMs'], label);
  integer(value.lastUpdatedAtMs, 0, Number.MAX_SAFE_INTEGER, `${label}.lastUpdatedAtMs`);
  if (value.role !== undefined) declaredField(value.role, `${label}.role`, 'text');
  if (value.focus !== undefined) declaredField(value.focus, `${label}.focus`, 'prose');
  if (value.expertise !== undefined) declaredField(value.expertise, `${label}.expertise`, 'expertise');
  if (value.publishedRefs !== undefined) declaredField(value.publishedRefs, `${label}.publishedRefs`, 'refs');
}

function agentNames(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new SchedulerStateError('state_invalid', 'root.agentNames must be a non-empty list');
  for (const [index, item] of value.entries()) {
    const name = humanFacingText(item, `root.agentNames[${index}]`);
    if (!name.trim()) throw new SchedulerStateError('state_invalid', `root.agentNames[${index}] is empty`);
  }
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validateSessionUniqueness(agents: Record<string, AgentRecord>): void {
  const withSessions = Object.values(agents).filter(
    (agent): agent is AgentRecord & { sessionDir: string } => typeof agent.sessionDir === 'string',
  );
  for (let leftIndex = 0; leftIndex < withSessions.length; leftIndex++) {
    const left = withSessions[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < withSessions.length; rightIndex++) {
      const right = withSessions[rightIndex];
      if (within(left.sessionDir, right.sessionDir) || within(right.sessionDir, left.sessionDir))
        throw new SchedulerStateError(
          'state_invalid',
          `Collaborators '${left.agentId}' and '${right.agentId}' have overlapping private session namespaces`,
        );
      if (left.sessionFile && right.sessionFile && pathIdentity(left.sessionFile) === pathIdentity(right.sessionFile))
        throw new SchedulerStateError(
          'state_invalid',
          `Collaborators '${left.agentId}' and '${right.agentId}' share a private session file`,
        );
    }
  }
}

function validatePendingConfiguration(value: unknown, agent: Readonly<AgentRecord>, nextSeq: number): number {
  if (!isRecord(value))
    throw new SchedulerStateError('state_invalid', `Collaborator '${agent.agentId}' pending configuration is invalid`);
  const label = `collaborator '${agent.agentId}'.pendingConfiguration`;
  exactKeys(
    value,
    [
      'changeId',
      'kind',
      'value',
      'provider',
      'thinking',
      'extensions',
      'extensionSources',
      'runtimeOwner',
      'status',
      'createdSeq',
    ],
    label,
  );
  id(value.changeId, `${label}.changeId`);
  if (value.kind !== 'model' && value.kind !== 'thinking' && value.kind !== 'extensions')
    throw new SchedulerStateError('state_invalid', `${label}.kind is invalid`);
  if (value.kind === 'extensions') {
    if (
      value.value !== undefined ||
      value.provider !== undefined ||
      value.thinking !== undefined ||
      !Array.isArray(value.extensions) ||
      !Array.isArray(value.extensionSources)
    )
      throw new SchedulerStateError('state_invalid', `${label} extension fields are inconsistent`);
    normalizeAgentLaunch(
      {
        noContextFiles: false,
        restrictSkills: false,
        restrictPromptTemplates: false,
        restrictThemes: false,
        extensionSources: value.extensionSources,
        extensions: value.extensions,
        skills: [],
        promptTemplates: [],
        themes: [],
      },
      label,
    );
  } else {
    nonemptyText(value.value, `${label}.value`);
    if (value.extensions !== undefined || value.extensionSources !== undefined)
      throw new SchedulerStateError('state_invalid', `${label} extensions are inconsistent`);
  }
  if (value.provider !== undefined) nonemptyText(value.provider, `${label}.provider`);
  if (value.thinking !== undefined) text(value.thinking, `${label}.thinking`, 32);
  const owner = id(value.runtimeOwner, `${label}.runtimeOwner`);
  if (value.status !== 'dispatching' && value.status !== 'indeterminate')
    throw new SchedulerStateError('state_invalid', `${label}.status is invalid`);
  if (value.status === 'dispatching' && owner !== agent.runtimeOwner)
    throw new SchedulerStateError('state_invalid', `${label} owner is inconsistent`);
  if (value.status === 'indeterminate' && agent.attention?.kind !== 'needs_attention')
    throw new SchedulerStateError('state_invalid', `${label} lacks attention evidence`);
  return integer(value.createdSeq, 1, nextSeq - 1, `${label}.createdSeq`);
}

function validateAgents(state: SchedulerState, nextSeq: number, statePath?: string): number {
  let maximumSeq = 0;
  for (const [key, raw] of Object.entries(state.agents)) {
    id(key, 'collaborator map key');
    if (!isRecord(raw)) throw new SchedulerStateError('state_invalid', `Collaborator '${key}' must be an object`);
    exactKeys(
      raw,
      [
        'agentId',
        'parentId',
        'segment',
        'lifecycle',
        'cwd',
        'displayName',
        'assignment',
        'ownershipBoundary',
        'expertCard',
        'sessionId',
        'sessionDir',
        'sessionFile',
        'provider',
        'model',
        'thinking',
        'completionMode',
        'spawnHash',
        'context',
        'launch',
        'capabilities',
        'spawnGrant',
        'pendingConfiguration',
        'runtimeOwner',
        'runtimePhase',
        'runtimeManagerPid',
        'runtimeHostname',
        'runtimePid',
        'runtimeSeq',
        'attention',
        'continuedAfterSeq',
        'createdSeq',
        'closedSeq',
        'archive',
      ],
      `collaborator '${key}'`,
    );
    if (id(raw.agentId, `collaborator '${key}'.agentId`) !== key)
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' identity is inconsistent`);
    if (raw.parentId !== null) id(raw.parentId, `collaborator '${key}'.parentId`);
    id(raw.segment, `collaborator '${key}'.segment`);
    if (raw.lifecycle !== 'open' && raw.lifecycle !== 'closed')
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' lifecycle is invalid`);
    const cwd = absolutePath(raw.cwd, `collaborator '${key}'.cwd`);
    if (cwd !== raw.cwd) throw new SchedulerStateError('state_invalid', `Collaborator '${key}' cwd is not normalized`);
    declaredField(raw.displayName, `collaborator '${key}'.displayName`, 'text');
    declaredField(raw.assignment, `collaborator '${key}'.assignment`, 'prose');
    declaredField(raw.ownershipBoundary, `collaborator '${key}'.ownershipBoundary`, 'prose');
    expertCard(raw.expertCard, `collaborator '${key}'.expertCard`);
    const sessionId = raw.sessionId === undefined ? undefined : text(raw.sessionId, `${key}.sessionId`, 128);
    if (sessionId !== undefined && !isPiSessionId(sessionId))
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' session ID is invalid`);
    const sessionDir = raw.sessionDir === undefined ? undefined : absolutePath(raw.sessionDir, `${key}.sessionDir`);
    const sessionFile = raw.sessionFile === undefined ? undefined : absolutePath(raw.sessionFile, `${key}.sessionFile`);
    if (sessionDir !== raw.sessionDir || sessionFile !== raw.sessionFile)
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' session path is not normalized`);
    if (key !== state.root.rootId && (!sessionId || !sessionDir))
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' lacks private session identity`);
    if (sessionFile && (!sessionDir || !within(sessionFile, sessionDir)))
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' session file escapes its directory`);
    if (raw.provider !== undefined) nonemptyText(raw.provider, `${key}.provider`);
    if (raw.model !== undefined) nonemptyText(raw.model, `${key}.model`);
    if (raw.thinking !== undefined) text(raw.thinking, `${key}.thinking`, 32);
    if (raw.spawnGrant !== undefined) {
      if (!isRecord(raw.spawnGrant) || raw.parentId === null)
        throw new SchedulerStateError('state_invalid', `${key}.spawnGrant is invalid`);
      exactKeys(raw.spawnGrant, ['spawn', 'maxDepth', 'extensions'], `${key}.spawnGrant`);
      if (raw.spawnGrant.spawn !== undefined && typeof raw.spawnGrant.spawn !== 'boolean')
        throw new SchedulerStateError('state_invalid', `${key}.spawnGrant.spawn is invalid`);
      if (raw.spawnGrant.maxDepth !== undefined)
        integer(raw.spawnGrant.maxDepth, 0, Number.MAX_SAFE_INTEGER, `${key}.spawnGrant.maxDepth`);
      if (raw.spawnGrant.extensions !== undefined)
        normalizeCapabilityRequest({ extensions: raw.spawnGrant.extensions });
    }
    if (raw.completionMode !== undefined && raw.completionMode !== 'default' && raw.completionMode !== 'notify_only')
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' completion mode is invalid`);
    if (typeof raw.spawnHash !== 'string' || !isLowercaseSha256(raw.spawnHash))
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' spawn hash is invalid`);
    normalizeAgentContext(raw.context, `collaborator '${key}'.context`);
    normalizeAgentLaunch(raw.launch, `collaborator '${key}'.launch`);
    try {
      normalizeCapabilityEnvelope(raw.capabilities);
    } catch (error) {
      throw new SchedulerStateError('state_invalid', `Collaborator '${key}' capabilities are invalid`, {
        cause: error,
      });
    }
    const createdSeq = integer(raw.createdSeq, 1, nextSeq - 1, `${key}.createdSeq`);
    maximumSeq = Math.max(maximumSeq, createdSeq);
    if (raw.lifecycle === 'open') {
      if (raw.closedSeq !== undefined)
        throw new SchedulerStateError('state_invalid', `Open collaborator '${key}' retains close evidence`);
      if (raw.archive !== undefined)
        throw new SchedulerStateError('state_invalid', `Open collaborator '${key}' retains archive evidence`);
    } else {
      if (raw.closedSeq === undefined)
        throw new SchedulerStateError('state_invalid', `Closed collaborator '${key}' lacks close evidence`);
      maximumSeq = Math.max(maximumSeq, integer(raw.closedSeq, createdSeq, nextSeq - 1, `${key}.closedSeq`));
      if (raw.archive !== undefined) {
        if (!isRecord(raw.archive))
          throw new SchedulerStateError('state_invalid', `Closed collaborator '${key}' archive marker is invalid`);
        exactKeys(raw.archive, ['archived', 'seq'], `collaborator '${key}'.archive`);
        if (typeof raw.archive.archived !== 'boolean')
          throw new SchedulerStateError('state_invalid', `Closed collaborator '${key}' archive marker is invalid`);
        maximumSeq = Math.max(maximumSeq, integer(raw.archive.seq, raw.closedSeq, nextSeq - 1, `${key}.archive.seq`));
      }
      if (raw.pendingConfiguration !== undefined || raw.attention !== undefined)
        throw new SchedulerStateError('state_invalid', `Closed collaborator '${key}' retains live coordination state`);
    }
    if (raw.runtimeOwner === undefined) {
      if (
        raw.runtimePhase !== undefined ||
        raw.runtimeManagerPid !== undefined ||
        raw.runtimeHostname !== undefined ||
        raw.runtimePid !== undefined
      )
        throw new SchedulerStateError('state_invalid', `Collaborator '${key}' has an incomplete runtime owner`);
    } else {
      id(raw.runtimeOwner, `${key}.runtimeOwner`);
      if (raw.runtimePhase !== 'starting' && raw.runtimePhase !== 'ready')
        throw new SchedulerStateError('state_invalid', `Collaborator '${key}' runtime phase is invalid`);
      integer(raw.runtimeManagerPid, 1, 2_147_483_647, `${key}.runtimeManagerPid`);
      text(raw.runtimeHostname, `${key}.runtimeHostname`, 255);
      if (raw.runtimePid !== undefined) integer(raw.runtimePid, 1, 2_147_483_647, `${key}.runtimePid`);
      if (raw.runtimePhase === 'ready' && raw.runtimePid === undefined)
        throw new SchedulerStateError('state_invalid', `Ready collaborator '${key}' lacks a runtime PID`);
    }
    if (raw.runtimeSeq !== undefined)
      maximumSeq = Math.max(maximumSeq, integer(raw.runtimeSeq, createdSeq, nextSeq - 1, `${key}.runtimeSeq`));
    if (raw.attention !== undefined) {
      if (!isRecord(raw.attention))
        throw new SchedulerStateError('state_invalid', `Collaborator '${key}' attention is invalid`);
      exactKeys(raw.attention, ['kind', 'code', 'seq'], `${key}.attention`);
      if (raw.attention.kind !== 'failed' && raw.attention.kind !== 'needs_attention')
        throw new SchedulerStateError('state_invalid', `Collaborator '${key}' attention kind is invalid`);
      text(raw.attention.code, `${key}.attention.code`, 64);
      maximumSeq = Math.max(maximumSeq, integer(raw.attention.seq, createdSeq, nextSeq - 1, `${key}.attention.seq`));
    }
    if (raw.continuedAfterSeq !== undefined)
      maximumSeq = Math.max(
        maximumSeq,
        integer(raw.continuedAfterSeq, createdSeq, nextSeq - 1, `${key}.continuedAfterSeq`),
      );
    if (raw.pendingConfiguration !== undefined)
      maximumSeq = Math.max(maximumSeq, validatePendingConfiguration(raw.pendingConfiguration, raw, nextSeq));
  }

  const root = state.agents[state.root.rootId];
  if (!root || root.parentId !== null || root.segment !== 'root' || root.lifecycle !== 'open')
    throw new SchedulerStateError('state_invalid', 'Root collaborator lineage is invalid');
  if (root.capabilities.maxDepth !== state.root.maxDepth)
    throw new SchedulerStateError('state_invalid', 'Root collaborator grants differ from root configuration');
  const paths = new Set<string>();
  for (const agent of Object.values(state.agents)) {
    const depth = agentDepth(state, agent.agentId);
    if (depth > state.root.maxDepth)
      throw new SchedulerStateError('state_invalid', `Collaborator '${agent.agentId}' exceeds root depth`);
    const path = agentPath(state, agent.agentId);
    if (paths.has(path)) throw new SchedulerStateError('state_invalid', `Collaborator path '${path}' is duplicated`);
    paths.add(path);
    if (agent.agentId === state.root.rootId) continue;
    const parent = agent.parentId ? state.agents[agent.parentId] : undefined;
    if (!parent) throw new SchedulerStateError('state_invalid', `Collaborator '${agent.agentId}' has no parent`);
    if (agent.lifecycle === 'open' && parent.lifecycle !== 'open')
      throw new SchedulerStateError('state_invalid', `Open collaborator '${agent.agentId}' has a closed parent`);
  }
  if (openCollaboratorCount(state) > state.root.maxOpenAgents)
    throw new SchedulerStateError('state_invalid', 'Root collaborator occupancy exceeds configured capacity');
  validateSessionUniqueness(state.agents);
  for (const agent of Object.values(state.agents))
    for (const reference of agent.expertCard.publishedRefs?.value ?? [])
      if (referenceTargetsPrivateState(reference, state, agent.cwd, statePath))
        throw new SchedulerStateError(
          'state_invalid',
          `Collaborator '${agent.agentId}' publishes a private ${LUMINARIES_IDENTITY.label} reference`,
        );
  return maximumSeq;
}

function validateActivations(state: SchedulerState, nextSeq: number): number {
  let maximumSeq = 0;
  const running = new Set<string>();
  for (const [key, raw] of Object.entries(state.activations)) {
    id(key, 'activation map key');
    if (!isRecord(raw)) throw new SchedulerStateError('state_invalid', `Activation '${key}' must be an object`);
    exactKeys(
      raw,
      ['activationId', 'agentId', 'leaseToken', 'state', 'inputKind', 'startedSeq', 'nativeInputSeq', 'terminalSeq'],
      `activation '${key}'`,
    );
    if (id(raw.activationId, `${key}.activationId`) !== key)
      throw new SchedulerStateError('state_invalid', `Activation '${key}' identity is inconsistent`);
    const agentId = id(raw.agentId, `${key}.agentId`);
    const agent = state.agents[agentId];
    if (!agent) throw new SchedulerStateError('state_invalid', `Activation '${key}' collaborator is missing`);
    id(raw.leaseToken, `${key}.leaseToken`);
    if (
      raw.state !== 'running' &&
      raw.state !== 'settled' &&
      raw.state !== 'aborted' &&
      raw.state !== 'failed' &&
      raw.state !== 'indeterminate'
    )
      throw new SchedulerStateError('state_invalid', `Activation '${key}' state is invalid`);
    text(raw.inputKind, `${key}.inputKind`, 32);
    const startedSeq = integer(raw.startedSeq, 1, nextSeq - 1, `${key}.startedSeq`);
    const terminalSeq = optionalSequence(raw.terminalSeq, startedSeq, nextSeq, `${key}.terminalSeq`);
    const nativeInputSeq = optionalSequence(raw.nativeInputSeq, startedSeq, nextSeq, `${key}.nativeInputSeq`);
    if (
      nativeInputSeq !== undefined &&
      (agentId !== state.root.rootId || (terminalSeq !== undefined && nativeInputSeq > terminalSeq))
    )
      throw new SchedulerStateError('state_invalid', `Activation '${key}' native input evidence is inconsistent`);
    if ((raw.state === 'running') !== (terminalSeq === undefined))
      throw new SchedulerStateError('state_invalid', `Activation '${key}' terminal evidence is inconsistent`);
    maximumSeq = Math.max(maximumSeq, startedSeq, nativeInputSeq ?? 0, terminalSeq ?? 0);
    if (raw.state === 'running') {
      if (running.has(agentId) || agent.lifecycle !== 'open')
        throw new SchedulerStateError('state_invalid', `Activation '${key}' running state is inconsistent`);
      if (agent.parentId !== null && (!agent.runtimeOwner || agent.runtimePhase !== 'ready'))
        throw new SchedulerStateError('state_invalid', `Activation '${key}' has no ready private runtime`);
      running.add(agentId);
    }
  }
  return maximumSeq;
}

interface AttemptGroup {
  recipientId: string;
  activationId: string;
  deliveryKind: string;
  attemptSeq: number;
  members: number;
  consumed: number;
}

function validatePeerEvents(state: SchedulerState, nextSeq: number): number {
  let maximumSeq = 0;
  const acceptedSeqs = new Set<number>();
  const bridgeRequests = new Set<string>();
  const attempts = new Map<string, AttemptGroup>();
  for (const [key, raw] of Object.entries(state.mailbox)) {
    if (!isRecord(raw) || raw.lane === 'direct') continue;
    exactKeys(
      raw,
      [
        'lane',
        'eventId',
        'bridgeRequestId',
        'requestHash',
        'origin',
        'senderId',
        'recipientId',
        'traceId',
        'causationId',
        'sourceActivationId',
        'targetActivationId',
        'afterControlId',
        'kind',
        'requestId',
        'resolutionCode',
        'systemType',
        'dedupeKey',
        'mode',
        'message',
        'payloadHash',
        'payloadBytes',
        'status',
        'acceptedSeq',
        'acceptedAtMs',
        'attemptId',
        'activationId',
        'deliveryKind',
        'attemptSeq',
        'consumedSeq',
        'terminalSeq',
        'outcomeCode',
      ],
      `peer event '${key}'`,
    );
    if (raw.lane !== 'peer' && raw.lane !== 'operator' && raw.lane !== 'service' && raw.lane !== 'system')
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' lane is invalid`);
    if (id(raw.eventId, `${key}.eventId`) !== key)
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' identity is inconsistent`);
    const bridgeRequestId = id(raw.bridgeRequestId, `${key}.bridgeRequestId`);
    if (bridgeRequests.has(bridgeRequestId))
      throw new SchedulerStateError('state_invalid', `Peer bridge request '${bridgeRequestId}' is duplicated`);
    bridgeRequests.add(bridgeRequestId);
    if (typeof raw.requestHash !== 'string' || !isLowercaseSha256(raw.requestHash))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' request hash is invalid`);
    if (typeof raw.origin !== 'string' || !EVENT_ORIGINS.has(raw.origin))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' origin is invalid`);
    const expectedLane =
      raw.origin === 'agent' ? 'peer' : raw.origin === 'scheduler' || raw.origin === 'system' ? 'system' : raw.origin;
    if (raw.lane !== expectedLane)
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' lane and origin disagree`);
    const senderId = id(raw.senderId, `${key}.senderId`);
    const recipientId = id(raw.recipientId, `${key}.recipientId`);
    const sender = state.agents[senderId];
    const recipient = state.agents[recipientId];
    if (!sender) throw new SchedulerStateError('state_invalid', `Peer event '${key}' sender is missing`);
    const traceId = id(raw.traceId, `${key}.traceId`);
    const causationId = optionalId(raw.causationId, `${key}.causationId`);
    const sourceActivationId = optionalId(raw.sourceActivationId, `${key}.sourceActivationId`);
    const targetActivationId = optionalId(raw.targetActivationId, `${key}.targetActivationId`);
    const afterControlId = optionalId(raw.afterControlId, `${key}.afterControlId`);
    if (sourceActivationId) {
      const activation = state.activations[sourceActivationId];
      if ((!activation || activation.agentId !== senderId) && raw.status !== 'indeterminate')
        throw new SchedulerStateError('state_invalid', `Peer event '${key}' source activation is inconsistent`);
    }
    if (targetActivationId) {
      const targetActivation = state.activations[targetActivationId];
      if (!targetActivation || targetActivation.agentId !== recipientId)
        throw new SchedulerStateError('state_invalid', `Peer event '${key}' target activation is inconsistent`);
    }
    if (afterControlId) {
      const control = state.mailbox[afterControlId];
      if (!control || control.lane !== 'direct' || control.targetId !== recipientId)
        throw new SchedulerStateError('state_invalid', `Peer event '${key}' control dependency is inconsistent`);
    }
    if ((raw.origin === 'agent') !== (sourceActivationId !== undefined) && raw.origin !== 'system')
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' origin and source activation disagree`);
    if (typeof raw.kind !== 'string' || !EVENT_KINDS.has(raw.kind))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' kind is invalid`);
    if (
      (raw.origin === 'agent' || raw.origin === 'operator' || raw.origin === 'service') &&
      (raw.kind === 'resolution' || raw.kind === 'system')
    )
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' actor kind is invalid`);
    if (raw.origin === 'scheduler' && raw.kind !== 'resolution' && raw.kind !== 'cancel')
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' scheduler kind is invalid`);
    if (raw.origin === 'system' && raw.kind !== 'system')
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' system kind is invalid`);
    const requestId = optionalId(raw.requestId, `${key}.requestId`);
    const correlated =
      raw.kind === 'request' || raw.kind === 'reply' || raw.kind === 'cancel' || raw.kind === 'resolution';
    if (correlated !== (requestId !== undefined))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' request correlation is inconsistent`);
    const resolutionCode =
      raw.resolutionCode === undefined ? undefined : text(raw.resolutionCode, `${key}.resolutionCode`, 64);
    if (
      (raw.kind === 'resolution') !== (resolutionCode !== undefined) ||
      (resolutionCode && !RESOLUTION_CODES.has(resolutionCode))
    )
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' resolution code is invalid`);
    const systemType = raw.systemType === undefined ? undefined : text(raw.systemType, `${key}.systemType`, 64);
    if ((raw.kind === 'system') !== (systemType !== undefined) || (systemType && !EVENT_TYPES.has(systemType)))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' system type is invalid`);
    if ((raw.origin === 'system') !== (raw.dedupeKey !== undefined))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' dedupe identity is invalid`);
    if (raw.dedupeKey !== undefined) text(raw.dedupeKey, `${key}.dedupeKey`, 128);
    if (typeof raw.mode !== 'string' || !EVENT_MODES.has(raw.mode))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' mode is invalid`);
    if (raw.kind === 'cancel' && raw.mode !== 'notify_only')
      throw new SchedulerStateError('state_invalid', `Cancellation event '${key}' is not notify-only`);
    const message = raw.message === undefined ? undefined : nonemptyText(raw.message, `${key}.message`);
    const payloadHash = raw.payloadHash;
    const payloadBytes = raw.payloadBytes;
    if (payloadHash !== undefined && (typeof payloadHash !== 'string' || !isLowercaseSha256(payloadHash)))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' payload hash is invalid`);
    if (payloadBytes !== undefined) integer(payloadBytes, 1, Number.MAX_SAFE_INTEGER, `${key}.payloadBytes`);
    if (message !== undefined && (sha256(message) !== payloadHash || Buffer.byteLength(message) !== payloadBytes))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' payload evidence is inconsistent`);
    if (typeof raw.status !== 'string' || !isPeerEventStatus(raw.status))
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' status is invalid`);
    const acceptedSeq = integer(raw.acceptedSeq, 1, nextSeq - 1, `${key}.acceptedSeq`);
    if (acceptedSeqs.has(acceptedSeq))
      throw new SchedulerStateError('state_invalid', `Peer event accepted sequence ${acceptedSeq} is duplicated`);
    acceptedSeqs.add(acceptedSeq);
    integer(raw.acceptedAtMs, 0, Number.MAX_SAFE_INTEGER, `${key}.acceptedAtMs`);
    const attemptId = optionalId(raw.attemptId, `${key}.attemptId`);
    const activationId = optionalId(raw.activationId, `${key}.activationId`);
    const deliveryKind = raw.deliveryKind;
    if (
      deliveryKind !== undefined &&
      deliveryKind !== 'wake' &&
      deliveryKind !== 'steer' &&
      deliveryKind !== 'follow_up'
    )
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' delivery kind is invalid`);
    const attemptSeq = optionalSequence(raw.attemptSeq, acceptedSeq, nextSeq, `${key}.attemptSeq`);
    const consumedSeq = optionalSequence(raw.consumedSeq, attemptSeq ?? acceptedSeq, nextSeq, `${key}.consumedSeq`);
    const terminalSeq = optionalSequence(raw.terminalSeq, acceptedSeq, nextSeq, `${key}.terminalSeq`);
    const outcomeCode = raw.outcomeCode === undefined ? undefined : text(raw.outcomeCode, `${key}.outcomeCode`, 96);
    const attemptParts = [attemptId, activationId, deliveryKind, attemptSeq].filter(
      (part) => part !== undefined,
    ).length;
    if (attemptParts !== 0 && attemptParts !== 4)
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' possible-send evidence is incomplete`);
    const hasAttempt = attemptParts === 4;
    if (
      attemptId !== undefined &&
      activationId !== undefined &&
      deliveryKind !== undefined &&
      attemptSeq !== undefined
    ) {
      const activation = state.activations[activationId];
      if (!activation || activation.agentId !== recipientId)
        throw new SchedulerStateError('state_invalid', `Peer event '${key}' target activation is inconsistent`);
      const group = attempts.get(attemptId) ?? {
        recipientId,
        activationId,
        deliveryKind,
        attemptSeq,
        members: 0,
        consumed: 0,
      };
      if (
        group.recipientId !== recipientId ||
        group.activationId !== activationId ||
        group.deliveryKind !== deliveryKind ||
        group.attemptSeq !== attemptSeq
      )
        throw new SchedulerStateError('state_invalid', `Peer attempt '${attemptId}' has inconsistent members`);
      group.members++;
      if (consumedSeq !== undefined) group.consumed++;
      attempts.set(attemptId, group);
    } else if (consumedSeq !== undefined) {
      throw new SchedulerStateError('state_invalid', `Peer event '${key}' has consumption without a possible send`);
    }
    if (raw.status === 'accepted') {
      if (
        !payloadHash ||
        payloadBytes === undefined ||
        hasAttempt ||
        consumedSeq !== undefined ||
        terminalSeq !== undefined ||
        outcomeCode !== undefined
      )
        throw new SchedulerStateError('state_invalid', `Accepted peer event '${key}' is inconsistent`);
    } else if (raw.status === 'sending') {
      if (
        !payloadHash ||
        payloadBytes === undefined ||
        !hasAttempt ||
        consumedSeq !== undefined ||
        terminalSeq !== undefined ||
        outcomeCode !== undefined
      )
        throw new SchedulerStateError('state_invalid', `Sending peer event '${key}' is inconsistent`);
    } else if (raw.status === 'consumed') {
      if (!hasAttempt || consumedSeq === undefined || terminalSeq !== undefined || outcomeCode !== undefined)
        throw new SchedulerStateError('state_invalid', `Consumed peer event '${key}' is inconsistent`);
    } else {
      if (terminalSeq === undefined || !outcomeCode)
        throw new SchedulerStateError('state_invalid', `Terminal peer event '${key}' lacks outcome evidence`);
      if (raw.mode === 'notify_only') {
        const validNotifyOnlyResult =
          (raw.status === 'settled' && payloadHash !== undefined && payloadBytes !== undefined) ||
          raw.status === 'refused';
        if (!validNotifyOnlyResult || hasAttempt || consumedSeq !== undefined)
          throw new SchedulerStateError('state_invalid', `Notify-only peer event '${key}' is inconsistent`);
      } else if (raw.status === 'settled' && (!hasAttempt || consumedSeq === undefined))
        throw new SchedulerStateError('state_invalid', `Settled peer event '${key}' lacks exact consumption`);
      else if (raw.status === 'aborted' && !hasAttempt)
        throw new SchedulerStateError('state_invalid', `Aborted peer event '${key}' lacks its attempted delivery`);
      else if (raw.status === 'indeterminate' && !hasAttempt)
        throw new SchedulerStateError(
          'state_invalid',
          `Indeterminate peer event '${key}' lacks possible-send evidence`,
        );
    }
    if (raw.mode === 'notify_only' && !TERMINAL_PEER_EVENT_STATUSES.has(raw.status))
      throw new SchedulerStateError('state_invalid', `Notify-only peer event '${key}' is not terminal`);
    if (!TERMINAL_PEER_EVENT_STATUSES.has(raw.status) && (!recipient || recipient.lifecycle !== 'open'))
      throw new SchedulerStateError('state_invalid', `Live peer event '${key}' target is unavailable`);
    maximumSeq = Math.max(maximumSeq, acceptedSeq, attemptSeq ?? 0, consumedSeq ?? 0, terminalSeq ?? 0);
    if (causationId) {
      const cause = peerMailboxRecord(state, causationId);
      if (
        (!cause && !TERMINAL_PEER_EVENT_STATUSES.has(raw.status)) ||
        (cause !== undefined && (cause.traceId !== traceId || cause.acceptedSeq >= acceptedSeq))
      )
        throw new SchedulerStateError('state_invalid', `Peer event '${key}' causation is inconsistent`);
    } else if (traceId !== key) {
      throw new SchedulerStateError('state_invalid', `Origin peer event '${key}' must own its trace identity`);
    }
  }
  for (const [attemptId, group] of attempts)
    if (group.consumed > 0 && group.consumed !== group.members)
      throw new SchedulerStateError('state_invalid', `Peer attempt '${attemptId}' has partial exact consumption`);
  return maximumSeq;
}

function validateDirectControls(state: SchedulerState, nextSeq: number): number {
  let maximumSeq = 0;
  const requestIds = new Set<string>();
  for (const [key, raw] of Object.entries(state.mailbox)) {
    if (!isRecord(raw) || raw.lane !== 'direct') continue;
    exactKeys(
      raw,
      [
        'lane',
        'controlId',
        'requestId',
        'requestHash',
        'issuer',
        'targetId',
        'activationId',
        'action',
        'status',
        'acceptedSeq',
        'attemptId',
        'deliveryKind',
        'attemptSeq',
        'consumedSeq',
        'terminalSeq',
        'outcomeCode',
      ],
      `direct control '${key}'`,
    );
    if (id(raw.controlId, `${key}.controlId`) !== key)
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' identity is inconsistent`);
    const requestId = id(raw.requestId, `${key}.requestId`);
    if (requestIds.has(requestId))
      throw new SchedulerStateError('state_invalid', `Direct request '${requestId}' is duplicated`);
    requestIds.add(requestId);
    const issuer = normalizePrincipal(raw.issuer);
    const targetId = id(raw.targetId, `${key}.targetId`);
    const target = state.agents[targetId];
    const activationId = id(raw.activationId, `${key}.activationId`);
    const activation = state.activations[activationId];
    if (!target || ((!activation || activation.agentId !== targetId) && raw.status !== 'indeterminate'))
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' target activation is inconsistent`);
    if (raw.action !== 'interrupt')
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' action is invalid`);
    if (issuer.kind === 'agent') {
      const caller = state.agents[issuer.agentId];
      if (!caller || (!isStrictAncestor(state, caller.agentId, targetId) && !caller.capabilities.peerInterrupt))
        throw new SchedulerStateError('state_invalid', `Direct control '${key}' issuer lacks authority`);
    }
    const expectedHash = sha256(
      JSON.stringify({ issuer, targetId, sourceActivationId: activationId, action: 'interrupt' }),
    );
    if (raw.requestHash !== expectedHash || typeof raw.requestHash !== 'string' || !isLowercaseSha256(raw.requestHash))
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' request hash is inconsistent`);
    if (typeof raw.status !== 'string' || !DIRECT_CONTROL_STATES.has(raw.status))
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' status is invalid`);
    const acceptedSeq = integer(raw.acceptedSeq, 1, nextSeq - 1, `${key}.acceptedSeq`);
    const attemptId = optionalId(raw.attemptId, `${key}.attemptId`);
    if (raw.deliveryKind !== undefined && raw.deliveryKind !== 'interrupt')
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' delivery kind is invalid`);
    const attemptSeq = optionalSequence(raw.attemptSeq, acceptedSeq, nextSeq, `${key}.attemptSeq`);
    const consumedSeq = optionalSequence(raw.consumedSeq, attemptSeq ?? acceptedSeq, nextSeq, `${key}.consumedSeq`);
    const terminalSeq = optionalSequence(raw.terminalSeq, acceptedSeq, nextSeq, `${key}.terminalSeq`);
    const outcomeCode = raw.outcomeCode === undefined ? undefined : text(raw.outcomeCode, `${key}.outcomeCode`, 96);
    const attemptParts = [attemptId, raw.deliveryKind, attemptSeq].filter((part) => part !== undefined).length;
    if (attemptParts !== 0 && attemptParts !== 3)
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' possible-send evidence is incomplete`);
    const hasAttempt = attemptParts === 3;
    if (!hasAttempt && consumedSeq !== undefined)
      throw new SchedulerStateError('state_invalid', `Direct control '${key}' has consumption without a send`);
    if (raw.status === 'accepted') {
      if (hasAttempt || consumedSeq !== undefined || terminalSeq !== undefined || outcomeCode !== undefined)
        throw new SchedulerStateError('state_invalid', `Accepted direct control '${key}' is inconsistent`);
    } else if (raw.status === 'sending') {
      if (!hasAttempt || consumedSeq !== undefined || terminalSeq !== undefined || outcomeCode !== undefined)
        throw new SchedulerStateError('state_invalid', `Sending direct control '${key}' is inconsistent`);
    } else if (raw.status === 'aborted') {
      if (!hasAttempt || consumedSeq === undefined || terminalSeq !== consumedSeq || outcomeCode !== 'turn_interrupted')
        throw new SchedulerStateError('state_invalid', `Aborted direct control '${key}' lacks exact abort evidence`);
    } else {
      if (terminalSeq === undefined || !outcomeCode || consumedSeq !== undefined)
        throw new SchedulerStateError('state_invalid', `Terminal direct control '${key}' is inconsistent`);
      if (raw.status === 'indeterminate' && !hasAttempt)
        throw new SchedulerStateError(
          'state_invalid',
          `Indeterminate direct control '${key}' lacks possible-send evidence`,
        );
    }
    if (!TERMINAL_DIRECT_CONTROL_STATES.has(raw.status) && target.lifecycle !== 'open')
      throw new SchedulerStateError('state_invalid', `Live direct control '${key}' target is closed`);
    maximumSeq = Math.max(maximumSeq, acceptedSeq, attemptSeq ?? 0, consumedSeq ?? 0, terminalSeq ?? 0);
  }
  return maximumSeq;
}

function validateCorrelations(state: SchedulerState, nextSeq: number): number {
  let maximumSeq = 0;
  for (const event of peerMailboxRecords(state)) {
    if (
      event.requestId &&
      !state.requests[event.requestId] &&
      (event.status === 'accepted' || event.status === 'sending') &&
      event.kind !== 'resolution'
    )
      throw new SchedulerStateError('state_invalid', `Peer event '${event.eventId}' request is missing`);
  }
  for (const [key, raw] of Object.entries(state.requests)) {
    id(key, 'request map key');
    if (!isRecord(raw)) throw new SchedulerStateError('state_invalid', `Request '${key}' must be an object`);
    exactKeys(
      raw,
      [
        'requestId',
        'traceId',
        'requesterId',
        'recipientId',
        'requestEventId',
        'createdSeq',
        'deadlineAtMs',
        'terminalEventId',
      ],
      `request '${key}'`,
    );
    if (id(raw.requestId, `${key}.requestId`) !== key)
      throw new SchedulerStateError('state_invalid', `Request '${key}' identity is inconsistent`);
    const traceId = id(raw.traceId, `${key}.traceId`);
    const requesterId = id(raw.requesterId, `${key}.requesterId`);
    const recipientId = id(raw.recipientId, `${key}.recipientId`);
    const requestEventId = id(raw.requestEventId, `${key}.requestEventId`);
    const requestEvent = peerMailboxRecord(state, requestEventId);
    if (
      !state.agents[requesterId] ||
      !state.agents[recipientId] ||
      !requestEvent ||
      requestEvent.kind !== 'request' ||
      requestEvent.requestId !== key ||
      requestEvent.traceId !== traceId ||
      requestEvent.senderId !== requesterId ||
      requestEvent.recipientId !== recipientId
    )
      throw new SchedulerStateError('state_invalid', `Request '${key}' origin is inconsistent`);
    const createdSeq = integer(raw.createdSeq, 1, nextSeq - 1, `${key}.createdSeq`);
    if (createdSeq !== requestEvent.acceptedSeq)
      throw new SchedulerStateError('state_invalid', `Request '${key}' accepted sequence is inconsistent`);
    if (raw.deadlineAtMs !== undefined) integer(raw.deadlineAtMs, 1, Number.MAX_SAFE_INTEGER, `${key}.deadlineAtMs`);
    const terminalEventId = optionalId(raw.terminalEventId, `${key}.terminalEventId`);
    if (terminalEventId) {
      const terminal = peerMailboxRecord(state, terminalEventId);
      if (
        !terminal ||
        terminal.requestId !== key ||
        terminal.traceId !== traceId ||
        (terminal.kind !== 'reply' && terminal.kind !== 'cancel' && terminal.kind !== 'resolution') ||
        terminal.causationId !== requestEventId
      )
        throw new SchedulerStateError('state_invalid', `Request '${key}' terminal correlation is inconsistent`);
    }
    const status = requestStatus(state, raw);
    // A resolved wait may retain its validated correlation for outstanding delivery or work.
    if (!isCorrelatedRequestStatus(status))
      throw new SchedulerStateError('state_invalid', `Request '${key}' has an invalid correlation status`);
    maximumSeq = Math.max(maximumSeq, createdSeq);
  }
  return maximumSeq;
}

function validateWatches(state: SchedulerState, nextSeq: number): number {
  let maximumSeq = 0;
  for (const [key, raw] of Object.entries(state.watches)) {
    id(key, 'watch map key');
    if (!isRecord(raw)) throw new SchedulerStateError('state_invalid', `Watch '${key}' must be an object`);
    exactKeys(
      raw,
      [
        'watchId',
        'ownerId',
        'requestHash',
        'requestIds',
        'agentIds',
        'eventKinds',
        'owned',
        'status',
        'createdSeq',
        'createdAtMs',
        'registeringActivationId',
        'causalInputs',
        'terminalSeq',
        'triggerEventId',
      ],
      `watch '${key}'`,
    );
    if (id(raw.watchId, `${key}.watchId`) !== key)
      throw new SchedulerStateError('state_invalid', `Watch '${key}' identity is inconsistent`);
    const ownerId = id(raw.ownerId, `${key}.ownerId`);
    const owner = state.agents[ownerId];
    if (!owner) throw new SchedulerStateError('state_invalid', `Watch '${key}' owner is missing`);
    if (typeof raw.requestHash !== 'string' || !isLowercaseSha256(raw.requestHash))
      throw new SchedulerStateError('state_invalid', `Watch '${key}' request hash is invalid`);
    if (raw.status !== 'active') throw new SchedulerStateError('state_invalid', `Watch '${key}' is not current`);
    const createdSeq = integer(raw.createdSeq, 1, nextSeq - 1, `${key}.createdSeq`);
    const terminalSeq = optionalSequence(raw.terminalSeq, createdSeq, nextSeq, `${key}.terminalSeq`);
    const triggerEventId = optionalId(raw.triggerEventId, `${key}.triggerEventId`);
    if (owner.lifecycle !== 'open' || terminalSeq !== undefined || triggerEventId !== undefined)
      throw new SchedulerStateError('state_invalid', `Active watch '${key}' is inconsistent`);
    const requestIds = idList(raw.requestIds, `${key}.requestIds`);
    const agentIds = idList(raw.agentIds, `${key}.agentIds`);
    if (!Array.isArray(raw.eventKinds))
      throw new SchedulerStateError('state_invalid', `Watch '${key}' event kinds are invalid`);
    const eventKinds = raw.eventKinds.map((kind, index) => {
      if (typeof kind !== 'string' || !EVENT_KINDS.has(kind))
        throw new SchedulerStateError('state_invalid', `Watch '${key}' eventKinds[${index}] is invalid`);
      return kind;
    });
    if (new Set(eventKinds).size !== eventKinds.length || typeof raw.owned !== 'boolean')
      throw new SchedulerStateError('state_invalid', `Watch '${key}' selectors are invalid`);
    integer(raw.createdAtMs, 0, Number.MAX_SAFE_INTEGER, `${key}.createdAtMs`);
    const registeringActivationId = optionalId(raw.registeringActivationId, `${key}.registeringActivationId`);
    if (registeringActivationId) {
      const activation = state.activations[registeringActivationId];
      if (!activation || activation.agentId !== ownerId)
        throw new SchedulerStateError('state_invalid', `Watch '${key}' registration activation is inconsistent`);
    }
    const causalInputs = idList(raw.causalInputs, `${key}.causalInputs`);
    const expectedHash = sha256(
      JSON.stringify({
        requestIds,
        agentIds,
        eventKinds,
        owned: raw.owned,
        registeringActivationId,
        causalInputs,
      }),
    );
    if (raw.requestHash !== expectedHash)
      throw new SchedulerStateError('state_invalid', `Watch '${key}' request hash is inconsistent`);
    for (const requestId of requestIds) {
      const request = state.requests[requestId];
      if (
        !request ||
        (!isStrictAncestor(state, ownerId, request.requesterId) &&
          ownerId !== request.requesterId &&
          !isStrictAncestor(state, ownerId, request.recipientId) &&
          ownerId !== request.recipientId)
      )
        throw new SchedulerStateError('state_invalid', `Watch '${key}' request authority is invalid`);
    }
    for (const agentId of agentIds)
      if (!state.agents[agentId] || (agentId !== ownerId && !isStrictAncestor(state, ownerId, agentId)))
        throw new SchedulerStateError('state_invalid', `Watch '${key}' collaborator authority is invalid`);
    for (const eventId of causalInputs)
      if (!peerMailboxRecord(state, eventId))
        throw new SchedulerStateError('state_invalid', `Watch '${key}' causal input is missing`);
    maximumSeq = Math.max(maximumSeq, createdSeq);
  }
  return maximumSeq;
}

export function validateSchedulerState(value: unknown, options: { statePath?: string } = {}): SchedulerState {
  if (!isRecord(value)) throw new SchedulerStateError('state_invalid', 'Scheduler state must be an object');
  exactKeys(
    value,
    [
      'version',
      'revision',
      'nextSeq',
      'updatedAtMs',
      'root',
      'agents',
      'activations',
      'mailbox',
      'requests',
      'watches',
    ],
    'state',
  );
  if (value.version !== 2)
    throw new SchedulerStateError('state_version', `Unsupported scheduler state version: ${String(value.version)}`);
  integer(value.revision, 0, Number.MAX_SAFE_INTEGER, 'revision');
  const nextSeq = integer(value.nextSeq, 1, Number.MAX_SAFE_INTEGER, 'nextSeq');
  integer(value.updatedAtMs, 0, Number.MAX_SAFE_INTEGER, 'updatedAtMs');
  if (!isRecord(value.root)) throw new SchedulerStateError('state_invalid', 'root must be an object');
  exactKeys(
    value.root,
    [
      'rootId',
      'maxOpenAgents',
      'maxOpenAgentsSource',
      'maxDepth',
      'maxDepthSource',
      'agentNames',
      'agentExtensions',
      'serviceGrant',
    ],
    'root',
  );
  id(value.root.rootId, 'root.rootId');
  integer(value.root.maxOpenAgents, 1, Number.MAX_SAFE_INTEGER, 'root.maxOpenAgents');
  if (value.root.maxOpenAgentsSource !== 'startup' && value.root.maxOpenAgentsSource !== 'operator-live')
    throw new SchedulerStateError('state_invalid', 'root.maxOpenAgentsSource is invalid');
  if (
    value.root.maxDepthSource !== undefined &&
    value.root.maxDepthSource !== 'startup' &&
    value.root.maxDepthSource !== 'operator-live'
  )
    throw new SchedulerStateError('state_invalid', 'root.maxDepthSource is invalid');
  integer(value.root.maxDepth, 1, Number.MAX_SAFE_INTEGER, 'root.maxDepth');
  if (value.root.agentNames !== undefined) agentNames(value.root.agentNames);
  if (!isRecord(value.root.agentExtensions))
    throw new SchedulerStateError('state_invalid', 'root.agentExtensions must be an object');
  for (const [specifier, setting] of Object.entries(value.root.agentExtensions)) {
    humanFacingText(specifier, 'root.agentExtensions specifier');
    if (setting !== 'always' && setting !== 'allow' && setting !== 'deny')
      throw new SchedulerStateError('state_invalid', `root.agentExtensions '${specifier}' is invalid`);
  }
  if (!Array.isArray(value.root.serviceGrant))
    throw new SchedulerStateError('state_invalid', 'root.serviceGrant must be a list');
  const serviceGrant = value.root.serviceGrant.map((permission, index) => {
    if (typeof permission !== 'string' || !SERVICE_PERMISSIONS.has(permission))
      throw new SchedulerStateError('state_invalid', `root.serviceGrant[${index}] is invalid`);
    return permission;
  });
  if (new Set(serviceGrant).size !== serviceGrant.length)
    throw new SchedulerStateError('state_invalid', 'root.serviceGrant contains duplicates');
  if (
    !isRecord(value.agents) ||
    !isRecord(value.activations) ||
    !isRecord(value.mailbox) ||
    !isRecord(value.requests) ||
    !isRecord(value.watches)
  )
    throw new SchedulerStateError('state_invalid', 'Scheduler collections must be objects');
  const state = value as unknown as SchedulerState;
  let maximumSeq = validateAgents(state, nextSeq, options.statePath);
  maximumSeq = Math.max(maximumSeq, validateActivations(state, nextSeq));
  maximumSeq = Math.max(maximumSeq, validatePeerEvents(state, nextSeq));
  maximumSeq = Math.max(maximumSeq, validateDirectControls(state, nextSeq));
  maximumSeq = Math.max(maximumSeq, validateCorrelations(state, nextSeq));
  maximumSeq = Math.max(maximumSeq, validateWatches(state, nextSeq));
  const referencedActivationIds = mailboxActivationIds(state);
  for (const activation of Object.values(state.activations)) {
    if (activation.state === 'running') continue;
    const referenced =
      referencedActivationIds.has(activation.activationId) ||
      state.agents[activation.agentId]?.attention?.seq === activation.terminalSeq;
    if (!referenced)
      throw new SchedulerStateError(
        'state_invalid',
        `Terminal activation '${activation.activationId}' is not current correlation evidence`,
      );
  }
  if (maximumSeq >= nextSeq) throw new SchedulerStateError('state_invalid', 'nextSeq is not ahead of persisted facts');
  return state;
}
