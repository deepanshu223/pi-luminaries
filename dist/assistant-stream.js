import { isRecord } from "./scheduler-state.js";
function assistantMessage(value) {
    return isRecord(value) && value.role === 'assistant' ? structuredClone(value) : undefined;
}
function assistantContent(message) {
    if (Array.isArray(message.content))
        return message.content;
    const content = [];
    message.content = content;
    return content;
}
function assistantBlock(message, contentIndex, type) {
    const content = assistantContent(message);
    if (contentIndex > content.length)
        return undefined;
    const current = content[contentIndex];
    if (isRecord(current) && current.type === type)
        return { block: current, created: false };
    if (contentIndex < content.length)
        return undefined;
    const block = type === 'text' ? { type, text: '' } : { type, thinking: '' };
    content.push(block);
    return { block, created: true };
}
function applyAssistantMessageEvent(state, value) {
    const type = value.type;
    const contentIndex = value.contentIndex;
    if (typeof type !== 'string' ||
        typeof contentIndex !== 'number' ||
        !Number.isInteger(contentIndex) ||
        contentIndex < 0)
        return false;
    if (type === 'text_start' || type === 'text_delta' || type === 'text_end') {
        const result = assistantBlock(state.message, contentIndex, 'text');
        if (!result)
            return false;
        if (type === 'text_start')
            return result.created;
        if (type === 'text_delta' && typeof value.delta === 'string' && value.delta) {
            result.block.text = `${String(result.block.text ?? '')}${value.delta}`;
            return true;
        }
        if (type === 'text_end' && typeof value.content === 'string' && result.block.text !== value.content) {
            result.block.text = value.content;
            return true;
        }
        return false;
    }
    if (type === 'thinking_start' || type === 'thinking_delta' || type === 'thinking_end') {
        const result = assistantBlock(state.message, contentIndex, 'thinking');
        if (!result)
            return false;
        if (type === 'thinking_start')
            return result.created;
        if (type === 'thinking_delta' && typeof value.delta === 'string' && value.delta) {
            result.block.thinking = `${String(result.block.thinking ?? '')}${value.delta}`;
            return true;
        }
        if (type === 'thinking_end' && typeof value.content === 'string' && result.block.thinking !== value.content) {
            result.block.thinking = value.content;
            return true;
        }
        return false;
    }
    if (type !== 'toolcall_end' || !isRecord(value.toolCall))
        return false;
    const content = assistantContent(state.message);
    const current = content[contentIndex];
    if (contentIndex > content.length ||
        (contentIndex < content.length && (!isRecord(current) || current.type !== 'toolCall')))
        return false;
    if (contentIndex === content.length)
        content.push(structuredClone(value.toolCall));
    else
        content[contentIndex] = structuredClone(value.toolCall);
    return true;
}
export function applyAssistantStreamEvent(current, event) {
    if (!isRecord(event) || typeof event.type !== 'string')
        return { state: current, changed: false, finished: false };
    if (event.type === 'message_start') {
        const message = assistantMessage(event.message);
        return message
            ? { state: { message }, changed: false, finished: false }
            : { state: undefined, changed: false, finished: false };
    }
    if (event.type === 'message_end') {
        const message = assistantMessage(event.message);
        return message
            ? { message, state: undefined, changed: true, finished: true }
            : { state: current, changed: false, finished: false };
    }
    if (event.type !== 'message_update')
        return { state: current, changed: false, finished: false };
    const cumulative = assistantMessage(event.message);
    if (cumulative)
        return { state: { message: cumulative }, message: cumulative, changed: true, finished: false };
    if (!current || !isRecord(event.assistantMessageEvent))
        return { state: current, changed: false, finished: false };
    const partial = assistantMessage(event.assistantMessageEvent.partial);
    if (partial)
        return { state: { message: partial }, message: partial, changed: true, finished: false };
    const changed = applyAssistantMessageEvent(current, event.assistantMessageEvent);
    return { state: current, ...(changed ? { message: current.message } : {}), changed, finished: false };
}
export function assistantSnapshotEvent(state) {
    return state ? { type: 'message_update', message: structuredClone(state.message) } : undefined;
}
export function eventIsAssistantStart(event) {
    return (isRecord(event) && event.type === 'message_start' && isRecord(event.message) && event.message.role === 'assistant');
}
