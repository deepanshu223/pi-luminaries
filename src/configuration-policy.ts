import { capabilityAllows } from './capability-policy.ts';
import {
  SchedulerStateError,
  absolutePath,
  agentRuntimeState,
  humanFacingText,
  id,
  isStrictAncestor,
  nextSequence,
  text,
  type AgentConfigurationChange,
  type AgentRecord,
  type SchedulerPrincipal,
  type SchedulerState,
} from './scheduler-state.ts';
import type { TreePolicyResult } from './tree-policy.ts';

export interface ConfigurationInput {
  changeId: string;
  targetId: string;
  kind: 'model' | 'thinking' | 'extensions';
  value?: string;
  provider?: string;
  thinking?: string;
  extensions?: readonly string[];
  extensionSources?: readonly string[];
}

function assertAuthority(state: SchedulerState, targetId: string, principal: SchedulerPrincipal): void {
  if (principal.kind === 'operator') return;
  if (principal.agentId === targetId || !isStrictAncestor(state, principal.agentId, targetId))
    throw new SchedulerStateError('authority_denied', `Agent '${principal.agentId}' cannot configure '${targetId}'`);
}

function normalizedInput(input: ConfigurationInput): ConfigurationInput {
  const kind = input.kind;
  if (kind !== 'model' && kind !== 'thinking' && kind !== 'extensions')
    throw new SchedulerStateError('input_invalid', 'Configuration kind is invalid');
  if (kind === 'extensions') {
    if (input.value !== undefined || input.provider !== undefined || input.thinking !== undefined)
      throw new SchedulerStateError('input_invalid', 'Extension configuration contains unrelated fields');
    const extensions = input.extensions;
    const extensionSources = input.extensionSources;
    if (!Array.isArray(extensions) || !Array.isArray(extensionSources))
      throw new SchedulerStateError('input_invalid', 'Extension configuration requires extensions');
    return {
      changeId: id(input.changeId, 'changeId'),
      targetId: id(input.targetId, 'targetId'),
      kind,
      extensions: [...new Set(extensions.map((path, index) => absolutePath(path, `extensions[${index}]`)))].sort(),
      extensionSources: [
        ...new Set(extensionSources.map((source) => humanFacingText(source, 'extension source', 4096))),
      ],
    };
  }
  if (input.value === undefined)
    throw new SchedulerStateError('input_invalid', 'Model and thinking configuration require a value');
  if (kind === 'thinking' && input.thinking !== undefined)
    throw new SchedulerStateError('input_invalid', 'Thinking configuration cannot include pinned thinking');
  return {
    changeId: id(input.changeId, 'changeId'),
    targetId: id(input.targetId, 'targetId'),
    kind,
    value: text(input.value, 'configuration value', 256),
    ...(input.provider === undefined ? {} : { provider: text(input.provider, 'provider', 128) }),
    ...(input.thinking === undefined ? {} : { thinking: text(input.thinking, 'thinking', 32) }),
  };
}

function validateChoice(agent: AgentRecord, input: ConfigurationInput): void {
  if (input.kind === 'extensions') {
    const allowed = agent.capabilities.extensions;
    const denied = allowed && input.extensions?.find((path) => !allowed.includes(path));
    if (denied)
      throw new SchedulerStateError('capability_denied', `Extension '${denied}' is outside the effective ceiling`);
    return;
  }
  const value = input.value;
  if (value === undefined) throw new SchedulerStateError('input_invalid', 'Configuration value is missing');
  if (input.kind === 'model') {
    if (!input.provider) throw new SchedulerStateError('input_invalid', 'Model change requires provider');
    const key = `${input.provider}/${value}`;
    if (!capabilityAllows(agent.capabilities, 'models', key))
      throw new SchedulerStateError('capability_denied', `Model '${key}' is outside the effective ceiling`);
    if (input.thinking && !capabilityAllows(agent.capabilities, 'thinking', input.thinking))
      throw new SchedulerStateError(
        'capability_denied',
        `Thinking '${input.thinking}' is outside the effective ceiling`,
      );
  } else if (!capabilityAllows(agent.capabilities, 'thinking', value))
    throw new SchedulerStateError('capability_denied', `Thinking '${value}' is outside the effective ceiling`);
}

function sameValue(agent: AgentRecord, input: ConfigurationInput): boolean {
  if (input.kind === 'extensions')
    return (
      input.extensions !== undefined &&
      input.extensionSources !== undefined &&
      input.extensions?.length === agent.launch.extensions.length &&
      input.extensions.every((path, index) => path === agent.launch.extensions[index]) &&
      input.extensionSources?.length === agent.launch.extensionSources?.length &&
      input.extensionSources.every((source, index) => source === agent.launch.extensionSources?.[index])
    );
  return input.kind === 'model'
    ? agent.provider === input.provider &&
        agent.model === input.value &&
        (input.thinking === undefined || agent.thinking === input.thinking)
    : agent.thinking === input.value;
}

export function validateOfflineConfigurationState(
  state: Readonly<SchedulerState>,
  raw: ConfigurationInput,
  principal: SchedulerPrincipal,
): { input: ConfigurationInput; agent: AgentRecord } {
  const input = normalizedInput(raw);
  assertAuthority(state, input.targetId, principal);
  const agent = state.agents[input.targetId];
  if (!agent || agent.lifecycle !== 'open')
    throw new SchedulerStateError('agent_unavailable', `Agent '${input.targetId}' is unavailable`);
  if (agent.runtimeOwner)
    throw new SchedulerStateError('runtime_owned', `Agent '${input.targetId}' has a live runtime`);
  validateChoice(agent, input);
  return { input, agent };
}

export function applyOfflineConfigurationState(
  state: SchedulerState,
  raw: ConfigurationInput,
  principal: SchedulerPrincipal,
): TreePolicyResult<AgentRecord> {
  const { input, agent } = validateOfflineConfigurationState(state, raw, principal);
  if (sameValue(agent, input)) return { changed: false, value: agent };
  nextSequence(state);
  if (input.kind === 'extensions') {
    agent.launch.extensions = [...(input.extensions ?? [])];
    agent.launch.extensionSources = [...(input.extensionSources ?? [])];
    if (
      agent.attention?.kind === 'needs_attention' &&
      (agent.attention.code === 'runtime_start_failed' || agent.attention.code === 'runtime_recovery_required')
    )
      delete agent.attention;
  } else if (input.kind === 'model') {
    agent.provider = input.provider;
    agent.model = input.value;
    if (input.thinking) agent.thinking = input.thinking;
  } else agent.thinking = input.value;
  return { changed: true, value: agent };
}

export function beginLiveConfigurationState(
  state: SchedulerState,
  raw: ConfigurationInput,
  principal: SchedulerPrincipal,
): TreePolicyResult<AgentConfigurationChange | undefined> {
  const input = normalizedInput(raw);
  assertAuthority(state, input.targetId, principal);
  const agent = state.agents[input.targetId];
  if (!agent || agent.lifecycle !== 'open' || !agent.runtimeOwner || agent.runtimePhase !== 'ready')
    throw new SchedulerStateError('runtime_unavailable', `Agent '${input.targetId}' has no ready runtime`);
  const runtimeState = agentRuntimeState(state, agent);
  if (input.kind !== 'extensions' && runtimeState !== 'idle' && runtimeState !== 'waiting')
    throw new SchedulerStateError('writer_busy', `Agent '${input.targetId}' must be idle before configuration`);
  validateChoice(agent, input);
  if (agent.pendingConfiguration) {
    const existing = agent.pendingConfiguration;
    if (
      existing.changeId === input.changeId &&
      existing.kind === input.kind &&
      existing.value === input.value &&
      existing.provider === input.provider &&
      existing.thinking === input.thinking &&
      existing.extensions?.length === input.extensions?.length &&
      existing.extensions?.every((path, index) => path === input.extensions?.[index]) &&
      existing.extensionSources?.length === input.extensionSources?.length &&
      existing.extensionSources?.every((source, index) => source === input.extensionSources?.[index])
    )
      return { changed: false, value: existing };
    throw new SchedulerStateError('configuration_busy', `Agent '${input.targetId}' has a pending configuration`);
  }
  if (sameValue(agent, input)) return { changed: false, value: undefined };
  const seq = nextSequence(state);
  const change: AgentConfigurationChange = {
    changeId: input.changeId,
    kind: input.kind,
    value: input.value,
    provider: input.provider,
    thinking: input.thinking,
    ...(input.extensions === undefined ? {} : { extensions: [...input.extensions] }),
    ...(input.extensionSources === undefined ? {} : { extensionSources: [...input.extensionSources] }),
    runtimeOwner: agent.runtimeOwner,
    status: 'dispatching',
    createdSeq: seq,
  };
  agent.pendingConfiguration = change;
  return { changed: true, value: change };
}

export function finishLiveConfigurationState(
  state: SchedulerState,
  targetIdInput: string,
  changeIdInput: string,
  outcome: 'applied' | 'refused' | 'indeterminate',
): TreePolicyResult<AgentRecord> {
  const targetId = id(targetIdInput, 'targetId');
  const changeId = id(changeIdInput, 'changeId');
  const agent = state.agents[targetId];
  const change = agent?.pendingConfiguration;
  if (!agent || !change || change.changeId !== changeId)
    throw new SchedulerStateError('configuration_stale', `Configuration '${changeId}' is not current`);
  const seq = nextSequence(state);
  if (outcome === 'applied') {
    if (change.kind === 'extensions') {
      agent.launch.extensions = [...(change.extensions ?? [])];
      agent.launch.extensionSources = [...(change.extensionSources ?? [])];
    } else if (change.kind === 'model') {
      agent.provider = change.provider;
      agent.model = change.value;
      if (change.thinking) agent.thinking = change.thinking;
    } else agent.thinking = change.value;
    delete agent.pendingConfiguration;
  } else if (outcome === 'refused') delete agent.pendingConfiguration;
  else {
    change.status = 'indeterminate';
    agent.attention = { kind: 'needs_attention', code: 'configuration_indeterminate', seq };
  }
  return { changed: true, value: agent };
}
