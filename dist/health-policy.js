import { agentRuntimeState, buildActivityIndex, canContinuePastIndeterminate, isContinuableIndeterminateEvidence, } from "./scheduler-state.js";
/** Deterministic, transcript-free health projection. It diagnoses mechanics, never intent. */
export function projectAgentHealth(state, agent, activityIndex = buildActivityIndex(state), additionalRecords = []) {
    const observations = [];
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
            message: agent.attention?.code === 'runtime_owner_unavailable'
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
    const level = observations.some((item) => item.level === 'critical')
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
