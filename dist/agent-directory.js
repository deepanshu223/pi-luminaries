import { projectAgentHealth } from "./health-policy.js";
import { deriveAgentHandles, deriveAgentShortIds } from "./agent-identity.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { SchedulerStateError, agentDepth, agentPath, agentRuntimePhase, exactKeys, humanFacingProse, humanFacingText, humanFacingTextList, isRecord, isStrictAncestor, nextSequence, openCollaboratorCount, projectAgentMailbox, referenceTargetsPrivateState, requestStatus, } from "./scheduler-state.js";
function principalAgent(state, principal) {
    if (principal.kind === 'operator')
        return undefined;
    const caller = state.agents[principal.agentId];
    if (!caller || caller.lifecycle !== 'open')
        throw new SchedulerStateError('authority_denied', `Principal collaborator '${principal.agentId}' is not open`);
    return caller;
}
function metadataSource(state, principal, targetId) {
    const caller = principalAgent(state, principal);
    if (!caller)
        return 'operator';
    if (caller.agentId === targetId)
        return 'self';
    if (isStrictAncestor(state, caller.agentId, targetId))
        return 'owner';
    throw new SchedulerStateError('authority_denied', `Collaborator '${caller.agentId}' cannot change metadata for '${targetId}'`);
}
export function normalizeAgentMetadataPatch(patchInput) {
    if (!isRecord(patchInput))
        throw new SchedulerStateError('input_invalid', 'Metadata patch must be an object');
    exactKeys(patchInput, ['displayName', 'assignment', 'ownershipBoundary', 'role', 'focus', 'expertise', 'publishedRefs'], 'metadata patch');
    if (Object.keys(patchInput).length === 0)
        throw new SchedulerStateError('input_invalid', 'Metadata patch is empty');
    return {
        displayName: patchInput.displayName === undefined ? undefined : humanFacingText(patchInput.displayName, 'displayName'),
        assignment: patchInput.assignment === undefined ? undefined : humanFacingProse(patchInput.assignment, 'assignment'),
        ownershipBoundary: patchInput.ownershipBoundary === undefined
            ? undefined
            : humanFacingProse(patchInput.ownershipBoundary, 'ownershipBoundary'),
        role: patchInput.role === undefined || patchInput.role === null
            ? patchInput.role
            : humanFacingText(patchInput.role, 'role'),
        focus: patchInput.focus === undefined || patchInput.focus === null
            ? patchInput.focus
            : humanFacingProse(patchInput.focus, 'focus'),
        expertise: patchInput.expertise === undefined || patchInput.expertise === null
            ? patchInput.expertise
            : humanFacingTextList(patchInput.expertise, 'expertise'),
        publishedRefs: patchInput.publishedRefs === undefined || patchInput.publishedRefs === null
            ? patchInput.publishedRefs
            : humanFacingTextList(patchInput.publishedRefs, 'publishedRefs'),
    };
}
export function updateAgentMetadata(state, statePath, targetId, patch, principal) {
    const target = state.agents[targetId];
    if (!target || target.lifecycle !== 'open')
        throw new SchedulerStateError('agent_unavailable', `Collaborator '${targetId}' is not open`);
    const source = metadataSource(state, principal, targetId);
    if (source === 'self' &&
        (patch.displayName !== undefined || patch.assignment !== undefined || patch.ownershipBoundary !== undefined))
        throw new SchedulerStateError('authority_denied', 'A collaborator cannot rewrite its own display name, assignment, or ownership boundary');
    for (const reference of patch.publishedRefs ?? [])
        if (referenceTargetsPrivateState(reference, state, target.cwd, statePath))
            throw new SchedulerStateError('private_reference', `Published references cannot expose ${LUMINARIES_IDENTITY.label} private state or sessions`);
    const now = Date.now();
    let changed = false;
    let expertChanged = false;
    const setText = (key, value) => {
        if (value === undefined)
            return;
        const current = target[key];
        if (current.value === value && current.source === source)
            return;
        target[key] = { value, source, updatedAtMs: now };
        changed = true;
    };
    setText('displayName', patch.displayName);
    setText('assignment', patch.assignment);
    setText('ownershipBoundary', patch.ownershipBoundary);
    const setExpertText = (key, value) => {
        if (value === undefined)
            return;
        const current = target.expertCard[key];
        if (value === null) {
            if (current) {
                delete target.expertCard[key];
                changed = true;
                expertChanged = true;
            }
            return;
        }
        if (current?.value === value && current.source === source)
            return;
        target.expertCard[key] = { value, source, updatedAtMs: now };
        changed = true;
        expertChanged = true;
    };
    const setExpertList = (key, value) => {
        if (value === undefined)
            return;
        const current = target.expertCard[key];
        if (value === null) {
            if (current) {
                delete target.expertCard[key];
                changed = true;
                expertChanged = true;
            }
            return;
        }
        if (current && current.source === source && JSON.stringify(current.value) === JSON.stringify(value))
            return;
        target.expertCard[key] = { value, source, updatedAtMs: now };
        changed = true;
        expertChanged = true;
    };
    setExpertText('role', patch.role);
    setExpertText('focus', patch.focus);
    setExpertList('expertise', patch.expertise);
    setExpertList('publishedRefs', patch.publishedRefs);
    if (!changed)
        return { changed: false, value: target };
    if (expertChanged)
        target.expertCard.lastUpdatedAtMs = now;
    nextSequence(state);
    return { changed: true, value: target };
}
function comparePath(state, left, right) {
    const leftPath = agentPath(state, left.agentId);
    const rightPath = agentPath(state, right.agentId);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}
function logicalState(state, agent) {
    return agentRuntimePhase(state, agent);
}
function compactText(value, maximum) {
    if (Buffer.byteLength(value) <= maximum)
        return value;
    let result = value.slice(0, maximum);
    while (Buffer.byteLength(result) > maximum)
        result = result.slice(0, -1);
    return result;
}
function compactDeclared(field, maximum) {
    return { ...field, value: compactText(field.value, maximum) };
}
function compactCard(agent) {
    const publishedRefs = agent.expertCard.publishedRefs;
    return {
        ...(agent.expertCard.role ? { role: compactDeclared(agent.expertCard.role, 128) } : {}),
        ...(agent.expertCard.focus ? { focus: compactDeclared(agent.expertCard.focus, 256) } : {}),
        ...(agent.expertCard.expertise
            ? {
                expertise: {
                    ...agent.expertCard.expertise,
                    value: agent.expertCard.expertise.value.slice(0, 4).map((value) => compactText(value, 128)),
                },
            }
            : {}),
        expertiseCount: agent.expertCard.expertise?.value.length ?? 0,
        publishedRefCount: publishedRefs?.value.length ?? 0,
        lastUpdatedAtMs: agent.expertCard.lastUpdatedAtMs,
    };
}
function compactActivity(state, agent) {
    if (agent.lifecycle === 'closed')
        return { state: 'closed', summary: 'Closed · Conversation kept.' };
    switch (logicalState(state, agent)) {
        case 'starting':
            return { state: 'starting', summary: 'Starting collaborator.' };
        case 'running':
            return { state: 'working', summary: 'Working on its current turn.' };
        case 'waiting':
            return { state: 'waiting', summary: 'Waiting for a reply or related work.' };
        case 'runtime_parked':
        case 'idle':
            return { state: 'idle', summary: 'Idle.' };
    }
}
function compactAttention(state, agent, callerId) {
    const owner = callerId === undefined || accessFor(state, callerId, agent.agentId) !== 'peer';
    if (owner) {
        const health = projectAgentHealth(state, agent);
        return { level: health.level === 'ok' ? 'none' : health.level, summary: health.summary };
    }
    if (agent.attention)
        return { level: 'critical', summary: 'This collaborator needs owner attention.' };
    return { level: 'none', summary: 'No attention required.' };
}
function compactAgent(state, agent, callerId, shortIds, handles) {
    const root = agent.agentId === state.root.rootId;
    return {
        agentId: agent.agentId,
        humanHandle: root ? 'Root' : (handles.get(agent.agentId) ?? agent.displayName.value),
        ...(root ? {} : { shortId: shortIds.get(agent.agentId) ?? agent.agentId }),
        parentId: agent.parentId,
        path: agentPath(state, agent.agentId),
        depth: agentDepth(state, agent.agentId),
        lifecycle: agent.lifecycle,
        displayName: root ? { ...agent.displayName, value: 'Root' } : compactDeclared(agent.displayName, 128),
        assignment: compactDeclared(agent.assignment, 320),
        ownershipBoundary: compactDeclared(agent.ownershipBoundary, 320),
        expertCard: compactCard(agent),
        activity: compactActivity(state, agent),
        attention: compactAttention(state, agent, callerId),
    };
}
function compactIdentityMaps(state) {
    const identities = Object.values(state.agents).map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.agentId === state.root.rootId ? 'Root' : agent.displayName.value,
    }));
    const handles = new Map(deriveAgentHandles(identities));
    handles.set(state.root.rootId, 'Root');
    return { shortIds: deriveAgentShortIds(identities.map((identity) => identity.agentId)), handles };
}
export function projectCompactDirectory(state, callerId, includeClosed = false) {
    const { shortIds, handles } = compactIdentityMaps(state);
    return Object.values(state.agents)
        .filter((agent) => agent.lifecycle === 'open' || includeClosed)
        .filter((agent) => agent.lifecycle === 'open' ||
        callerId === undefined ||
        agent.agentId === callerId ||
        isStrictAncestor(state, callerId, agent.agentId))
        .sort((left, right) => comparePath(state, left, right))
        .map((agent) => compactAgent(state, agent, callerId, shortIds, handles));
}
export function projectCompactAgentSummary(state, agent, callerId) {
    const { shortIds, handles } = compactIdentityMaps(state);
    const base = compactAgent(state, agent, callerId, shortIds, handles);
    const pendingRequests = Object.values(state.requests).filter((request) => request.requesterId === agent.agentId && requestStatus(state, request) === 'pending').length;
    const pendingWatches = Object.values(state.watches).filter((watch) => watch.ownerId === agent.agentId && watch.status === 'active').length;
    const pendingActivations = Object.values(state.activations).filter((activation) => activation.agentId === agent.agentId && activation.state === 'running').length;
    const mailbox = projectAgentMailbox(state, agent.agentId);
    return {
        ...base,
        mailbox: { count: mailbox.count, bytes: mailbox.bytes },
        pending: { requests: pendingRequests, watches: pendingWatches, activations: pendingActivations },
        health: callerId !== undefined && accessFor(state, callerId, agent.agentId) === 'peer'
            ? {
                level: base.attention.level === 'none' ? 'ok' : base.attention.level,
                attention: base.attention.level,
                summary: base.attention.summary,
                reasons: [],
                observations: [],
            }
            : projectAgentHealth(state, agent),
        capacity: {
            used: openCollaboratorCount(state),
            limit: state.root.maxOpenAgents,
            available: Math.max(0, state.root.maxOpenAgents - openCollaboratorCount(state)),
        },
    };
}
function accessFor(state, callerId, agentId) {
    if (callerId === undefined)
        return 'operator';
    if (callerId === agentId)
        return 'self';
    return isStrictAncestor(state, callerId, agentId) ? 'owner' : 'peer';
}
