import { applyAssistantStreamEvent, eventIsAssistantStart } from "./assistant-stream.js";
import { projectConversationEvent, projectConversationMessages, } from "./command-center-projection.js";
import { SchedulerStateError } from "./scheduler-store.js";
import { deepFreeze, isRecord } from "./scheduler-state.js";
function requiresSessionReload(event) {
    return (isRecord(event) && (event.type === 'message_end' || event.type === 'agent_settled' || event.type === 'agent_end'));
}
function successfulCompaction(event) {
    if (!isRecord(event))
        return false;
    if (event.type === 'session_compact')
        return isRecord(event.compactionEntry);
    return event.type === 'compaction_end' && event.aborted === false && isRecord(event.result);
}
function assistantIdentity(value) {
    if (!isRecord(value) || value.role !== 'assistant')
        return undefined;
    if (typeof value.responseId === 'string' && value.responseId.length > 0)
        return `response:${value.responseId}`;
    return typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
        ? `timestamp:${value.timestamp}`
        : undefined;
}
/** Demand-driven private Pi conversation publication for selected collaborators only. */
export class AgentConversationStreams {
    options;
    channels = new Map();
    loads = new Set();
    revision = 0;
    closing = false;
    constructor(options) {
        this.options = options;
    }
    subscribe(agentId, listener) {
        if (this.closing)
            throw new Error('Collaborator conversations are closing');
        let channel = this.channels.get(agentId);
        const created = channel === undefined;
        if (!channel) {
            channel = {
                agentId,
                listeners: new Set(),
                messages: [],
                revision: this.nextRevision(),
                incarnation: 0,
                hydrated: false,
                dirty: false,
                pendingEvents: [],
            };
            this.channels.set(agentId, channel);
        }
        channel.listeners.add(listener);
        if (created) {
            this.bindChannelSource(channel, this.options.currentActor(agentId));
            this.reload(channel);
        }
        this.notifyOne(listener, this.reset(channel));
        return () => {
            const current = this.channels.get(agentId);
            if (!current || !current.listeners.delete(listener) || current.listeners.size)
                return;
            current.unsubscribeActor?.();
            current.unsubscribeRoot?.();
            this.channels.delete(agentId);
        };
    }
    snapshot(agentId) {
        const channel = this.channels.get(agentId);
        if (!channel)
            throw new SchedulerStateError('history_unavailable', `Collaborator '${agentId}' is not selected`);
        return this.reset(channel);
    }
    bindActor(actor) {
        const channel = this.channels.get(actor.agentId);
        if (!channel || channel.actor === actor)
            return;
        this.bindChannelSource(channel, actor);
        this.reload(channel);
    }
    reconcile() {
        if (this.closing)
            return;
        for (const channel of this.channels.values()) {
            if (channel.agentId === this.options.rootAgentId)
                continue;
            const actor = this.options.currentActor(channel.agentId);
            if (actor === channel.actor)
                continue;
            this.bindChannelSource(channel, actor);
            this.reload(channel);
        }
    }
    quiesce() {
        if (this.closing)
            return;
        this.closing = true;
        for (const channel of this.channels.values()) {
            channel.unsubscribeActor?.();
            channel.unsubscribeRoot?.();
            channel.listeners.clear();
        }
        this.channels.clear();
    }
    async close() {
        this.quiesce();
        await Promise.allSettled(this.loads);
        this.loads.clear();
    }
    bindChannelSource(channel, actor) {
        channel.unsubscribeActor?.();
        channel.unsubscribeRoot?.();
        channel.actor = actor;
        channel.incarnation++;
        channel.streamingMessage = undefined;
        channel.streamingAssistant = undefined;
        channel.pendingEvents = [];
        if (actor) {
            const subscription = actor.subscribeConversation((event) => this.sourceChanged(channel, event));
            channel.unsubscribeActor = subscription.unsubscribe;
            channel.pendingEvents.push(...subscription.snapshot);
        }
        else if (channel.agentId === this.options.rootAgentId && this.options.currentRootEvents) {
            const subscription = this.options.currentRootEvents((event) => this.sourceChanged(channel, event));
            channel.unsubscribeRoot = subscription.unsubscribe;
            channel.pendingEvents.push(...subscription.snapshot);
        }
    }
    sourceChanged(channel, event) {
        if (this.closing || this.channels.get(channel.agentId) !== channel)
            return;
        if (successfulCompaction(event)) {
            this.reload(channel);
            return;
        }
        if (!channel.hydrated || channel.loading) {
            channel.pendingEvents.push(event);
            if (requiresSessionReload(event)) {
                channel.dirty = true;
                if (!channel.loading)
                    this.reload(channel);
            }
            return;
        }
        this.applyEvent(channel, event);
    }
    applyEvent(channel, event, publish = true) {
        const assistant = applyAssistantStreamEvent(channel.streamingAssistant, event);
        channel.streamingAssistant = assistant.state;
        if (eventIsAssistantStart(event))
            return;
        const projectedEvent = assistant.message
            ? { ...(isRecord(event) ? event : {}), message: assistant.message }
            : event;
        const projected = projectConversationEvent(projectedEvent, channel.projectionState ?? this.options.store.snapshot(), channel.agentId);
        if (!projected.length || !isRecord(projectedEvent) || typeof projectedEvent.type !== 'string')
            return;
        const previous = channel.messages;
        let next = [...previous];
        let start = next.length;
        if ((projectedEvent.type === 'message_update' || projectedEvent.type === 'message_end') &&
            isRecord(projectedEvent.message)) {
            if (projectedEvent.message.role === 'assistant') {
                const identity = assistantIdentity(projectedEvent.message);
                const authoritativeIndex = identity
                    ? next.findIndex((message, index) => index !== channel.streamingMessage && assistantIdentity(message) === identity)
                    : -1;
                if (authoritativeIndex >= 0) {
                    channel.streamingAssistant = undefined;
                    if (channel.streamingMessage === undefined)
                        return;
                    start = channel.streamingMessage;
                    next.splice(start, 1);
                    channel.streamingMessage = undefined;
                    if (!publish) {
                        channel.messages = next;
                        return;
                    }
                    this.publishSplice(channel, start, 1, next);
                    return;
                }
                start = channel.streamingMessage ?? next.length;
                next.splice(start, channel.streamingMessage === undefined ? 0 : 1, ...projected);
                channel.streamingMessage = assistant.finished ? undefined : start;
            }
            else if (projectedEvent.message.role === 'toolResult' &&
                typeof projectedEvent.message.toolCallId === 'string') {
                start = this.replaceToolResult(next, projectedEvent.message.toolCallId, projected);
            }
            else
                next.push(...projected);
        }
        else if (typeof projectedEvent.toolCallId === 'string') {
            start = this.replaceToolResult(next, projectedEvent.toolCallId, projected);
        }
        else
            return;
        if (!publish) {
            channel.messages = next;
            return;
        }
        this.publishSplice(channel, start, previous.length - start, next);
    }
    replaceToolResult(messages, toolCallId, replacement) {
        const first = messages.findIndex((message) => message.role === 'toolResult' && message.toolCallId === toolCallId);
        if (first < 0) {
            const start = messages.length;
            messages.push(...replacement);
            return start;
        }
        const suffix = messages
            .slice(first + 1)
            .filter((message) => message.role !== 'toolResult' || message.toolCallId !== toolCallId);
        messages.splice(first, messages.length - first, ...replacement, ...suffix);
        return first;
    }
    reload(channel) {
        if (this.closing || this.channels.get(channel.agentId) !== channel)
            return;
        if (channel.loading) {
            channel.dirty = true;
            return;
        }
        channel.dirty = false;
        const loading = this.load(channel).finally(() => {
            this.loads.delete(loading);
            if (this.channels.get(channel.agentId) !== channel)
                return;
            channel.loading = undefined;
            if (channel.dirty)
                this.reload(channel);
        });
        channel.loading = loading;
        this.loads.add(loading);
        void loading.catch(this.options.onDiagnostic);
    }
    async load(channel) {
        const incarnation = channel.incarnation;
        try {
            if (!this.options.readSession)
                throw new SchedulerStateError('history_unavailable', `Collaborator '${channel.agentId}' has no conversation to open`);
            const history = await this.options.readSession(channel.agentId);
            if (this.closing || !this.options.running() || this.channels.get(channel.agentId) !== channel)
                return;
            if (channel.dirty || channel.incarnation !== incarnation) {
                channel.dirty = true;
                return;
            }
            channel.projectionState = history.state;
            channel.messages = projectConversationMessages(history.messages, history.state ?? this.options.store.snapshot(), channel.agentId);
            channel.streamingMessage = undefined;
            channel.streamingAssistant = undefined;
            for (const event of channel.pendingEvents)
                this.applyEvent(channel, event, false);
            channel.pendingEvents = [];
            channel.hydrated = true;
            channel.error = undefined;
            this.publishReset(channel);
        }
        catch (error) {
            if (this.closing || this.channels.get(channel.agentId) !== channel)
                return;
            channel.messages = [];
            channel.projectionState = undefined;
            channel.streamingMessage = undefined;
            channel.streamingAssistant = undefined;
            channel.hydrated = false;
            channel.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
            this.publishReset(channel);
        }
    }
    publishReset(channel) {
        channel.revision = this.nextRevision();
        this.notify(channel, this.reset(channel));
    }
    publishSplice(channel, start, deleteCount, messages) {
        const baseRevision = channel.revision;
        channel.messages = messages;
        channel.revision = this.nextRevision();
        this.notify(channel, deepFreeze({
            type: 'splice',
            epoch: this.options.epoch,
            agentId: channel.agentId,
            incarnation: channel.incarnation,
            revision: channel.revision,
            baseRevision,
            start,
            deleteCount,
            messages: messages.slice(start),
        }));
    }
    reset(channel) {
        return deepFreeze({
            type: 'reset',
            epoch: this.options.epoch,
            agentId: channel.agentId,
            incarnation: channel.incarnation,
            revision: channel.revision,
            hydrated: channel.hydrated,
            messages: [...channel.messages],
            ...(channel.error ? { error: channel.error } : {}),
        });
    }
    notify(channel, update) {
        for (const listener of channel.listeners)
            this.notifyOne(listener, update);
    }
    notifyOne(listener, update) {
        try {
            listener(update);
        }
        catch (error) {
            this.options.onDiagnostic(error);
        }
    }
    nextRevision() {
        return ++this.revision;
    }
}
