import { LUMINARIES_IDENTITY } from './product-identity.ts';

export const FORK_BOUNDARY_TEXT = Object.freeze({
  selected: `[${LUMINARIES_IDENTITY.label} fork boundary] This ${LUMINARIES_IDENTITY.tools.spawn} call created the current child. Its visible assignment follows.`,
  unresolved: `[${LUMINARIES_IDENTITY.label} fork boundary] This earlier parallel tool call was unresolved here; its result was not transferred.`,
});
export const RECENT_BOUNDARY_TEXT = Object.freeze({
  selected: `[${LUMINARIES_IDENTITY.label} recent boundary] This ${LUMINARIES_IDENTITY.tools.spawn} call created the current child. Its visible assignment follows.`,
  unresolved: `[${LUMINARIES_IDENTITY.label} recent boundary] This earlier parallel tool call was unresolved here; its result was not transferred.`,
});

export interface ForkProjection {
  messages: readonly unknown[];
  selectedToolCallId: string;
  omittedContentItems: number;
  repairedToolCalls: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function contentItem(value: unknown, label: string): Record<string, unknown> {
  const item = record(value, label);
  if (typeof item.type !== 'string') throw new Error(`${label} has no type`);
  return item;
}

function projectThroughToolCall(
  messagesInput: readonly unknown[],
  toolCallId: string,
  boundary: Readonly<{ selected: string; unresolved: string }>,
): ForkProjection {
  if (!toolCallId) throw new Error('Fork projection requires a tool call ID');
  const messages = messagesInput.map((message) => structuredClone(message));
  let selectedMessageIndex = -1;
  let selectedContentIndex = -1;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = record(messages[messageIndex], `message ${messageIndex}`);
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const index = message.content.findIndex((item) => {
      const candidate = contentItem(item, `message ${messageIndex} assistant content`);
      return candidate.type === 'toolCall' && candidate.id === toolCallId;
    });
    if (index < 0) continue;
    if (selectedMessageIndex >= 0) throw new Error(`Tool call '${toolCallId}' appears more than once in context`);
    selectedMessageIndex = messageIndex;
    selectedContentIndex = index;
  }
  if (selectedMessageIndex < 0 || selectedContentIndex < 0)
    throw new Error(`Tool call '${toolCallId}' is not present in the current Pi context`);
  if (selectedMessageIndex !== messages.length - 1)
    throw new Error(`Tool call '${toolCallId}' is not on the current Pi context leaf`);

  const selectedMessage = record(messages[selectedMessageIndex], 'selected assistant message');
  if (!Array.isArray(selectedMessage.content)) throw new Error('Selected assistant message has no content array');
  if (typeof selectedMessage.timestamp !== 'number' || !Number.isFinite(selectedMessage.timestamp))
    throw new Error('Selected assistant message has no Pi timestamp');
  const content = selectedMessage.content.map((item, index) => contentItem(item, `assistant content ${index}`));
  const selected = content[selectedContentIndex];
  if (selected?.type !== 'toolCall' || selected.id !== toolCallId || typeof selected.name !== 'string')
    throw new Error('Selected fork content is not the expected tool call');
  const included = content.slice(0, selectedContentIndex + 1);
  const calls = included.filter(
    (item): item is Record<string, unknown> & { id: string; name: string } =>
      item.type === 'toolCall' && typeof item.id === 'string' && typeof item.name === 'string',
  );
  const projected = [
    ...messages.slice(0, selectedMessageIndex),
    { ...selectedMessage, content: included },
    ...calls.map((call) => ({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [
        {
          type: 'text',
          text: call.id === toolCallId ? boundary.selected : boundary.unresolved,
        },
      ],
      isError: false,
      timestamp: selectedMessage.timestamp,
    })),
  ];
  return {
    messages: projected,
    selectedToolCallId: toolCallId,
    omittedContentItems: content.length - included.length,
    repairedToolCalls: calls.length,
  };
}

/** Project Pi context directly through one exact spawn tool call. */
export function projectForkThroughToolCall(messages: readonly unknown[], toolCallId: string): ForkProjection {
  return projectThroughToolCall(messages, toolCallId, FORK_BOUNDARY_TEXT);
}

export function projectRecentThroughToolCall(messages: readonly unknown[], toolCallId: string): ForkProjection {
  return projectThroughToolCall(messages, toolCallId, RECENT_BOUNDARY_TEXT);
}
