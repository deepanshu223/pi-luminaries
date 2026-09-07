import { projectAgentHealth } from "./health-policy.js";
import { buildActivityIndex, activationSeq, agentSeq, mailboxRecordSeq, peerMailboxRecords, projectAgentMailbox, sha256, isStartingInputEvent, } from "./scheduler-state.js";
const DEFAULT_WARNING_ESCALATION_MS = 30_000;
function healthCause(state, agent, health) {
    const reasons = new Set(health.reasons);
    if (reasons.has('indeterminate_effect') || reasons.has('runtime_attention')) {
        const event = peerMailboxRecords(state)
            .filter((candidate) => candidate.status === 'indeterminate' &&
            (candidate.senderId === agent.agentId || candidate.recipientId === agent.agentId))
            .sort((left, right) => mailboxRecordSeq(left) - mailboxRecordSeq(right))
            .at(-1);
        if (event)
            return { traceId: event.traceId, causationId: event.eventId };
    }
    if (!reasons.has('runtime_failed') && !reasons.has('runtime_attention'))
        return undefined;
    const activation = Object.values(state.activations)
        .filter((candidate) => candidate.agentId === agent.agentId && (candidate.state === 'failed' || candidate.state === 'indeterminate'))
        .sort((left, right) => activationSeq(left) - activationSeq(right))
        .at(-1);
    if (activation)
        return { sourceActivationId: activation.activationId };
    const startingInput = peerMailboxRecords(state)
        .filter((candidate) => candidate.recipientId === agent.agentId && isStartingInputEvent(state, candidate))
        .sort((left, right) => mailboxRecordSeq(left) - mailboxRecordSeq(right))
        .at(-1);
    return startingInput ? { traceId: startingInput.traceId, causationId: startingInput.eventId } : undefined;
}
function nearestOpenOwner(state, agent) {
    let parentId = agent.parentId;
    while (parentId) {
        const parent = state.agents[parentId];
        if (!parent)
            break;
        if (parent.lifecycle === 'open')
            return parent;
        parentId = parent.parentId;
    }
    return state.agents[state.root.rootId] ?? agent;
}
function healthFingerprint(health) {
    return `${health.level}:${health.reasons.join(',')}`;
}
export class SupervisionCoordinator {
    store;
    onDiagnostic;
    warningEscalationMs;
    episodes = new Map();
    unsubscribe;
    pending = false;
    running;
    closing = false;
    constructor(store, onDiagnostic, warningEscalationMs = DEFAULT_WARNING_ESCALATION_MS) {
        this.store = store;
        this.onDiagnostic = onDiagnostic;
        this.warningEscalationMs = warningEscalationMs;
        this.unsubscribe = store.onChange(() => this.schedule());
        this.schedule();
    }
    close() {
        this.closing = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        for (const episode of this.episodes.values())
            if (episode.timer)
                clearTimeout(episode.timer);
        this.episodes.clear();
    }
    async settled() {
        await this.running;
    }
    schedule() {
        if (this.closing)
            return;
        this.pending = true;
        if (this.running)
            return;
        this.running = this.scanLoop().finally(() => {
            this.running = undefined;
            if (this.pending)
                this.schedule();
        });
    }
    async scanLoop() {
        while (this.pending && !this.closing) {
            this.pending = false;
            const snapshot = this.store.snapshot();
            const activityIndex = buildActivityIndex(snapshot);
            for (const agent of Object.values(snapshot.agents)) {
                if (agent.lifecycle !== 'open') {
                    this.clearEpisode(agent.agentId);
                    continue;
                }
                const health = projectAgentHealth(snapshot, agent, activityIndex);
                if (health.level === 'ok') {
                    this.clearEpisode(agent.agentId);
                    continue;
                }
                const fingerprint = healthFingerprint(health);
                if (this.episodes.get(agent.agentId)?.fingerprint === fingerprint)
                    continue;
                this.clearEpisode(agent.agentId);
                const episode = {
                    fingerprint,
                    token: sha256(`${agentSeq(snapshot, agent)}:${fingerprint}`).slice(0, 24),
                };
                this.episodes.set(agent.agentId, episode);
                await this.publish(agent, health, episode.token);
                if (health.level === 'warning') {
                    episode.timer = setTimeout(() => {
                        void this.escalatePersistent(agent.agentId, fingerprint, episode.token).catch((error) => this.onDiagnostic(error instanceof Error ? error : new Error(String(error))));
                    }, this.warningEscalationMs);
                    episode.timer.unref();
                }
            }
        }
    }
    async publish(agent, health, token) {
        const snapshot = this.store.snapshot();
        const cause = healthCause(snapshot, agent, health);
        if (!cause)
            return;
        const owner = nearestOpenOwner(snapshot, agent);
        const mailbox = projectAgentMailbox(snapshot, agent.agentId);
        const detail = `${agent.displayName.value} health: ${health.summary}. Mailbox=${mailbox.count} events/${mailbox.bytes} bytes.`;
        await this.emit({
            dedupeKey: `health:${health.level}:${agent.agentId}:${token}`,
            type: health.level === 'critical' ? 'health_attention' : 'routine',
            senderId: agent.agentId,
            recipientId: owner.agentId,
            message: detail,
            wake: health.level === 'critical',
            ...cause,
        });
        if (owner.agentId !== snapshot.root.rootId)
            await this.emit({
                dedupeKey: `health:root-notice:${agent.agentId}:${token}`,
                type: 'routine',
                senderId: agent.agentId,
                recipientId: snapshot.root.rootId,
                message: detail,
                wake: false,
                ...cause,
            });
    }
    async escalatePersistent(agentId, fingerprint, token) {
        if (this.closing)
            return;
        const episode = this.episodes.get(agentId);
        if (!episode || episode.fingerprint !== fingerprint || episode.token !== token)
            return;
        episode.timer = undefined;
        const snapshot = this.store.snapshot();
        const agent = snapshot.agents[agentId];
        if (!agent || agent.lifecycle !== 'open')
            return;
        const health = projectAgentHealth(snapshot, agent);
        if (health.level !== 'warning' || healthFingerprint(health) !== fingerprint)
            return;
        const cause = healthCause(snapshot, agent, health);
        if (!cause)
            return;
        const owner = nearestOpenOwner(snapshot, agent);
        await this.emit({
            dedupeKey: `health:persistent:${agent.agentId}:${token}`,
            type: 'health_attention',
            senderId: agent.agentId,
            recipientId: owner.agentId,
            message: `${agent.displayName.value} has a persistent mechanical warning: ${health.summary}. Inspect before choosing any intervention.`,
            wake: true,
            ...cause,
        });
    }
    clearEpisode(agentId) {
        const episode = this.episodes.get(agentId);
        if (episode?.timer)
            clearTimeout(episode.timer);
        this.episodes.delete(agentId);
    }
    async emit(input) {
        try {
            await this.store.admitSystemEvent(input);
        }
        catch (error) {
            this.onDiagnostic(error instanceof Error ? error : new Error(String(error)));
        }
    }
}
