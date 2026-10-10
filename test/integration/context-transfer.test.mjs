import test from 'node:test';
import assert from 'node:assert/strict';
import { planContextLaunch } from '../../src/context-session.ts';
import { projectForkThroughToolCall } from '../../src/context-transfer.ts';

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

test('recent context keeps a complete suffix inside the requested budget', () => {
  const old = messageEntry('old', null, 'user', 'old context '.repeat(500)).message;
  const recent = [
    messageEntry('question', 'old', 'custom', 'Inspect the latest finding.').message,
    {
      role: 'assistant',
      timestamp: 1,
      api: 'faux',
      provider: 'faux',
      model: 'test',
      usage: {},
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'finding.txt' } }],
    },
    {
      role: 'toolResult',
      timestamp: 1,
      toolCallId: 'read-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'The finding.' }],
      isError: false,
    },
  ];
  recent[0].display = true;
  recent[0].customType = 'luminaries_protocol_message';
  const snapshot = { messages: [old, ...recent], selectedToolCallId: 'spawn' };
  const plan = planContextLaunch(
    { context: 'recent', contextWindow: 128_000, recentTokens: 200, cwd: process.cwd() },
    snapshot,
  );
  assert.deepEqual(plan.messages, recent);
  assert.equal(plan.receipt.omittedMessages, 1);
  assert.ok(plan.receipt.estimatedTokens <= 200);
  assert.throws(
    () =>
      planContextLaunch({ context: 'recent', contextWindow: 128_000, recentTokens: 1, cwd: process.cwd() }, snapshot),
    /newest protocol-valid context group/,
  );
});

test('Pi-native context budgeting counts media structurally and still refuses oversized text', () => {
  const imagePlan = planContextLaunch(
    {
      context: 'fork',
      contextWindow: 32_000,
      cwd: process.cwd(),
    },
    {
      messages: [
        messageEntry('user', null, 'user', [
          { type: 'text', text: 'Inspect this image.' },
          { type: 'image', data: Buffer.alloc(1024 * 1024).toString('base64'), mimeType: 'image/png' },
        ]).message,
      ],
      selectedToolCallId: 'call-boundary',
    },
  );
  assert.ok(imagePlan.receipt.estimatedTokens > 0);
  assert.ok(imagePlan.receipt.estimatedTokens < imagePlan.receipt.targetContextWindow);

  assert.throws(
    () =>
      planContextLaunch(
        { context: 'fork', contextWindow: 32_000, cwd: process.cwd() },
        {
          messages: [messageEntry('user', null, 'user', [{ type: 'text', text: 'x'.repeat(200_000) }]).message],
          selectedToolCallId: 'call-boundary',
        },
      ),
    /Fork context needs/,
  );
});
