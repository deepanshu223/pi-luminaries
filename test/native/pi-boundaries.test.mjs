import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePi, textOf } from '../helpers/native-pi.mjs';

test('Pi clear_queue removes extension input; abort alone does not discard it', { timeout: 45000 }, async (t) => {
  const pi = await nativePi(t, {
    luminaries: false,
    respond: (call) => (textOf(call.messages.at(-1)) === 'Hold this turn' ? false : undefined),
  });
  for (const clear of [false, true]) {
    const start = pi.calls.length;
    await pi.rpc.request({ type: 'prompt', message: 'Hold this turn' });
    await pi.wait(() => pi.calls.length > start);
    const marker = clear ? 'removed-input' : 'retained-input';
    await pi.rpc.request({ type: 'prompt', message: `/test-input ${marker}` });
    if (clear) await pi.rpc.request({ type: 'clear_queue' });
    await pi.rpc.request({ type: 'abort' });
    await pi.turn('Continue');
    const messages = pi.calls.at(-1).messages.filter((message) => textOf(message) === marker);
    assert.equal(messages.length, clear ? 0 : 1);
    if (!clear) assert.equal(messages[0].role, 'user');
  }
  const offset = pi.events.length;
  await pi.rpc.request({ type: 'prompt', message: '/test-error' });
  assert.ok(
    pi.events
      .slice(offset)
      .some((event) => event.type === 'extension_error' && event.error.includes('could not be read')),
  );
  await pi.turn('Still usable');
});

test('real Pi delivers busy input and follow-up once, then interrupts cleanly', { timeout: 60000 }, async (t) => {
  let held;
  let atNextBoundary;
  const pi = await nativePi(t, {
    respond(call) {
      const last = call.messages.at(-1);
      if (last?.role === 'user' && !textOf(last).startsWith('TEST_CALL ') && textOf(last).includes('Hold the expert')) {
        held = call;
        return false;
      }
      if (last?.role === 'user' && textOf(last).includes('busy-input')) {
        atNextBoundary = call;
        return false;
      }
    },
  });
  const spawn = await pi.tool('luminaries_spawn', { assignment: 'Hold the expert', ownershipBoundary: 'Test only' });
  const id = spawn.agent.agentId;
  await pi.wait(() => {
    assert.ok(!pi.agent(id)?.attention, JSON.stringify(pi.agent(id)?.health));
    return held;
  });
  await pi.client.operatorInput(id, 'busy-input', 'auto');
  await pi.client.operatorInput(id, 'later-input', 'follow_up');
  held.respond([
    { type: 'toolCall', id: 'next-boundary', name: 'luminaries_directory', arguments: { action: 'list' } },
  ]);
  await pi.wait(() => atNextBoundary);
  assert.ok(
    !atNextBoundary.messages.some((message) => textOf(message).includes('later-input')),
    'A follow-up must wait for the turn to finish while steering reaches its next model boundary',
  );
  atNextBoundary.respond();
  await pi.settled(id);
  const childCalls = pi.calls.filter((call) => call.sessionId === held.sessionId);
  for (const marker of ['busy-input', 'later-input']) {
    const messages = childCalls.at(-1).messages.filter((message) => textOf(message).includes(marker));
    assert.equal(messages.length, 1, marker);
    assert.equal(messages[0].role, 'user');
  }
  held = undefined;
  await pi.client.operatorInput(id, 'Hold the expert again', 'auto');
  await pi.wait(() => held);
  await pi.client.operatorInput(id, 'queued-across-interrupt', 'follow_up');
  await pi.client.operatorInterrupt(id);
  await pi.wait(() => pi.calls.some((call) => textOf(call.messages.at(-1)).includes('queued-across-interrupt')));
  await pi.settled(id);
  await pi.client.operatorInput(id, 'after-interrupt', 'auto');
  await pi.wait(() => pi.calls.some((call) => textOf(call.messages.at(-1)).includes('after-interrupt')));
  await pi.settled(id);
  const resumed = pi.calls.filter((call) => call.sessionId === held.sessionId).at(-1);
  assert.equal(resumed.messages.filter((message) => textOf(message).includes('queued-across-interrupt')).length, 1);
  assert.equal(pi.agent(id).attention, false);
});
