import { resolve } from 'node:path';
import { CapabilityError, capabilityAllows, capabilityAllowsCwd, narrowCapabilityEnvelope, normalizeCapabilityEnvelope, normalizeCapabilityRequest, sameCapabilityCwd, } from "./capability-policy.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { isLowercaseSha256, isPiSessionId, SchedulerStateError, absolutePath, agentDepth, agentPath, assertSessionNamespaceAvailable, exactKeys, humanFacingProse, humanFacingText, humanFacingTextList, id, isRecord, isStrictAncestor, normalizeAgentContext, normalizeAgentLaunch, nextSequence, openCollaboratorCount, optionalText, referenceTargetsPrivateState, sha256, text, } from "./scheduler-state.js";
// Single-word IAU star names, with familiar names first: https://iauarchive.eso.org/public/themes/naming_stars/
const BUILT_IN_AGENT_NAMES = [
    'Vega Sirius Altair Rigel Deneb Polaris Arcturus Capella',
    'Antares Spica Procyon Pollux Castor Regulus Aldebaran Betelgeuse',
    'Canopus Achernar Fomalhaut Bellatrix Alnilam Alnitak Mintaka Alhena',
    'Mirach Almach Alpheratz Hamal Sheratan Menkar Mirfak Algol',
    'Alcyone Maia Merope Electra Taygeta Celaeno Atlas Pleione',
    'Dubhe Merak Phecda Megrez Alioth Mizar Alkaid Alcor',
    'Kochab Pherkad Thuban Eltanin Rastaban Albireo Sadr Gienah',
    'Shaula Lesath Nunki Ascella Alnasl Rukbat Albaldah Nashira',
    'Sadalmelik Sadalsuud Sadachbia Skat Markab Scheat Enif Matar',
    'Caph Schedar Ruchbah Segin Alderamin Alfirk Errai Altais',
    'Algedi Algenib Algieba Algorab Alnair Alphard Alphecca Alrescha',
    'Ankaa Arneb Atria Avior Azha Botein Chara Chertan',
    'Cursa Dabih Denebola Diadem Diphda Edasich Elnath Gomeisa',
    'Hadar Haedus Izar Keid Kitalpha Kurhah Maasym Meissa',
    'Menkent Mimosa Mira Mirzam Muphrid Muscida Naos Nekkar',
    'Nihal Nusakan Phact Porrima Propus Sabik Saiph Sargas',
]
    .join(' ')
    .split(' ');
export function admissionDisplayName(state, requested, reserved = []) {
    if (requested !== undefined)
        return requested;
    const names = state.root.agentNames ?? BUILT_IN_AGENT_NAMES;
    const admitted = Object.values(state.agents).filter((agent) => agent.parentId !== null);
    const used = new Set([...admitted.map((agent) => agent.displayName.value), ...reserved]);
    const displayName = names.find((name) => !used.has(name)) ?? names[admitted.length % names.length];
    if (!displayName)
        throw new SchedulerStateError('state_invalid', 'Agent name pool is empty');
    return displayName;
}
function excludedLaunchResource(launch, capabilities) {
    return (launch.extensions.find((value) => capabilities.extensions !== undefined && !capabilities.extensions.includes(value)) ??
        launch.skills.find((value) => capabilities.skills !== undefined && !capabilities.skills.includes(value)) ??
        launch.promptTemplates.find((value) => capabilities.promptTemplates !== undefined && !capabilities.promptTemplates.includes(value)) ??
        launch.themes.find((value) => capabilities.themes !== undefined && !capabilities.themes.includes(value)));
}
function principalAgent(state, principal) {
    if (principal.kind === 'operator')
        return undefined;
    const caller = state.agents[principal.agentId];
    if (!caller || caller.lifecycle !== 'open')
        throw new SchedulerStateError('authority_denied', `Principal agent '${principal.agentId}' is not open`);
    return caller;
}
function assertSpawnAuthority(state, principal, parentId) {
    const caller = principalAgent(state, principal);
    if (caller && caller.agentId !== parentId)
        throw new SchedulerStateError('authority_denied', `Agent '${caller.agentId}' may spawn only its own direct child`);
}
function assertLifecycleAuthority(state, principal, targetId) {
    const caller = principalAgent(state, principal);
    if (caller && !isStrictAncestor(state, caller.agentId, targetId))
        throw new SchedulerStateError('authority_denied', `Agent '${caller.agentId}' does not own '${targetId}'`);
}
export function normalizeAdmission(input) {
    if (!isRecord(input))
        throw new SchedulerStateError('input_invalid', 'Agent admission input must be an object');
    exactKeys(input, [
        'agentId',
        'parentId',
        'segment',
        'cwd',
        'sessionId',
        'sessionDir',
        'sessionFile',
        'displayName',
        'assignment',
        'ownershipBoundary',
        'expertCard',
        'provider',
        'model',
        'thinking',
        'spawnHash',
        'context',
        'launch',
        'grants',
    ], 'agent admission input');
    const rawCard = input.expertCard ?? {};
    if (!isRecord(rawCard))
        throw new SchedulerStateError('input_invalid', 'expertCard must be an object');
    exactKeys(rawCard, ['role', 'focus', 'expertise', 'publishedRefs'], 'expertCard input');
    const assignment = humanFacingProse(input.assignment, 'assignment');
    const result = {
        agentId: id(input.agentId, 'agentId'),
        parentId: id(input.parentId, 'parentId'),
        segment: id(input.segment, 'segment'),
        cwd: absolutePath(input.cwd, 'cwd'),
        sessionId: text(input.sessionId, 'sessionId', 128),
        sessionDir: absolutePath(input.sessionDir, 'sessionDir'),
        sessionFile: input.sessionFile === undefined ? undefined : absolutePath(input.sessionFile, 'sessionFile'),
        displayName: input.displayName === undefined ? undefined : humanFacingText(input.displayName, 'displayName'),
        assignment,
        ownershipBoundary: humanFacingProse(input.ownershipBoundary, 'ownershipBoundary'),
        role: rawCard.role === undefined ? undefined : humanFacingText(rawCard.role, 'expertCard.role'),
        focus: rawCard.focus === undefined ? undefined : humanFacingProse(rawCard.focus, 'expertCard.focus'),
        expertise: rawCard.expertise === undefined ? undefined : humanFacingTextList(rawCard.expertise, 'expertCard.expertise'),
        publishedRefs: rawCard.publishedRefs === undefined
            ? undefined
            : humanFacingTextList(rawCard.publishedRefs, 'expertCard.publishedRefs'),
        provider: optionalText(input.provider, 'provider'),
        model: optionalText(input.model, 'model'),
        thinking: optionalText(input.thinking, 'thinking', 32),
        spawnHash: input.spawnHash ??
            sha256(JSON.stringify({
                agentId: input.agentId,
                parentId: input.parentId,
                sessionId: input.sessionId,
                assignment: input.assignment,
            })),
        context: normalizeAgentContext(input.context ?? {
            mode: 'fresh',
            effectiveTokens: 0,
            estimatedTokens: 0,
            transferredMessages: 0,
            omittedMessages: 0,
        }, 'context'),
        launch: normalizeAgentLaunch(input.launch ?? {
            noContextFiles: false,
            restrictSkills: false,
            restrictPromptTemplates: false,
            restrictThemes: false,
            extensions: [],
            skills: [],
            promptTemplates: [],
            themes: [],
        }, 'launch'),
    };
    try {
        if (input.grants !== undefined)
            result.grants = normalizeCapabilityRequest(input.grants);
    }
    catch (error) {
        const code = error instanceof CapabilityError ? error.code : 'capability_invalid';
        throw new SchedulerStateError(code, 'Agent capability grant is invalid', { cause: error });
    }
    if (!isPiSessionId(result.sessionId))
        throw new SchedulerStateError('input_invalid', 'sessionId is invalid');
    if (!isLowercaseSha256(result.spawnHash))
        throw new SchedulerStateError('input_invalid', 'spawnHash is invalid');
    return result;
}
export function reconcileRootPolicy(state, input) {
    const root = state.agents[state.root.rootId];
    if (!root)
        throw new SchedulerStateError('state_invalid', 'Root agent is unavailable');
    let platform;
    try {
        platform = normalizeCapabilityEnvelope(input.capabilities);
    }
    catch (error) {
        throw new SchedulerStateError('capability_invalid', 'Root containment policy is invalid', { cause: error });
    }
    const deepest = Object.values(state.agents).reduce((maximum, agent) => Math.max(maximum, agentDepth(state, agent.agentId)), 0);
    const openCount = openCollaboratorCount(state);
    if (!Number.isSafeInteger(input.maxOpenAgents) || input.maxOpenAgents < openCount)
        throw new SchedulerStateError('capability_conflict', `Configured capacity ${input.maxOpenAgents} cannot contain ${openCount} open collaborators`);
    if (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 1)
        throw new SchedulerStateError('input_invalid', 'Nesting depth must be a positive whole number.');
    if (input.maxDepth < deepest)
        throw new SchedulerStateError('capability_conflict', `Retained descendants reach level ${deepest}; choose ${deepest} or higher.`);
    if (platform.maxDepth < input.maxDepth)
        throw new SchedulerStateError('capability_conflict', `Configured depth ${input.maxDepth} and root capability depth ${platform.maxDepth} cannot contain preserved depth ${deepest}`);
    const agentNames = input.agentNames === undefined
        ? undefined
        : input.agentNames.map((name, index) => humanFacingText(name, `agentNames[${index}]`));
    const rootCwd = absolutePath(input.cwd, 'root cwd');
    const retiredCwdRoot = input.retiredCwdRoot === undefined ? undefined : absolutePath(input.retiredCwdRoot, 'retired cwd root');
    const agents = Object.values(state.agents);
    const provider = optionalText(input.provider, 'root provider');
    const model = optionalText(input.model, 'root model');
    const thinking = optionalText(input.thinking, 'root thinking', 32);
    if (!capabilityAllowsCwd(platform, rootCwd))
        throw new SchedulerStateError('capability_conflict', 'Root policy would exclude the root cwd');
    const reconciledCapabilities = new Map([[root.agentId, platform]]);
    const depthChanged = state.root.maxDepth !== input.maxDepth;
    const extensionsChanged = JSON.stringify(root.capabilities.extensions) !== JSON.stringify(platform.extensions);
    const depthSource = input.maxDepthSource ?? state.root.maxDepthSource ?? 'startup';
    const spawnGrants = new Map();
    if (retiredCwdRoot || depthChanged || extensionsChanged) {
        const descendants = agents
            .filter((agent) => agent.agentId !== root.agentId)
            .sort((left, right) => agentDepth(state, left.agentId) - agentDepth(state, right.agentId));
        for (const agent of descendants) {
            const parent = agent.parentId ? state.agents[agent.parentId] : undefined;
            const parentCapabilities = parent ? reconciledCapabilities.get(parent.agentId) : undefined;
            if (!parent || !parentCapabilities)
                throw new SchedulerStateError('state_invalid', `Collaborator '${agent.agentId}' lost its capability parent`);
            let capabilities = agent.capabilities;
            const grant = declaredSpawnGrant(agent, parent);
            if (depthChanged) {
                const depth = agentDepth(state, agent.agentId);
                const ceiling = Math.min(grant.maxDepth ?? parentCapabilities.maxDepth, parentCapabilities.maxDepth);
                const spawn = (grant.spawn ?? parentCapabilities.spawn) && parentCapabilities.spawn && depth < ceiling;
                capabilities = { ...capabilities, spawn, maxDepth: spawn ? ceiling : depth };
                spawnGrants.set(agent.agentId, grant);
            }
            if (extensionsChanged) {
                capabilities = { ...capabilities };
                const extensions = extensionGrant(parentCapabilities, grant.extensions);
                if (extensions)
                    capabilities.extensions = extensions;
                else
                    delete capabilities.extensions;
            }
            if (!retiredCwdRoot) {
                reconciledCapabilities.set(agent.agentId, capabilities);
                continue;
            }
            const requiredCwds = agents
                .filter((candidate) => candidate.agentId === agent.agentId || isStrictAncestor(state, agent.agentId, candidate.agentId))
                .map((candidate) => candidate.cwd);
            if (requiredCwds.some((cwd) => !capabilityAllowsCwd(parentCapabilities, cwd)))
                throw new SchedulerStateError('capability_conflict', `Root policy would exclude retained work owned by '${agent.agentId}'`);
            const cwdRoots = [
                ...(agent.capabilities.cwdRoots ?? []).filter((cwd) => !sameCapabilityCwd(cwd, retiredCwdRoot) && capabilityAllowsCwd(parentCapabilities, cwd)),
                ...requiredCwds,
            ];
            reconciledCapabilities.set(agent.agentId, {
                ...capabilities,
                cwdRoots: [...new Set(cwdRoots.map((cwd) => resolve(cwd)))],
            });
        }
    }
    const changed = JSON.stringify(root.capabilities) !== JSON.stringify(platform) ||
        root.cwd !== rootCwd ||
        state.root.maxOpenAgents !== input.maxOpenAgents ||
        state.root.maxOpenAgentsSource !== input.maxOpenAgentsSource ||
        state.root.maxDepth !== input.maxDepth ||
        (state.root.maxDepthSource ?? 'startup') !== depthSource ||
        JSON.stringify(state.root.agentNames) !== JSON.stringify(agentNames) ||
        JSON.stringify(state.root.agentExtensions) !== JSON.stringify(input.agentExtensions) ||
        JSON.stringify(state.root.serviceGrant) !== JSON.stringify(input.serviceGrant) ||
        root.provider !== provider ||
        root.model !== model ||
        root.thinking !== thinking ||
        agents.some((agent) => {
            const capabilities = reconciledCapabilities.get(agent.agentId);
            return capabilities !== undefined && JSON.stringify(agent.capabilities) !== JSON.stringify(capabilities);
        }) ||
        agents.some((agent) => !!provider && agent.agentId !== root.agentId && !!agent.model && !agent.provider);
    if (!changed)
        return { changed: false, value: root };
    nextSequence(state);
    state.root.maxOpenAgents = input.maxOpenAgents;
    state.root.maxOpenAgentsSource = input.maxOpenAgentsSource;
    state.root.maxDepth = input.maxDepth;
    state.root.maxDepthSource = depthSource;
    if (agentNames)
        state.root.agentNames = agentNames;
    else
        delete state.root.agentNames;
    state.root.agentExtensions = { ...input.agentExtensions };
    state.root.serviceGrant = [...input.serviceGrant];
    root.cwd = rootCwd;
    root.capabilities = platform;
    for (const agent of agents) {
        const capabilities = reconciledCapabilities.get(agent.agentId);
        if (capabilities)
            agent.capabilities = capabilities;
        const grant = spawnGrants.get(agent.agentId);
        if (grant)
            agent.spawnGrant = grant;
        if (provider && agent.agentId !== root.agentId && agent.model && !agent.provider)
            agent.provider = provider;
    }
    if (provider)
        root.provider = provider;
    else
        delete root.provider;
    if (model)
        root.model = model;
    else
        delete root.model;
    if (thinking)
        root.thinking = thinking;
    else
        delete root.thinking;
    return { changed: true, value: root };
}
function capabilityPatchBase(envelope) {
    return {
        spawn: envelope.spawn,
        peerInterrupt: envelope.peerInterrupt,
        maxDepth: envelope.maxDepth,
        ...(envelope.models ? { models: envelope.models } : {}),
        ...(envelope.thinking ? { thinking: envelope.thinking } : {}),
        ...(envelope.tools ? { tools: envelope.tools } : {}),
        ...(envelope.extensions ? { extensions: envelope.extensions } : {}),
        ...(envelope.skills ? { skills: envelope.skills } : {}),
        ...(envelope.promptTemplates ? { promptTemplates: envelope.promptTemplates } : {}),
        ...(envelope.themes ? { themes: envelope.themes } : {}),
        ...(envelope.cwdRoots ? { cwdRoots: envelope.cwdRoots } : {}),
    };
}
function declaredSpawnGrant(agent, parent) {
    // Older records preserve disabled spawning and any narrower effective ceiling.
    return (agent.spawnGrant ?? {
        spawn: agent.capabilities.spawn,
        ...(agent.capabilities.spawn && agent.capabilities.maxDepth < parent.capabilities.maxDepth
            ? { maxDepth: agent.capabilities.maxDepth }
            : {}),
    });
}
function extensionGrant(parent, requested) {
    if (requested === undefined)
        return parent.extensions === undefined ? undefined : [...parent.extensions];
    if (parent.extensions === undefined)
        return [...requested];
    const allowed = new Set(parent.extensions);
    return requested.filter((path) => allowed.has(path));
}
function reconcileExtensionDescendants(state, parentId) {
    const descendants = Object.values(state.agents)
        .filter((agent) => isStrictAncestor(state, parentId, agent.agentId))
        .sort((left, right) => agentDepth(state, left.agentId) - agentDepth(state, right.agentId));
    for (const agent of descendants) {
        const parent = agent.parentId ? state.agents[agent.parentId] : undefined;
        if (!parent)
            throw new SchedulerStateError('state_invalid', `Collaborator '${agent.agentId}' lost its parent`);
        const extensions = extensionGrant(parent.capabilities, agent.spawnGrant?.extensions);
        if (extensions)
            agent.capabilities.extensions = extensions;
        else
            delete agent.capabilities.extensions;
    }
}
export function approveRootExtensionCapability(state, paths) {
    const root = state.agents[state.root.rootId];
    if (!root)
        throw new SchedulerStateError('state_invalid', 'Root collaborator is unavailable');
    root.capabilities.extensions = [...new Set([...(root.capabilities.extensions ?? []), ...paths])].sort();
    reconcileExtensionDescendants(state, root.agentId);
}
export function setAgentCapabilities(state, targetId, request, principal) {
    const target = state.agents[targetId];
    if (!target || target.lifecycle !== 'open' || !target.parentId)
        throw new SchedulerStateError('agent_unavailable', `Capability target '${targetId}' is unavailable`);
    const caller = principalAgent(state, principal);
    if (principal.kind !== 'operator' && (!caller || !isStrictAncestor(state, caller.agentId, targetId)))
        throw new SchedulerStateError('authority_denied', `Caller cannot change capabilities for '${targetId}'`);
    const parent = state.agents[target.parentId];
    if (!parent)
        throw new SchedulerStateError('state_invalid', `Capability target '${targetId}' lost its parent`);
    let effective;
    const spawnGrant = { ...declaredSpawnGrant(target, parent) };
    try {
        const patch = normalizeCapabilityRequest(request);
        if (patch.spawn !== undefined)
            spawnGrant.spawn = patch.spawn;
        if (patch.maxDepth !== undefined)
            spawnGrant.maxDepth = patch.maxDepth;
        else if (patch.spawn === true)
            delete spawnGrant.maxDepth;
        if (patch.extensions !== undefined)
            spawnGrant.extensions = [...patch.extensions];
        const base = capabilityPatchBase(target.capabilities);
        if (patch.spawn === true && patch.maxDepth === undefined)
            delete base.maxDepth;
        if (spawnGrant.extensions === undefined)
            delete base.extensions;
        else
            base.extensions = [...spawnGrant.extensions];
        effective = narrowCapabilityEnvelope(parent.capabilities, { ...base, ...patch }, agentDepth(state, targetId));
    }
    catch (error) {
        const code = error instanceof CapabilityError ? error.code : 'capability_invalid';
        throw new SchedulerStateError(code, `Capability change for '${targetId}' is invalid`, { cause: error });
    }
    const before = JSON.stringify(Object.values(state.agents)
        .filter((agent) => agent.agentId === targetId || isStrictAncestor(state, targetId, agent.agentId))
        .map((agent) => [agent.agentId, agent.capabilities, agent.spawnGrant]));
    target.capabilities = effective;
    target.spawnGrant = spawnGrant;
    reconcileExtensionDescendants(state, targetId);
    const after = JSON.stringify(Object.values(state.agents)
        .filter((agent) => agent.agentId === targetId || isStrictAncestor(state, targetId, agent.agentId))
        .map((agent) => [agent.agentId, agent.capabilities, agent.spawnGrant]));
    if (before === after)
        return { changed: false, value: target };
    nextSequence(state);
    return { changed: true, value: target };
}
export function admitAgent(state, statePath, input, principal) {
    assertSpawnAuthority(state, principal, input.parentId);
    if (state.agents[input.agentId])
        throw new SchedulerStateError('agent_exists', `Agent '${input.agentId}' already exists`);
    const parent = state.agents[input.parentId];
    if (!parent || parent.lifecycle !== 'open')
        throw new SchedulerStateError('parent_unavailable', `Parent '${input.parentId}' is not open`);
    if (openCollaboratorCount(state) >= state.root.maxOpenAgents)
        throw new SchedulerStateError('capacity_exhausted', 'Root open-agent capacity is exhausted');
    const depth = agentDepth(state, parent.agentId) + 1;
    if (depth > state.root.maxDepth || depth > parent.capabilities.maxDepth)
        throw new SchedulerStateError('depth_exhausted', 'Effective maximum depth would be exceeded');
    if (!parent.capabilities.spawn)
        throw new SchedulerStateError('capability_denied', `Parent '${parent.agentId}' has no spawn authority`);
    if (!capabilityAllowsCwd(parent.capabilities, input.cwd))
        throw new SchedulerStateError('capability_denied', `Child cwd is outside parent '${parent.agentId}' roots`);
    const selectedModel = input.provider && input.model ? `${input.provider}/${input.model}` : input.model;
    if (selectedModel && !capabilityAllows(parent.capabilities, 'models', selectedModel))
        throw new SchedulerStateError('capability_denied', `Model '${selectedModel}' is outside the parent ceiling`);
    if (input.thinking && !capabilityAllows(parent.capabilities, 'thinking', input.thinking))
        throw new SchedulerStateError('capability_denied', `Thinking level '${input.thinking}' is outside the parent ceiling`);
    const deniedResource = excludedLaunchResource(input.launch, parent.capabilities);
    if (deniedResource)
        throw new SchedulerStateError('capability_denied', `Resource '${deniedResource}' is outside the parent ceiling`);
    let capabilities;
    try {
        capabilities = narrowCapabilityEnvelope(parent.capabilities, { peerInterrupt: false, ...(input.grants ?? {}) }, depth);
    }
    catch (error) {
        const code = error instanceof CapabilityError ? error.code : 'capability_invalid';
        const detail = error instanceof Error ? error.message : 'invalid child grant';
        throw new SchedulerStateError(code, `Child capability grant is invalid: ${detail}`, { cause: error });
    }
    const path = `${agentPath(state, parent.agentId)}/${input.segment}`;
    if (Object.values(state.agents).some((agent) => agentPath(state, agent.agentId) === path))
        throw new SchedulerStateError('path_exists', `Logical agent path '${path}' already exists`);
    assertSessionNamespaceAvailable(state, input.sessionDir, input.sessionId);
    for (const reference of input.publishedRefs ?? [])
        if (referenceTargetsPrivateState(reference, state, input.cwd, statePath, input.sessionDir))
            throw new SchedulerStateError('private_reference', `Published references cannot expose ${LUMINARIES_IDENTITY.label} private state or sessions`);
    const now = Date.now();
    const seq = nextSequence(state);
    const displayName = admissionDisplayName(state, input.displayName);
    const expertCard = { lastUpdatedAtMs: now };
    if (input.role)
        expertCard.role = { value: input.role, source: 'spawn', updatedAtMs: now };
    if (input.focus)
        expertCard.focus = { value: input.focus, source: 'spawn', updatedAtMs: now };
    if (input.expertise)
        expertCard.expertise = { value: input.expertise, source: 'spawn', updatedAtMs: now };
    if (input.publishedRefs)
        expertCard.publishedRefs = { value: input.publishedRefs, source: 'spawn', updatedAtMs: now };
    const agent = {
        agentId: input.agentId,
        parentId: input.parentId,
        segment: input.segment,
        cwd: input.cwd,
        sessionId: input.sessionId,
        sessionDir: input.sessionDir,
        sessionFile: input.sessionFile,
        provider: input.provider,
        model: input.model,
        thinking: input.thinking,
        // Completions are UI-only facts; every newly admitted collaborator stores the
        // single canonical quiet value. Durable records keep validating both historical
        // values so retained roots open without migration.
        completionMode: 'notify_only',
        spawnHash: input.spawnHash,
        context: input.context,
        launch: input.launch,
        capabilities,
        spawnGrant: {
            ...(input.grants?.spawn !== undefined ? { spawn: input.grants.spawn } : {}),
            ...(input.grants?.maxDepth !== undefined ? { maxDepth: input.grants.maxDepth } : {}),
            ...(input.grants?.extensions !== undefined ? { extensions: [...input.grants.extensions] } : {}),
        },
        lifecycle: 'open',
        displayName: { value: displayName, source: 'spawn', updatedAtMs: now },
        assignment: { value: input.assignment, source: 'spawn', updatedAtMs: now },
        ownershipBoundary: { value: input.ownershipBoundary, source: 'spawn', updatedAtMs: now },
        expertCard,
        createdSeq: seq,
    };
    state.agents[agent.agentId] = agent;
    return { changed: true, value: agent };
}
export function closeAgent(state, targetId, principal, subtree) {
    if (targetId === state.root.rootId)
        throw new SchedulerStateError('root_control_denied', `The ${LUMINARIES_IDENTITY.label} root cannot be closed as an agent`);
    const target = state.agents[targetId];
    if (!target || target.lifecycle !== 'open')
        throw new SchedulerStateError('agent_unavailable', `Agent '${targetId}' is not open`);
    assertLifecycleAuthority(state, principal, targetId);
    const descendants = Object.values(state.agents)
        .filter((agent) => agent.lifecycle === 'open' && isStrictAncestor(state, targetId, agent.agentId))
        .sort((left, right) => {
        const leftPath = agentPath(state, left.agentId);
        const rightPath = agentPath(state, right.agentId);
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });
    if (!subtree && descendants.length)
        throw new SchedulerStateError('descendants_open', `Agent '${targetId}' owns ${descendants.length} open descendants: ${descendants.map((agent) => agent.agentId).join(', ')}; use close_subtree to close them together`);
    const closing = subtree ? [target, ...descendants] : [target];
    const seq = nextSequence(state);
    for (const agent of closing) {
        agent.lifecycle = 'closed';
        agent.closedSeq = seq;
        delete agent.pendingConfiguration;
        delete agent.attention;
    }
    return { changed: true, value: closing.map((agent) => agent.agentId) };
}
export function setAgentArchived(state, targetId, archived, principal) {
    if (principal.kind !== 'operator')
        throw new SchedulerStateError('authority_denied', 'Only the human operator can organize archived conversations');
    if (targetId === state.root.rootId)
        throw new SchedulerStateError('root_control_denied', `The ${LUMINARIES_IDENTITY.label} root cannot be archived`);
    const target = state.agents[targetId];
    if (!target || target.lifecycle !== 'closed')
        throw new SchedulerStateError('agent_unavailable', `Agent '${targetId}' must be closed first`);
    const affected = Object.values(state.agents).filter((agent) => agent.lifecycle === 'closed' && (agent.agentId === targetId || isStrictAncestor(state, targetId, agent.agentId)));
    if (!archived) {
        let ancestor = target.parentId ? state.agents[target.parentId] : undefined;
        while (ancestor && ancestor.agentId !== state.root.rootId) {
            if (ancestor.lifecycle === 'closed' && ancestor.archive?.archived === true)
                affected.push(ancestor);
            ancestor = ancestor.parentId ? state.agents[ancestor.parentId] : undefined;
        }
    }
    const changed = affected.filter((agent) => archived ? agent.archive?.archived !== true : agent.archive?.archived === true);
    if (!changed.length)
        return { changed: false, value: [] };
    const seq = nextSequence(state);
    for (const agent of changed)
        agent.archive = { archived, seq };
    return { changed: true, value: changed.map((agent) => agent.agentId) };
}
export function resumeAgent(state, targetId, principal, restoreArchivedLineage = false) {
    if (targetId === state.root.rootId)
        throw new SchedulerStateError('root_control_denied', `The ${LUMINARIES_IDENTITY.label} root is always open`);
    const target = state.agents[targetId];
    if (!target || target.lifecycle !== 'closed')
        throw new SchedulerStateError('agent_unavailable', `Agent '${targetId}' is not closed`);
    assertLifecycleAuthority(state, principal, targetId);
    if (restoreArchivedLineage && principal.kind !== 'operator')
        throw new SchedulerStateError('authority_denied', 'Only the human operator can restore archived lineage');
    const opening = [target];
    let parent = target.parentId ? state.agents[target.parentId] : undefined;
    while (restoreArchivedLineage && parent?.lifecycle === 'closed' && parent.archive?.archived === true) {
        opening.unshift(parent);
        parent = parent.parentId ? state.agents[parent.parentId] : undefined;
    }
    if (!parent || parent.lifecycle !== 'open')
        throw new SchedulerStateError('parent_unavailable', `Parent of '${targetId}' must be resumed first`);
    if (openCollaboratorCount(state) + opening.length > state.root.maxOpenAgents)
        throw new SchedulerStateError('capacity_exhausted', 'Root open-agent capacity is exhausted');
    nextSequence(state);
    for (const agent of opening) {
        agent.lifecycle = 'open';
        delete agent.closedSeq;
        delete agent.archive;
    }
    for (const agent of opening) {
        const owner = agent.parentId ? state.agents[agent.parentId] : undefined;
        if (!owner)
            throw new SchedulerStateError('state_invalid', `Resumed collaborator '${agent.agentId}' lost its owner`);
        const extensions = extensionGrant(owner.capabilities, agent.spawnGrant?.extensions);
        if (extensions)
            agent.capabilities.extensions = extensions;
        else
            delete agent.capabilities.extensions;
    }
    return { changed: true, value: target };
}
