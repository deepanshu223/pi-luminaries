import { deriveAgentHandles, deriveAgentShortIds } from "./agent-identity.js";
import { selectedManagedExtensionSpecifiers, } from "./root-configuration.js";
import { collapseWhitespace, isDisplaySecretKey, isPrivateDisplayReference as isPrivateReference, normalizePathSeparators, preparePrivateDisplayPaths, sanitizePreparedDisplayText, } from "./display-sanitizer.js";
import { projectAgentHealth } from "./health-policy.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { systemEventSummary } from "./peer-prompt.js";
import { activationSeq, agentDepth, agentPath, agentRuntimePhase, buildActivityIndex, canContinuePastIndeterminate, deepFreeze, isStartingInputEvent, isRecord, mailboxRecordSeq, openCollaboratorCount, requestStatus, } from "./scheduler-state.js";
const TOOL = LUMINARIES_IDENTITY.tools;
const PRODUCT = LUMINARIES_IDENTITY.label;
const MAX_TRANSCRIPT_TEXT = 3_000;
const MAX_INTERACTIONS = 5;
/** Deterministically order projected rows as one rooted tree and derive rails for that exact row set. */
export function orderCommandCenterDirectory(rows, rootId) {
    const byId = new Map();
    const sorted = [...rows].sort((left, right) => {
        const leftPath = left.breadcrumb.join('\0');
        const rightPath = right.breadcrumb.join('\0');
        if (leftPath !== rightPath)
            return leftPath < rightPath ? -1 : 1;
        return left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0;
    });
    for (const row of sorted)
        if (!byId.has(row.agentId))
            byId.set(row.agentId, row);
    const children = new Map();
    for (const row of byId.values()) {
        const parentId = row.parentId && byId.has(row.parentId) ? row.parentId : null;
        const siblings = children.get(parentId) ?? [];
        siblings.push(row);
        children.set(parentId, siblings);
    }
    const ordered = [];
    const visited = new Set();
    const visit = (row, ancestorLast, last) => {
        if (visited.has(row.agentId))
            return;
        visited.add(row.agentId);
        const treePrefix = row.agentId === rootId
            ? '▾ '
            : `  ${ancestorLast.map((value) => (value ? '   ' : '│  ')).join('')}${last ? '└─' : '├─'} `;
        ordered.push({ ...row, treePrefix });
        const descendants = children.get(row.agentId) ?? [];
        const nextAncestors = row.agentId === rootId ? [] : [...ancestorLast, last];
        for (let index = 0; index < descendants.length; index++) {
            const descendant = descendants[index];
            if (descendant)
                visit(descendant, nextAncestors, index === descendants.length - 1);
        }
    };
    const root = byId.get(rootId);
    if (root)
        visit(root, [], true);
    const topLevel = children.get(null) ?? [];
    for (let index = 0; index < topLevel.length; index++) {
        const row = topLevel[index];
        if (row && row.agentId !== rootId)
            visit(row, [], index === topLevel.length - 1);
    }
    for (const row of byId.values())
        if (!visited.has(row.agentId))
            visit(row, [], true);
    return ordered;
}
function textContent(message) {
    const content = message.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return undefined;
    const parts = content
        .filter((part) => isRecord(part) && part.type === 'text')
        .map((part) => part.text)
        .filter((value) => typeof value === 'string');
    return parts.length ? parts.join('') : undefined;
}
function clipText(value, maximum = MAX_TRANSCRIPT_TEXT, privatePaths = []) {
    const normalized = sanitizePreparedDisplayText(value, privatePaths).trim();
    return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}
function inspectionRow(kind, value, privatePaths, extras = {}) {
    return {
        kind,
        text: sanitizePreparedDisplayText(value, privatePaths).trim(),
        ...extras,
    };
}
function singleLine(value, maximum = 180, privatePaths = []) {
    const normalized = collapseWhitespace(sanitizePreparedDisplayText(value, privatePaths)).trim();
    return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}
function safePath(value, privatePaths) {
    if (typeof value !== 'string' || !value.trim() || isPrivateReference(value, privatePaths))
        return undefined;
    const parts = normalizePathSeparators(value).split('/').filter(Boolean);
    return parts.slice(-2).join('/');
}
function toolArgs(event) {
    for (const key of ['args', 'arguments', 'input']) {
        const value = event[key];
        if (isRecord(value))
            return value;
    }
    return undefined;
}
function toolLabel(name, args, privatePaths) {
    const path = safePath(args?.path ?? args?.file_path, privatePaths);
    if (name === 'read')
        return path ? `Reading ${path}` : 'Reading a file';
    if (name === 'edit' || name === 'write')
        return path ? `Editing ${path}` : 'Editing a file';
    if (name === 'bash') {
        const command = typeof args?.command === 'string' ? singleLine(args.command, 100, privatePaths) : undefined;
        return command ? `Running ${command}` : 'Running a command';
    }
    if (name === 'web_search')
        return 'Searching the web';
    if (name === 'fetch_content')
        return 'Reading a web source';
    if (name === TOOL.spawn)
        return 'Starting a collaborator';
    if (name === TOOL.message)
        return 'Messaging a collaborator';
    if (name === TOOL.directory)
        return 'Checking the collaborator directory';
    if (name === TOOL.control)
        return 'Controlling a collaborator';
    if (name === TOOL.await)
        return 'Waiting for collaborators';
    return `Using ${singleLine(name, 80)}`;
}
function structuredString(value, privatePaths) {
    return sanitizePreparedDisplayText(value, privatePaths);
}
function structuredValue(value, privatePaths) {
    if (typeof value === 'string')
        return structuredString(value, privatePaths);
    if (value === null || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (Array.isArray(value))
        return value.map((item) => structuredValue(item, privatePaths));
    if (!isRecord(value))
        return undefined;
    const result = {};
    for (const [key, item] of Object.entries(value))
        result[key] = isDisplaySecretKey(key) ? '[secret]' : structuredValue(item, privatePaths);
    return result;
}
function nativeMessage(value, role, privatePaths) {
    const sanitized = structuredValue(value, privatePaths);
    return isRecord(sanitized) ? { ...sanitized, role } : { role };
}
function attributedUserMessage(label, value, privatePaths) {
    const text = structuredString(value, privatePaths);
    return {
        role: 'user',
        content: [{ type: 'text', text }],
        ...(label ? { attribution: label } : {}),
    };
}
function friendlyUserMessages(value, context) {
    return [attributedUserMessage(undefined, value, context.privatePaths)];
}
function conversationFromSession(messages, context) {
    const projected = [];
    for (const value of messages) {
        if (!isRecord(value) || typeof value.role !== 'string')
            continue;
        if (value.role === 'user') {
            const text = textContent(value);
            if (text)
                projected.push(...friendlyUserMessages(text, context));
            else
                projected.push(nativeMessage(value, value.role, context.privatePaths));
            continue;
        }
        if (value.role === 'custom' &&
            value.customType === LUMINARIES_IDENTITY.namespace.protocolMessageType &&
            isRecord(value.details) &&
            (typeof value.details.inputId === 'string' || value.details.operatorInput === true)) {
            const content = typeof value.details.content === 'string' && value.details.content.length > 0
                ? value.details.content
                : typeof value.content === 'string'
                    ? value.content
                    : textContent(value);
            if (content)
                projected.push(...(value.details.operatorInput === true
                    ? [attributedUserMessage('Human operator', content, context.privatePaths)]
                    : friendlyUserMessages(content, context)));
            continue;
        }
        projected.push(nativeMessage(value, value.role, context.privatePaths));
    }
    return projected;
}
export function projectConversationMessages(messages, state, _targetAgentId) {
    return conversationFromSession(messages, cachedConversationContext(state));
}
function privateDisplayPaths(state) {
    return preparePrivateDisplayPaths(Object.values(state.agents).flatMap((agent) => [agent.sessionFile, agent.sessionDir].filter((value) => !!value)));
}
function conversationProjectionContext(state, targetAgentId, privatePaths = privateDisplayPaths(state), handles = deriveAgentHandles(Object.values(state.agents).map((agent) => ({ agentId: agent.agentId, displayName: agent.displayName.value })))) {
    return {
        state,
        handles,
        ...(targetAgentId ? { targetAgentId } : {}),
        privatePaths,
    };
}
/** Published scheduler images are immutable, so per-image contexts are shared across streaming deltas. */
const conversationContextCache = new WeakMap();
function cachedConversationContext(state) {
    let context = conversationContextCache.get(state);
    if (!context) {
        context = conversationProjectionContext(state);
        conversationContextCache.set(state, context);
    }
    return context;
}
function toolResultFromEvent(value, partial) {
    if (typeof value.toolCallId !== 'string' || typeof value.toolName !== 'string')
        return undefined;
    const raw = partial ? value.partialResult : value.result;
    const result = isRecord(raw) ? raw : {};
    const content = Array.isArray(result.content)
        ? result.content
        : typeof raw === 'string'
            ? [{ type: 'text', text: raw }]
            : [];
    return {
        role: 'toolResult',
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        content,
        ...(result.details !== undefined ? { details: result.details } : {}),
        isError: value.isError === true,
        ...(partial ? { isPartial: true } : {}),
    };
}
export function projectConversationEvent(event, state, targetAgentId) {
    if (!isRecord(event) || typeof event.type !== 'string')
        return [];
    if ((event.type === 'message_end' || event.type === 'message_update') && isRecord(event.message))
        return projectConversationMessages([event.message], state, targetAgentId);
    if (event.type !== 'tool_execution_update' && event.type !== 'tool_execution_end')
        return [];
    const result = toolResultFromEvent(event, event.type === 'tool_execution_update');
    return result ? projectConversationMessages([result], state, targetAgentId) : [];
}
/** Sanitized text projection used only by the explicit authorized transcript tool view. */
export function projectTranscriptInspection(messages, state, targetAgentId) {
    const context = targetAgentId
        ? conversationProjectionContext(state, targetAgentId)
        : cachedConversationContext(state);
    const rows = [];
    const tools = new Map();
    for (const value of messages) {
        if (!isRecord(value) || typeof value.role !== 'string')
            continue;
        const text = textContent(value) ?? (typeof value.summary === 'string' ? value.summary : undefined);
        if (value.role === 'user') {
            if (!text)
                continue;
            for (const message of friendlyUserMessages(text, context)) {
                const messageText = textContent(message);
                if (messageText)
                    rows.push(inspectionRow('user', messageText, context.privatePaths, {
                        ...(typeof message.attribution === 'string' ? { label: message.attribution } : {}),
                    }));
            }
            continue;
        }
        if (value.role === 'assistant') {
            if (text)
                rows.push(inspectionRow('assistant', text, context.privatePaths));
            if (Array.isArray(value.content))
                for (const part of value.content) {
                    if (!isRecord(part) || part.type !== 'toolCall' || typeof part.name !== 'string')
                        continue;
                    rows.push({
                        kind: 'tool',
                        text: toolLabel(part.name, isRecord(part.arguments) ? part.arguments : undefined, context.privatePaths),
                        status: 'running',
                    });
                    if (typeof part.id === 'string')
                        tools.set(part.id, rows.length - 1);
                }
            if (value.stopReason === 'error' && typeof value.errorMessage === 'string')
                rows.push(inspectionRow('notice', value.errorMessage, context.privatePaths, {
                    label: 'Turn failed',
                }));
            continue;
        }
        if (value.role === 'toolResult') {
            const status = value.isError === true ? 'error' : 'complete';
            const index = typeof value.toolCallId === 'string' ? tools.get(value.toolCallId) : undefined;
            if (index !== undefined && rows[index]?.kind === 'tool')
                rows[index] = { ...rows[index], status };
            else if (typeof value.toolName === 'string')
                rows.push({ kind: 'tool', text: toolLabel(value.toolName, undefined, context.privatePaths), status });
            continue;
        }
        if (value.role === 'bashExecution' && typeof value.command === 'string') {
            rows.push({
                kind: 'tool',
                text: toolLabel('bash', { command: value.command }, context.privatePaths),
                status: value.cancelled === true || (typeof value.exitCode === 'number' && value.exitCode !== 0)
                    ? 'error'
                    : 'complete',
            });
            continue;
        }
        if ((value.role === 'custom' || value.role === 'branchSummary' || value.role === 'compactionSummary') && text)
            rows.push(inspectionRow('notice', text, context.privatePaths, {
                label: value.role === 'custom' ? 'Note' : 'Earlier context',
            }));
    }
    return rows;
}
function currentActivity(actor, runtimeState, privatePaths) {
    if (runtimeState === 'starting')
        return 'Starting collaborator';
    if (runtimeState !== 'running' || !actor)
        return '';
    const activeTools = new Map();
    let latest;
    for (const value of actor.activityEvents) {
        if (!isRecord(value) || typeof value.type !== 'string')
            continue;
        if (value.type === 'compaction_start')
            return 'Compacting context';
        if ((value.type === 'tool_execution_start' || value.type === 'tool_execution_update') &&
            typeof value.toolName === 'string') {
            const label = toolLabel(value.toolName, toolArgs(value), privatePaths);
            latest = label;
            if (typeof value.toolCallId === 'string')
                activeTools.set(value.toolCallId, label);
        }
        else if (value.type === 'tool_execution_end' && typeof value.toolCallId === 'string')
            activeTools.delete(value.toolCallId);
        else if (value.type === 'message_update' && isRecord(value.assistantMessageEvent)) {
            latest =
                value.assistantMessageEvent.type === 'thinking_start' ||
                    value.assistantMessageEvent.type === 'thinking_delta' ||
                    value.assistantMessageEvent.type === 'thinking_end'
                    ? 'Thinking'
                    : 'Writing a response';
        }
        else if (value.type === 'message_update' && isRecord(value.message) && value.message.role === 'assistant')
            latest = value.activityPhase === 'thinking' ? 'Thinking' : 'Writing a response';
        else if (value.type === 'message_end' && isRecord(value.message)) {
            if (value.message.role === 'user') {
                activeTools.clear();
                latest = 'Reading new input';
            }
            else if (value.message.role === 'assistant')
                latest = 'Finishing its turn';
        }
        else if (value.type === 'thinking_delta' || value.type === 'thinking_start')
            latest = 'Thinking';
    }
    return [...activeTools.values()].at(-1) ?? latest ?? '';
}
function currentDependency(state, agentId, activityIndex, handles) {
    const waits = [];
    for (const request of Object.values(state.requests))
        if (request.requesterId === agentId && requestStatus(state, request) === 'pending')
            waits.push({
                order: request.createdSeq,
                text: `Waiting on ${request.recipientId === state.root.rootId ? 'Root' : (handles.get(request.recipientId) ?? 'a collaborator')}`,
            });
    for (const watch of Object.values(state.watches)) {
        if (watch.ownerId !== agentId || watch.status !== 'active')
            continue;
        const watchedId = watch.agentIds?.length === 1 ? watch.agentIds[0] : undefined;
        waits.push({
            order: watch.createdSeq,
            text: watchedId
                ? `Waiting on ${watchedId === state.root.rootId ? 'Root' : (handles.get(watchedId) ?? 'a collaborator')}`
                : 'Waiting for collaborator activity',
        });
    }
    const wait = waits.sort((left, right) => right.order - left.order)[0];
    if (wait)
        return wait.text;
    const deliveries = [];
    for (const event of activityIndex.peerByRecipient.get(agentId) ?? [])
        if (event.status === 'accepted' || event.status === 'sending')
            deliveries.push({
                order: mailboxRecordSeq(event),
                text: `Message from ${event.origin === 'operator'
                    ? 'Human operator'
                    : event.origin === 'service'
                        ? `${PRODUCT} service`
                        : event.senderId === state.root.rootId
                            ? 'Root'
                            : (handles.get(event.senderId) ?? 'a collaborator')} is queued`,
            });
    return deliveries.sort((left, right) => right.order - left.order)[0]?.text;
}
function humanState(state) {
    if (state === 'starting')
        return 'starting';
    if (state === 'running')
        return 'working';
    if (state === 'waiting')
        return 'waiting';
    return 'idle';
}
function interactionSummary(event, state, agentId, privatePaths, handles) {
    const outgoing = event.senderId === agentId;
    const otherId = outgoing ? event.recipientId : event.senderId;
    const other = !outgoing && event.origin === 'operator'
        ? 'Human operator'
        : !outgoing && event.origin === 'service'
            ? `${PRODUCT} service`
            : otherId === state.root.rootId
                ? 'Root'
                : (handles.get(otherId) ?? 'a collaborator');
    const message = event.message ? clipText(event.message, 1_000, privatePaths) : undefined;
    if (outgoing && event.origin === 'system' && event.systemType === 'background_completion')
        return 'Completed a turn';
    if (event.origin === 'system' || event.origin === 'scheduler')
        return `Luminaries update · ${clipText(systemEventSummary(event, event.senderId === state.root.rootId ? 'Root' : (handles.get(event.senderId) ?? 'a luminary')), 1_000, privatePaths)}`;
    if (!message)
        return '';
    if (!outgoing)
        return `From ${other}: ${message}`;
    if (event.kind === 'request')
        return `Asked ${other}: ${message}`;
    if (event.kind === 'reply')
        return `Replied to ${other}: ${message}`;
    return '';
}
function directActivity(control, state, handles) {
    const from = control.issuer.kind === 'operator'
        ? 'Human operator'
        : control.issuer.agentId === state.root.rootId
            ? 'Root'
            : (handles.get(control.issuer.agentId) ?? 'a collaborator');
    if (control.status === 'aborted')
        return `${from} interrupted the active turn`;
    if (control.status === 'refused')
        return `Interrupt from ${from} was refused`;
    if (control.status === 'failed')
        return `Interrupt from ${from} failed`;
    return `Interrupt outcome from ${from} is uncertain`;
}
function recentInteractions(state, agentId, privatePaths, handles, activityIndex) {
    const rows = [];
    for (const event of (activityIndex.peerBySender.get(agentId) ?? []).concat((activityIndex.peerByRecipient.get(agentId) ?? []).filter((candidate) => candidate.senderId !== agentId))) {
        if (event.status !== 'settled' || isStartingInputEvent(state, event))
            continue;
        const text = interactionSummary(event, state, agentId, privatePaths, handles);
        if (text)
            rows.push({ order: mailboxRecordSeq(event), text });
    }
    for (const control of (activityIndex.directByTarget.get(agentId) ?? [])
        .slice()
        .sort((left, right) => left.acceptedSeq - right.acceptedSeq)) {
        if (control.status === 'accepted' || control.status === 'sending')
            continue;
        rows.push({ order: mailboxRecordSeq(control), text: directActivity(control, state, handles) });
    }
    for (const activation of activityIndex.activationsByAgent.get(agentId) ?? []) {
        if (activation.state === 'running')
            continue;
        const text = activation.state === 'settled'
            ? 'Completed a turn'
            : activation.state === 'failed'
                ? 'Turn failed'
                : activation.state === 'indeterminate'
                    ? 'Turn outcome needs attention'
                    : 'Turn interrupted';
        rows.push({ order: activationSeq(activation), text });
    }
    const seen = new Set();
    const recent = [];
    for (const row of rows.sort((left, right) => right.order - left.order)) {
        const key = row.text === 'Completed a turn' ? 'turn-completed' : row.text;
        if (seen.has(key))
            continue;
        seen.add(key);
        recent.push(row.text);
        if (recent.length === MAX_INTERACTIONS)
            break;
    }
    return recent;
}
function lineageNames(agentId, records, handles) {
    const names = [];
    let currentId = agentId;
    const visited = new Set();
    while (currentId) {
        const current = records.get(currentId);
        if (!current || visited.has(currentId))
            break;
        visited.add(currentId);
        names.push(handles.get(currentId) ?? current.displayName.value);
        currentId = current.parentId ?? undefined;
    }
    return names.reverse();
}
function treePrefix(agent, rootId, records, lastSiblingIds) {
    if (agent.agentId === rootId)
        return '▾ ';
    const ancestors = [];
    let parent = agent.parentId ? records.get(agent.parentId) : undefined;
    while (parent && parent.agentId !== rootId) {
        ancestors.unshift(parent);
        parent = parent.parentId ? records.get(parent.parentId) : undefined;
    }
    return `  ${ancestors.map((ancestor) => (lastSiblingIds.has(ancestor.agentId) ? '   ' : '│  ')).join('')}${lastSiblingIds.has(agent.agentId) ? '└─' : '├─'} `;
}
function projectAgent(state, agent, records, handles, shortIds, conversationContext, prefix, actors, activityIndex, indeterminateEvidence, extensionPolicy) {
    const closed = agent.lifecycle === 'closed';
    const runtimeState = closed ? undefined : agentRuntimePhase(state, agent);
    const dependency = closed ? undefined : currentDependency(state, agent.agentId, activityIndex, handles);
    const health = closed
        ? { level: 'ok', attention: 'none', summary: 'Closed · Conversation kept', reasons: [], observations: [] }
        : projectAgentHealth(state, agent, activityIndex, indeterminateEvidence);
    const attention = !closed && health.attention !== 'none';
    const stateForHuman = closed ? 'closed' : humanState(runtimeState ?? 'runtime_parked');
    const active = !closed &&
        (attention || stateForHuman === 'working' || stateForHuman === 'starting' || stateForHuman === 'waiting');
    const declaredFocus = agent.expertCard.focus;
    const focus = declaredFocus
        ? sanitizePreparedDisplayText(declaredFocus.value, conversationContext.privatePaths)
        : undefined;
    const interactions = recentInteractions(state, agent.agentId, conversationContext.privatePaths, handles, activityIndex);
    return {
        agentId: agent.agentId,
        parentId: agent.parentId,
        depth: agentDepth(state, agent.agentId),
        lifecycle: agent.lifecycle,
        archived: agent.archive?.archived === true,
        name: agent.agentId === state.root.rootId ? 'Root' : agent.displayName.value,
        shortId: shortIds.get(agent.agentId) ?? agent.agentId,
        handle: handles.get(agent.agentId) ?? agent.displayName.value,
        breadcrumb: lineageNames(agent.agentId, records, handles),
        ...(agent.expertCard.role
            ? { role: sanitizePreparedDisplayText(agent.expertCard.role.value, conversationContext.privatePaths) }
            : {}),
        ...(focus ? { focus } : {}),
        ...(declaredFocus ? { focusSource: declaredFocus.source } : {}),
        assignment: sanitizePreparedDisplayText(agent.agentId === state.root.rootId ? 'Owns and supervises this constellation.' : agent.assignment.value, conversationContext.privatePaths),
        ownershipBoundary: sanitizePreparedDisplayText(agent.ownershipBoundary.value, conversationContext.privatePaths),
        expertise: (agent.expertCard.expertise?.value ?? []).map((value) => sanitizePreparedDisplayText(value, conversationContext.privatePaths)),
        artifacts: (agent.expertCard.publishedRefs?.value ?? [])
            .filter((value) => !isPrivateReference(value, conversationContext.privatePaths))
            .map((value) => sanitizePreparedDisplayText(value, conversationContext.privatePaths)),
        state: closed ? 'closed' : (runtimeState ?? 'runtime_parked'),
        humanState: stateForHuman,
        runtimeResident: !closed && (agent.parentId === null || agent.runtimeOwner !== undefined),
        ...(agent.model ? { model: agent.provider ? `${agent.provider}/${agent.model}` : agent.model } : {}),
        ...(agent.thinking ? { thinking: agent.thinking } : {}),
        selectedExtensions: extensionPolicy
            ? selectedManagedExtensionSpecifiers(extensionPolicy, agent.launch.extensions, agent.launch.extensionSources)
            : [],
        alwaysExtensions: extensionPolicy?.entries.filter((entry) => entry.state === 'always').map((entry) => entry.specifier) ?? [],
        extensionChangePending: agent.pendingConfiguration?.kind === 'extensions',
        canSpawn: agent.capabilities.spawn,
        canPeerInterrupt: agent.capabilities.peerInterrupt,
        maxDepth: agent.capabilities.maxDepth,
        contextMode: agent.context.mode,
        ...(dependency ? { dependency } : {}),
        canContinueWithMessage: !closed && canContinuePastIndeterminate(state, agent.agentId, indeterminateEvidence),
        active,
        attention,
        health,
        activity: closed
            ? ''
            : currentActivity(actors.get(agent.agentId), runtimeState ?? 'runtime_parked', conversationContext.privatePaths),
        interactions,
        cwd: agent.cwd,
        treePrefix: prefix,
    };
}
function ambientRows(agents, rootId) {
    const active = agents.filter((agent) => agent.active && agent.agentId !== rootId);
    const byId = new Map(active.map((agent) => [agent.agentId, agent]));
    const indexes = new Map(active.map((agent, index) => [agent.agentId, index]));
    return active.map((agent, index) => {
        const ancestors = [];
        let parent = agent.parentId ? byId.get(agent.parentId) : undefined;
        while (parent) {
            ancestors.unshift(parent);
            parent = parent.parentId ? byId.get(parent.parentId) : undefined;
        }
        const prefix = ancestors
            .map((ancestor) => {
            const ancestorIndex = indexes.get(ancestor.agentId) ?? -1;
            return active.slice(ancestorIndex + 1).some((candidate) => candidate.parentId === ancestor.parentId)
                ? '│  '
                : '   ';
        })
            .join('');
        const sameParentAfter = active.slice(index + 1).some((candidate) => candidate.parentId === agent.parentId);
        return {
            agent,
            prefix: `${prefix}${sameParentAfter ? '├─' : '└─'} `,
            name: agent.depth > 1 && (!agent.parentId || !byId.has(agent.parentId))
                ? agent.breadcrumb.slice(1).join(' › ')
                : agent.handle,
        };
    });
}
/** Pure projection over current scheduler truth and live actor activity. It performs no I/O. */
export function projectCommandCenter(state, actors = new Map(), uiRevision = state.revision, rootConfiguration, historyRevision = state.revision, indeterminateEvidence = []) {
    const records = new Map(Object.entries(state.agents));
    const identities = Object.values(state.agents).map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.agentId === state.root.rootId ? 'Root' : agent.displayName.value,
    }));
    const handles = new Map(deriveAgentHandles(identities));
    handles.set(state.root.rootId, 'Root');
    const shortIds = deriveAgentShortIds(identities.map((identity) => identity.agentId));
    const selectedRecords = Object.values(state.agents).sort((left, right) => {
        const leftPath = agentPath(state, left.agentId);
        const rightPath = agentPath(state, right.agentId);
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });
    const children = new Map();
    for (const agent of selectedRecords) {
        const siblings = children.get(agent.parentId) ?? [];
        siblings.push(agent);
        children.set(agent.parentId, siblings);
    }
    const lastSiblingIds = new Set([...children.values()].map((siblings) => siblings.at(-1)?.agentId).filter((value) => !!value));
    const conversationContext = conversationProjectionContext(state, undefined, privateDisplayPaths(state), handles);
    const activityIndex = buildActivityIndex(state);
    const directory = selectedRecords.map((agent) => projectAgent(state, agent, records, handles, shortIds, conversationContext, treePrefix(agent, state.root.rootId, records, lastSiblingIds), actors, activityIndex, indeterminateEvidence, rootConfiguration?.extensions));
    const agents = directory.filter((agent) => agent.lifecycle === 'open');
    const closedAgents = directory.filter((agent) => agent.lifecycle === 'closed');
    const nonRoot = agents.filter((agent) => agent.agentId !== state.root.rootId);
    const ambient = ambientRows(agents, state.root.rootId);
    const counts = {
        working: nonRoot.filter((agent) => agent.humanState === 'working' || agent.humanState === 'starting').length,
        waiting: nonRoot.filter((agent) => agent.humanState === 'waiting').length,
        idle: nonRoot.filter((agent) => agent.humanState === 'idle').length,
        attention: agents.filter((agent) => agent.attention).length,
    };
    return deepFreeze({
        revision: uiRevision,
        historyRevision,
        rootId: state.root.rootId,
        capacity: {
            used: openCollaboratorCount(state),
            limit: state.root.maxOpenAgents,
            available: Math.max(0, state.root.maxOpenAgents - openCollaboratorCount(state)),
        },
        configuration: {
            maxOpenAgents: state.root.maxOpenAgents,
            maxDepth: state.root.maxDepth,
            namePoolSource: rootConfiguration?.sources.agentNames ?? (state.root.agentNames ? 'configured' : 'built-in'),
            sources: {
                maxOpenAgents: state.root.maxOpenAgentsSource === 'operator-live'
                    ? 'operator-live'
                    : (rootConfiguration?.sources.maxOpenAgents ?? 'built-in'),
                maxDepth: state.root.maxDepthSource === 'operator-live'
                    ? 'operator-live'
                    : (rootConfiguration?.sources.maxDepth ?? 'built-in'),
                serviceGrant: rootConfiguration?.sources.serviceGrant ?? 'built-in',
            },
            agentExtensions: Object.entries(state.root.agentExtensions).map(([specifier, setting]) => ({
                specifier,
                state: setting,
                source: rootConfiguration?.extensions.entries.find((entry) => entry.specifier === specifier)?.source ?? 'built-in',
            })),
            serviceGrant: [...state.root.serviceGrant],
        },
        agents,
        closedAgents,
        directory,
        archivedCount: Object.values(state.agents).filter((agent) => agent.lifecycle === 'closed' && agent.archive?.archived === true).length,
        ambient,
        counts,
        visible: ambient.length > 0,
    });
}
