import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { capabilityAllowsCwd, defaultCapabilityEnvelope, normalizeCapabilityEnvelope, } from "./capability-policy.js";
import { hasUnsafeHumanFacingControl, isLuminariesId } from "./identifiers.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
export { isLuminariesId, isLowercaseSha256, isPiSessionId } from "./identifiers.js";
const FORBIDDEN_MAP_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SERVICE_PERMISSIONS = new Set([
    'spawn',
    'directory',
    'message',
    'watch',
    'steer',
    'follow_up',
    'interrupt',
    'close',
    'close_subtree',
    'resume',
    'set_model',
    'set_thinking',
    'set_extensions',
    'set_grants',
]);
const PEER_EVENT_STATUSES = new Set([
    'accepted',
    'sending',
    'consumed',
    'settled',
    'aborted',
    'refused',
    'failed',
    'indeterminate',
]);
const REQUEST_STATES = new Set([
    'pending',
    'replied',
    'refused',
    'cancelled',
    'delivery_failed',
    'delivery_indeterminate',
    'timed_out',
]);
export const DIRECT_CONTROL_STATES = new Set(['accepted', 'sending', 'aborted', 'refused', 'failed', 'indeterminate']);
export const TERMINAL_DIRECT_CONTROL_STATES = new Set(['aborted', 'refused', 'failed', 'indeterminate']);
export const TERMINAL_PEER_EVENT_STATUSES = new Set(['settled', 'aborted', 'refused', 'failed', 'indeterminate']);
export function isPeerEventStatus(value) {
    return typeof value === 'string' && PEER_EVENT_STATUSES.has(value);
}
export function isCorrelatedRequestStatus(value) {
    return typeof value === 'string' && REQUEST_STATES.has(value);
}
export function isPeerMailboxRecord(record) {
    return record !== undefined && record.lane !== 'direct';
}
export function isDirectMailboxRecord(record) {
    return record?.lane === 'direct';
}
export function peerMailboxRecords(state) {
    return Object.values(state.mailbox).filter(isPeerMailboxRecord);
}
export function directMailboxRecords(state) {
    return Object.values(state.mailbox).filter(isDirectMailboxRecord);
}
export function buildActivityIndex(state) {
    const index = {
        peerByRecipient: new Map(),
        peerBySender: new Map(),
        directByTarget: new Map(),
        activationsByAgent: new Map(),
    };
    for (const record of Object.values(state.mailbox)) {
        if (isDirectMailboxRecord(record)) {
            const controls = index.directByTarget.get(record.targetId);
            if (controls)
                controls.push(record);
            else
                index.directByTarget.set(record.targetId, [record]);
            continue;
        }
        const sent = index.peerBySender.get(record.senderId);
        if (sent)
            sent.push(record);
        else
            index.peerBySender.set(record.senderId, [record]);
        const received = index.peerByRecipient.get(record.recipientId);
        if (received)
            received.push(record);
        else
            index.peerByRecipient.set(record.recipientId, [record]);
    }
    for (const activation of Object.values(state.activations)) {
        const activations = index.activationsByAgent.get(activation.agentId);
        if (activations)
            activations.push(activation);
        else
            index.activationsByAgent.set(activation.agentId, [activation]);
    }
    return index;
}
export function mailboxActivationIds(state) {
    const activationIds = new Set();
    for (const record of Object.values(state.mailbox)) {
        if (record.activationId)
            activationIds.add(record.activationId);
        if (record.lane === 'direct')
            continue;
        if (record.sourceActivationId)
            activationIds.add(record.sourceActivationId);
        if (record.targetActivationId)
            activationIds.add(record.targetActivationId);
    }
    for (const watch of Object.values(state.watches))
        if (watch.registeringActivationId)
            activationIds.add(watch.registeringActivationId);
    return activationIds;
}
export function peerMailboxRecord(state, eventId) {
    const record = state.mailbox[eventId];
    return isPeerMailboxRecord(record) ? record : undefined;
}
export function isStartingInputEvent(state, event) {
    const recipient = state.agents[event.recipientId];
    return (recipient?.spawnHash !== undefined &&
        recipient.parentId === event.senderId &&
        event.kind === 'message' &&
        event.mode === 'default' &&
        event.acceptedSeq === recipient.createdSeq + 1);
}
export function directMailboxRecord(state, controlId) {
    const record = state.mailbox[controlId];
    return isDirectMailboxRecord(record) ? record : undefined;
}
export function openCollaboratorCount(state) {
    return Object.values(state.agents).filter((agent) => agent.parentId !== null && agent.lifecycle === 'open').length;
}
export function agentDepth(state, agentId) {
    let depth = 0;
    let current = state.agents[agentId];
    const seen = new Set();
    while (current?.parentId) {
        if (seen.has(current.agentId))
            throw new SchedulerStateError('state_invalid', `Agent '${agentId}' has cyclic lineage`);
        seen.add(current.agentId);
        depth++;
        current = state.agents[current.parentId];
    }
    if (!current || current.agentId !== state.root.rootId)
        throw new SchedulerStateError('state_invalid', `Agent '${agentId}' is outside the root lineage`);
    return depth;
}
export function agentPath(state, agentId) {
    const segments = [];
    let current = state.agents[agentId];
    const seen = new Set();
    while (current) {
        if (seen.has(current.agentId))
            throw new SchedulerStateError('state_invalid', `Agent '${agentId}' has cyclic lineage`);
        seen.add(current.agentId);
        segments.push(current.segment);
        if (!current.parentId)
            break;
        current = state.agents[current.parentId];
    }
    if (!current || current.agentId !== state.root.rootId)
        throw new SchedulerStateError('state_invalid', `Agent '${agentId}' is outside the root lineage`);
    return segments.reverse().join('/');
}
export function mailboxRecordSeq(record) {
    return record.terminalSeq ?? record.consumedSeq ?? record.attemptSeq ?? record.acceptedSeq;
}
export function activationSeq(activation) {
    return activation.terminalSeq ?? activation.startedSeq;
}
export function requestStatus(state, request) {
    const requestEvent = peerMailboxRecord(state, request.requestEventId);
    if (!requestEvent)
        return 'delivery_indeterminate';
    if (!request.terminalEventId) {
        if (requestEvent.status === 'refused')
            return 'refused';
        if (requestEvent.status === 'aborted' || requestEvent.status === 'failed')
            return 'delivery_failed';
        if (requestEvent.status === 'indeterminate')
            return 'delivery_indeterminate';
        return 'pending';
    }
    const terminal = peerMailboxRecord(state, request.terminalEventId);
    if (!terminal)
        return 'delivery_indeterminate';
    if (terminal.kind === 'cancel')
        return 'cancelled';
    if (terminal.kind === 'reply') {
        if (terminal.consumedSeq !== undefined || terminal.status === 'settled')
            return 'replied';
        if (terminal.status === 'indeterminate')
            return 'delivery_indeterminate';
        if (terminal.status === 'failed' || terminal.status === 'refused')
            return 'delivery_failed';
        return 'pending';
    }
    if (terminal.kind === 'resolution') {
        if (terminal.resolutionCode === 'request_timeout')
            return 'timed_out';
        if (terminal.resolutionCode === 'request_dispatch_indeterminate' || terminal.status === 'indeterminate')
            return 'delivery_indeterminate';
        return 'delivery_failed';
    }
    return 'delivery_indeterminate';
}
export function requestSeq(state, request) {
    const terminal = request.terminalEventId ? peerMailboxRecord(state, request.terminalEventId) : undefined;
    return terminal ? mailboxRecordSeq(terminal) : request.createdSeq;
}
export function watchSeq(watch) {
    return watch.terminalSeq ?? watch.createdSeq;
}
export function agentRuntimePhase(state, agent) {
    const running = Object.values(state.activations).some((activation) => activation.agentId === agent.agentId && activation.state === 'running');
    if (running)
        return 'running';
    if (agent.parentId !== null && !agent.sessionFile)
        return 'starting';
    if (agent.runtimeOwner && agent.runtimePhase === 'starting')
        return 'starting';
    const waiting = Object.values(state.requests).some((request) => request.requesterId === agent.agentId && requestStatus(state, request) === 'pending') || Object.values(state.watches).some((watch) => watch.ownerId === agent.agentId && watch.status === 'active');
    if (waiting)
        return 'waiting';
    if (agent.parentId !== null && !agent.runtimeOwner)
        return 'runtime_parked';
    return 'idle';
}
export function canContinuePastIndeterminate(state, agentId, additionalRecords = []) {
    const agent = state.agents[agentId];
    if (!agent || agent.lifecycle !== 'open' || agent.attention?.kind !== 'needs_attention')
        return false;
    const activationId = indeterminateContinuationActivationId(state, agentId);
    if (!activationId)
        return false;
    const boundary = agent.continuedAfterSeq ?? 0;
    return [...Object.values(state.mailbox), ...additionalRecords].some((record) => isContinuableIndeterminateEvidence(record, agentId, boundary, activationId));
}
export function indeterminateContinuationActivationId(state, agentId) {
    const attention = state.agents[agentId]?.attention;
    if (attention?.kind !== 'needs_attention' || attention.code !== 'activation_indeterminate')
        return undefined;
    return Object.values(state.activations).find((activation) => activation.agentId === agentId &&
        activation.state === 'indeterminate' &&
        activation.terminalSeq === attention.seq)?.activationId;
}
export function isContinuableIndeterminateEvidence(record, agentId, boundary, activationId) {
    if (record.status !== 'indeterminate' || mailboxRecordSeq(record) <= boundary)
        return false;
    const targetsAgent = record.lane === 'direct' ? record.targetId === agentId : record.recipientId === agentId;
    return targetsAgent && (activationId === undefined || record.activationId === activationId);
}
export function agentRuntimeState(state, agent) {
    return agent.attention?.kind ?? agentRuntimePhase(state, agent);
}
export function agentSeq(state, agent) {
    let result = Math.max(agent.createdSeq, agent.closedSeq ?? 0, agent.archive?.seq ?? 0, agent.runtimeSeq ?? 0, agent.attention?.seq ?? 0, agent.continuedAfterSeq ?? 0, agent.pendingConfiguration?.createdSeq ?? 0);
    for (const activation of Object.values(state.activations))
        if (activation.agentId === agent.agentId)
            result = Math.max(result, activationSeq(activation));
    for (const record of Object.values(state.mailbox)) {
        const related = record.lane === 'direct'
            ? record.targetId === agent.agentId
            : record.senderId === agent.agentId || record.recipientId === agent.agentId;
        if (related)
            result = Math.max(result, mailboxRecordSeq(record));
    }
    return result;
}
export function projectAgentMailbox(state, agentId) {
    const events = Object.values(state.mailbox).filter((record) => record.lane !== 'direct' &&
        record.recipientId === agentId &&
        record.consumedSeq === undefined &&
        !TERMINAL_PEER_EVENT_STATUSES.has(record.status));
    return {
        count: events.length,
        bytes: events.reduce((total, event) => total + Buffer.byteLength(event.message ?? ''), 0),
    };
}
export class SchedulerStateError extends Error {
    code;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'SchedulerStateError';
        this.code = code;
    }
}
export function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function normalizeAgentLaunch(value, label = 'agent launch') {
    if (!isRecord(value))
        throw new SchedulerStateError('state_invalid', `${label} must be an object`);
    exactKeys(value, [
        'noContextFiles',
        'restrictSkills',
        'restrictPromptTemplates',
        'restrictThemes',
        'systemPrompt',
        'extensionSources',
        'extensions',
        'skills',
        'promptTemplates',
        'themes',
    ], label);
    if (typeof value.noContextFiles !== 'boolean' ||
        typeof value.restrictSkills !== 'boolean' ||
        typeof value.restrictPromptTemplates !== 'boolean' ||
        typeof value.restrictThemes !== 'boolean')
        throw new SchedulerStateError('state_invalid', `${label} isolation fields must be boolean`);
    const extensions = textList(value.extensions, `${label}.extensions`, 4096).map((path, index) => absolutePath(path, `${label}.extensions[${index}]`));
    const extensionSources = value.extensionSources === undefined
        ? undefined
        : textList(value.extensionSources, `${label}.extensionSources`, 4096);
    if (extensionSources?.some((source) => hasUnsafeHumanFacingControl(source)))
        throw new SchedulerStateError('state_invalid', `${label}.extensionSources contains a presentation control`);
    const skills = textList(value.skills, `${label}.skills`, 4096).map((path, index) => absolutePath(path, `${label}.skills[${index}]`));
    const promptTemplates = textList(value.promptTemplates, `${label}.promptTemplates`, 4096).map((path, index) => absolutePath(path, `${label}.promptTemplates[${index}]`));
    const themes = textList(value.themes, `${label}.themes`, 4096).map((path, index) => absolutePath(path, `${label}.themes[${index}]`));
    return {
        noContextFiles: value.noContextFiles,
        restrictSkills: value.restrictSkills,
        restrictPromptTemplates: value.restrictPromptTemplates,
        restrictThemes: value.restrictThemes,
        ...(value.systemPrompt === undefined
            ? {}
            : { systemPrompt: nonemptyText(value.systemPrompt, `${label}.systemPrompt`) }),
        ...(extensionSources === undefined ? {} : { extensionSources }),
        extensions,
        skills,
        promptTemplates,
        themes,
    };
}
export function normalizeAgentContext(value, label = 'agent context') {
    if (!isRecord(value))
        throw new SchedulerStateError('state_invalid', `${label} must be an object`);
    exactKeys(value, [
        'mode',
        'requestedTokens',
        'effectiveTokens',
        'estimatedTokens',
        'transferredMessages',
        'omittedMessages',
        'targetContextWindow',
        'warning',
    ], label);
    if (value.mode !== 'fresh' && value.mode !== 'recent' && value.mode !== 'fork' && value.mode !== 'custom')
        throw new SchedulerStateError('state_invalid', `${label}.mode is invalid`);
    const result = {
        mode: value.mode,
        effectiveTokens: integer(value.effectiveTokens, 0, Number.MAX_SAFE_INTEGER, `${label}.effectiveTokens`),
        estimatedTokens: integer(value.estimatedTokens, 0, Number.MAX_SAFE_INTEGER, `${label}.estimatedTokens`),
        transferredMessages: integer(value.transferredMessages, 0, Number.MAX_SAFE_INTEGER, `${label}.transferredMessages`),
        omittedMessages: integer(value.omittedMessages, 0, Number.MAX_SAFE_INTEGER, `${label}.omittedMessages`),
        ...(value.requestedTokens === undefined
            ? {}
            : { requestedTokens: integer(value.requestedTokens, 1, Number.MAX_SAFE_INTEGER, `${label}.requestedTokens`) }),
        ...(value.targetContextWindow === undefined
            ? {}
            : {
                targetContextWindow: integer(value.targetContextWindow, 1, Number.MAX_SAFE_INTEGER, `${label}.targetContextWindow`),
            }),
        ...(value.warning === undefined ? {} : { warning: nonemptyText(value.warning, `${label}.warning`) }),
    };
    if ((result.mode === 'fresh' || result.mode === 'custom') &&
        (result.estimatedTokens !== 0 || result.transferredMessages !== 0))
        throw new SchedulerStateError('state_invalid', `${label} transfers history in ${result.mode} mode`);
    return result;
}
export function exactKeys(value, allowed, label) {
    const expected = new Set(allowed);
    for (const key of Object.keys(value))
        if (!expected.has(key))
            throw new SchedulerStateError('state_invalid', `${label} contains unknown field '${key}'`);
}
export function integer(value, minimum, maximum, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new SchedulerStateError('state_invalid', `${label} is outside its integer bound`);
    return value;
}
export function text(value, label, maximum = 256) {
    if (typeof value !== 'string' || value.length < 1 || value.length > maximum)
        throw new SchedulerStateError('state_invalid', `${label} is outside its string bound`);
    return value;
}
export function nonemptyText(value, label) {
    if (typeof value !== 'string' || value.length < 1)
        throw new SchedulerStateError('state_invalid', `${label} must be a nonempty string`);
    return value;
}
export function id(value, label) {
    const result = text(value, label, 64);
    if (!isLuminariesId(result) ||
        FORBIDDEN_MAP_KEYS.has(result) ||
        Object.prototype.hasOwnProperty.call(Object.prototype, result))
        throw new SchedulerStateError('state_invalid', `${label} is invalid`);
    return result;
}
export function within(child, parent) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
}
export function absolutePath(value, label) {
    const result = text(value, label, 4096);
    if (result.includes('\0'))
        throw new SchedulerStateError('state_invalid', `${label} contains a NUL byte`);
    if (!isAbsolute(result))
        throw new SchedulerStateError('state_invalid', `${label} must be absolute`);
    return resolve(result);
}
export function optionalText(value, label, maximum) {
    if (value === undefined)
        return undefined;
    return maximum === undefined ? nonemptyText(value, label) : text(value, label, maximum);
}
export function textList(value, label, itemMaximum) {
    if (!Array.isArray(value))
        throw new SchedulerStateError('state_invalid', `${label} must be a list`);
    const result = value.map((item, index) => text(item, `${label}[${index}]`, itemMaximum));
    if (new Set(result).size !== result.length)
        throw new SchedulerStateError('state_invalid', `${label} contains duplicates`);
    return result;
}
export function humanFacingText(value, label, maximum) {
    const result = maximum === undefined ? nonemptyText(value, label) : text(value, label, maximum);
    if (hasUnsafeHumanFacingControl(result))
        throw new SchedulerStateError('state_invalid', `${label} contains a presentation control`);
    return result;
}
export function humanFacingProse(value, label, maximum) {
    const result = maximum === undefined ? nonemptyText(value, label) : text(value, label, maximum);
    for (let index = 0; index < result.length; index++) {
        const character = result[index];
        if (character === '\n' || character === '\t' || (character === '\r' && result[index + 1] === '\n'))
            continue;
        if (character && hasUnsafeHumanFacingControl(character))
            throw new SchedulerStateError('state_invalid', `${label} contains a presentation control`);
    }
    return result;
}
export function humanFacingTextList(value, label, itemMaximum) {
    if (!Array.isArray(value))
        throw new SchedulerStateError('state_invalid', `${label} must be a list`);
    const result = value.map((item, index) => humanFacingText(item, `${label}[${index}]`, itemMaximum));
    if (new Set(result).size !== result.length)
        throw new SchedulerStateError('state_invalid', `${label} contains duplicates`);
    if (result.some(hasUnsafeHumanFacingControl))
        throw new SchedulerStateError('state_invalid', `${label} contains a presentation control`);
    return result;
}
function agentNameList(value, label) {
    if (!Array.isArray(value) || value.length === 0)
        throw new SchedulerStateError('state_invalid', `${label} must be a non-empty list`);
    return value.map((item, index) => {
        const name = humanFacingText(item, `${label}[${index}]`);
        if (!name.trim())
            throw new SchedulerStateError('state_invalid', `${label}[${index}] is empty`);
        return name;
    });
}
export function idList(value, label) {
    if (!Array.isArray(value))
        throw new SchedulerStateError('state_invalid', `${label} must be a list`);
    const result = value.map((item, index) => id(item, `${label}[${index}]`));
    if (new Set(result).size !== result.length)
        throw new SchedulerStateError('state_invalid', `${label} contains duplicates`);
    return result;
}
export function normalizePrincipal(value) {
    if (!isRecord(value))
        throw new SchedulerStateError('input_invalid', 'Scheduler principal must be an object');
    if (value.kind === 'operator') {
        exactKeys(value, ['kind'], 'scheduler principal');
        return { kind: 'operator' };
    }
    if (value.kind === 'agent') {
        exactKeys(value, ['kind', 'agentId'], 'scheduler principal');
        return { kind: 'agent', agentId: id(value.agentId, 'principal.agentId') };
    }
    throw new SchedulerStateError('input_invalid', 'Scheduler principal kind is invalid');
}
export function isStrictAncestor(state, candidateId, targetId) {
    let current = state.agents[targetId];
    while (current?.parentId) {
        if (current.parentId === candidateId)
            return true;
        current = state.agents[current.parentId];
    }
    return false;
}
export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Reflect.ownKeys(value))
            deepFreeze(Reflect.get(value, key));
    }
    return value;
}
export function nextSequence(state) {
    const seq = state.nextSeq++;
    state.revision++;
    state.updatedAtMs = Date.now();
    return seq;
}
export function startActivationState(state, agentId, inputKind) {
    const agent = state.agents[agentId];
    if (!agent || agent.lifecycle !== 'open')
        throw new SchedulerStateError('agent_unavailable', `Agent '${agentId}' is not open`);
    if (agent.attention)
        throw new SchedulerStateError('recovery_required', `Agent '${agentId}' requires explicit recovery before activation`);
    if (agent.parentId !== null && (!agent.runtimeOwner || agent.runtimePhase !== 'ready'))
        throw new SchedulerStateError('runtime_unavailable', `Agent '${agentId}' has no ready runtime`);
    if (Object.values(state.activations).some((candidate) => candidate.agentId === agentId && candidate.state === 'running'))
        throw new SchedulerStateError('writer_busy', `Agent '${agentId}' already has a live activation`);
    const activationId = randomUUID();
    const startedSeq = nextSequence(state);
    const activation = {
        activationId,
        agentId,
        leaseToken: randomUUID(),
        state: 'running',
        inputKind: text(inputKind, 'activation input kind', 32),
        startedSeq,
    };
    state.activations[activationId] = activation;
    return { changed: true, value: activation };
}
export function discardActivationBeforeWriteState(state, activationId, leaseToken) {
    const activation = state.activations[activationId];
    assertActivationLease(activation, leaseToken);
    if (activation.state !== 'running')
        return { changed: false, value: activation };
    const consumed = peerMailboxRecords(state).some((event) => event.activationId === activationId && event.consumedSeq !== undefined);
    if (consumed)
        throw new SchedulerStateError('activation_transition', `Activation '${activationId}' crossed a model boundary and cannot be discarded`);
    delete state.activations[activationId];
    nextSequence(state);
    return { changed: true, value: activation };
}
export function finishActivationState(state, activationId, leaseToken, outcome) {
    const activation = state.activations[activationId];
    assertActivationLease(activation, leaseToken);
    if (activation.state !== 'running') {
        if (activation.state === outcome)
            return { changed: false, value: activation };
        throw new SchedulerStateError('activation_transition', `Activation '${activationId}' has immutable terminal outcome ${activation.state}`);
    }
    const seq = nextSequence(state);
    activation.state = outcome;
    activation.terminalSeq = seq;
    const agent = state.agents[activation.agentId];
    if (outcome === 'failed')
        agent.attention = { kind: 'failed', code: 'activation_failed', seq };
    else if (outcome === 'indeterminate')
        agent.attention = { kind: 'needs_attention', code: 'activation_indeterminate', seq };
    return { changed: true, value: activation };
}
export function assertActivationLease(activation, leaseToken) {
    if (!activation)
        throw new SchedulerStateError('activation_missing', 'Activation does not exist');
    if (activation.leaseToken !== leaseToken)
        throw new SchedulerStateError('activation_lease', `Activation '${activation.activationId}' lease token is invalid`);
}
export function mailboxRecordId(record) {
    return record.lane === 'direct' ? record.controlId : record.eventId;
}
export function beginMailboxAttemptState(state, records, input) {
    if (!records.length)
        throw new SchedulerStateError('state_invalid', 'Mailbox attempt has no records');
    for (const record of records)
        if (record.status !== 'accepted')
            throw new SchedulerStateError('mailbox_transition', `Mailbox record '${mailboxRecordId(record)}' cannot send from ${record.status}`);
    const seq = nextSequence(state);
    for (const record of records) {
        record.status = 'sending';
        record.attemptId = input.attemptId;
        record.activationId = input.activationId;
        if (record.lane === 'direct') {
            if (input.deliveryKind !== 'interrupt')
                throw new SchedulerStateError('mailbox_transition', 'Direct mailbox attempt must be an interrupt');
            record.deliveryKind = 'interrupt';
        }
        else {
            if (input.deliveryKind === 'interrupt')
                throw new SchedulerStateError('mailbox_transition', 'Routed mailbox attempt cannot be an interrupt');
            record.deliveryKind = input.deliveryKind;
        }
        record.attemptSeq = seq;
    }
    return seq;
}
export function releaseMailboxAttemptState(state, records, attemptId) {
    const selected = records.filter((record) => record.attemptId === attemptId && record.status === 'sending');
    if (!selected.length)
        return { changed: false, value: [] };
    nextSequence(state);
    for (const record of selected) {
        record.status = 'accepted';
        delete record.attemptId;
        delete record.activationId;
        delete record.deliveryKind;
        delete record.attemptSeq;
        delete record.consumedSeq;
    }
    return { changed: true, value: selected };
}
export function consumeMailboxAtBoundaryState(state, records, attemptId) {
    const selected = records.filter((record) => record.attemptId === attemptId);
    if (!selected.length)
        throw new SchedulerStateError('mailbox_transition', `Mailbox attempt '${attemptId}' does not exist`);
    if (selected.every((record) => record.consumedSeq !== undefined))
        return { changed: false, value: selected };
    if (selected.some((record) => record.status !== 'sending' || record.consumedSeq !== undefined))
        throw new SchedulerStateError('mailbox_transition', `Mailbox attempt '${attemptId}' has partial consumption`);
    const seq = nextSequence(state);
    for (const record of selected) {
        record.consumedSeq = seq;
        if (record.lane === 'direct') {
            record.status = 'aborted';
            record.terminalSeq = seq;
            record.outcomeCode = 'turn_interrupted';
        }
        else
            record.status = 'consumed';
    }
    return { changed: true, value: selected };
}
export function terminalizeMailboxRecordState(state, record, status, code) {
    const terminal = record.lane === 'direct'
        ? TERMINAL_DIRECT_CONTROL_STATES.has(record.status)
        : TERMINAL_PEER_EVENT_STATUSES.has(record.status);
    if (terminal) {
        if (record.status === status && record.outcomeCode === code)
            return { changed: false, value: record };
        throw new SchedulerStateError('mailbox_transition', `Mailbox record '${mailboxRecordId(record)}' has immutable terminal outcome ${record.status}`);
    }
    if (record.lane === 'direct' && status === 'settled')
        throw new SchedulerStateError('mailbox_transition', 'Direct interrupt cannot settle as a message');
    const seq = nextSequence(state);
    if (record.lane === 'direct') {
        if (status === 'settled')
            throw new SchedulerStateError('mailbox_transition', 'Direct interrupt cannot settle as a message');
        record.status = status;
    }
    else
        record.status = status;
    record.terminalSeq = seq;
    record.outcomeCode = text(code, 'mailbox outcome code', 96);
    return { changed: true, value: record };
}
function pathIdentity(path) {
    const normalized = resolve(path);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function pathsOverlap(left, right) {
    return within(left, right) || within(right, left);
}
export function assertSessionNamespaceAvailable(state, sessionDir, sessionId, excludeAgentId) {
    for (const agent of Object.values(state.agents)) {
        if (agent.agentId === excludeAgentId || !agent.sessionDir)
            continue;
        if (pathsOverlap(sessionDir, agent.sessionDir))
            throw new SchedulerStateError('session_conflict', `Private session namespace overlaps agent '${agent.agentId}'`);
        if (pathIdentity(sessionDir) === pathIdentity(agent.sessionDir) && sessionId === agent.sessionId)
            throw new SchedulerStateError('session_conflict', `Private session identity is already owned by agent '${agent.agentId}'`);
    }
}
export function assertSessionFileAvailable(state, sessionFile, excludeAgentId) {
    const candidate = pathIdentity(sessionFile);
    for (const agent of Object.values(state.agents))
        if (agent.agentId !== excludeAgentId && agent.sessionFile && pathIdentity(agent.sessionFile) === candidate)
            throw new SchedulerStateError('session_conflict', `Private session file is already owned by agent '${agent.agentId}'`);
}
export function referenceTargetsPrivateState(reference, state, cwd, statePath, extraSessionDir) {
    if (reference.includes('\0'))
        return true;
    const candidate = resolve(cwd, reference);
    if (statePath && within(candidate, dirname(resolve(statePath))))
        return true;
    const sessionDirs = [
        ...Object.values(state.agents)
            .map((agent) => agent.sessionDir)
            .filter((value) => !!value),
        ...(extraSessionDir ? [extraSessionDir] : []),
    ];
    return sessionDirs.some((directory) => within(candidate, directory));
}
function rootExtensionSettings(value) {
    if (!isRecord(value))
        throw new SchedulerStateError('input_invalid', 'agentExtensions must be an object');
    const result = {};
    for (const [specifier, setting] of Object.entries(value)) {
        if (!specifier || FORBIDDEN_MAP_KEYS.has(specifier) || hasUnsafeHumanFacingControl(specifier))
            throw new SchedulerStateError('input_invalid', 'agentExtensions contains an invalid specifier');
        if (setting !== 'always' && setting !== 'allow' && setting !== 'deny')
            throw new SchedulerStateError('input_invalid', `agentExtensions '${specifier}' is invalid`);
        result[specifier] = setting;
    }
    return result;
}
function rootServiceGrant(value) {
    if (!Array.isArray(value))
        throw new SchedulerStateError('input_invalid', 'serviceGrant must be a list');
    const result = value.map((permission) => {
        if (typeof permission !== 'string' || !SERVICE_PERMISSIONS.has(permission))
            throw new SchedulerStateError('input_invalid', `serviceGrant contains '${String(permission)}'`);
        return permission;
    });
    if (new Set(result).size !== result.length)
        throw new SchedulerStateError('input_invalid', 'serviceGrant contains duplicates');
    return result;
}
export function bootstrapState(input) {
    const rootId = id(input.rootId, 'bootstrap.rootId');
    const cwd = absolutePath(input.cwd, 'bootstrap.cwd');
    const maxOpenAgents = integer(input.maxOpenAgents ?? 10, 1, Number.MAX_SAFE_INTEGER, 'bootstrap.maxOpenAgents');
    const maxDepth = integer(input.maxDepth ?? 1, 1, Number.MAX_SAFE_INTEGER, 'bootstrap.maxDepth');
    let agentNames;
    try {
        agentNames = input.agentNames === undefined ? undefined : agentNameList(input.agentNames, 'bootstrap.agentNames');
    }
    catch (error) {
        throw new SchedulerStateError('input_invalid', 'Bootstrap agentNames is invalid', { cause: error });
    }
    const now = Date.now();
    const agentExtensions = rootExtensionSettings(input.agentExtensions ?? {});
    const serviceGrant = rootServiceGrant(input.serviceGrant ?? []);
    let capabilities;
    try {
        const requestedCapabilities = normalizeCapabilityEnvelope(input.capabilities ?? defaultCapabilityEnvelope(cwd, maxDepth));
        if (requestedCapabilities.maxDepth < maxDepth)
            throw new SchedulerStateError('input_invalid', 'Root capabilities are below configured maxDepth');
        capabilities = normalizeCapabilityEnvelope({ ...requestedCapabilities, maxDepth });
    }
    catch (error) {
        throw new SchedulerStateError('input_invalid', 'Bootstrap containment policy is invalid', { cause: error });
    }
    if (!capabilityAllowsCwd(capabilities, cwd))
        throw new SchedulerStateError('input_invalid', 'Bootstrap capabilities exceed the root policy');
    const state = {
        version: 2,
        revision: 1,
        nextSeq: 2,
        updatedAtMs: now,
        root: {
            rootId,
            maxOpenAgents,
            maxOpenAgentsSource: 'startup',
            maxDepth,
            ...(agentNames ? { agentNames } : {}),
            agentExtensions,
            serviceGrant,
        },
        agents: {
            [rootId]: {
                agentId: rootId,
                parentId: null,
                segment: 'root',
                lifecycle: 'open',
                cwd,
                displayName: { value: rootId, source: 'spawn', updatedAtMs: now },
                assignment: { value: `Root ${LUMINARIES_IDENTITY.label} agent`, source: 'spawn', updatedAtMs: now },
                ownershipBoundary: { value: `Owns this ${LUMINARIES_IDENTITY.label} root`, source: 'spawn', updatedAtMs: now },
                expertCard: { lastUpdatedAtMs: now },
                ...(input.provider ? { provider: nonemptyText(input.provider, 'bootstrap.provider') } : {}),
                ...(input.model ? { model: nonemptyText(input.model, 'bootstrap.model') } : {}),
                ...(input.thinking ? { thinking: text(input.thinking, 'bootstrap.thinking', 32) } : {}),
                completionMode: 'notify_only',
                spawnHash: sha256(JSON.stringify({ rootId, cwd })),
                context: {
                    mode: 'fresh',
                    effectiveTokens: 0,
                    estimatedTokens: 0,
                    transferredMessages: 0,
                    omittedMessages: 0,
                },
                launch: {
                    noContextFiles: false,
                    restrictSkills: false,
                    restrictPromptTemplates: false,
                    restrictThemes: false,
                    extensions: [],
                    skills: [],
                    promptTemplates: [],
                    themes: [],
                },
                capabilities,
                createdSeq: 1,
            },
        },
        activations: {},
        mailbox: {},
        requests: {},
        watches: {},
    };
    return state;
}
