import test from 'node:test';
import assert from 'node:assert/strict';
import { planContextLaunch } from '../../src/context-session.ts';
import { projectForkThroughToolCall } from '../../src/context-transfer.ts';
import { captureSpawnCallContext } from '../../src/parent-context.ts';

function messageEntry(id, parentId, role, content) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-06T00:00:00.000Z',
    message: { role, content, timestamp: 1 },
  };
}

test('fork projection stops at the exact spawn call and repairs its parallel prefix as one valid branch', () => {
  const messages = [
    messageEntry('user-entry', null, 'user', [{ type: 'text', text: 'Delegate two checks.' }]).message,
    messageEntry('assistant-entry', 'user-entry', 'assistant', [
      { type: 'text', text: 'I will delegate.' },
      { type: 'toolCall', id: 'call-before', name: 'luminaries_directory', arguments: { action: 'list' } },
      { type: 'toolCall', id: 'call-spawn', name: 'luminaries_spawn', arguments: { name: 'Vega' } },
      { type: 'toolCall', id: 'call-after', name: 'luminaries_spawn', arguments: { name: 'Deneb' } },
    ]).message,
  ];
  const projection = projectForkThroughToolCall(messages, 'call-spawn');

  assert.equal(projection.selectedToolCallId, 'call-spawn');
  assert.equal(projection.omittedContentItems, 1);
  assert.equal(projection.repairedToolCalls, 2);
  assert.equal(projection.messages.length, 4);
  const assistant = projection.messages[1];
  assert.deepEqual(
    assistant.content.map((item) => item.id ?? item.type),
    ['text', 'call-before', 'call-spawn'],
  );
  assert.equal(projection.messages[2].toolCallId, 'call-before');
  assert.equal(projection.messages[3].toolCallId, 'call-spawn');
  assert.ok(JSON.stringify(projection.messages).includes('created the current child'));
  assert.ok(!JSON.stringify(projection.messages).includes('call-after'));

  assert.throws(() => projectForkThroughToolCall(messages, 'missing-call'), /not present/);
  assert.throws(
    () =>
      projectForkThroughToolCall(
        [...messages, messageEntry('later', 'assistant-entry', 'assistant', []).message],
        'call-spawn',
      ),
    /current Pi context leaf/,
  );
});

test('spawn context includes the active Pi call before that assistant message is persisted', () => {
  const requestId = 'pi-tool-active-call';
  const snapshot = captureSpawnCallContext({
    entries: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Create a child.' }], timestamp: 1 }],
    activeAssistant: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: requestId, name: 'luminaries_spawn', arguments: { name: 'Child' } }],
      timestamp: 2,
    },
    requestId,
  });

  assert.equal(snapshot.selectedToolCallId, requestId);
  assert.equal(snapshot.messages.at(-1).role, 'toolResult');
});

test('recent context can select a suffix from a long branch without an entry-count refusal', () => {
  const entries = Array.from({ length: 10_001 }, (_, index) =>
    messageEntry(`entry-${index}`, null, 'user', [{ type: 'text', text: `message-${index}` }]),
  );
  const plan = planContextLaunch(
    {
      context: 'recent',
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
      cwd: process.cwd(),
    },
    { messages: entries.map((entry) => entry.message), selectedToolCallId: 'call-boundary' },
  );
  assert.ok(plan.receipt.transferredMessages > 0);
  assert.ok(plan.receipt.omittedMessages >= 0);
  assert.match(plan.receipt.warning ?? '', /conservative/i);
});

test('recent context uses supported target token accounting when supplied', () => {
  const plan = planContextLaunch(
    {
      context: 'recent',
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
      recentTokens: 100,
      cwd: process.cwd(),
    },
    {
      messages: [
        messageEntry('user', null, 'user', [{ type: 'text', text: 'one' }]).message,
        messageEntry('assistant', 'user', 'assistant', [{ type: 'text', text: 'two' }]).message,
      ],
      selectedToolCallId: 'call-boundary',
    },
    0,
    (messages) => messages.length * 7,
  );
  assert.equal(plan.receipt.estimatedTokens, 14);
  assert.doesNotMatch(plan.receipt.warning ?? '', /conservative/i);
});
