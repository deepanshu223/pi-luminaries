import { isRecord } from './scheduler-state.ts';

export interface AssistantStreamState {
  message: Record<string, unknown>;
  activityPhase?: 'thinking' | 'writing';
}

export interface AssistantStreamResult {
  message?: Record<string, unknown>;
  state?: AssistantStreamState;
  changed: boolean;
  finished: boolean;
}

function assistantMessage(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && value.role === 'assistant' ? structuredClone(value) : undefined;
}

function assistantContent(message: Record<string, unknown>): unknown[] {
  if (Array.isArray(message.content)) return message.content;
  const content: unknown[] = [];
  message.content = content;
  return content;
}

function assistantBlock(
  message: Record<string, unknown>,
  contentIndex: number,
  type: 'text' | 'thinking',
): { block: Record<string, unknown>; created: boolean } | undefined {
  const content = assistantContent(message);
  if (contentIndex > content.length) return undefined;
  const current = content[contentIndex];
  if (isRecord(current) && current.type === type) return { block: current, created: false };
  if (contentIndex < content.length) return undefined;
  const block: Record<string, unknown> = type === 'text' ? { type, text: '' } : { type, thinking: '' };
  content.push(block);
  return { block, created: true };
}

function applyAssistantMessageEvent(state: AssistantStreamState, value: Record<string, unknown>): boolean {
  const type = value.type;
  const contentIndex = value.contentIndex;
  if (
    typeof type !== 'string' ||
    typeof contentIndex !== 'number' ||
    !Number.isInteger(contentIndex) ||
    contentIndex < 0
  )
    return false;
  if (type === 'toolcall_start' || type === 'toolcall_delta') {
    const content = assistantContent(state.message);
    const current = content[contentIndex];
    if (
      (contentIndex === content.length || (isRecord(current) && current.type === 'toolCall')) &&
      (type === 'toolcall_start' || typeof value.delta === 'string')
    )
      state.activityPhase = 'writing';
    // Pi supplies the complete tool call at toolcall_end; only the live phase changes here.
    return false;
  }
  if (type === 'text_start' || type === 'text_delta' || type === 'text_end') {
    const result = assistantBlock(state.message, contentIndex, 'text');
    if (!result) return false;
    if (type === 'text_start') {
      if (result.created) state.activityPhase = 'writing';
      return result.created;
    }
    if (type === 'text_delta' && typeof value.delta === 'string' && value.delta) {
      result.block.text = `${String(result.block.text ?? '')}${value.delta}`;
      state.activityPhase = 'writing';
      return true;
    }
    if (type === 'text_end' && typeof value.content === 'string' && result.block.text !== value.content) {
      result.block.text = value.content;
      state.activityPhase = 'writing';
      return true;
    }
    return false;
  }
  if (type === 'thinking_start' || type === 'thinking_delta' || type === 'thinking_end') {
    const result = assistantBlock(state.message, contentIndex, 'thinking');
    if (!result) return false;
    if (type === 'thinking_start') {
      if (result.created) state.activityPhase = 'thinking';
      return result.created;
    }
    if (type === 'thinking_delta' && typeof value.delta === 'string' && value.delta) {
      result.block.thinking = `${String(result.block.thinking ?? '')}${value.delta}`;
      state.activityPhase = 'thinking';
      return true;
    }
    if (type === 'thinking_end' && typeof value.content === 'string' && result.block.thinking !== value.content) {
      result.block.thinking = value.content;
      state.activityPhase = 'thinking';
      return true;
    }
    return false;
  }
  if (type !== 'toolcall_end' || !isRecord(value.toolCall)) return false;
  const content = assistantContent(state.message);
  const current = content[contentIndex];
  if (
    contentIndex > content.length ||
    (contentIndex < content.length && (!isRecord(current) || current.type !== 'toolCall'))
  )
    return false;
  if (contentIndex === content.length) content.push(structuredClone(value.toolCall));
  else content[contentIndex] = structuredClone(value.toolCall);
  state.activityPhase = 'writing';
  return true;
}

export function applyAssistantStreamEvent(
  current: AssistantStreamState | undefined,
  event: unknown,
): AssistantStreamResult {
  if (!isRecord(event) || typeof event.type !== 'string') return { state: current, changed: false, finished: false };
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
  if (event.type !== 'message_update') return { state: current, changed: false, finished: false };
  const cumulative = assistantMessage(event.message);
  if (cumulative)
    return {
      state: {
        message: cumulative,
        ...(event.activityPhase === 'thinking' || event.activityPhase === 'writing'
          ? { activityPhase: event.activityPhase }
          : { activityPhase: 'writing' }),
      },
      message: cumulative,
      changed: true,
      finished: false,
    };
  if (!current || !isRecord(event.assistantMessageEvent)) return { state: current, changed: false, finished: false };
  const partial = assistantMessage(event.assistantMessageEvent.partial);
  if (partial) return { state: { message: partial }, message: partial, changed: true, finished: false };
  const changed = applyAssistantMessageEvent(current, event.assistantMessageEvent);
  return { state: current, ...(changed ? { message: current.message } : {}), changed, finished: false };
}

export function assistantSnapshotEvent(state: AssistantStreamState | undefined): unknown | undefined {
  return state
    ? {
        type: 'message_update',
        message: structuredClone(state.message),
        ...(state.activityPhase ? { activityPhase: state.activityPhase } : {}),
      }
    : undefined;
}

export function eventIsAssistantStart(event: unknown): boolean {
  return (
    isRecord(event) && event.type === 'message_start' && isRecord(event.message) && event.message.role === 'assistant'
  );
}
