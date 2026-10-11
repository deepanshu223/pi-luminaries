import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { discoverAttachmentDescriptors, LuminariesAttachmentClient } from '../../src/attachment.ts';
import { nativePi, textOf, waitFor } from '../helpers/native-pi.mjs';

test(
  'attached clients share a retained expert across restart, archive, standalone handoff and adoption',
  { timeout: 60000 },
  async (t) => {
    let firstTurn;
    const pi = await nativePi(t, {
      respond(call) {
        const last = call.messages.at(-1);
        const text = textOf(last);
        if (last?.role === 'user' && !text.startsWith('TEST_CALL ') && text.includes('Remember the blue notebook.')) {
          firstTurn = call;
          return false;
        }
      },
    });
    const spawned = await pi.tool('luminaries_spawn', {
      name: 'Vega',
      assignment: 'Remember the blue notebook.',
      ownershipBoundary: 'Test only',
    });
    const id = spawned.agent.agentId;
    await pi.wait(() => firstTurn);
    const [descriptor] = await discoverAttachmentDescriptors(pi.profile, pi.root);
    const observer = await LuminariesAttachmentClient.connect(descriptor.descriptorPath);
    t.after(() => observer.close());
    const stopWatching = observer.onAgentConversationChange(id, () => {});
    t.after(stopWatching);
    await observer.operatorInput(id, 'A second terminal can contribute.', 'auto');
    firstTurn.respond();
    await pi.wait(() => pi.calls.some((call) => textOf(call.messages.at(-1)).includes('second terminal')));
    await pi.settled(id);
    await waitFor(
      () =>
        observer.agentConversationSnapshot(id).messages.some((message) => textOf(message).includes('second terminal')),
      (check) => observer.onAgentConversationChange(id, check),
      t.signal,
    );
    await pi.tool('luminaries_control', { action: 'set_model', agentId: id, model: 'luminaries-test/reasoning' });
    await pi.tool('luminaries_control', { action: 'set_thinking', agentId: id, thinking: 'high' });
    await pi.client.operatorSetCapacity(2);
    await pi.client.operatorSetDepth(2);
    await observer.close();
    assert.equal(pi.agent(id).lifecycle, 'open');
    await pi.restart();
    const resumed = pi.client;
    const expert = () => pi.agent(id);
    const until = pi.waitState;
    assert.equal(expert().state, 'runtime_parked');
    assert.equal(pi.client.commandCenterProjection().capacity.limit, 2);
    assert.equal(pi.client.commandCenterProjection().configuration.maxDepth, 2);
    await resumed.operatorInput(id, 'Continue after restart.', 'auto');
    const continued = await pi.wait(() =>
      pi.calls.find((call) => textOf(call.messages.at(-1)).includes('Continue after restart.')),
    );
    assert.equal(continued.model, 'reasoning');
    assert.equal(continued.thinking, 'high');
    assert.equal(
      continued.messages.filter(
        (message) => message.role === 'user' && textOf(message).includes('Remember the blue notebook.'),
      ).length,
      1,
    );
    await until(() => expert()?.humanState === 'idle');
    await resumed.operatorExecute('luminaries_control', { action: 'close', agentId: id });
    await resumed.operatorSetArchived(id, true);
    assert.equal((await resumed.operatorClosedHistory()).agents.find((agent) => agent.agentId === id).archived, true);
    await resumed.operatorResume(id);
    await until(() => expert()?.lifecycle === 'open');
    const detached = await resumed.operatorDetachSession(id);
    assert.equal(detached.command, `pi --session ${detached.sessionId}`);
    assert.equal((await resumed.operatorDetachSession(id)).sessionId, detached.sessionId);
    assert.ok((await stat(detached.sessionFile)).isFile());
    const standalone = await pi.launch({ session: detached.sessionId, withLuminaries: false });
    await standalone.turn('Continue independently.');
    await standalone.rpc.close();
    const source = await readFile(detached.sessionFile);
    const adopted = await resumed.operatorAdoptSession(detached.sessionId, {});
    assert.notEqual(adopted.sessionId, detached.sessionId);
    await assert.rejects(resumed.operatorInspectSessionReference('not-a-session'), /unavailable/u);
    await resumed.operatorInput(adopted.agentId, 'Continue the adopted conversation.', 'auto');
    const adoptionCall = await pi.wait(() =>
      pi.calls.find((call) => textOf(call.messages.at(-1)).includes('Continue the adopted conversation.')),
    );
    assert.ok(adoptionCall.messages.some((message) => textOf(message).includes('Continue independently.')));
    await until(
      () =>
        resumed.commandCenterProjection().agents.find((agent) => agent.agentId === adopted.agentId)?.humanState ===
        'idle',
    );
    assert.deepEqual(await readFile(detached.sessionFile), source);
  },
);
