import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { copyFile, rm } from 'node:fs/promises';
import { nativePi, textOf } from '../helpers/native-pi.mjs';

const command = (tool, args) => `TEST_CALL ${JSON.stringify({ tool, args })}`;
const systemText = (call) =>
  [
    call.systemPrompt ?? '',
    ...call.messages
      .filter((message) => message.role === 'system')
      .flatMap((message) => [textOf(message), ...Object.values(message.sections ?? {})]),
  ].join('\n');
const spawn = (pi, name, assignment, context = 'fresh') =>
  pi.tool('luminaries_spawn', {
    name,
    assignment,
    ownershipBoundary: 'Test only',
    context,
  });

test(
  'nested experts retain recent context and exchange a reply with an isolated peer through real Pi',
  { timeout: 60000 },
  async (t) => {
    const ambientInstruction = 'Ambient profile instruction: use the observatory glossary.';
    const pi = await nativePi(t, {
      appendSystemPrompt: ambientInstruction,
      respond(call) {
        const last = call.messages.at(-1);
        const text = textOf(last);
        if (last?.role === 'user' && text.includes('reply-now') && !text.includes('TEST_CALL ')) {
          const correlationId = text.match(/\(correlationId ([^)]+)\)/u)?.[1];
          assert.ok(correlationId);
          call.respond([
            {
              type: 'toolCall',
              id: 'peer-reply',
              name: 'luminaries_message',
              arguments: { action: 'reply', correlationId, message: 'The peer finding.' },
            },
          ]);
          return false;
        }
      },
    });
    await pi.turn('Keep the observation: blue notebook.');
    const owner = (await spawn(pi, 'Owner', 'Remember the first observation.', 'recent')).agent.agentId;
    const peer = (await spawn(pi, 'Peer', 'Wait for consultation.', 'custom')).agent.agentId;
    await pi.settled(owner);
    const peerCall = await pi.wait(() =>
      pi.calls.find((call) => textOf(call.messages.at(-1)).endsWith('Wait for consultation.')),
    );
    await pi.settled(peer);
    assert.ok(!systemText(peerCall).includes(ambientInstruction));
    assert.ok(!peerCall.messages.some((message) => textOf(message).includes('blue notebook')));
    await pi.client.operatorInput(
      owner,
      command('luminaries_spawn', {
        name: 'Nested',
        assignment: 'Keep the inherited observation.',
        ownershipBoundary: 'Test only',
        context: 'recent',
      }),
      'auto',
    );
    const nested = await pi.waitState(() =>
      pi.client.commandCenterProjection().agents.find((item) => item.name === 'Nested'),
    );
    const nestedCall = await pi.wait(() =>
      pi.calls.find((call) => {
        const last = call.messages.at(-1);
        return (
          last?.role === 'user' &&
          textOf(last).includes('Keep the inherited observation.') &&
          !textOf(last).includes('TEST_CALL ')
        );
      }),
    );
    await pi.settled(nested.agentId);
    assert.ok(systemText(nestedCall).includes(ambientInstruction));
    assert.equal(nested.parentId, owner);
    assert.equal(nested.depth, 2);
    assert.ok(nestedCall.messages.some((message) => textOf(message).includes('blue notebook')));
    await pi.client.operatorInput(
      nested.agentId,
      command('luminaries_message', {
        action: 'request',
        recipientId: peer,
        message: 'reply-now',
      }),
      'auto',
    );
    await pi.wait(() =>
      pi.calls.some((call) => {
        const last = call.messages.at(-1);
        return (
          call.sessionId === nestedCall.sessionId && last?.role === 'user' && textOf(last).includes('The peer finding.')
        );
      }),
    );
    await pi.settled(nested.agentId);
    await pi.settled(peer);
    const rootId = pi.client.commandCenterProjection().rootId;
    const rootSessionId = (await pi.rpc.request({ type: 'get_state' })).data.sessionId;
    const watch = await pi.tool('luminaries_await', {
      action: 'wait',
      agentIds: [nested.agentId],
      eventKinds: ['message'],
    });
    assert.equal(watch.status, 'active');
    await pi.waitState(() => pi.agent(rootId).humanState === 'waiting');
    const callsBeforeNotice = pi.calls.length;
    await pi.client.operatorInput(
      nested.agentId,
      command('luminaries_message', {
        action: 'send',
        recipientId: rootId,
        message: 'The nested consultation is complete.',
        mode: 'notify_only',
      }),
      'auto',
    );
    await pi.wait(() => pi.calls.slice(callsBeforeNotice).some((call) => call.sessionId === rootSessionId));
    await pi.settled(rootId);
    await pi.settled(nested.agentId);
    const errors = pi.calls.flatMap((call) =>
      call.messages.filter((message) => message.role === 'toolResult' && message.isError),
    );
    assert.deepEqual(errors, []);
  },
);

test('extension changes preserve queued work and report a missed explicit steer', { timeout: 60000 }, async (t) => {
  let held;
  const pi = await nativePi(t, {
    respond(call) {
      const last = call.messages.at(-1);
      if (last?.role === 'user' && textOf(last).endsWith('Hold extension change')) {
        held = call;
        return false;
      }
    },
  });
  const id = (await spawn(pi, 'Expert', 'Hold extension change')).agent.agentId;
  await pi.wait(() => held);
  const optional = join(pi.root, 'optional-extension.mjs');
  await copyFile(resolve('test/fixtures/optional-extension.mjs'), optional);
  await assert.rejects(
    pi.client.operatorExecute('luminaries_control', {
      action: 'set_extensions',
      agentId: id,
      extensions: [optional],
    }),
    /not allowed/u,
  );
  await pi.client.operatorApproveExtension(optional, 'user', false);
  const configuration = await pi.tool('luminaries_control', {
    action: 'set_extensions',
    agentId: id,
    extensions: [optional],
  });
  assert.equal(configuration.status, 'pending');
  await pi.client.operatorExecute('luminaries_control', { action: 'steer', agentId: id, message: 'explicit-steer' });
  await pi.tool('luminaries_message', { action: 'send', recipientId: id, message: 'ordinary-queued-work' });
  held.respond();
  const delivered = await pi.wait(() =>
    pi.calls.find((call) => {
      const last = call.messages.at(-1);
      return (
        last?.role === 'user' && textOf(last).includes('ordinary-queued-work') && !textOf(last).includes('TEST_CALL ')
      );
    }),
  );
  await pi.settled(id);
  const messages = delivered.messages;
  assert.equal(delivered.sessionId, held.sessionId);
  assert.equal(
    messages.filter((message) => message.role === 'user' && textOf(message).includes('ordinary-queued-work')).length,
    1,
  );
  assert.ok(!messages.some((message) => textOf(message).includes('explicit-steer')));
  await pi.wait(() =>
    pi.calls.some((call) => textOf(call.messages.at(-1)).includes('was not delivered because the turn ended')),
  );
  await pi.client.operatorInput(id, command('test_extension_tool', {}), 'auto');
  await pi.wait(() =>
    pi.calls.some((call) =>
      call.messages.some((message) => message.toolName === 'test_extension_tool' && !message.isError),
    ),
  );
  await pi.settled(id);
  await pi.tool('luminaries_control', { action: 'set_extensions', agentId: id, extensions: [] });
  await pi.client.operatorInput(id, 'Work after extension removal', 'auto');
  const afterRemoval = await pi.wait(() =>
    pi.calls.find((call) => textOf(call.messages.at(-1)).includes('Work after extension removal')),
  );
  await pi.settled(id);
  assert.deepEqual(pi.agent(id).selectedExtensions, []);
  assert.ok(!afterRemoval.tools.includes('test_extension_tool'));
  await pi.tool('luminaries_control', { action: 'set_extensions', agentId: id, extensions: [optional] });
  await rm(optional);
  await pi.restart();
  assert.ok(pi.agent(id), 'A removed selected extension must not prevent Root from reopening');
  await pi.client.operatorInput(id, 'Recovered after deleting the extension', 'auto');
  await pi.waitState(() => pi.agent(id).attention);
  await pi.tool('luminaries_control', { action: 'set_extensions', agentId: id, extensions: [] });
  const recovered = await pi.wait(() =>
    pi.calls.find((call) => textOf(call.messages.at(-1)).includes('Recovered after deleting')),
  );
  await pi.settled(id);
  assert.equal(
    recovered.messages.filter(
      (message) => message.role === 'user' && textOf(message).includes('Recovered after deleting the extension'),
    ).length,
    1,
  );
  assert.equal(recovered.sessionId, held.sessionId);
  assert.ok(recovered.messages.some((message) => textOf(message).includes('ordinary-queued-work')));
  assert.equal(pi.agent(id).attention, false);
});
