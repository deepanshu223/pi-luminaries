import { buildSessionContext } from '@earendil-works/pi-coding-agent';
import { projectForkThroughToolCall, projectRecentThroughToolCall } from "./context-transfer.js";
import { normalizePiToolCallId } from "./luminaries-tools.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { isRecord } from "./scheduler-state.js";
function assistantToolCall(message, requestId, toolCallId) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content))
        return undefined;
    for (const item of message.content) {
        if (!isRecord(item) ||
            item.type !== 'toolCall' ||
            item.name !== LUMINARIES_IDENTITY.tools.spawn ||
            typeof item.id !== 'string')
            continue;
        if (item.id === toolCallId || normalizePiToolCallId(item.id) === requestId)
            return item.id;
    }
    return undefined;
}
function selectedToolCall(messages, requestId, toolCallId) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const selected = assistantToolCall(messages[index], requestId, toolCallId);
        if (selected)
            return { index, toolCallId: selected };
    }
    return undefined;
}
function messagesFromEntries(entries) {
    return entries.flatMap((entry) => isRecord(entry) && entry.type === 'message' && isRecord(entry.message) ? [structuredClone(entry.message)] : []);
}
export function captureSpawnCallContext(options) {
    let messages = options.messages
        ? options.messages.map((message) => structuredClone(message))
        : messagesFromEntries(options.entries);
    let selected = selectedToolCall(messages, options.requestId, options.toolCallId);
    if (!selected) {
        const candidates = messagesFromEntries(options.entries).reverse();
        const assistant = candidates.find((message) => assistantToolCall(message, options.requestId, options.toolCallId));
        if (!assistant)
            throw new Error(`The exact ${LUMINARIES_IDENTITY.tools.spawn} call is not visible in the current parent context`);
        messages = [...messages, structuredClone(assistant)];
        selected = selectedToolCall(messages, options.requestId, options.toolCallId);
    }
    if (!selected)
        throw new Error(`The exact ${LUMINARIES_IDENTITY.tools.spawn} call could not be correlated`);
    const projection = options.mode === 'recent'
        ? projectRecentThroughToolCall(messages.slice(0, selected.index + 1), selected.toolCallId)
        : projectForkThroughToolCall(messages.slice(0, selected.index + 1), selected.toolCallId);
    return {
        messages: projection.messages,
        selectedToolCallId: projection.selectedToolCallId,
        ...(options.sourceSessionFile ? { sourceSessionFile: options.sourceSessionFile } : {}),
    };
}
function captureSpawnCallMessage(options) {
    const selected = selectedToolCall(options.messages, options.requestId, options.toolCallId);
    if (!selected)
        throw new Error(`The exact ${LUMINARIES_IDENTITY.tools.spawn} call is not visible in the current Pi context`);
    return captureSpawnCallContext({
        entries: [],
        messages: [options.messages[selected.index]],
        mode: options.mode,
        requestId: options.requestId,
        toolCallId: selected.toolCallId,
    });
}
export function appendSpawnCallContext(messages, call) {
    const selected = selectedToolCall(call.messages, '', call.selectedToolCallId);
    if (selected === undefined)
        throw new Error(`The exact ${LUMINARIES_IDENTITY.tools.spawn} call could not be correlated`);
    const existing = selectedToolCall(messages, '', call.selectedToolCallId);
    const before = existing ? messages.slice(0, existing.index) : messages;
    const after = existing ? messages.slice(existing.index + 1) : [];
    return [...before, ...call.messages, ...after].map((message) => structuredClone(message));
}
export class ParentContextTracker {
    current(sessionManager) {
        const sourceSessionFile = sessionManager.getSessionFile();
        return {
            messages: structuredClone(buildSessionContext(sessionManager.getBranch()).messages),
            selectedToolCallId: `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}operator-boundary`,
            ...(sourceSessionFile ? { sourceSessionFile } : {}),
        };
    }
    snapshot(mode, requestId, toolCallId, sessionManager) {
        const branch = sessionManager.getBranch();
        return captureSpawnCallContext({
            entries: branch,
            messages: buildSessionContext(branch).messages,
            mode,
            requestId,
            toolCallId,
            sourceSessionFile: sessionManager.getSessionFile(),
        });
    }
    boundary(mode, requestId, toolCallId, sessionManager) {
        const branch = sessionManager.getBranch();
        return captureSpawnCallContext({
            entries: branch,
            messages: buildSessionContext(branch).messages,
            mode,
            requestId,
            toolCallId,
        });
    }
    call(mode, requestId, toolCallId, sessionManager) {
        return captureSpawnCallMessage({
            messages: buildSessionContext(sessionManager.getBranch()).messages,
            mode,
            requestId,
            toolCallId,
        });
    }
}
