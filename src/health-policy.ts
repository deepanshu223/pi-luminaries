import {
  agentRuntimeState,
  buildActivityIndex,
  canContinuePastIndeterminate,
  isContinuableIndeterminateEvidence,
  type AgentRecord,
  type MailboxRecord,
  type SchedulerActivityIndex,
  type SchedulerState,
} from './scheduler-state.ts';

export type HealthLevel = 'ok' | 'warning' | 'critical';
export interface HealthObservation {
  code: string;
  level: Exclude<HealthLevel, 'ok'>;
  message: string;
}
export interface AgentHealth {
  level: HealthLevel;
  attention: 'none' | 'warning' | 'critical';
  summary: string;
  reasons: readonly string[];
  observations: readonly HealthObservation[];
}

/** Deterministic, transcript-free health projection. It diagnoses mechanics, never intent. */
export function projectAgentHealth(
  state: Readonly<SchedulerState>,
  agent: Readonly<AgentRecord>,
  activityIndex: SchedulerActivityIndex = buildActivityIndex(state),
  additionalRecords: readonly MailboxRecord[] = [],
): AgentHealth {
  const observations: HealthObservation[] = [];
  const continuationBoundary = agent.continuedAfterSeq ?? 0;
  const runtimeState = agentRuntimeState(state, agent);
  const relatedPeer = activityIndex.peerByRecipient.get(agent.agentId) ?? [];
  const hasIndeterminate = [
    ...relatedPeer,
    ...(activityIndex.directByTarget.get(agent.agentId) ?? []),
    ...additionalRecords,
  ].some((record) => isContinuableIndeterminateEvidence(record, agent.agentId, continuationBoundary));
  const canContinue = canContinuePastIndeterminate(state, agent.agentId, additionalRecords);
  if (runtimeState === 'failed')
    observations.push({ code: 'runtime_failed', level: 'critical', message: 'Collaborator could not continue' });
  else if (runtimeState === 'needs_attention' && !canContinue)
    observations.push({
      code: 'runtime_attention',
      level: 'critical',
      message:
        agent.attention?.code === 'runtime_owner_unavailable'
          ? 'Runtime ownership is unavailable'
          : agent.attention?.code === 'configuration_indeterminate'
            ? 'Configuration outcome is uncertain'
            : agent.attention?.code === 'payload_materialization_failed'
              ? 'Message delivery could not be prepared'
              : agent.attention?.code?.startsWith('session_')
                ? 'Session binding needs review'
                : agent.attention?.code?.startsWith('runtime_')
                  ? 'Runtime needs review'
                  : 'This collaborator needs review',
    });
  if (hasIndeterminate && runtimeState !== 'failed' && (runtimeState !== 'needs_attention' || canContinue))
    observations.push({
      code: 'indeterminate_effect',
      level: 'critical',
      message: 'Delivery outcome is uncertain',
    });

  const level: HealthLevel = observations.some((item) => item.level === 'critical')
    ? 'critical'
    : observations.length
      ? 'warning'
      : 'ok';
  return {
    level,
    attention: level === 'ok' ? 'none' : level,
    summary: observations.length ? observations.map((item) => item.message).join(' · ') : 'No health issues',
    reasons: observations.map((item) => item.code),
    observations,
  };
}
