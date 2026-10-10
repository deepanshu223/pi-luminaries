import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { estimateTokens, SessionManager } from '@earendil-works/pi-coding-agent';
import { planContextLaunch } from '../../src/context-session.ts';
import { LuminariesManager } from '../../src/luminaries-manager.ts';
import { availabilityLabel, agentCard } from '../../src/command-center-card.ts';
import { createPiSessionHost } from '../../src/pi-session-host.ts';
import { LUMINARIES_IDENTITY } from '../../src/product-identity.ts';
import { agentRuntimeState, openCollaboratorCount, SchedulerStateError, sha256 } from '../../src/scheduler-state.ts';
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

test('a child input error before its RPC acknowledgement ends Working and surfaces the failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-input-error-'));
  const manager = new LuminariesManager({
    sessionHost: createPiSessionHost(),
    sessionId: 'parent-session',
    sessionFile: join(root, 'parent.jsonl'),
    cwd: root,
    agentDir: join(root, 'profile'),
    invocation: { command: process.execPath, args: [resolve('test/fixtures/fake-actor-rpc.mjs')] },
    env: { FAKE_INPUT_COMMAND_ERROR: '1' },
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();
  const spawned = await manager.operatorExecute('luminaries_spawn', {
    assignment: 'An input which cannot be read',
    ownershipBoundary: 'Test only',
  });
  const id = spawned.details.agent.agentId;
  await waitFor(
    () =>
      runtimeState(manager.store, id) === 'failed' &&
      manager.diagnostics.some((message) => message.includes('fixture input payload was unreadable')),
  );
  assert.equal(
    Object.values(manager.store.snapshot().activations).some(
      (activation) => activation.agentId === id && activation.state === 'running',
    ),
    false,
  );
});

test('child compaction events reach the live status and clear on completion or interruption', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-compaction-'));
  const manager = new LuminariesManager({
    sessionId: 'parent-session',
    sessionFile: join(root, 'parent.jsonl'),
    cwd: root,
    agentDir: join(root, 'agent-state'),
    sessionHost: createPiSessionHost(),
    invocation: { command: process.execPath, args: [resolve('test/fixtures/fake-actor-rpc.mjs')] },
    env: { FAKE_ACTOR_DELAY_MS: '60000' },
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();
  const spawned = await manager.operatorExecute('luminaries_spawn', {
    assignment: 'Review the project',
    ownershipBoundary: 'Read-only review',
  });
  const agentId = spawned.details.agent.agentId;
  await waitFor(() => runtimeState(manager.store, agentId) === 'running');
  let visible = manager.commandCenterProjection().agents.find((agent) => agent.agentId === agentId);
  t.after(
    manager.onCommandCenterChange((projection) => {
      visible = projection.agents.find((agent) => agent.agentId === agentId);
    }),
  );
  const child = manager.actors.get(agentId).process;
  const emit = (event) => child.stdin.write(JSON.stringify({ type: 'fixture_emit_event', event }) + '\n');
  emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
  });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Considering the evidence.' },
  });
  await waitFor(() => visible.activity === 'Thinking');
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1 } });
  await waitFor(() => visible.activity === 'Writing a response');
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{' } });
  emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { type: 'toolCall', id: 'activity-tool', name: 'read', arguments: { path: 'fieldnotes/evidence.md' } },
    },
  });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 2 } });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'Writing the answer.' },
  });
  await waitFor(() => visible.activity === 'Writing a response');
  emit({
    type: 'tool_execution_start',
    toolCallId: 'activity-tool',
    toolName: 'read',
    args: { path: 'fieldnotes/evidence.md' },
  });
  await waitFor(() => visible.activity === 'Reading fieldnotes/evidence.md');
  emit({ type: 'tool_execution_end', toolCallId: 'activity-tool', toolName: 'read', result: {} });
  await waitFor(() => visible.activity === 'Writing a response');
  emit({ type: 'compaction_start', reason: 'threshold' });
  await waitFor(() => visible.activity === 'Compacting context');
  assert.equal(availabilityLabel(visible), 'Compacting');
  assert.ok(agentCard(visible).fields.some((field) => field.value === 'Compacting context'));
  emit({ type: 'compaction_end', reason: 'threshold', aborted: false });
  await waitFor(() => availabilityLabel(visible) === 'Working');
  emit({ type: 'compaction_start', reason: 'threshold' });
  await waitFor(() => availabilityLabel(visible) === 'Compacting');
  await manager.operatorInterrupt(agentId);
  await waitFor(() => visible.humanState === 'idle');
  assert.equal(availabilityLabel(visible), 'Ready');
  assert.equal(visible.activity, '');
});

test('native context survives transfer, session seeding, and adoption without changing the source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-native-context-'));
  const host = createPiSessionHost();
  const manager = new LuminariesManager({
    sessionId: 'parent-session',
    sessionFile: join(root, 'parent.jsonl'),
    cwd: root,
    agentDir: join(root, 'profile'),
    sessionHost: host,
  });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  const native = SessionManager.inMemory(root);
  const system = {
    role: 'system',
    content: 'Keep the native instructions.',
    timestamp: 1,
    sections: { project: 'Read-only review.', retired: null },
    toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    toolsRemoved: [{ name: 'write' }],
  };
  // Older Pi has no system-message protocol; exercise its ordinary context on that host.
  const systemSupported = estimateTokens(system) > 0;
  if (systemSupported) native.appendMessage(system);
  native.appendMessage({ role: 'user', content: 'Retain this finding.', timestamp: 2 });
  const messages = native.buildSessionContext().messages;
  t.diagnostic(systemSupported ? 'Native system records included' : 'Pre-system-message Pi context');
  for (const context of ['fork', 'recent']) {
    const plan = planContextLaunch(
      { context, contextWindow: 32_000, cwd: root },
      { messages, selectedToolCallId: 'operator-boundary' },
    );
    const sessionId = randomUUID();
    const sessionFile = await host.createSeededSession({
      sessionId,
      cwd: root,
      sessionDir: join(root, context),
      messages: plan.messages,
    });
    assert.deepEqual((await host.readContext(sessionFile, root, sessionId)).messages, messages);
  }
  const sourceId = randomUUID();
  const sourceFile = await host.createSeededSession({
    sessionId: sourceId,
    cwd: root,
    sessionDir: join(root, 'ordinary'),
    messages,
  });
  const sourceBytes = await readFile(sourceFile);
  await manager.start();
  const adopted = await manager.operatorAdoptSession(sourceFile, { name: 'Vega' });
  const agent = manager.store.snapshot().agents[adopted.agentId];
  const imported = await host.readContext(agent.sessionFile, root, adopted.sessionId);
  assert.notEqual(adopted.sessionId, sourceId);
  assert.equal(runtimeState(manager.store, adopted.agentId), 'runtime_parked');
  assert.deepEqual(imported.messages.slice(0, messages.length), messages);
  assert.deepEqual(await readFile(sourceFile), sourceBytes);
});

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
  const receipt = await staleHost.execute(
    { toolName: 'luminaries_directory', input: { requestId: 'list', action: 'list' } },
    undefined,
  );
  assert.equal(receipt.details.capacity.used, 0);
  const modelListReceipt = receipt.details;
  assert.deepEqual(modelListReceipt.capacity, { used: 0, limit: 10 });
  assert.equal(modelListReceipt.entries[0].agentId, manager.store.snapshot().root.rootId);
  assert.equal(modelListReceipt.entries[0].humanHandle, 'Root');
  assert.equal(modelListReceipt.entries[0].depth, 0);
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

test('manager shutdown joins an in-progress startup without leaking its Store or bridge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-manager-start-close-'));
  const sessionFile = join(root, 'parent.jsonl');
  const agentDir = join(root, 'agent-state');
  const manager = new LuminariesManager({ sessionId: 'parent-session', sessionFile, cwd: root, agentDir });
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  const start = manager.start();
  const close = manager.close();
  const [started, closed] = await Promise.allSettled([start, close]);
  assert.equal(closed.status, 'fulfilled');
  assert.equal(manager.lifecycle, 'closed');
  if (started.status === 'rejected') assert.match(started.reason.message, /closed|startup/i);

  const reopened = new LuminariesManager({ sessionId: 'parent-session', sessionFile, cwd: root, agentDir });
  t.after(() => reopened.close());
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

test('Root delivery races preserve exact consumption and never replay uncertain input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-root-delivery-'));
  const sessionFile = join(root, 'parent.jsonl');
  const agentDir = join(root, 'agent-state');
  const deliveries = [];
  let falseBoundaryAttempts = 0;
  let settledBeforeBoundaryAttempts = 0;
  const falseBoundaryMessage = 'Root cannot prove this queued follow-up was withdrawn';
  const siblingFollowUpMessage = `${falseBoundaryMessage} (sibling)`;
  const pendingBoundaryMessage = 'hold this Root steer at its exact Pi boundary';
  const settledBeforeBoundaryMessage = 'retry Root input after a proven pre-write race';
  const recoveryMessage = 'Continue Root after retired uncertain completion.';
  let pendingBoundaryInput;
  let holdNativeWake = false;
  let rejectNativeWake;
  let hostFactReads = 0;
  let manager;
  const rootTransport = {
    async sendMessage(message, options) {
      const content = message.content;
      if (content.includes(recoveryMessage)) {
        assert.equal(content, `From Luminaries:\n${recoveryMessage}`);
        assert.equal(message.details.source, 'Luminaries');
      }
      const missedBoundaryFollowUp = content.includes(falseBoundaryMessage);
      const settlesBeforeBoundary = content.includes(settledBeforeBoundaryMessage);
      deliveries.push({ content, options });
      if (settlesBeforeBoundary && ++settledBeforeBoundaryAttempts === 1)
        throw new SchedulerStateError('delivery_race', 'Fixture refused input before writing Pi');
      if (!options?.deliverAs) {
        await manager.parentBeforeAgentStart(content);
        await manager.parentAgentStart();
      }
      if (missedBoundaryFollowUp) {
        falseBoundaryAttempts++;
        return;
      }
      if (content.includes(pendingBoundaryMessage)) {
        pendingBoundaryInput = message;
        if (holdNativeWake) {
          holdNativeWake = false;
          await new Promise((_, reject) => {
            rejectNativeWake = reject;
          });
        }
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
    currentHostFacts: () => {
      hostFactReads++;
      return { models: [], startupPrompt: '', activeToolTokens: 0 };
    },
    rootTransport,
  });
  await manager.start();
  try {
    const snapshot = manager.store.snapshot();
    const rootId = snapshot.root.rootId;
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

    pendingBoundaryInput = undefined;
    holdNativeWake = true;
    const nativeOverlap = await manager.store.admitPeerEvent(auth, {
      bridgeRequestId: 'root-native-overlap',
      recipientId: rootId,
      message: pendingBoundaryMessage,
    });
    await waitFor(() => pendingBoundaryInput);
    const nativeActivation =
      manager.store.snapshot().activations[
        mailboxEvent(manager.store.snapshot(), nativeOverlap.value.event.eventId).activationId
      ];
    assert.equal(nativeActivation.inputKind, 'peer_event');
    const nativeOutput = {
      toolName: 'luminaries_message',
      input: {
        requestId: 'root-native-output',
        action: 'send',
        recipientId: 'sender',
        message: 'Work from native Pi input.',
        mode: 'notify_only',
      },
    };
    await assert.rejects(parentHost.execute(nativeOutput, undefined), { code: 'causation_required' });
    await manager.parentMessageStart({
      role: 'user',
      content: [{ type: 'text', text: 'Native input before the health wake.' }],
      timestamp: Date.now(),
    });
    assert.ok(manager.store.snapshot().activations[nativeActivation.activationId].nativeInputSeq);
    assert.equal((await parentHost.execute(nativeOutput, undefined)).details.status, 'settled');
    assert.equal(mailboxEvent(manager.store.snapshot(), nativeOverlap.value.event.eventId).consumedSeq, undefined);
    const rejectedNativeInput = pendingBoundaryInput;
    rejectNativeWake(new SchedulerStateError('delivery_race', 'Wake was not written after native input joined'));
    await waitFor(() => pendingBoundaryInput !== rejectedNativeInput);
    assert.equal(
      mailboxEvent(manager.store.snapshot(), nativeOverlap.value.event.eventId).activationId,
      nativeActivation.activationId,
    );
    assert.equal(manager.store.snapshot().activations[nativeActivation.activationId].state, 'running');
    await manager.parentMessageStart({ role: 'custom', ...pendingBoundaryInput });
    await waitFor(
      () => mailboxEvent(manager.store.snapshot(), nativeOverlap.value.event.eventId)?.consumedSeq !== undefined,
    );
    await manager.parentAgentSettled();
    pendingBoundaryInput = undefined;

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
    await manager.parentAgentSettled();
    await waitFor(() => {
      const evidence = manager.store.indeterminateEvidenceSnapshot([rootId]);
      return evidence.some(
        (event) => event.eventId === siblingFollowUp.value.event.eventId && event.status === 'indeterminate',
      );
    });
    assert.deepEqual(deliveries.find((delivery) => delivery.content.includes(falseBoundaryMessage))?.options, {
      deliverAs: 'followUp',
      triggerTurn: true,
    });
    for (const [bridgeRequestId, message] of [
      ['root-follow-up-requeue', falseBoundaryMessage],
      ['root-follow-up-requeue-sibling', siblingFollowUpMessage],
    ]) {
      const duplicate = await manager.store.admitPeerEvent(auth, {
        bridgeRequestId,
        recipientId: rootId,
        message,
        mode: 'follow_up',
      });
      assert.equal(duplicate.value.duplicate, true);
      assert.equal(duplicate.value.event.status, 'indeterminate');
      assert.equal(duplicate.value.event.consumedSeq, undefined);
    }
    assert.equal(falseBoundaryAttempts, 2);
    await manager.parentBeforeAgentStart('later Root turn must not blindly replay unwithdrawn input');
    await manager.parentAgentStart();
    await manager.parentAgentSettled();
    assert.equal(falseBoundaryAttempts, 2);

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
    const quietRecord = modelInspection.records.find(
      (record) => record.outcomeCode === 'notify_only' && record.senderId === 'sender',
    );
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
    await manager.close();
    await rm(root, { recursive: true, force: true });
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

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail('Timed out waiting for Luminaries state transition');
}
