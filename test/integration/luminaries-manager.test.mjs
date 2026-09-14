import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AttachmentTargetError,
  discoverAttachmentDescriptors,
  LuminariesAttachmentClient,
} from '../../src/attachment.ts';
import { LuminariesManager } from '../../src/luminaries-manager.ts';
import { createPiSessionHost } from '../../src/pi-session-host.ts';
import { LUMINARIES_IDENTITY } from '../../src/product-identity.ts';
import { agentRuntimeState, openCollaboratorCount, sha256 } from '../../src/scheduler-state.ts';
import { SchedulerStore } from '../../src/scheduler-store.ts';
import { controls as mailboxControls, event as mailboxEvent } from '../helpers/mailbox.mjs';

function context(root, sessionFile, sessionId = 'parent-session', mode = 'tui') {
  return {
    mode,
    cwd: root,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  };
}

function runtimeState(store, agentId) {
  const snapshot = store.snapshot();
  return agentRuntimeState(snapshot, snapshot.agents[agentId]);
}

test('manager startup owns one root lease, fences stale callers, and closes idempotently', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'luminaries-manager-'));
  let manager;
  t.after(async () => {
    await manager?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const physicalRoot = join(directory, 'project');
  const root = join(directory, 'project-alias');
  await mkdir(physicalRoot);
  await symlink(physicalRoot, root, process.platform === 'win32' ? 'junction' : 'dir');
  const sessionFile = join(root, 'parent.jsonl');
  const agentDir = join(root, 'agent-state');
  manager = new LuminariesManager({ sessionId: 'parent-session', sessionFile, cwd: root, agentDir });
  await manager.start();
  await manager.start();
  const staleHost = manager.hostForParent(context(root, sessionFile, 'parent-session'));
  assert.equal(manager.lifecycle, 'running');
  assert.equal(manager.actors.size, 0);
  assert.equal(openCollaboratorCount(manager.store.snapshot()), 0);
  assert.equal(manager.store.snapshot().root.maxDepth, 1);
  assert.equal(
    manager.store.statePath,
    join(await realpath(agentDir), 'luminaries', 'roots', manager.store.snapshot().root.rootId, 'state.json'),
  );
  assert.ok(
    manager.store
      .snapshot()
      .agents[manager.store.snapshot().root.rootId].capabilities.cwdRoots.includes(await realpath(root)),
  );
  assert.doesNotMatch(manager.store.statePath, /\.luminaries[/\\].*parent\.jsonl/u);
  const receipt = await staleHost.execute(
    { toolName: 'luminaries_directory', input: { requestId: 'list', action: 'list' } },
    undefined,
  );
  assert.equal(receipt.details.capacity.used, 0);
  const modelListReceipt = receipt.details;
  assert.deepEqual(modelListReceipt.capacity, { used: 0, limit: 10 });
  assert.equal(modelListReceipt.entries[0].agentId, manager.store.snapshot().root.rootId);
  assert.equal(modelListReceipt.entries[0].humanHandle, 'Root');
  assert.equal('shortId' in modelListReceipt.entries[0], false);
  assert.equal(modelListReceipt.entries[0].depth, 0);
  assert.equal('tree' in modelListReceipt, false);
  const operator = manager.hostForOperator();
  const oversizedPublicExpertise = `fifth-specialty-${'x'.repeat(60 * 1024)}`;
  const longPublicRef = join(
    root,
    'public',
    ...Array.from({ length: 4 }, (_, index) => `${index}-${'x'.repeat(70)}`),
    'result.md',
  );
  const oversizedMutation = manager.result('oversized-multicast', false, 'Multicast admitted.', {
    action: 'multicast',
    status: 'accepted',
    legs: Array.from({ length: 4_000 }, (_, index) => ({ eventId: `event-${index}` })),
  });
  assert.match(oversizedMutation.details.resultBound.retry, /must not be replayed/u);
  await operator.execute(
    {
      toolName: 'luminaries_directory',
      input: {
        requestId: 'operator-update',
        action: 'update',
        patch: {
          focus: 'operator focus',
          expertise: ['one', 'two', 'three', 'four', oversizedPublicExpertise],
          publishedRefs: [longPublicRef],
        },
      },
    },
    undefined,
  );
  assert.equal(
    manager.store.snapshot().agents[manager.store.snapshot().root.rootId].expertCard.focus.source,
    'operator',
  );
  let publicCard = await staleHost.execute(
    {
      toolName: 'luminaries_directory',
      input: { requestId: 'public-card', action: 'inspect', agentId: 'Root', view: 'card' },
    },
    undefined,
  );
  const publicCardEntries = [...publicCard.details.entries];
  let publicCardPage = 1;
  while (publicCard.details.page.nextCursor) {
    publicCard = await staleHost.execute(
      {
        toolName: 'luminaries_directory',
        input: {
          requestId: `public-card-${++publicCardPage}`,
          action: 'inspect',
          agentId: 'Root',
          view: 'card',
          cursor: publicCard.details.page.nextCursor,
        },
      },
      undefined,
    );
    publicCardEntries.push(...publicCard.details.entries);
  }
  assert.equal(
    publicCardEntries
      .filter((entry) => entry.field === 'expertise')
      .map((entry) => entry.value)
      .join('')
      .includes(oversizedPublicExpertise),
    true,
  );
  assert.equal(
    publicCardEntries.some((entry) => entry.value === longPublicRef),
    true,
  );
  assert.doesNotMatch(JSON.stringify(receipt.details), /sessionId|sessionDir|sessionFile|runtimeOwner|runtimePid/);
  await assert.rejects(async () => {
    const host = manager.hostForParent(context(root, sessionFile, 'other-session'));
    await host.execute({ toolName: 'luminaries_directory', input: { requestId: 'stale', action: 'list' } }, undefined);
  }, /session/);
  const rootId = manager.store.snapshot().root.rootId;
  const statePath = manager.store.statePath;
  const staleSessionDir = join(agentDir, 'stale-child-session');
  const staleSessionFile = join(staleSessionDir, 'stale-child-session.jsonl');
  await mkdir(staleSessionDir, { recursive: true });
  await writeFile(staleSessionFile, '', { mode: 0o600 });
  await manager.store.admitAgent(
    {
      agentId: 'stale-child',
      parentId: rootId,
      segment: 'stale-child',
      cwd: root,
      sessionId: 'stale-child-session',
      sessionDir: staleSessionDir,
      sessionFile: staleSessionFile,
      displayName: 'stale child',
      assignment: 'prove restart reconciliation',
      ownershipBoundary: 'startup only',
    },
    { kind: 'agent', agentId: rootId },
  );
  const printHost = manager.hostForParent(context(root, sessionFile, 'parent-session', 'print'));
  const beforeOneShotYield = manager.store.snapshot();
  for (const [toolName, input] of [
    ['luminaries_await', { requestId: 'print-wait', action: 'wait', agentIds: ['stale-child'] }],
    [
      'luminaries_message',
      { requestId: 'print-request', action: 'request', recipientId: 'stale-child', message: 'reply later' },
    ],
    [
      'luminaries_message',
      {
        requestId: 'print-request-many',
        action: 'request_many',
        recipientIds: ['stale-child', rootId],
        message: 'reply later',
      },
    ],
  ])
    await assert.rejects(
      printHost.execute({ toolName, input }, undefined),
      /needs a persistent Pi parent session.*send\/multicast.*TUI\/RPC/su,
    );
  assert.equal(manager.store.snapshot().revision, beforeOneShotYield.revision);
  assert.deepEqual(manager.store.snapshot().watches, beforeOneShotYield.watches);
  assert.deepEqual(manager.store.snapshot().requests, beforeOneShotYield.requests);
  const deadPid = 2_147_483_647;
  const staleClaim = await manager.store.claimRuntime('stale-child', deadPid, hostname());
  await manager.store.markRuntimeSpawned('stale-child', staleClaim.value.runtimeOwner, deadPid);
  await manager.store.markRuntimeReady('stale-child', staleClaim.value.runtimeOwner, deadPid);
  await manager.close();
  await manager.close();
  assert.equal(manager.lifecycle, 'closed');
  await assert.rejects(
    staleHost.execute({ toolName: 'luminaries_directory', input: { requestId: 'closed', action: 'list' } }, undefined),
    /manager_closed|closed/,
  );

  const crashStore = await SchedulerStore.open({ statePath });
  const crashSource = await crashStore.startActivation(rootId, 'test');
  const crashWake = await crashStore.admitPeerEvent(
    { agentId: rootId, rootId, runtimeOwner: 'crash-root-runtime' },
    {
      bridgeRequestId: 'stale-wake-recovery-order',
      recipientId: 'stale-child',
      message: 'Cross an uncertain wake boundary before restart.',
    },
  );
  await crashStore.finishActivation(crashSource.value.activationId, crashSource.value.leaseToken, 'settled');
  const crashDispatch = await crashStore.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: crashWake.value.event.eventId,
    runtimeOwner: staleClaim.value.runtimeOwner,
  });
  const crashWakeActivationId = crashDispatch.value.activationId;
  assert.equal(crashDispatch.value.deliveryKind, 'wake');
  const strandedControl = await crashStore.applyMailboxIntent({
    kind: 'admit_direct',
    input: {
      requestId: 'stranded-before-control-dispatch',
      targetId: 'stale-child',
      sourceActivationId: crashWakeActivationId,
      action: 'interrupt',
    },
    requestedBy: { kind: 'operator' },
  });
  await crashStore.close();

  const reopened = new LuminariesManager({ sessionId: 'parent-session', sessionFile, cwd: root, agentDir });
  await reopened.start();
  t.after(() => reopened.close());
  assert.equal(mailboxEvent(reopened.store.snapshot(), crashWake.value.event.eventId), undefined);
  const retainedCrashWake = await reopened.store.admitPeerEvent(
    { agentId: rootId, rootId, runtimeOwner: 'crash-root-runtime' },
    {
      bridgeRequestId: 'stale-wake-recovery-order',
      recipientId: 'stale-child',
      message: 'Cross an uncertain wake boundary before restart.',
    },
  );
  assert.equal(retainedCrashWake.value.duplicate, true);
  assert.equal(retainedCrashWake.value.event.status, 'indeterminate');
  assert.equal(mailboxEvent(reopened.store.snapshot(), crashWake.value.event.eventId), undefined);
  assert.equal(reopened.store.snapshot().activations[crashWakeActivationId], undefined);
  assert.equal(
    mailboxControls(reopened.store.snapshot()).find(
      (control) => control.controlId === strandedControl.value.control.controlId,
    ),
    undefined,
  );
  assert.equal(runtimeState(reopened.store, reopened.store.snapshot().root.rootId), 'idle');
  assert.equal(reopened.store.snapshot().agents['stale-child'].runtimeOwner, undefined);
  assert.equal(runtimeState(reopened.store, 'stale-child'), 'needs_attention');
  await reopened.store.admitAgent(
    {
      agentId: 'unknown-child',
      parentId: rootId,
      segment: 'unknown-child',
      cwd: root,
      sessionId: 'unknown-child-session',
      sessionDir: join(agentDir, 'unknown-child-session'),
      displayName: 'unknown child',
      assignment: 'prove ambiguous restart refusal',
      ownershipBoundary: 'startup only',
    },
    { kind: 'agent', agentId: rootId },
  );
  await reopened.store.claimRuntime('unknown-child', deadPid, hostname());
  await reopened.close();
  await rm(join(agentDir, 'unknown-child-session'), { recursive: true, force: true });

  const quarantined = new LuminariesManager({ sessionId: 'parent-session', sessionFile, cwd: root, agentDir });
  try {
    await quarantined.start();
    assert.equal(quarantined.lifecycle, 'running');
    assert.equal(runtimeState(quarantined.store, 'unknown-child'), 'needs_attention');
    assert.equal(quarantined.store.snapshot().agents['unknown-child'].lifecycle, 'open');
    const staleRuntimeOwner = quarantined.store.snapshot().agents['unknown-child'].runtimeOwner;
    assert.ok(staleRuntimeOwner);
    assert.equal(quarantined.actors.size, 0);
    await quarantined.operatorExecute('luminaries_control', { action: 'close', agentId: 'unknown-child' });
    assert.equal(quarantined.store.snapshot().agents['unknown-child']?.lifecycle, 'closed');
    assert.equal(quarantined.store.snapshot().agents['unknown-child']?.runtimeOwner, staleRuntimeOwner);
    assert.equal((await quarantined.store.closedAgentLineage('unknown-child'))[0]?.lifecycle, 'closed');
  } finally {
    await quarantined.close();
  }
});

test('manager shutdown joins an in-progress startup without leaking its Store or bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-manager-start-close-'));
  const sessionFile = join(root, 'parent.jsonl');
  const agentDir = join(root, 'agent-state');
  const manager = new LuminariesManager({ sessionId: 'parent-session', sessionFile, cwd: root, agentDir });
  const start = manager.start();
  const close = manager.close();
  const [started, closed] = await Promise.allSettled([start, close]);
  assert.equal(closed.status, 'fulfilled');
  assert.equal(manager.lifecycle, 'closed');
  if (started.status === 'rejected') assert.match(started.reason.message, /closed|startup/i);

  const reopened = new LuminariesManager({ sessionId: 'parent-session', sessionFile, cwd: root, agentDir });
  await reopened.start();
  assert.equal(reopened.lifecycle, 'running');
  await reopened.close();
});

test('Root interrupt refusal and native cancellation preserve the Pi turn settlement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-root-interrupt-settlement-'));
  const sessionFile = join(root, 'parent.jsonl');
  const manager = new LuminariesManager({
    sessionId: 'parent-session',
    sessionFile,
    cwd: root,
    agentDir: join(root, 'agent-state'),
    rootTransport: {
      async sendMessage() {},
      async abort() {
        throw new Error('Pi refused the Root interrupt');
      },
    },
  });
  await manager.start();
  t.after(() => manager.close());
  const rootId = manager.store.snapshot().root.rootId;
  await manager.parentBeforeAgentStart('Keep the Root turn active.');
  await manager.parentAgentStart();
  const activation = Object.values(manager.store.snapshot().activations).find(
    (candidate) => candidate.agentId === rootId && candidate.state === 'running',
  );
  assert.ok(activation);

  await assert.rejects(manager.operatorInterrupt(rootId), /indeterminate/);
  await manager.parentAgentSettled();
  await waitFor(() => manager.store.snapshot().activations[activation.activationId]?.state !== 'running');
  assert.notEqual(manager.store.snapshot().activations[activation.activationId]?.state, 'running');
  await manager.parentBeforeAgentStart('Wait for a future message.');
  const nativeTurn = Object.values(manager.store.snapshot().activations).find(
    (candidate) => candidate.agentId === rootId && candidate.state === 'running',
  );
  await manager.store.registerWatch(
    { watchId: 'native-root-wait', eventKinds: ['message'], registeringActivationId: nativeTurn.activationId },
    { kind: 'operator' },
  );
  manager.parentMessageEnd({ role: 'assistant', content: [], stopReason: 'aborted' });
  await manager.parentAgentSettled();
  assert.notEqual(manager.store.snapshot().watches['native-root-wait']?.status, 'active');
  await waitFor(
    () =>
      manager.commandCenterProjection().agents.find((candidate) => candidate.agentId === rootId).humanState === 'idle',
  );
  await manager.parentBeforeAgentStart('Wait again.');
  const nextTurn = Object.values(manager.store.snapshot().activations).find(
    (candidate) => candidate.agentId === rootId && candidate.state === 'running',
  );
  await manager.store.registerWatch(
    { watchId: 'next-root-wait', eventKinds: ['message'], registeringActivationId: nextTurn.activationId },
    { kind: 'operator' },
  );
  await manager.parentAgentSettled();
  assert.equal(
    manager.store.snapshot().watches['next-root-wait'].status,
    'active',
    'native abort evidence must not leak into the next turn',
  );
});

test('parent root conversation and delivery preserve native history and exact Pi boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-root-delivery-'));
  const sessionHost = createPiSessionHost();
  const sessionFile = await sessionHost.createSeededSession({
    sessionId: 'parent-session',
    sessionDir: root,
    cwd: root,
    messages: [
      ...Array.from({ length: 203 }, (_, index) => ({
        role: 'user',
        content: `Retained Root history ${index + 1}.`,
        timestamp: index + 1,
      })),
      { role: 'user', content: 'Show the settled Root history.', timestamp: 204 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Settled Root history is available.' }],
        timestamp: 205,
        api: 'openai-responses',
        provider: 'openai',
        model: 'test-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
      },
    ],
  });
  const agentDir = join(root, 'agent-state');
  const deliveries = [];
  let falseBoundaryAttempts = 0;
  let settledBeforeBoundaryAttempts = 0;
  const falseBoundaryMessage = 'retry this Root follow-up after a known missed boundary';
  const siblingFollowUpMessage = `${falseBoundaryMessage} (sibling)`;
  const pendingBoundaryMessage = 'hold this Root steer at its exact Pi boundary';
  const settledBeforeBoundaryMessage = 'retry Root input when Pi settles before sendMessage returns';
  const recoveryMessage = 'Continue Root after retired uncertain completion.';
  let pendingBoundaryInput;
  let hostFactReads = 0;
  let manager;
  const rootTransport = {
    async sendMessage(message, options) {
      const content = message.content;
      const missedBoundaryFollowUp = content.includes(falseBoundaryMessage);
      const settlesBeforeBoundary = content.includes(settledBeforeBoundaryMessage);
      deliveries.push({ content, options });
      if (!options?.deliverAs) {
        await manager.parentBeforeAgentStart(content);
        await manager.parentAgentStart();
      }
      if (missedBoundaryFollowUp) {
        falseBoundaryAttempts++;
        if (falseBoundaryAttempts <= 4) return;
      }
      if (settlesBeforeBoundary) {
        settledBeforeBoundaryAttempts++;
        if (settledBeforeBoundaryAttempts === 1) {
          await manager.parentAgentSettled();
          return;
        }
      }
      if (content.includes(pendingBoundaryMessage)) {
        pendingBoundaryInput = message;
        return;
      }
      await manager.parentMessageStart({
        role: 'custom',
        customType: message.customType,
        content: `decoy before exact boundary: ${content}`,
      });
      await manager.parentMessageStart({ role: 'custom', ...message });
      await manager.parentMessageStart({ role: 'custom', ...message });
      if (!missedBoundaryFollowUp && !content.includes(recoveryMessage)) await manager.parentAgentSettled();
    },
  };
  manager = new LuminariesManager({
    sessionId: 'parent-session',
    sessionFile,
    cwd: root,
    agentDir,
    sessionHost,
    currentHostFacts: () => {
      hostFactReads++;
      return { models: [], startupPrompt: '', activeToolTokens: 0 };
    },
    rootTransport,
  });
  await manager.start();
  let unsubscribeRoot = () => undefined;
  try {
    const snapshot = manager.store.snapshot();
    const rootId = snapshot.root.rootId;
    await Promise.all([
      manager.store.reconcileRootHostFacts({ provider: 'next-provider', model: 'next-model', thinking: 'high' }),
      manager.store.setRootCapacity(12),
    ]);
    const reconciled = manager.store.snapshot();
    assert.equal(reconciled.root.maxOpenAgents, 12);
    assert.equal(reconciled.agents[rootId].model, 'next-model');
    assert.equal(reconciled.agents[rootId].thinking, 'high');
    assert.equal(snapshot.agents[rootId].sessionId, undefined);
    assert.equal(snapshot.agents[rootId].sessionFile, undefined);
    unsubscribeRoot = manager.onAgentConversationChange(rootId, () => undefined);
    await waitFor(() => manager.agentConversationSnapshot(rootId).hydrated);
    assert.equal(manager.agentConversationSnapshot(rootId).messages.length, 205);
    assert.match(JSON.stringify(manager.agentConversationSnapshot(rootId).messages[0]), /Retained Root history 1/);
    assert.match(JSON.stringify(manager.agentConversationSnapshot(rootId).messages), /Settled Root history/);
    await manager.parentMessageStart({ role: 'assistant', content: [], timestamp: 206 });
    manager.parentMessageUpdate({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    });
    manager.parentMessageUpdate({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Live Root response' },
    });
    await waitFor(() =>
      JSON.stringify(manager.agentConversationSnapshot(rootId).messages).includes('Live Root response'),
    );
    manager.parentMessageEnd({
      role: 'assistant',
      content: [{ type: 'text', text: 'Live Root response complete.' }],
      timestamp: 207,
    });
    const parentHost = manager.hostForParent(context(root, sessionFile));
    await assert.rejects(
      parentHost.execute(
        {
          toolName: 'luminaries_await',
          input: {
            requestId: 'retired-watch-reuse',
            action: 'wait',
            watchId: 'luminaries-1111111111111111111111111111111111111111',
          },
        },
        undefined,
      ),
      /no longer active.*register a new watch/iu,
    );
    await manager.store.admitAgent(
      {
        agentId: 'sender',
        parentId: rootId,
        segment: 'sender',
        cwd: root,
        sessionId: 'sender-session',
        sessionDir: join(agentDir, 'sender-session'),
        displayName: 'sender',
        assignment: 'send root events',
        ownershipBoundary: 'messaging only',
      },
      { kind: 'agent', agentId: rootId },
    );
    const claimed = await manager.store.claimRuntime('sender', process.pid, 'test-host');
    const runtimeOwner = claimed.value.runtimeOwner;
    await manager.store.markRuntimeSpawned('sender', runtimeOwner, process.pid);
    await manager.store.markRuntimeReady('sender', runtimeOwner, process.pid);
    const source = await manager.store.startActivation('sender', 'test_source');
    const auth = { agentId: 'sender', rootId, runtimeOwner };

    const wake = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-wake',
      recipientId: rootId,
      message: 'wake the root',
    });
    await waitFor(() => mailboxEvent(manager.store.snapshot(), wake.value.event.eventId)?.status === 'settled');
    assert.deepEqual(deliveries[0].options, { triggerTurn: true });
    assert.match(deliveries[0].content, /wake the root/);
    assert.ok(mailboxEvent(manager.store.snapshot(), wake.value.event.eventId).terminalSeq);

    await manager.parentBeforeAgentStart('root is already working');
    await manager.parentAgentStart();
    const steer = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-steer',
      recipientId: rootId,
      message: 'steer the busy root',
    });
    await waitFor(() => mailboxEvent(manager.store.snapshot(), steer.value.event.eventId)?.status === 'settled');
    assert.deepEqual(deliveries[1].options, { deliverAs: 'steer', triggerTurn: true });
    assert.match(deliveries[1].content, /steer the busy root/);
    assert.ok(mailboxEvent(manager.store.snapshot(), steer.value.event.eventId).consumedSeq);
    const settledBeforeBoundary = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-settled-before-boundary',
      recipientId: rootId,
      message: settledBeforeBoundaryMessage,
    });
    await waitFor(
      () => mailboxEvent(manager.store.snapshot(), settledBeforeBoundary.value.event.eventId)?.status === 'settled',
    );
    assert.equal(settledBeforeBoundaryAttempts, 2);
    assert.ok(mailboxEvent(manager.store.snapshot(), settledBeforeBoundary.value.event.eventId).consumedSeq);

    await manager.parentBeforeAgentStart('root remains busy while its Luminaries tool executes');
    await manager.parentAgentStart();
    const pendingSteer = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-steer-pending-boundary',
      recipientId: rootId,
      message: pendingBoundaryMessage,
    });
    await waitFor(() => pendingBoundaryInput);
    const pendingEventId = pendingSteer.value.event.eventId;
    assert.equal(mailboxEvent(manager.store.snapshot(), pendingEventId).status, 'sending');
    let timeout;
    const hostFactReadsBeforeTool = hostFactReads;
    const toolWhileBoundaryPending = parentHost.execute(
      { toolName: 'luminaries_directory', input: { requestId: 'list-during-root-steer', action: 'list' } },
      undefined,
    );
    const listedWhilePending = await Promise.race([
      toolWhileBoundaryPending,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Root Luminaries tool waited for an unrelated Pi input boundary')),
          1_000,
        );
        timeout.unref();
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.equal(listedWhilePending.details.entries[0].agentId, rootId);
    assert.equal(hostFactReads, hostFactReadsBeforeTool);
    assert.equal(mailboxEvent(manager.store.snapshot(), pendingEventId).consumedSeq, undefined);
    await manager.parentMessageStart({ role: 'custom', ...pendingBoundaryInput });
    await waitFor(() => mailboxEvent(manager.store.snapshot(), pendingEventId)?.consumedSeq !== undefined);
    await manager.parentAgentSettled();
    await waitFor(() => mailboxEvent(manager.store.snapshot(), pendingEventId)?.status === 'settled');
    assert.notEqual(mailboxEvent(manager.store.snapshot(), pendingEventId).status, 'indeterminate');

    await manager.parentBeforeAgentStart('root is working before a follow-up');
    await manager.parentAgentStart();
    const followUp = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-follow-up-requeue',
      recipientId: rootId,
      message: falseBoundaryMessage,
      mode: 'follow_up',
    });
    assert.equal(followUp.value.event.status, 'accepted');
    await waitFor(() => falseBoundaryAttempts === 1);
    const siblingFollowUp = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-follow-up-requeue-sibling',
      recipientId: rootId,
      message: siblingFollowUpMessage,
      mode: 'follow_up',
    });
    await waitFor(() => falseBoundaryAttempts === 2);
    assert.equal(siblingFollowUp.value.event.targetActivationId, followUp.value.event.targetActivationId);
    const removeDeliveryPayload = manager.store.removeDeliveryPayload.bind(manager.store);
    manager.store.removeDeliveryPayload = async () => {
      throw new Error('derived payload cleanup failed before a known retry');
    };
    try {
      await manager.parentAgentSettled();
      await waitFor(() => {
        const event = mailboxEvent(manager.store.snapshot(), followUp.value.event.eventId);
        const sibling = mailboxEvent(manager.store.snapshot(), siblingFollowUp.value.event.eventId);
        const activation = manager.store.snapshot().activations[followUp.value.event.targetActivationId];
        return (
          event?.status === 'accepted' &&
          event.targetActivationId === undefined &&
          sibling?.status === 'accepted' &&
          sibling.targetActivationId === undefined &&
          activation?.state !== 'running'
        );
      });
    } finally {
      manager.store.removeDeliveryPayload = removeDeliveryPayload;
    }
    assert.deepEqual(deliveries.find((delivery) => delivery.content.includes(falseBoundaryMessage))?.options, {
      deliverAs: 'followUp',
      triggerTurn: true,
    });
    assert.equal(mailboxEvent(manager.store.snapshot(), followUp.value.event.eventId).consumedSeq, undefined);
    assert.equal(mailboxEvent(manager.store.snapshot(), siblingFollowUp.value.event.eventId).consumedSeq, undefined);
    assert.equal(falseBoundaryAttempts, 2);
    await manager.parentBeforeAgentStart('later Root turn admits the retained follow-up');
    await manager.parentAgentStart();
    await waitFor(() => falseBoundaryAttempts === 4);
    const reboundActivationId = mailboxEvent(manager.store.snapshot(), followUp.value.event.eventId).activationId;
    assert.equal(
      mailboxEvent(manager.store.snapshot(), siblingFollowUp.value.event.eventId).activationId,
      reboundActivationId,
    );
    await manager.parentAgentSettled();
    await waitFor(() => {
      const current = manager.store.snapshot();
      const first = mailboxEvent(current, followUp.value.event.eventId);
      const sibling = mailboxEvent(current, siblingFollowUp.value.event.eventId);
      return (
        first?.status === 'accepted' &&
        first.activationId === undefined &&
        sibling?.status === 'accepted' &&
        sibling.activationId === undefined &&
        current.activations[reboundActivationId]?.state !== 'running'
      );
    });
    await manager.parentBeforeAgentStart('another Root turn admits the rebound follow-up cohort');
    await manager.parentAgentStart();
    await waitFor(
      () => mailboxEvent(manager.store.snapshot(), followUp.value.event.eventId)?.consumedSeq !== undefined,
    );
    await waitFor(
      () => mailboxEvent(manager.store.snapshot(), siblingFollowUp.value.event.eventId)?.consumedSeq !== undefined,
    );
    assert.equal(falseBoundaryAttempts, 6);
    await manager.parentAgentSettled();
    await waitFor(
      () =>
        mailboxEvent(manager.store.snapshot(), followUp.value.event.eventId)?.status === 'settled' &&
        mailboxEvent(manager.store.snapshot(), siblingFollowUp.value.event.eventId)?.status === 'settled',
    );

    const quiet = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-notify',
      recipientId: rootId,
      message: 'quiet root note',
      mode: 'notify_only',
    });
    assert.equal(quiet.value.event.outcomeCode, 'notify_only');
    const inspected = await parentHost.execute(
      {
        toolName: 'luminaries_directory',
        input: { requestId: 'inspect-root', action: 'inspect', agentId: rootId, view: 'coordination' },
      },
      undefined,
    );
    const modelInspection = inspected.details;
    const quietRecord = modelInspection.records.find((record) => record.outcomeCode === 'notify_only');
    assert.equal(quietRecord.message, 'quiet root note');
    assert.equal(quietRecord.senderId, 'sender');

    manager.setParentTransport(undefined);
    const uncertainCompletion = await manager.store.admitSystemEvent({
      dedupeKey: 'retired-root-recovery-evidence',
      type: 'background_completion',
      senderId: 'sender',
      recipientId: rootId,
      message: 'Retired uncertain completion requires one later operator continuation.',
      wake: true,
      sourceActivationId: source.value.activationId,
      traceId: quiet.value.event.traceId,
      causationId: quiet.value.event.eventId,
    });
    const begunCompletion = await manager.store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: uncertainCompletion.value.event.eventId,
      runtimeOwner: manager.generationId,
    });
    assert.ok(begunCompletion.value && 'eventId' in begunCompletion.value && begunCompletion.value.attemptId);
    const uncertainRootActivation = manager.store.snapshot().activations[begunCompletion.value.activationId];
    assert.ok(uncertainRootActivation);
    await manager.store.applyMailboxIntent({
      kind: 'finish_delivery',
      recordId: begunCompletion.value.eventId,
      attemptId: begunCompletion.value.attemptId,
      status: 'indeterminate',
      outcomeCode: 'root_input_unconfirmed',
    });
    await manager.store.finishActivation(
      uncertainRootActivation.activationId,
      uncertainRootActivation.leaseToken,
      'indeterminate',
    );
    assert.equal(mailboxEvent(manager.store.snapshot(), uncertainCompletion.value.event.eventId), undefined);
    assert.equal(manager.store.snapshot().agents[rootId].attention?.kind, 'needs_attention');
    const continuedBeforeRecovery = manager.store.snapshot().agents[rootId].continuedAfterSeq ?? 0;
    manager.setParentTransport(rootTransport);
    const recoveryOperationId = '33333333-3333-4333-8333-333333333333';
    assert.equal(await manager.operatorInput(rootId, recoveryMessage, 'auto', recoveryOperationId), 'woken');
    assert.ok(manager.store.snapshot().agents[rootId].continuedAfterSeq > continuedBeforeRecovery);
    assert.equal(manager.store.snapshot().agents[rootId].attention, undefined);
    const recoveryRequestId = `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}ui-${sha256(recoveryOperationId).slice(0, 40)}`;
    const recoveryInput = Object.values(manager.store.snapshot().mailbox).find(
      (record) => record.lane === 'operator' && record.bridgeRequestId === recoveryRequestId,
    );
    assert.ok(recoveryInput);
    await waitFor(() => mailboxEvent(manager.store.snapshot(), recoveryInput.eventId)?.consumedSeq !== undefined);
    await manager.parentAgentSettled();
    await waitFor(() => {
      const event = mailboxEvent(manager.store.snapshot(), recoveryInput.eventId);
      return event === undefined || event.status === 'settled';
    });

    pendingBoundaryInput = undefined;
    await manager.parentBeforeAgentStart('Root consumes one final source-owned delivery.');
    await manager.parentAgentStart();
    const consumedBeforeSourceClose = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-consumed-before-source-close',
      recipientId: rootId,
      message: pendingBoundaryMessage,
    });
    await waitFor(() => pendingBoundaryInput);
    await manager.parentMessageStart({ role: 'custom', ...pendingBoundaryInput });
    await waitFor(
      () =>
        mailboxEvent(manager.store.snapshot(), consumedBeforeSourceClose.value.event.eventId)?.status === 'consumed',
    );
    const activationMissingBefore = manager.diagnostics.filter(
      (message) => message === 'Activation does not exist',
    ).length;
    const sourceSettlement = {
      activationId: source.value.activationId,
      leaseToken: source.value.leaseToken,
      outcome: 'settled',
    };
    manager.recipientDrain.observeSettlement(Promise.resolve(sourceSettlement));
    manager.recipientDrain.observeSettlement(Promise.resolve(sourceSettlement));
    await waitFor(() => manager.store.snapshot().activations[source.value.activationId]?.state !== 'running');
    await parentHost.execute(
      {
        toolName: 'luminaries_control',
        input: { requestId: 'close-consumed-source', action: 'close_subtree', agentId: 'sender' },
      },
      undefined,
    );
    const afterSourceClose = mailboxEvent(manager.store.snapshot(), consumedBeforeSourceClose.value.event.eventId);
    assert.ok(
      afterSourceClose === undefined || afterSourceClose.status === 'consumed' || afterSourceClose.status === 'settled',
    );
    await manager.parentAgentSettled();
    await waitFor(() => {
      const event = mailboxEvent(manager.store.snapshot(), consumedBeforeSourceClose.value.event.eventId);
      return event === undefined || event.status === 'settled';
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(
      manager.diagnostics.filter((message) => message === 'Activation does not exist').length,
      activationMissingBefore,
    );
    await manager.store.releaseClosedRuntime('sender', runtimeOwner);
  } finally {
    unsubscribeRoot();
    await manager.close();
  }
});

test('Root configuration validates authority and capabilities before changing owner Pi', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-root-configuration-'));
  const sessionFile = join(root, 'parent.jsonl');
  const effects = [];
  const manager = new LuminariesManager({
    sessionId: 'parent-session',
    sessionFile,
    cwd: root,
    agentDir: join(root, 'agent-state'),
    provider: 'test-provider',
    model: 'test-model',
    thinking: 'low',
    capabilities: {
      version: 1,
      spawn: true,
      peerInterrupt: false,
      maxDepth: 1,
      models: ['test-provider/test-model', 'test-provider/next-model', 'test-provider/plain-model'],
      thinking: ['low', 'high'],
    },
    models: ['test-model', 'next-model', 'outside-model', 'plain-model'].map((id) => ({
      provider: 'test-provider',
      id,
      contextWindow: 100_000,
      reasoning: id !== 'plain-model',
    })),
    setRootModel: async (provider, model) => {
      effects.push({ provider, model });
      return true;
    },
    setRootThinking: async (thinking) => {
      effects.push({ thinking });
      return true;
    },
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();
  const rootId = manager.store.snapshot().root.rootId;
  await manager.store.admitAgent(
    {
      agentId: 'child',
      parentId: rootId,
      segment: 'child',
      cwd: root,
      sessionId: 'child-session',
      sessionDir: join(root, 'child-session'),
      displayName: 'Vega',
      assignment: 'Review the project.',
      ownershipBoundary: 'Review only.',
    },
    { kind: 'agent', agentId: rootId },
  );
  const claim = await manager.store.claimRuntime('child', process.pid, 'configuration-test');
  const runtimeOwner = claim.value.runtimeOwner;
  await manager.store.markRuntimeSpawned('child', runtimeOwner, process.pid);
  await manager.store.markRuntimeReady('child', runtimeOwner, process.pid);
  const child = {
    kind: 'child',
    agentId: 'child',
    rootId,
    runtimeOwner,
    generation: manager.generationId,
    sessionId: 'child-session',
  };
  const parent = manager.hostForParent(context(root, sessionFile));
  const initialRoot = structuredClone(manager.store.snapshot().agents[rootId]);
  for (const input of [
    { action: 'set_model', agentId: 'Root', model: 'test-provider/next-model' },
    { action: 'set_thinking', agentId: 'Root', thinking: 'high' },
  ]) {
    const request = { toolName: 'luminaries_control', input };
    await assert.rejects(manager.executeForCaller(child, request), { code: 'authority_denied' });
    await assert.rejects(parent.execute(request), { code: 'authority_denied' });
  }
  for (const input of [
    { action: 'set_model', agentId: 'Root', model: 'test-provider/outside-model' },
    { action: 'set_model', agentId: 'Root', model: 'test-provider/plain-model' },
    { action: 'set_thinking', agentId: 'Root', thinking: 'medium' },
  ])
    await assert.rejects(manager.operatorExecute('luminaries_control', input), { code: 'capability_denied' });
  assert.deepEqual(effects, [], 'denied changes must not reach either owner Pi setter');
  assert.deepEqual(manager.store.snapshot().agents[rootId], initialRoot);
  const applied = await manager.operatorExecute('luminaries_control', {
    action: 'set_model',
    agentId: 'Root',
    model: 'test-provider/next-model',
  });
  assert.equal(applied.details.status, 'applied');
  assert.deepEqual(effects, [{ provider: 'test-provider', model: 'next-model' }]);
  assert.equal(manager.store.snapshot().agents[rootId].model, 'next-model');
  await manager.store.releaseRuntime('child', runtimeOwner, 'runtime_parked', 'configuration_test_complete');
});

test('recipient drains overlap startup, same-turn input, correlation, recovery, and exact-session resume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-failed-reacquire-'));
  const sessionFile = join(root, 'parent.jsonl');
  const optionalExtension = join(await realpath(root), 'optional-extension.mjs');
  await writeFile(optionalExtension, 'export default function optionalExtension() {}\n');
  const env = { FAKE_ACTOR_DELAY_MS: '2500', FAKE_CONTROL_DELAY_MS: '500', FAKE_STATE_DELAY_MS: '50' };
  const rootModelChanges = [];
  const rootThinkingChanges = [];
  let acceptRootModel = true;
  let acceptRootThinking = true;
  let approvalEntered = false;
  const approvalsStarted = [];
  let releaseApproval = () => undefined;
  const approvalGate = new Promise((resolveApproval) => {
    releaseApproval = resolveApproval;
  });
  const options = {
    sessionId: 'parent-session',
    sessionFile,
    cwd: root,
    agentDir: join(root, 'agent-state'),
    invocation: { command: process.execPath, args: [resolve('test/fixtures/fake-actor-rpc.mjs')] },
    env,
    sessionHost: createPiSessionHost(),
    provider: 'test-provider',
    model: 'test-model',
    thinking: 'low',
    models: [
      { provider: 'test-provider', id: 'test-model', contextWindow: 100_000, reasoning: true },
      { provider: 'test-provider', id: 'next-model', contextWindow: 100_000, reasoning: true },
      { provider: 'test-provider', id: 'plain-model', contextWindow: 100_000, reasoning: false },
    ],
    setRootModel: async (provider, model) => {
      rootModelChanges.push({ provider, model });
      return acceptRootModel;
    },
    setRootThinking: async (thinking) => {
      rootThinkingChanges.push(thinking);
      return acceptRootThinking;
    },
    maxDepth: 2,
    rootConfiguration: {
      maxOpenAgents: 10,
      maxDepth: 2,
      serviceGrant: ['spawn', 'directory', 'message', 'watch', 'steer', 'follow_up', 'interrupt'],
      extensions: { entries: [], allowedPaths: [] },
      sources: {
        maxOpenAgents: 'built-in',
        maxDepth: 'built-in',
        agentNames: 'built-in',
        serviceGrant: 'built-in',
      },
    },
    managedExtensionHost: {
      sources: () => [{ specifier: 'fixture:optional-extension', scope: 'user' }],
      async approve(specifier) {
        approvalsStarted.push(specifier);
        if (specifier === 'fixture:slow-extension') {
          approvalEntered = true;
          await approvalGate;
        } else if (specifier !== 'fixture:optional-extension') throw new Error('Extension source is unavailable');
        return {
          specifier,
          state: 'allow',
          source: 'global',
          paths: [optionalExtension],
        };
      },
      async resolve(settings) {
        const entries = Object.entries(settings).map(([specifier, state]) => {
          if (specifier !== 'fixture:optional-extension' && specifier !== 'fixture:slow-extension')
            throw new Error('Extension source is unavailable');
          return {
            specifier,
            state,
            source: 'global',
            paths: state === 'deny' ? [] : [optionalExtension],
          };
        });
        return {
          entries,
          allowedPaths: entries.flatMap((entry) => entry.paths),
        };
      },
    },
  };
  const emptySource = join(root, 'empty-source-session.jsonl');
  await writeFile(emptySource, '');
  await assert.rejects(options.sessionHost.inspectSession(emptySource));
  assert.equal((await readFile(emptySource)).byteLength, 0, 'session preview must not initialize the source file');
  const legacySource = join(root, 'legacy-v1-session.jsonl');
  const legacyBytes = Buffer.from(
    `${JSON.stringify({ type: 'session', id: 'legacy-v1-session', timestamp: '2026-09-07T00:00:00.000Z', cwd: root })}\n${JSON.stringify(
      {
        type: 'message',
        timestamp: '2026-09-07T00:00:01.000Z',
        message: { role: 'user', content: 'LEGACY_HANDOFF_CONTEXT', timestamp: 1 },
      },
    )}\n`,
  );
  await writeFile(legacySource, legacyBytes);
  assert.match(
    JSON.stringify((await options.sessionHost.inspectSession(legacySource)).messages),
    /LEGACY_HANDOFF_CONTEXT/u,
  );
  assert.deepEqual(await readFile(legacySource), legacyBytes);
  const cyclicSource = join(root, 'cyclic-session.jsonl');
  const cyclicBytes = Buffer.from(
    `${JSON.stringify({ type: 'session', version: 3, id: 'cyclic-session', timestamp: '2026-09-07T00:00:00.000Z', cwd: root })}\n${JSON.stringify(
      {
        type: 'message',
        id: 'cycle',
        parentId: 'cycle',
        timestamp: '2026-09-07T00:00:01.000Z',
        message: { role: 'user', content: 'must not be evaluated', timestamp: 1 },
      },
    )}\n`,
  );
  await writeFile(cyclicSource, cyclicBytes);
  await assert.rejects(options.sessionHost.inspectSession(cyclicSource), /ancestry is invalid or cyclic/u);
  assert.deepEqual(await readFile(cyclicSource), cyclicBytes);
  const legacyFork = await options.sessionHost.forkSession({
    sourceFile: legacySource,
    targetCwd: root,
    targetSessionDir: join(root, 'legacy-fork'),
    sessionId: 'legacy-v1-fork',
    operationId: 'legacy-v1-operation',
    kind: 'adopt',
    contextNote: 'Legacy session adopted for continued work.',
    destinationName: 'Legacy specialist',
  });
  assert.match(
    JSON.stringify((await options.sessionHost.inspectSession(legacyFork.sessionFile)).messages),
    /LEGACY_HANDOFF_CONTEXT/u,
  );
  assert.deepEqual(await readFile(legacySource), legacyBytes);
  let manager = new LuminariesManager(options);
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();
  try {
    const service = manager.hostForService();
    const parent = manager.hostForParent(context(root, sessionFile));
    const spawnInput = {
      requestId: 'spawn-failure-recovery',
      name: 'recoverable',
      assignment: 'remain reusable\nwith ordinary multiline direction',
      ownershipBoundary: 'one task',
      grants: { spawn: false },
    };
    await assert.rejects(
      service.execute(
        {
          toolName: 'luminaries_spawn',
          input: {
            ...spawnInput,
            requestId: 'spawn-missing-cwd',
            name: 'missing-cwd',
            cwd: join(root, 'missing-cwd'),
          },
        },
        undefined,
      ),
      (error) =>
        error.message ===
        `Working directory '${join(root, 'missing-cwd')}' does not exist. Choose an existing authorized directory or omit cwd to use the parent's working directory.`,
    );
    const explicitCwd = join(root, 'explicit-spawn-cwd');
    await mkdir(explicitCwd);
    const parallelInput = {
      ...spawnInput,
      requestId: 'spawn-parallel',
      name: 'parallel',
      assignment: 'start in parallel',
      cwd: explicitCwd,
    };
    const requesterInput = {
      ...spawnInput,
      requestId: 'spawn-requester',
      name: 'requester',
      assignment: 'exercise correlation',
      grants: { spawn: true, maxDepth: 2 },
    };
    const responderInput = {
      ...spawnInput,
      requestId: 'spawn-responder',
      name: 'responder',
      assignment: 'reply independently',
    };
    const admissions = await Promise.all(
      [spawnInput, parallelInput, requesterInput, responderInput].map(async (input) => {
        const receipt = await service.execute({ toolName: 'luminaries_spawn', input }, undefined);
        const snapshot = manager.store.snapshot();
        const agent = snapshot.agents[receipt.details.agent.agentId];
        assert.ok(agent);
        const startingInput = Object.values(snapshot.mailbox).find(
          (record) =>
            record.lane !== 'direct' &&
            record.recipientId === agent.agentId &&
            record.acceptedSeq === agent.createdSeq + 1,
        );
        assert.ok(startingInput);
        return { receipt, consumedAtReceipt: startingInput.consumedSeq };
      }),
    );
    const [spawned, parallel, requester, responder] = admissions.map((admission) => admission.receipt);
    const agentId = spawned.details.agent.agentId;
    const parallelId = parallel.details.agent.agentId;
    const requesterId = requester.details.agent.agentId;
    const responderId = responder.details.agent.agentId;
    const spawnedIds = [agentId, parallelId, requesterId, responderId];
    assert.deepEqual(
      [spawned, parallel, requester, responder].map((receipt) => receipt.details.startupState),
      ['starting', 'starting', 'starting', 'starting'],
    );
    assert.ok(admissions.every((admission) => admission.consumedAtReceipt === undefined));
    const serviceHandleInspection = await service.execute(
      {
        toolName: 'luminaries_directory',
        input: {
          requestId: 'service-human-handle-inspect',
          action: 'inspect',
          agentId: spawned.details.agent.humanHandle,
          view: 'coordination',
        },
      },
      undefined,
    );
    assert.equal(serviceHandleInspection.details.agentId, agentId);
    assert.deepEqual(spawned.details.effectiveConfiguration, {
      model: 'test-provider/test-model',
      thinking: 'low',
      contextMode: 'fresh',
      cwd: await realpath(root),
      resources: { extensions: [], skills: [], promptTemplates: [], themes: [] },
    });
    assert.equal(parallel.details.effectiveConfiguration.cwd, await realpath(explicitCwd));
    assert.equal(openCollaboratorCount(manager.store.snapshot()), 4);
    await waitFor(
      () =>
        spawnedIds.every((spawnedId) => {
          const snapshot = manager.store.snapshot();
          const agent = snapshot.agents[spawnedId];
          const startingInput = Object.values(snapshot.mailbox).find(
            (record) =>
              record.lane !== 'direct' &&
              record.recipientId === spawnedId &&
              record.acceptedSeq === agent.createdSeq + 1,
          );
          return (
            startingInput?.consumedSeq !== undefined &&
            manager.actors.has(spawnedId) &&
            Object.values(snapshot.activations).some(
              (activation) => activation.agentId === spawnedId && activation.state === 'running',
            )
          );
        }),
      10_000,
    );
    for (const spawnedId of spawnedIds) {
      assert.equal(
        Object.values(manager.store.snapshot().mailbox).filter(
          (record) => record.lane !== 'direct' && record.recipientId === spawnedId && record.consumedSeq !== undefined,
        ).length,
        1,
      );
      assert.ok(
        Object.values(manager.store.snapshot().activations).some(
          (activation) => activation.agentId === spawnedId && activation.state === 'running',
        ),
      );
    }
    assert.equal(
      Object.values(manager.store.snapshot().mailbox).filter((record) => record.lane === 'direct').length,
      0,
    );
    const callerFor = (id) => {
      const agent = manager.store.snapshot().agents[id];
      assert.ok(agent.runtimeOwner);
      return {
        kind: 'child',
        agentId: id,
        rootId: manager.store.snapshot().root.rootId,
        runtimeOwner: agent.runtimeOwner,
        generation: manager.generationId,
        sessionId: agent.sessionId,
      };
    };
    const duplicate = await service.execute({ toolName: 'luminaries_spawn', input: spawnInput }, undefined);
    assert.equal(duplicate.details.duplicate, true);
    assert.equal(duplicate.details.agent.agentId, agentId);
    const nested = await manager.executeForCaller(
      callerFor(requesterId),
      {
        toolName: 'luminaries_spawn',
        input: {
          requestId: 'structural-child',
          name: 'nested',
          assignment: 'prove structural startup accounting',
          ownershipBoundary: 'one nested result',
          grants: { spawn: false },
        },
      },
      undefined,
    );
    assert.equal(nested.details.startupState, 'starting');
    const postSpawnMessage = await manager.executeForCaller(
      callerFor(requesterId),
      {
        toolName: 'luminaries_message',
        input: {
          requestId: 'message-after-structural-spawn',
          action: 'send',
          recipientId: responderId,
          message: 'Parent result after structural child admission.',
        },
      },
      undefined,
    );
    assert.notEqual(postSpawnMessage.details.status, 'refused');

    const firstOperationId = '11111111-1111-4111-8111-111111111101';
    const secondOperationId = '11111111-1111-4111-8111-111111111102';
    const followUpOperationId = '11111111-1111-4111-8111-111111111103';
    const independentOperationId = '11111111-1111-4111-8111-111111111104';
    const holdOperationId = '11111111-1111-4111-8111-111111111105';
    const priorityOperationId = '11111111-1111-4111-8111-111111111106';
    const sourceBoundaryOperationId = '11111111-1111-4111-8111-111111111107';
    const continuationOperationId = '11111111-1111-4111-8111-111111111108';
    const inputEvent = (operationId) =>
      Object.values(manager.store.snapshot().mailbox).find(
        (record) =>
          record.lane !== 'direct' &&
          record.bridgeRequestId ===
            `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}ui-${sha256(operationId).slice(0, 40)}`,
      );
    const heldGrantOperationId = '11111111-1111-4111-8111-111111111100';
    await waitFor(() =>
      Object.values(manager.store.snapshot().activations).some(
        (activation) => activation.agentId === nested.details.agent.agentId && activation.state === 'running',
      ),
    );
    await manager.operatorInput(
      nested.details.agent.agentId,
      'Hold a descendant follow-up boundary.',
      'follow_up',
      heldGrantOperationId,
    );
    await waitFor(() => inputEvent(heldGrantOperationId)?.status === 'sending');
    let grantTimeout;
    const grant = await Promise.race([
      parent.execute(
        {
          toolName: 'luminaries_control',
          input: {
            requestId: 'grant-while-descendant-delivery-pending',
            action: 'set_grants',
            agentId: requesterId,
            grants: { peerInterrupt: true },
          },
        },
        undefined,
      ),
      new Promise((_, reject) => {
        grantTimeout = setTimeout(() => reject(new Error('Grant change waited for descendant delivery')), 750);
        grantTimeout.unref();
      }),
    ]).finally(() => clearTimeout(grantTimeout));
    assert.equal(grant.details.status, 'applied');
    assert.equal(manager.store.snapshot().agents[requesterId].capabilities.peerInterrupt, true);
    assert.equal(inputEvent(heldGrantOperationId).status, 'sending');
    const firstInput = manager.operatorInput(agentId, 'Same-turn operator input one.', 'auto', firstOperationId);
    const secondInput = manager.operatorInput(agentId, 'Same-turn operator input two.', 'auto', secondOperationId);
    const followUp = manager.operatorInput(agentId, 'Explicit later follow-up.', 'follow_up', followUpOperationId);
    const independentInput = manager.operatorInput(
      requesterId,
      'Independent target input.',
      'auto',
      independentOperationId,
    );
    const notification = service.execute(
      {
        toolName: 'luminaries_message',
        input: {
          requestId: 'notify-without-turn',
          action: 'send',
          recipientId: agentId,
          message: 'Record without model motion.',
          mode: 'notify_only',
        },
      },
      undefined,
    );
    const [firstDisposition, secondDisposition, followUpDisposition, independentDisposition, notifyReceipt] =
      await Promise.all([firstInput, secondInput, followUp, independentInput, notification]);
    assert.deepEqual(
      [firstDisposition, secondDisposition, followUpDisposition, independentDisposition],
      ['steered', 'steered', 'follow_up_queued', 'steered'],
    );
    await waitFor(
      () =>
        inputEvent(firstOperationId)?.consumedSeq !== undefined &&
        inputEvent(secondOperationId)?.consumedSeq !== undefined &&
        inputEvent(independentOperationId)?.consumedSeq !== undefined,
    );
    const firstEvent = inputEvent(firstOperationId);
    const secondEvent = inputEvent(secondOperationId);
    const queuedFollowUp = inputEvent(followUpOperationId);
    assert.ok(firstEvent.acceptedSeq < secondEvent.acceptedSeq);
    assert.ok(firstEvent.consumedSeq < secondEvent.consumedSeq);
    assert.equal(firstEvent.activationId, secondEvent.activationId);
    assert.equal(queuedFollowUp.consumedSeq, undefined);
    assert.equal(mailboxEvent(manager.store.snapshot(), notifyReceipt.details.eventId).outcomeCode, 'notify_only');
    assert.ok(
      Object.values(manager.store.snapshot().activations).some(
        (activation) => activation.agentId === agentId && activation.state === 'running',
      ),
    );
    assert.ok(
      Object.values(manager.store.snapshot().activations).some(
        (activation) => activation.agentId === requesterId && activation.state === 'running',
      ),
    );

    await manager.operatorInput(responderId, 'Hold the priority gate.', 'auto', holdOperationId);
    await waitFor(
      () => inputEvent(holdOperationId)?.status === 'sending' && inputEvent(holdOperationId)?.consumedSeq === undefined,
    );
    const systemPriority = await manager.store.admitSystemEvent({
      dedupeKey: 'section-3-system-priority',
      type: 'control_failure',
      senderId: agentId,
      recipientId: responderId,
      message: 'System-priority input.',
      wake: true,
      traceId: firstEvent.traceId,
      causationId: firstEvent.eventId,
    });
    const peerPriorityInput = {
      requestId: 'section-3-peer-priority',
      action: 'send',
      recipientId: responderId,
      message: 'Peer-priority input.',
    };
    const peerPriority = manager.executeForCaller(
      callerFor(agentId),
      { toolName: 'luminaries_message', input: peerPriorityInput },
      undefined,
    );
    const operatorPriority = manager.operatorInput(
      responderId,
      'Operator-priority input.',
      'auto',
      priorityOperationId,
    );
    const [peerPriorityReceipt] = await Promise.all([peerPriority, operatorPriority]);
    await waitFor(
      () =>
        inputEvent(priorityOperationId)?.consumedSeq !== undefined &&
        mailboxEvent(manager.store.snapshot(), systemPriority.value.event.eventId)?.consumedSeq !== undefined &&
        mailboxEvent(manager.store.snapshot(), peerPriorityReceipt.details.eventId)?.consumedSeq !== undefined,
    );
    assert.ok(
      inputEvent(priorityOperationId).consumedSeq <
        mailboxEvent(manager.store.snapshot(), systemPriority.value.event.eventId).consumedSeq,
    );
    assert.ok(
      mailboxEvent(manager.store.snapshot(), systemPriority.value.event.eventId).consumedSeq <
        mailboxEvent(manager.store.snapshot(), peerPriorityReceipt.details.eventId).consumedSeq,
    );
    const quietRoutine = await manager.store.admitSystemEvent({
      dedupeKey: 'section-3-routine-cannot-wake',
      type: 'routine',
      senderId: agentId,
      recipientId: responderId,
      message: 'Routine remains informational.',
      wake: true,
      traceId: firstEvent.traceId,
      causationId: firstEvent.eventId,
    });
    assert.equal(quietRoutine.value.event.mode, 'notify_only');
    assert.equal(quietRoutine.value.event.consumedSeq, undefined);
    await waitFor(() => inputEvent(followUpOperationId)?.consumedSeq !== undefined, 10_000);
    const sourceBoundaryDisposition = await manager.operatorInput(
      agentId,
      'Keep the current source boundary active.',
      'auto',
      sourceBoundaryOperationId,
    );
    assert.ok(sourceBoundaryDisposition === 'steered' || sourceBoundaryDisposition === 'woken');
    await waitFor(() => {
      const snapshot = manager.store.snapshot();
      const event = inputEvent(sourceBoundaryOperationId);
      return event?.consumedSeq !== undefined && snapshot.activations[event.activationId]?.state === 'running';
    }, 10_000);

    const requestInput = {
      requestId: 'child-request-reply',
      action: 'request',
      recipientId: responderId,
      message: 'Return a correlated answer.',
    };
    const request = await manager.executeForCaller(
      callerFor(agentId),
      { toolName: 'luminaries_message', input: requestInput },
      undefined,
    );
    assert.equal(request.terminate, true);
    await waitFor(() => mailboxEvent(manager.store.snapshot(), request.details.eventId)?.consumedSeq !== undefined);
    const replyInput = {
      requestId: 'child-correlated-reply',
      action: 'reply',
      correlationId: request.details.correlationId,
      message: 'Correlated answer.',
    };
    const reply = await manager.executeForCaller(
      callerFor(responderId),
      { toolName: 'luminaries_message', input: replyInput },
      undefined,
    );
    await waitFor(
      () => mailboxEvent(manager.store.snapshot(), reply.details.eventId)?.consumedSeq !== undefined,
      10_000,
    );
    assert.equal(manager.store.snapshot().requests[request.details.correlationId], undefined);
    await waitFor(() => mailboxEvent(manager.store.snapshot(), reply.details.eventId)?.status === 'settled', 10_000);
    const interactionProjection = manager.commandCenterProjection();
    const responderInteractions = interactionProjection.agents.find(
      (candidate) => candidate.agentId === responderId,
    ).interactions;
    assert.ok(responderInteractions.includes(`Replied to ${spawned.details.agent.humanHandle}: Correlated answer.`));
    assert.equal(
      await manager.operatorInput(
        agentId,
        'Continue after reviewing the correlated answer.',
        'auto',
        continuationOperationId,
      ),
      'woken',
    );
    await waitFor(() => {
      const event = inputEvent(continuationOperationId);
      return (
        event?.consumedSeq !== undefined &&
        manager.store.snapshot().activations[event.activationId]?.state === 'running'
      );
    }, 10_000);

    const cancelInput = {
      requestId: 'child-request-cancel',
      action: 'request',
      recipientId: responderId,
      message: 'This request will be cancelled.',
    };
    const cancellable = await manager.executeForCaller(
      callerFor(agentId),
      { toolName: 'luminaries_message', input: cancelInput },
      undefined,
    );
    const activeRequestWait = await manager.executeForCaller(
      callerFor(agentId),
      {
        toolName: 'luminaries_await',
        input: {
          requestId: 'await-active-owned-request',
          action: 'wait',
          requestIds: [cancellable.details.correlationId],
        },
      },
      undefined,
    );
    assert.equal(activeRequestWait.details.status, 'pending');
    await assert.rejects(
      manager.executeForCaller(
        callerFor(responderId),
        {
          toolName: 'luminaries_await',
          input: {
            requestId: 'await-foreign-request',
            action: 'wait',
            requestIds: [cancellable.details.correlationId],
          },
        },
        undefined,
      ),
      { code: 'authority_denied' },
    );
    const cancel = {
      requestId: 'child-cancel',
      action: 'cancel',
      correlationId: cancellable.details.correlationId,
    };
    const cancelled = await manager.executeForCaller(
      callerFor(agentId),
      { toolName: 'luminaries_message', input: cancel },
      undefined,
    );
    assert.equal(cancelled.details.requestStatus, 'cancelled');
    assert.equal(manager.store.snapshot().requests[cancellable.details.correlationId], undefined);
    for (const [requestId, reference] of [
      ['await-retired-owned-request', cancellable.details.correlationId],
      ['await-unknown-request', 'never-issued-request'],
    ])
      await assert.rejects(
        manager.executeForCaller(
          callerFor(agentId),
          {
            toolName: 'luminaries_await',
            input: { requestId, action: 'wait', requestIds: [reference] },
          },
          undefined,
        ),
        { code: 'request_missing' },
      );

    const timeoutInput = {
      requestId: 'child-request-timeout',
      action: 'request',
      recipientId: responderId,
      message: 'Reply after the deadline.',
      deadlineMs: 1_000,
    };
    const timeoutRequest = await manager.executeForCaller(
      callerFor(agentId),
      { toolName: 'luminaries_message', input: timeoutInput },
      undefined,
    );
    await waitFor(
      () => mailboxEvent(manager.store.snapshot(), timeoutRequest.details.eventId)?.consumedSeq !== undefined,
    );
    await waitFor(() => {
      const current = manager.store.snapshot();
      return current.requests[timeoutRequest.details.correlationId] === undefined;
    }, 5_000);
    const lateReplyInput = {
      requestId: 'child-late-reply',
      action: 'reply',
      correlationId: timeoutRequest.details.correlationId,
      message: 'Late answer remains visible.',
    };
    await assert.rejects(
      manager.executeForCaller(
        callerFor(responderId),
        { toolName: 'luminaries_message', input: lateReplyInput },
        undefined,
      ),
      /does not exist/,
    );

    const interruptedActivation = Object.values(manager.store.snapshot().activations).find(
      (activation) => activation.agentId === agentId && activation.state === 'running',
    );
    assert.ok(interruptedActivation);
    const interrupted = await manager.operatorExecute('luminaries_control', {
      action: 'interrupt',
      agentId,
      message: 'Replacement after interrupt.',
    });
    await waitFor(() => mailboxEvent(manager.store.snapshot(), interrupted.details.eventId)?.consumedSeq !== undefined);
    assert.equal(manager.store.snapshot().activations[interruptedActivation.activationId].state, 'aborted');

    const closedParallelSessionFile = manager.store.snapshot().agents[parallelId].sessionFile;
    await manager.operatorExecute('luminaries_control', { action: 'close', agentId: parallelId });
    assert.equal(manager.store.snapshot().agents[parallelId]?.lifecycle, 'closed');
    await waitFor(() => manager.store.snapshot().agents[parallelId] === undefined);
    assert.equal((await manager.store.closedAgentLineage(parallelId))[0]?.lifecycle, 'closed');
    await assert.rejects(
      service.execute(
        {
          toolName: 'luminaries_message',
          input: {
            requestId: 'closed-multicast-target',
            action: 'multicast',
            recipientIds: [agentId, parallelId],
            message: 'Closed model targets are unavailable.',
            mode: 'notify_only',
          },
        },
        undefined,
      ),
      /No luminary matches/,
    );

    const leaf = manager.store.snapshot().agents[agentId].capabilities;
    assert.deepEqual(
      {
        spawn: leaf.spawn,
        maxDepth: leaf.maxDepth,
      },
      { spawn: false, maxDepth: 1 },
    );
    assert.ok(firstEvent.acceptedSeq > manager.store.snapshot().agents[agentId].createdSeq + 1);

    env.FAKE_STATE_STREAMING = '1';
    const failedInput = { ...spawnInput, requestId: 'spawn-start-failure', name: 'attention' };
    const failedReceipt = await service.execute({ toolName: 'luminaries_spawn', input: failedInput }, undefined);
    assert.equal(failedReceipt.details.startupState, 'starting');
    const failedId = failedReceipt.details.agent.agentId;
    await waitFor(() => runtimeState(manager.store, failedId) === 'needs_attention', 10_000);
    await waitFor(
      () =>
        Object.values(manager.store.snapshot().mailbox).find(
          (record) =>
            record.lane === 'system' &&
            record.systemType === 'health_attention' &&
            record.senderId === failedId &&
            record.recipientId === manager.store.snapshot().root.rootId,
        ),
      10_000,
    );
    assert.equal(
      Object.values(manager.store.snapshot().mailbox).filter(
        (record) =>
          record.lane === 'system' &&
          record.systemType === 'health_attention' &&
          record.senderId === failedId &&
          record.recipientId === manager.store.snapshot().root.rootId,
      ).length,
      1,
    );
    const failedSessionId = manager.store.snapshot().agents[failedId].sessionId;
    assert.equal(runtimeState(manager.store, failedId), 'needs_attention');
    assert.equal(manager.store.snapshot().agents[failedId].lifecycle, 'open');
    assert.equal(manager.store.snapshot().agents[failedId].runtimeOwner, undefined);
    const duplicateFailure = await service.execute({ toolName: 'luminaries_spawn', input: failedInput }, undefined);
    assert.equal(duplicateFailure.details.duplicate, true);
    assert.equal(duplicateFailure.details.agent.agentId, failedId);
    assert.equal(duplicateFailure.details.startupState, 'needs_attention');
    assert.equal(
      Object.values(manager.store.snapshot().agents).filter((agent) => agent.displayName.value === 'attention').length,
      1,
    );

    delete env.FAKE_STATE_STREAMING;
    await manager.operatorInput(failedId, 'Recover on the same private identity.', 'auto');
    await waitFor(() => runtimeState(manager.store, failedId) === 'idle', 15_000);
    assert.equal(manager.store.snapshot().agents[failedId].sessionId, failedSessionId);
    await waitFor(
      () => [agentId, requesterId, responderId, failedId].every((id) => runtimeState(manager.store, id) === 'idle'),
      15_000,
    );
    const agentHandle = spawned.details.agent.humanHandle;
    const preExtensionAgent = manager.store.snapshot().agents[agentId];
    const preExtensionPid = manager.actors.get(agentId)?.process?.pid;
    const initialHistory = JSON.stringify(
      await options.sessionHost.readMessages(
        preExtensionAgent.sessionFile,
        preExtensionAgent.cwd,
        preExtensionAgent.sessionId,
      ),
    );
    const assignmentOccurrences = initialHistory.split('remain reusable').length - 1;
    await assert.rejects(
      manager.operatorExecute('luminaries_control', {
        action: 'set_extensions',
        agentId: agentHandle,
        extensions: ['fixture:not-approved'],
      }),
      /not allowed for explicit child selection/u,
    );
    assert.equal(manager.actors.get(agentId)?.process?.pid, preExtensionPid);
    assert.deepEqual(manager.store.snapshot().agents[agentId].launch.extensions, []);
    const extensionDescriptor = (await discoverAttachmentDescriptors(options.agentDir, root))[0];
    if (!extensionDescriptor) throw new Error('Extension acceptance attachment descriptor was not published');
    const extensionClient = await LuminariesAttachmentClient.connect(extensionDescriptor.descriptorPath);
    t.after(() => extensionClient.close());
    assert.deepEqual(extensionClient.operatorExtensionSources(), [
      { specifier: 'fixture:optional-extension', scope: 'user' },
    ]);
    await extensionClient.operatorApproveExtension('fixture:optional-extension', 'user', false);
    await manager.operatorExecute('luminaries_control', { action: 'resume', agentId: parallelId });
    assert.deepEqual(manager.store.snapshot().agents[parallelId].spawnGrant.extensions, undefined);
    assert.deepEqual(manager.store.snapshot().agents[parallelId].capabilities.extensions, [optionalExtension]);
    const resumedExtensionChange = await manager.operatorExecute('luminaries_control', {
      action: 'set_extensions',
      agentId: parallelId,
      extensions: ['fixture:optional-extension'],
    });
    assert.equal(resumedExtensionChange.details.status, 'saved');
    assert.deepEqual(manager.store.snapshot().agents[parallelId].launch.extensions, [optionalExtension]);
    await manager.operatorExecute('luminaries_control', { action: 'close', agentId: parallelId });
    await waitFor(() => manager.store.snapshot().agents[parallelId] === undefined);
    assert.deepEqual(manager.store.snapshot().agents[agentId].capabilities.extensions, [optionalExtension]);
    await manager.store.setAgentCapabilities(agentId, { extensions: [] }, { kind: 'operator' });
    await assert.rejects(
      manager.operatorExecute('luminaries_control', {
        action: 'set_extensions',
        agentId: agentHandle,
        extensions: ['fixture:optional-extension'],
      }),
      { code: 'capability_denied' },
    );
    assert.deepEqual(manager.store.snapshot().agents[agentId].launch.extensions, []);
    await manager.store.setAgentCapabilities(agentId, { extensions: [optionalExtension] }, { kind: 'operator' });
    await assert.rejects(
      manager.executeForCaller(callerFor(agentId), {
        toolName: 'luminaries_control',
        input: {
          requestId: 'self-extension-change',
          action: 'set_extensions',
          agentId,
          extensions: ['fixture:optional-extension'],
        },
      }),
      { code: 'authority_denied' },
    );
    await manager.operatorInput(agentId, 'PRE_EXTENSION_CONTEXT', 'auto');
    await waitFor(() =>
      Object.values(manager.store.snapshot().activations).some(
        (activation) => activation.agentId === agentId && activation.state === 'running',
      ),
    );
    const extensionChange = await manager.operatorExecute('luminaries_control', {
      action: 'set_extensions',
      agentId: agentHandle,
      extensions: ['fixture:optional-extension'],
    });
    assert.equal(extensionChange.details.status, 'pending');
    assert.equal(manager.store.snapshot().agents[agentId].pendingConfiguration?.kind, 'extensions');
    await waitFor(
      () =>
        manager.store.snapshot().agents[agentId].pendingConfiguration === undefined &&
        runtimeState(manager.store, agentId) === 'runtime_parked',
      15_000,
    );
    const configuredAgent = manager.store.snapshot().agents[agentId];
    assert.equal(configuredAgent.agentId, preExtensionAgent.agentId);
    assert.equal(configuredAgent.sessionId, preExtensionAgent.sessionId);
    assert.equal(configuredAgent.sessionFile, preExtensionAgent.sessionFile);
    assert.deepEqual(configuredAgent.launch.extensions, [optionalExtension]);
    assert.deepEqual(configuredAgent.launch.extensionSources, ['fixture:optional-extension']);
    const beforeWake = JSON.stringify(
      await options.sessionHost.readMessages(
        configuredAgent.sessionFile,
        configuredAgent.cwd,
        configuredAgent.sessionId,
      ),
    );
    assert.equal(beforeWake.split('remain reusable').length - 1, assignmentOccurrences);
    const extensionWakeOperationId = '88888888-8888-4888-8888-888888888888';
    const extensionWakeBridgeRequestId = `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}ui-${sha256(extensionWakeOperationId).slice(0, 40)}`;
    await manager.operatorInput(agentId, 'USE_EXTENSION_AFTER_WAKE', 'auto', extensionWakeOperationId);
    await waitFor(() => manager.actors.has(agentId));
    assert.ok(manager.actors.get(agentId)?.process?.spawnargs.includes(optionalExtension));
    await waitFor(
      () =>
        Object.values(manager.store.snapshot().mailbox).some(
          (record) =>
            record.lane !== 'direct' &&
            record.bridgeRequestId === extensionWakeBridgeRequestId &&
            record.consumedSeq !== undefined,
        ),
      15_000,
    );
    await waitFor(() => runtimeState(manager.store, agentId) === 'idle', 15_000);
    const afterWake = JSON.stringify(
      await options.sessionHost.readMessages(
        configuredAgent.sessionFile,
        configuredAgent.cwd,
        configuredAgent.sessionId,
      ),
    );
    assert.equal(afterWake.split('remain reusable').length - 1, assignmentOccurrences);
    assert.match(afterWake, /PRE_EXTENSION_CONTEXT.*USE_EXTENSION_AFTER_WAKE/su);
    const busyConfigurationOperationId = '99999999-9999-4999-8999-999999999999';
    const busyConfigurationBridgeRequestId = `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}ui-${sha256(busyConfigurationOperationId).slice(0, 40)}`;
    await manager.operatorInput(agentId, 'BUSY_CONFIGURATION_INPUT', 'auto', busyConfigurationOperationId);
    await waitFor(() =>
      Object.values(manager.store.snapshot().activations).some(
        (activation) => activation.agentId === agentId && activation.state === 'running',
      ),
    );
    const busyHandoff = await extensionClient.operatorDetachSession(agentId);
    assert.equal(busyHandoff.status, 'not_ready');
    assert.equal(manager.store.snapshot().agents[agentId].lifecycle, 'open');
    const busyModelChange = await extensionClient.operatorExecute('luminaries_control', {
      action: 'set_model',
      agentId: agentHandle,
      model: 'test-provider/next-model',
    });
    assert.equal(busyModelChange.details.status, 'not_ready');
    assert.equal(manager.store.snapshot().agents[agentId].model, 'test-model');
    await waitFor(
      () =>
        Object.values(manager.store.snapshot().mailbox).some(
          (record) =>
            record.lane !== 'direct' &&
            record.bridgeRequestId === busyConfigurationBridgeRequestId &&
            record.consumedSeq !== undefined,
        ),
      15_000,
    );
    await waitFor(() => runtimeState(manager.store, agentId) === 'idle', 15_000);
    const controlsBeforeSettledInterrupt = mailboxControls(manager.store.snapshot()).length;
    assert.equal(await manager.operatorInterrupt(agentId), 'already_finished');
    assert.equal(mailboxControls(manager.store.snapshot()).length, controlsBeforeSettledInterrupt);
    await extensionClient.close();
    const modelChange = await manager.operatorExecute('luminaries_control', {
      action: 'set_model',
      agentId: agentHandle,
      model: 'test-provider/plain-model',
    });
    assert.equal(modelChange.details.status, 'applied');
    assert.equal(manager.store.snapshot().agents[agentId].thinking, 'off');
    await assert.rejects(
      manager.operatorExecute('luminaries_control', { action: 'set_thinking', agentId: agentHandle, thinking: 'high' }),
      /does not support reasoning/,
    );
    const rootId = manager.store.snapshot().root.rootId;
    await manager.parentBeforeAgentStart('ROOT_BUSY_CONTEXT_PREFLIGHT');
    await manager.parentAgentStart();
    const openBeforeBusySpawn = openCollaboratorCount(manager.store.snapshot());
    const busySpawn = await manager.operatorExecute('luminaries_spawn', {
      assignment: 'Do not admit this expert while Root is active.',
      ownershipBoundary: 'No files.',
      context: 'recent',
    });
    assert.equal(busySpawn.details.status, 'not_ready');
    assert.equal(openCollaboratorCount(manager.store.snapshot()), openBeforeBusySpawn);
    await manager.parentAgentSettled();
    const rootModelChange = await manager.operatorExecute('luminaries_control', {
      action: 'set_model',
      agentId: 'Root',
      model: 'test-provider/next-model',
    });
    assert.equal(rootModelChange.details.status, 'applied');
    assert.deepEqual(rootModelChange.details.effectiveConfiguration, {
      model: 'test-provider/next-model',
      thinking: 'low',
    });
    assert.deepEqual(rootModelChanges.at(-1), { provider: 'test-provider', model: 'next-model' });
    assert.equal(manager.store.snapshot().agents[rootId].model, 'next-model');
    const rootThinkingChange = await manager.operatorExecute('luminaries_control', {
      action: 'set_thinking',
      agentId: rootId,
      thinking: 'high',
    });
    assert.equal(rootThinkingChange.details.status, 'applied');
    assert.deepEqual(rootThinkingChange.details.effectiveConfiguration, {
      model: 'test-provider/next-model',
      thinking: 'high',
    });
    assert.equal(rootThinkingChanges.at(-1), 'high');
    assert.equal(manager.store.snapshot().agents[rootId].thinking, 'high');
    acceptRootModel = false;
    const refusedModel = await manager.operatorExecute('luminaries_control', {
      action: 'set_model',
      agentId: 'Root',
      model: 'test-provider/plain-model',
    });
    assert.equal(refusedModel.details.status, 'refused');
    assert.equal(refusedModel.details.effectiveConfiguration, undefined);
    assert.match(refusedModel.details.error, /refused/u);
    acceptRootModel = true;
    acceptRootThinking = false;
    const uncertainModel = await manager.operatorExecute('luminaries_control', {
      action: 'set_model',
      agentId: 'Root',
      model: 'test-provider/plain-model',
    });
    assert.equal(uncertainModel.details.status, 'indeterminate');
    assert.equal(uncertainModel.details.effectiveConfiguration, undefined);
    assert.match(uncertainModel.details.error, /changed model but did not confirm/u);
    acceptRootThinking = true;
    const uniqueName = await manager.operatorExecute('luminaries_directory', {
      action: 'inspect',
      agentId: 'responder',
    });
    assert.equal(uniqueName.details.agent.agentId, responderId);
    await manager.store.updateAgentMetadata(agentId, { displayName: 'Vega' }, { kind: 'operator' });
    await manager.store.updateAgentMetadata(requesterId, { displayName: 'Vega' }, { kind: 'operator' });
    const vegaHandles = manager
      .commandCenterProjection()
      .agents.filter((agent) => agent.name === 'Vega')
      .map((agent) => agent.handle);
    const exactVega = manager.commandCenterProjection().agents.find((agent) => agent.agentId === agentId);
    assert.ok(exactVega);
    await manager.store.updateAgentMetadata(failedId, { displayName: exactVega.handle }, { kind: 'operator' });
    const exactHandle = await manager.operatorExecute('luminaries_directory', {
      action: 'inspect',
      agentId: exactVega.handle,
    });
    assert.equal(exactHandle.details.agent.agentId, agentId);
    await assert.rejects(
      manager.operatorExecute('luminaries_directory', { action: 'inspect', agentId: 'Vega' }),
      (error) => error.code === 'agent_ambiguous' && vegaHandles.every((handle) => error.message.includes(handle)),
    );
    const multilineFocus = 'Offline merge invariant\nShared notebook conflict handling\r\nRecovery review';
    await manager.operatorExecute('luminaries_directory', {
      action: 'update',
      agentId,
      patch: { focus: multilineFocus },
    });
    assert.equal(manager.store.snapshot().agents[agentId].expertCard.focus.value, multilineFocus);
    const retainedSessionId = manager.store.snapshot().agents[agentId].sessionId;
    const retainedSessionFile = manager.store.snapshot().agents[agentId].sessionFile;
    await manager.close();
    manager = new LuminariesManager(options);
    await manager.start();
    assert.equal((await stat(closedParallelSessionFile)).isFile(), true);
    assert.equal(runtimeState(manager.store, agentId), 'runtime_parked');
    assert.equal(manager.store.snapshot().agents[agentId].sessionId, retainedSessionId);
    assert.equal(manager.store.snapshot().agents[agentId].sessionFile, retainedSessionFile);
    assert.deepEqual(manager.store.snapshot().agents[agentId].launch.extensions, [optionalExtension]);
    assert.deepEqual(manager.store.snapshot().agents[agentId].launch.extensionSources, ['fixture:optional-extension']);
    assert.equal(manager.store.snapshot().agents[agentId].expertCard.focus.value, multilineFocus);
    assert.equal(
      manager.commandCenterProjection().agents.find((candidate) => candidate.agentId === agentId)?.focus,
      multilineFocus.replaceAll('\r\n', '\n'),
    );
    assert.equal(await manager.operatorInput(agentId, 'Resume the exact private session.', 'auto'), 'woken');
    await waitFor(() => runtimeState(manager.store, agentId) === 'idle', 15_000);
    assert.ok(manager.actors.get(agentId)?.process?.spawnargs.includes(optionalExtension));
    assert.equal(manager.store.snapshot().agents[agentId].sessionId, retainedSessionId);
    const pendingApproval = manager.operatorApproveExtension('fixture:slow-extension', 'user', false);
    await waitFor(() => approvalEntered);
    const queuedApproval = manager.operatorApproveExtension('fixture:queued-extension', 'user', false);
    const closedBeforeApproval = await Promise.race([
      manager.close().then(() => true),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
    ]);
    assert.equal(closedBeforeApproval, true);
    assert.equal(manager.actors.size, 0);
    releaseApproval();
    await assert.rejects(pendingApproval, /manager is closing|cancelled because the manager is closing/u);
    await assert.rejects(queuedApproval, /manager is closing|cancelled because the manager is closing/u);
    assert.deepEqual(approvalsStarted, ['fixture:optional-extension', 'fixture:slow-extension']);
  } finally {
    releaseApproval();
    await manager.close();
  }
});

test('queued peer work reacquires an open runtime-parked actor on its exact private session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-parked-reacquire-'));
  const sessionFile = join(root, 'parent.jsonl');
  const agentDir = join(root, 'agent-state');
  const options = {
    sessionId: 'parent-session',
    sessionFile,
    cwd: root,
    agentDir,
    provider: 'test-provider',
    model: 'test-model',
    thinking: 'low',
    sessionHost: createPiSessionHost(),
    invocation: { command: process.execPath, args: [resolve('test/fixtures/fake-actor-rpc.mjs')] },
    env: { FAKE_ACTOR_DELAY_MS: '100' },
  };
  const first = new LuminariesManager({ ...options, idleParkDelayMs: 500 });
  t.after(() => first.close());
  await first.start();
  await first.parentBeforeAgentStart('Spawn a collaborator for parked-session reacquisition.');
  await first.parentAgentStart();
  const firstHost = first.hostForParent(context(root, sessionFile));
  const spawned = await firstHost.execute(
    {
      toolName: 'luminaries_spawn',
      input: {
        requestId: 'spawn',
        name: 'parked',
        assignment: 'wait for peer work',
        ownershipBoundary: 'one task',
      },
    },
    undefined,
  );
  const agentId = spawned.details.agent.agentId;
  const prepareOperationId = '22222222-2222-4222-8222-222222222222';
  const prepareBridgeRequestId = `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}ui-${sha256(prepareOperationId).slice(0, 40)}`;
  await first.operatorInput(agentId, 'Prepare the private session for restart.', 'auto', prepareOperationId);
  const prepareEvent = Object.values(first.store.snapshot().mailbox).find(
    (record) => record.lane !== 'direct' && record.bridgeRequestId === prepareBridgeRequestId,
  );
  assert.ok(prepareEvent);
  await waitFor(() => mailboxEvent(first.store.snapshot(), prepareEvent.eventId)?.status === 'settled');
  await waitFor(() => runtimeState(first.store, agentId) === 'idle');
  assert.equal(first.actors.has(agentId), true);
  const unchangedExtensions = await first.operatorExecute('luminaries_control', {
    action: 'set_extensions',
    agentId,
    extensions: [],
  });
  assert.equal(unchangedExtensions.details.status, 'saved');
  assert.equal(unchangedExtensions.details.duplicate, true);
  await waitFor(() => runtimeState(first.store, agentId) === 'runtime_parked');
  assert.equal(first.store.snapshot().agents[agentId].runtimeOwner, undefined);
  await first.parentAgentSettled();
  const inheritedLeaf = first.store.snapshot().agents[agentId].capabilities;
  assert.deepEqual(
    {
      spawn: inheritedLeaf.spawn,
      maxDepth: inheritedLeaf.maxDepth,
    },
    { spawn: false, maxDepth: 1 },
  );
  const modelSpawnReceipt = spawned.details;
  assert.equal(modelSpawnReceipt.agent.agentId, agentId);
  assert.equal(modelSpawnReceipt.admitted, true);
  const before = first.store.snapshot().agents[agentId];
  assert.equal(before.model, 'test-model');
  assert.equal(before.thinking, 'low');
  await first.operatorSetCapacity(20);
  assert.equal(first.store.snapshot().root.maxOpenAgents, 20);
  assert.equal(first.store.snapshot().root.maxOpenAgentsSource, 'operator-live');
  const firstRootId = first.store.snapshot().root.rootId;
  await first.close();

  const reopenedCwd = join(root, 'supported-cwd-override');
  await mkdir(reopenedCwd, { recursive: true });
  const second = new LuminariesManager({ ...options, cwd: reopenedCwd });
  t.after(() => second.close());
  await second.start();
  const descriptor = (await discoverAttachmentDescriptors(options.agentDir, reopenedCwd))[0];
  if (!descriptor) throw new Error('Luminaries attachment descriptor was not published');
  const descriptorPath = descriptor.descriptorPath;
  const firstClient = await LuminariesAttachmentClient.connect(descriptorPath);
  t.after(() => firstClient.close());
  const secondClient = await LuminariesAttachmentClient.connect(descriptorPath);
  t.after(() => secondClient.close());
  try {
    await firstClient.operatorSetDepth(3);
    assert.equal(second.store.snapshot().root.maxDepth, 3);
    assert.equal(second.store.snapshot().root.maxDepthSource, 'operator-live');
    await waitFor(() => secondClient.commandCenterProjection().configuration.maxDepth === 3);
    assert.equal(secondClient.commandCenterProjection().configuration.sources.maxDepth, 'operator-live');
    await assert.rejects(secondClient.operatorSetDepth(0), /depth/u);
    assert.equal(second.store.snapshot().root.maxDepth, 3);
    await assert.rejects(
      secondClient.resolveTarget('ambiguous-case'),
      (error) => error instanceof AttachmentTargetError && error.code === 'agent_missing',
    );
    const setCapacity = second.operatorSetCapacity.bind(second);
    let capacityCalls = 0;
    second.operatorSetCapacity = async (...args) => {
      capacityCalls++;
      return setCapacity(...args);
    };
    const mutation = {
      action: 'set_capacity',
      operationId: '11111111-1111-4111-8111-111111111111',
      capacity: 20,
    };
    const mutateAttachment = () =>
      fetch(descriptor.descriptor.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${descriptor.descriptor.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(mutation),
      });
    const firstMutation = await mutateAttachment();
    assert.equal(firstMutation.status, 200);
    const firstMutationBody = await firstMutation.json();
    const retriedMutation = await mutateAttachment();
    assert.equal(retriedMutation.status, 200);
    assert.deepEqual(await retriedMutation.json(), firstMutationBody);
    assert.equal(capacityCalls, 1);
    const acknowledgementUrl = new URL(descriptor.descriptor.url);
    acknowledgementUrl.pathname += '/ack';
    const acknowledged = await fetch(acknowledgementUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.descriptor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operationId: mutation.operationId }),
    });
    assert.deepEqual(await acknowledged.json(), { ok: true });
    assert.equal(second.store.snapshot().root.maxOpenAgents, 20);
    assert.equal(second.store.snapshot().root.maxOpenAgentsSource, 'operator-live');
    assert.equal(second.store.snapshot().root.rootId, firstRootId);
    assert.equal(second.store.snapshot().agents[firstRootId].cwd, reopenedCwd);
    assert.equal(runtimeState(second.store, agentId), 'runtime_parked');
    assert.equal(second.store.snapshot().agents[agentId].runtimeOwner, undefined);
    const secondHost = second.hostForParent(context(reopenedCwd, sessionFile));
    const controlCount = mailboxControls(second.store.snapshot()).length;
    for (const action of ['steer', 'follow_up'])
      await assert.rejects(
        secondHost.execute(
          {
            toolName: 'luminaries_control',
            input: { requestId: `parked-${action}`, action, agentId, message: 'wrong input lane' },
          },
          undefined,
        ),
        /no running turn.*luminaries_message/,
      );
    assert.equal(mailboxControls(second.store.snapshot()).length, controlCount);
    const sent = await secondHost.execute(
      {
        toolName: 'luminaries_message',
        input: {
          requestId: 'wake-parked',
          action: 'send',
          recipientId: `parked · ${agentId.slice(-6)}`,
          message: 'continue now',
        },
      },
      undefined,
    );
    await waitFor(() => mailboxEvent(second.store.snapshot(), sent.details.eventId)?.status === 'settled');
    assert.equal(mailboxEvent(second.store.snapshot(), sent.details.eventId).recipientId, agentId);
    const after = second.store.snapshot().agents[agentId];
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.sessionFile, before.sessionFile);
    assert.equal(agentRuntimeState(second.store.snapshot(), after), 'idle');
    const sharedRuntimeOwner = after.runtimeOwner;
    assert.ok(sharedRuntimeOwner);
    await firstClient.close();
    assert.equal(second.store.snapshot().agents[agentId].runtimeOwner, sharedRuntimeOwner);
    assert.equal(second.store.snapshot().agents[agentId].lifecycle, 'open');

    const request = await secondHost.execute(
      {
        toolName: 'luminaries_message',
        input: {
          requestId: 'terminal-request',
          action: 'request',
          recipientId: agentId,
          message: 'reply if needed',
        },
      },
      undefined,
    );
    assert.equal(request.terminate, true);
    await waitFor(() => mailboxEvent(second.store.snapshot(), request.details.eventId)?.consumedSeq !== undefined);
    const child = second.store.snapshot().agents[agentId];
    assert.ok(child.runtimeOwner);
    const rootAlias = await second.executeForCaller(
      {
        kind: 'child',
        agentId,
        rootId: second.store.snapshot().root.rootId,
        runtimeOwner: child.runtimeOwner,
        generation: second.generationId,
        sessionId: child.sessionId,
      },
      {
        toolName: 'luminaries_message',
        input: {
          requestId: 'message-root-alias',
          action: 'send',
          recipientId: 'Root',
          message: 'Root alias works.',
          mode: 'notify_only',
        },
      },
      undefined,
    );
    assert.equal(rootAlias.details.recipient.humanHandle, 'Root');
    assert.equal('shortId' in rootAlias.details.recipient, false);
    assert.equal(
      mailboxEvent(second.store.snapshot(), rootAlias.details.eventId).recipientId,
      second.store.snapshot().root.rootId,
    );
    await waitFor(() => mailboxEvent(second.store.snapshot(), request.details.eventId)?.status === 'settled');
    const cancelled = await secondHost.execute(
      {
        toolName: 'luminaries_message',
        input: {
          requestId: 'cancel-terminal-request',
          action: 'cancel',
          correlationId: request.details.correlationId,
        },
      },
      undefined,
    );
    assert.equal(cancelled.details.requestStatus, 'cancelled');
    assert.equal(second.store.snapshot().requests[request.details.correlationId], undefined);

    await assert.rejects(
      secondHost.execute(
        {
          toolName: 'luminaries_control',
          input: { requestId: 'idle-steer', action: 'steer', agentId, message: 'still the wrong input lane' },
        },
        undefined,
      ),
      /no running turn.*luminaries_message/,
    );
    assert.equal(mailboxControls(second.store.snapshot()).length, controlCount);
    const operatorAcceptedSeq = Math.max(
      0,
      ...Object.values(second.store.snapshot().mailbox).map((record) => record.acceptedSeq ?? 0),
    );
    await secondClient.operatorInput(agentId, 'operator follow-through', 'auto');
    const operatorEvent = Object.values(second.store.snapshot().mailbox).find(
      (event) => event.lane === 'operator' && event.recipientId === agentId && event.acceptedSeq > operatorAcceptedSeq,
    );
    assert.equal(operatorEvent.lane, 'operator');
    assert.equal(operatorEvent.senderId, second.store.snapshot().root.rootId);
    await waitFor(() => mailboxEvent(second.store.snapshot(), operatorEvent.eventId)?.status === 'settled');
    await waitFor(() => runtimeState(second.store, agentId) === 'idle');
    let unsubscribeLiveHistory = () => undefined;
    const liveHistory = await new Promise((resolveHistory, rejectHistory) => {
      const timer = setTimeout(() => rejectHistory(new Error('Live child conversation did not hydrate')), 5_000);
      unsubscribeLiveHistory = secondClient.onAgentConversationChange(agentId, (update) => {
        if (update.type !== 'reset' || !update.hydrated || !update.messages.length) return;
        clearTimeout(timer);
        resolveHistory(update);
      });
    });
    unsubscribeLiveHistory();
    assert.match(JSON.stringify(liveHistory.messages), /operator follow-through/u);
    const retainedSessionId = second.store.snapshot().agents[agentId].sessionId;
    const retainedSessionFile = second.store.snapshot().agents[agentId].sessionFile;
    await second.operatorParkAll('now');
    assert.equal(runtimeState(second.store, agentId), 'runtime_parked');
    await second.operatorExecute('luminaries_control', { action: 'close', agentId });
    assert.equal(second.store.snapshot().agents[agentId], undefined);
    const closedAgent = (await second.store.closedAgentLineage(agentId)).find(
      (candidate) => candidate.agentId === agentId,
    );
    assert.equal(closedAgent?.lifecycle, 'closed');
    const archivedHistoryMarker = 'ARCHIVED_HISTORY_MARKER';
    await appendFile(
      closedAgent.sessionFile,
      `${JSON.stringify({
        type: 'message',
        id: 'archived-history-entry',
        parentId: null,
        timestamp: '2026-08-18T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: archivedHistoryMarker.padEnd(32 * 1024, '.') }],
          timestamp: 1,
        },
      })}\n`,
    );
    const historyRoot = join(root, 'archived-history-bound');
    for (let index = 0; index < 100; index++) {
      const fillerId = `closed-history-${String(index).padStart(3, '0')}`;
      const sessionDir = join(historyRoot, fillerId);
      await mkdir(sessionDir, { recursive: true });
      await second.store.admitAgent(
        {
          agentId: fillerId,
          parentId: second.store.snapshot().root.rootId,
          segment: fillerId,
          cwd: reopenedCwd,
          sessionId: `${fillerId}-session`,
          sessionDir,
          displayName: fillerId,
          assignment: 'Bound ordinary closed-history projection',
          ownershipBoundary: 'Fixture history only',
        },
        { kind: 'operator' },
      );
      await second.store.closeAgent(fillerId, { kind: 'operator' });
    }
    await waitFor(() => !second.commandCenterProjection().directory.some((candidate) => candidate.agentId === agentId));
    const observerClient = await LuminariesAttachmentClient.connect(descriptorPath);
    t.after(() => observerClient.close());
    assert.equal(await observerClient.resolveTarget(agentId), agentId);
    const retainedIdentity = await observerClient.resolveTargetIdentity(agentId);
    const retainedShortId = retainedIdentity.handle.slice(retainedIdentity.handle.lastIndexOf(' · ') + 3);
    assert.equal(await observerClient.resolveTarget(retainedShortId), agentId);
    assert.equal(await secondClient.resolveTarget(agentId), agentId);
    const observerHistory = await observerClient.operatorClosedHistory();
    const attachedHistory = await secondClient.operatorClosedHistory();
    assert.ok(observerHistory.agents.length > 100);
    assert.ok(attachedHistory.agents.length > 100);
    assert.equal(observerHistory.agents.find((candidate) => candidate.agentId === agentId)?.archived, false);
    assert.equal(attachedHistory.agents.find((candidate) => candidate.agentId === agentId)?.archived, false);
    await secondClient.operatorSetArchived(agentId, true);
    assert.equal(
      (await secondClient.operatorClosedHistory()).agents.find((candidate) => candidate.agentId === agentId)?.archived,
      true,
    );
    let archivedResetCount = 0;
    let unsubscribeArchivedHistory = () => undefined;
    const archivedHistory = await new Promise((resolveHistory, rejectHistory) => {
      const timer = setTimeout(() => rejectHistory(new Error('Archived conversation did not hydrate')), 5_000);
      unsubscribeArchivedHistory = secondClient.onAgentConversationChange(agentId, (update) => {
        if (update.type !== 'reset' || !JSON.stringify(update.messages).includes(archivedHistoryMarker)) return;
        archivedResetCount += 1;
        clearTimeout(timer);
        resolveHistory(update.messages);
      });
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    unsubscribeArchivedHistory();
    assert.ok(archivedHistory.length > 0);
    assert.equal(archivedResetCount, 1);
    assert.match(JSON.stringify(archivedHistory), /ARCHIVED_HISTORY_MARKER/u);
    assert.equal(second.store.snapshot().agents[agentId], undefined);
    const archivedAgent = (await second.store.closedAgentLineage(agentId)).find(
      (candidate) => candidate.agentId === agentId,
    );
    assert.equal(archivedAgent?.archive.archived, true);
    const retainedArchivedSession = archivedAgent.sessionFile;
    await secondClient.operatorResume(agentId);
    assert.equal(second.store.snapshot().agents[agentId].lifecycle, 'open');
    assert.equal(second.store.snapshot().agents[agentId].archive, undefined);
    assert.equal(second.store.snapshot().agents[agentId].sessionFile, retainedArchivedSession);
    assert.equal(retainedArchivedSession, retainedSessionFile);
    const resumedProjection = secondClient
      .commandCenterProjection()
      .directory.find((candidate) => candidate.agentId === agentId);
    assert.equal(resumedProjection?.lifecycle, 'open');
    assert.equal(resumedProjection?.archived, false);
    const detachOperationId = '33333333-3333-4333-8333-333333333333';
    const [detached, concurrentDetach] = await Promise.all([
      second.operatorDetachSession(agentId, detachOperationId),
      second.operatorDetachSession(agentId, detachOperationId),
    ]);
    assert.equal(concurrentDetach.sessionFile, detached.sessionFile);
    assert.match(detached.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(detached.sessionName, 'parked · standalone');
    assert.equal(detached.command, `pi --session ${detached.sessionId}`);
    assert.doesNotMatch(detached.sessionId, /luminaries/u);
    t.after(() => rm(detached.sessionFile, { force: true }));
    assert.equal((await second.store.closedAgentLineage(agentId))[0]?.lifecycle, 'closed');
    const detachedBeforeAdvance = await options.sessionHost.inspectSession(detached.sessionFile);
    assert.equal(detachedBeforeAdvance.name, 'parked · standalone');
    assert.ok(
      detachedBeforeAdvance.entries.some(
        (entry) => entry.type === 'custom_message' && entry.customType === 'Pi session handoff',
      ),
    );
    const detachedLeafId = detachedBeforeAdvance.entries.at(-1)?.id;
    assert.ok(detachedLeafId);
    await appendFile(
      detached.sessionFile,
      `${JSON.stringify({
        type: 'custom',
        id: 'standalone-advanced-after-detach',
        parentId: detachedLeafId,
        timestamp: '2026-09-07T00:00:00.000Z',
        customType: 'standalone-progress',
        data: { advanced: true },
      })}\n`,
    );
    assert.equal((await second.operatorDetachSession(agentId)).sessionFile, detached.sessionFile);
    assert.notEqual(detached.sessionId, retainedSessionId);
    const detachedContext = await options.sessionHost.readContext(
      detached.sessionFile,
      reopenedCwd,
      detached.sessionId,
    );
    assert.match(JSON.stringify(detachedContext.messages), /ARCHIVED_HISTORY_MARKER/u);
    const adapterForkInput = {
      sourceFile: detached.sessionFile,
      targetCwd: reopenedCwd,
      targetSessionDir: join(root, 'concurrent-adapter-fork'),
      sessionId: 'concurrent-adapter-session',
      operationId: 'concurrent-adapter-operation',
      kind: 'adopt',
      contextNote: 'Concurrent adapter fork.',
      destinationName: 'Concurrent adapter',
    };
    const [adapterFork, joinedAdapterFork] = await Promise.all([
      options.sessionHost.forkSession(adapterForkInput),
      options.sessionHost.forkSession(adapterForkInput),
    ]);
    assert.equal(joinedAdapterFork.sessionFile, adapterFork.sessionFile);
    assert.equal(
      (await second.operatorSessions()).some((session) => session.sessionFile === adapterFork.sessionFile),
      false,
      'the explicit custom-directory path must not be supplied by Pi session indexing',
    );
    const customPathAdopted = await second.operatorAdoptSession(
      adapterFork.sessionFile,
      { name: 'Custom path specialist', assignment: 'Continue the custom-directory Pi session.' },
      '55555555-5555-4555-8555-555555555555',
    );
    assert.equal(customPathAdopted.sourceSessionFile, adapterFork.sessionFile);
    assert.equal(runtimeState(second.store, customPathAdopted.agentId), 'runtime_parked');

    const openBeforeInvalidPreview = openCollaboratorCount(second.store.snapshot());
    await assert.rejects(secondClient.operatorInspectSessionReference('not-a-session'), /unavailable/u);
    assert.equal(openCollaboratorCount(second.store.snapshot()), openBeforeInvalidPreview);
    const adoptionPreview = await secondClient.operatorInspectSessionReference(detached.sessionId);
    assert.equal(adoptionPreview.sessionFile, detached.sessionFile);
    assert.equal(adoptionPreview.sessionId, detached.sessionId);
    assert.equal(openCollaboratorCount(second.store.snapshot()), openBeforeInvalidPreview);
    const adoptOperationId = '44444444-4444-4444-8444-444444444444';
    const adopted = await second.operatorAdoptSession(
      detached.sessionId,
      { name: 'Imported specialist', assignment: 'Continue the imported specialist work.', expertise: ['handoffs'] },
      adoptOperationId,
    );
    const adoptedAgain = await second.operatorAdoptSession(
      detached.sessionId,
      { name: 'Imported specialist', assignment: 'Continue the imported specialist work.', expertise: ['handoffs'] },
      adoptOperationId,
    );
    assert.equal(adoptedAgain.agentId, adopted.agentId);
    assert.equal(adoptedAgain.sessionId, adopted.sessionId);
    assert.notEqual(adopted.sessionId, detached.sessionId);
    assert.equal(runtimeState(second.store, adopted.agentId), 'runtime_parked');
    const adoptedAgent = second.store.snapshot().agents[adopted.agentId];
    const adoptedContext = await options.sessionHost.readContext(
      adoptedAgent.sessionFile,
      adoptedAgent.cwd,
      adoptedAgent.sessionId,
    );
    assert.match(JSON.stringify(adoptedContext.messages), /ARCHIVED_HISTORY_MARKER/u);
    assert.equal((await options.sessionHost.inspectSession(adoptedAgent.sessionFile)).name, 'Imported specialist');
    await second.close();
    await waitFor(() => secondClient.readOnlyReason() !== undefined);
    await assert.rejects(secondClient.operatorInput(agentId, 'must remain dormant', 'auto'), /root offline/iu);
    await secondClient.close();
    await assert.rejects(stat(descriptorPath), /ENOENT/u);
  } finally {
    await second.close();
  }
});

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail('Timed out waiting for Luminaries state transition');
}
