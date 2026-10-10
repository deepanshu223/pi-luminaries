import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPath, agentRuntimeState, openCollaboratorCount, requestStatus } from '../../src/scheduler-state.ts';
import { SchedulerStore } from '../../src/scheduler-store.ts';
import { RequestDeadlineCoordinator } from '../../src/request-deadlines.ts';
import { projectCommandCenter } from '../../src/command-center-projection.ts';

const operator = { kind: 'operator' };
const testRoot = await mkdtemp(join(tmpdir(), 'luminaries-store-'));
after(() => rm(testRoot, { recursive: true, force: true }));
function admission(input) {
  return {
    displayName: input.agentId,
    assignment: `Assignment for ${input.agentId}`,
    ownershipBoundary: `Owns ${input.agentId} work`,
    ...input,
  };
}
function admit(store, input, principal = operator) {
  return store.admitAgent(admission(input), principal);
}
async function fresh() {
  const root = await mkdtemp(join(testRoot, 'case-'));
  return { root, statePath: join(root, 'luminaries', 'state.json') };
}
async function openStore(t, options = {}) {
  const context = await fresh();
  const store = await SchedulerStore.open({
    statePath: context.statePath,
    bootstrap: { rootId: 'root', cwd: context.root, maxOpenAgents: 10, maxDepth: 3, ...(options.bootstrap ?? {}) },
  });
  t.after(() => store.close());
  return { ...context, store };
}
async function admitA(store, root) {
  const sessionDir = join(root, 'agent-a', 'sessions');
  await mkdir(sessionDir, { recursive: true });
  const result = await admit(store, {
    agentId: 'agent-a',
    parentId: 'root',
    segment: 'a',
    cwd: root,
    sessionId: 'agent-a-session',
    sessionDir,
  });
  return { result, sessionDir };
}
test('closing an expert retires its pending health notice without hiding uncertain work delivery', async (t) => {
  for (const type of ['health_attention', 'background_completion']) {
    const { root, store } = await openStore(t);
    await admitA(store, root);
    const activation = await store.startActivation('root', 'prompt');
    const input = await store.admitPeerEvent(
      { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
      { bridgeRequestId: 'child-task', recipientId: 'agent-a', message: 'Review the current work.' },
    );
    const event = await store.admitSystemEvent({
      dedupeKey: `close-${type}`,
      type,
      senderId: 'agent-a',
      recipientId: 'root',
      message: 'Review the expert status.',
      traceId: input.value.event.traceId,
      causationId: input.value.event.eventId,
    });
    const delivery = await store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: event.value.event.eventId,
      runtimeOwner: 'owner',
    });
    assert.equal(delivery.value.deliveryKind, 'steer');
    await store.closeAgent('agent-a', operator);
    const projection = projectCommandCenter(
      store.snapshot(),
      undefined,
      undefined,
      undefined,
      undefined,
      store.indeterminateEvidenceSnapshot(['root']),
    );
    assert.equal(projection.agents.find((entry) => entry.agentId === 'root').attention, type !== 'health_attention');
    assert.equal(store.snapshot().activations[activation.value.activationId].state, 'running');
    await store.finishActivation(activation.value.activationId, activation.value.leaseToken, 'settled');
  }
});

test('bootstraps, appends current control truth, checkpoints on close, and reopens', async (t) => {
  const { root, statePath, store } = await openStore(t, { bootstrap: { serviceGrant: ['spawn', 'set_extensions'] } });
  const controlDirectory = join(root, 'luminaries', 'control');
  const snapshotPath = join(controlDirectory, 'snapshot.jsonl');
  assert.equal(store.startup.created, true);
  assert.equal(openCollaboratorCount(store.snapshot()), 0);
  const { sessionDir } = await admitA(store, root);
  const sessionFile = join(sessionDir, 'agent-a.jsonl');
  await writeFile(sessionFile, '');
  await store.bindSession('agent-a', sessionFile);
  const runtime = await store.claimRuntime('agent-a', process.pid, 'test-host');
  await store.markRuntimeSpawned('agent-a', runtime.value.runtimeOwner, process.pid);
  await store.markRuntimeReady('agent-a', runtime.value.runtimeOwner, process.pid);
  const steerTurn = await store.startActivation('agent-a', 'prompt');
  const steerAuth = { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' };
  const steerInput = {
    bridgeRequestId: 'ended-turn-steer',
    recipientId: 'agent-a',
    message: 'Guide this running turn only.',
  };
  const steer = await store.admitPeerEvent(steerAuth, steerInput, steerTurn.value.activationId);
  const beginSteer = () =>
    store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: steer.value.event.eventId,
      runtimeOwner: runtime.value.runtimeOwner,
    });
  await store.finishActivation(steerTurn.value.activationId, steerTurn.value.leaseToken, 'settled');
  assert.equal((await beginSteer()).value, undefined);
  const steerNotices = () =>
    Object.values(store.snapshot().mailbox).filter(
      (record) => record.systemType === 'control_failure' && record.causationId === steer.value.event.eventId,
    );
  assert.equal(steerNotices().length, 1, 'A missed explicit steer must notify its sender');
  const steerNotice = steerNotices()[0];
  assert.equal(steerNotice.recipientId, 'root');
  assert.equal(steerNotice.status, 'accepted');
  assert.match(steerNotice.message, /not delivered.*turn ended.*luminaries_message/u);
  assert.equal(store.snapshot().mailbox[steer.value.event.eventId].status, 'refused');
  const refusedRevision = store.snapshot().revision;
  assert.equal((await beginSteer()).revision, refusedRevision);
  assert.equal((await store.admitPeerEvent(steerAuth, steerInput, 'agent-a')).value.duplicate, true);
  assert.equal(steerNotices().length, 1);
  const notification = await store.admitPeerEvent(
    { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
    {
      bridgeRequestId: 'surfaced-causal-notification',
      recipientId: 'agent-a',
      message: 'Visible notification with retained causal work.',
      mode: 'notify_only',
    },
  );
  const activation = await store.startActivation('agent-a', 'prompt');
  const sourcedNotification = await store.admitSystemEvent({
    dedupeKey: 'surfaced-sourced-notification',
    type: 'routine',
    senderId: 'agent-a',
    recipientId: 'root',
    message: 'A sourced notification retaining its terminal activation.',
    wake: false,
    traceId: notification.value.event.traceId,
    causationId: notification.value.event.eventId,
    sourceActivationId: activation.value.activationId,
  });
  const descendant = await store.admitSystemEvent({
    dedupeKey: 'surfaced-causal-descendant',
    type: 'control_failure',
    senderId: 'root',
    recipientId: 'agent-a',
    message: 'Live work retaining the surfaced notification.',
    traceId: sourcedNotification.value.event.traceId,
    causationId: sourcedNotification.value.event.eventId,
  });
  const request = await store.acceptCorrelatedRequest(
    { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
    {
      bridgeRequestId: 'terminal-activation-request',
      recipientId: 'agent-a',
      message: 'Keep this request open across retirement.',
    },
  );
  assert.equal(request.value.route.event.status, 'accepted');
  assert.equal(request.value.route.event.targetActivationId, undefined);
  await store.finishActivation(activation.value.activationId, activation.value.leaseToken, 'settled');
  const delivery = await store.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: request.value.route.event.eventId,
    runtimeOwner: runtime.value.runtimeOwner,
  });
  assert.equal(delivery.value.deliveryKind, 'wake');
  assert.notEqual(delivery.value.activationId, activation.value.activationId);
  await store.applyMailboxIntent({
    kind: 'admit_boundary',
    recordId: request.value.route.event.eventId,
    attemptId: delivery.value.attemptId,
  });
  await store.finishActivation(delivery.value.activationId, delivery.value.activationLeaseToken, 'settled');
  const operatorAuth = { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' };
  const missedWake = await store.admitPeerEvent(operatorAuth, {
    bridgeRequestId: 'missed-wake-boundary',
    recipientId: 'agent-a',
    message: 'Retry after Pi settles before observing this wake.',
  });
  const missedWakeDelivery = await store.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: missedWake.value.event.eventId,
    runtimeOwner: runtime.value.runtimeOwner,
  });
  assert.equal(missedWakeDelivery.value.deliveryKind, 'wake');
  await assert.rejects(
    store.applyMailboxIntent({
      kind: 'release_delivery',
      recordId: missedWake.value.event.eventId,
      attemptId: missedWakeDelivery.value.attemptId,
      settlement: {
        activationId: missedWakeDelivery.value.activationId,
        leaseToken: '00000000-0000-4000-8000-000000000000',
        outcome: 'settled',
      },
    }),
    /lease token is invalid/u,
  );
  assert.equal(store.snapshot().mailbox[missedWake.value.event.eventId].status, 'sending');
  await store.applyMailboxIntent({
    kind: 'release_delivery',
    recordId: missedWake.value.event.eventId,
    attemptId: missedWakeDelivery.value.attemptId,
    settlement: {
      activationId: missedWakeDelivery.value.activationId,
      leaseToken: missedWakeDelivery.value.activationLeaseToken,
      outcome: 'settled',
    },
  });
  assert.equal(store.snapshot().mailbox[missedWake.value.event.eventId].status, 'accepted');
  assert.equal(store.snapshot().activations[missedWakeDelivery.value.activationId], undefined);
  const recoveryActivation = await store.startActivation('agent-a', 'continuation boundary');
  const uncertainInterrupt = await store.applyMailboxIntent({
    kind: 'admit_direct',
    input: {
      requestId: 'continuation-interrupt',
      targetId: 'agent-a',
      sourceActivationId: recoveryActivation.value.activationId,
      action: 'interrupt',
    },
    requestedBy: operator,
  });
  const interruptAttempt = await store.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: uncertainInterrupt.value.control.controlId,
    runtimeOwner: runtime.value.runtimeOwner,
  });
  await store.applyMailboxIntent({
    kind: 'finish_delivery',
    recordId: uncertainInterrupt.value.control.controlId,
    attemptId: interruptAttempt.value.attemptId,
    status: 'indeterminate',
    outcomeCode: 'interrupt_boundary_unknown',
  });
  await store.finishActivation(
    recoveryActivation.value.activationId,
    recoveryActivation.value.leaseToken,
    'indeterminate',
  );
  assert.equal(store.snapshot().agents['agent-a'].attention?.kind, 'needs_attention');
  const beforeDuplicateContinuation = store.snapshot().revision;
  const duplicateRecovery = await store.admitOperatorInput(operatorAuth, {
    bridgeRequestId: 'missed-wake-boundary',
    recipientId: 'agent-a',
    message: 'Retry after Pi settles before observing this wake.',
  });
  assert.equal(duplicateRecovery.value.duplicate, true);
  assert.equal(duplicateRecovery.revision, beforeDuplicateContinuation);
  assert.equal(store.snapshot().agents['agent-a'].attention?.kind, 'needs_attention');
  // Runtime recovery can finish before the owner acknowledges the earlier uncertain turn.
  await store.releaseRuntime('agent-a', runtime.value.runtimeOwner, 'runtime_parked');
  const recoveredProjection = projectCommandCenter(
    store.snapshot(),
    new Map(),
    store.snapshot().revision,
    undefined,
    store.snapshot().revision,
    store.indeterminateEvidenceSnapshot(['agent-a']),
  );
  assert.equal(recoveredProjection.agents.find((agent) => agent.agentId === 'agent-a').canContinueWithMessage, true);
  await store.markAgentContinuedAfterIndeterminate('agent-a', { kind: 'agent', agentId: 'root' });
  assert.equal(store.snapshot().agents['agent-a'].attention, undefined);
  assert.ok(store.snapshot().agents['agent-a'].continuedAfterSeq > recoveryActivation.value.startedSeq);
  assert.equal(store.snapshot().activations[recoveryActivation.value.activationId].state, 'indeterminate');
  assert.equal(store.indeterminateEvidenceSnapshot(['agent-a']).length, 0);
  // A finished turn leaves one settled notify_only completion fact for its parent's card.
  const completions = Object.values(store.snapshot().mailbox).filter(
    (record) => record.systemType === 'background_completion',
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].senderId, 'agent-a');
  assert.equal(completions[0].recipientId, 'root');
  assert.equal(completions[0].status, 'settled');
  assert.equal(completions[0].mode, 'notify_only');
  assert.equal(completions[0].sourceActivationId, recoveryActivation.value.activationId);
  // Surfacing retires that finished-turn fact while causally retained notifications survive.
  assert.equal((await store.retireSurfacedNotifications()).value, 1);
  assert.equal(store.snapshot().mailbox[notification.value.event.eventId].status, 'settled');
  assert.equal(store.snapshot().mailbox[sourcedNotification.value.event.eventId].status, 'settled');
  assert.equal(store.snapshot().mailbox[descendant.value.event.eventId].status, 'accepted');
  assert.equal(store.snapshot().activations[activation.value.activationId].state, 'settled');
  const expectedRevision = store.snapshot().revision;
  assert.equal(await store.close(), true);
  assert.equal(await store.close(), false);
  assert.equal(JSON.parse((await readFile(snapshotPath, 'utf8')).split('\n')[0]).revision, expectedRevision);
  await assert.rejects(readFile(statePath), /ENOENT/);
  const sealedPartial = join(controlDirectory, 'journal.0.jsonl');
  await writeFile(sealedPartial, '{"type":"transaction"');
  await assert.rejects(SchedulerStore.open({ statePath }), /incomplete final record/);
  await rm(sealedPartial);
  const activeJournal = join(
    controlDirectory,
    (await readdir(controlDirectory))
      .filter((name) => name.startsWith('journal.'))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .at(-1),
  );
  await appendFile(activeJournal, '{"type":"transaction"');
  const reopened = await SchedulerStore.open({ statePath });
  t.after(() => reopened.close());
  assert.equal((await stat(activeJournal)).size, 0);
  assert.equal(reopened.startup.created, false);
  assert.equal(reopened.snapshot().mailbox[steerNotice.eventId].recipientId, 'root');
  assert.equal(reopened.snapshot().mailbox[steerNotice.eventId].status, 'accepted');
  assert.equal(reopened.snapshot().mailbox[steer.value.event.eventId].status, 'refused');
  assert.deepEqual(reopened.snapshot().root.serviceGrant, ['spawn', 'set_extensions']);
  assert.equal(agentPath(reopened.snapshot(), 'agent-a'), 'root/a');
  assert.equal(reopened.snapshot().mailbox[notification.value.event.eventId].status, 'settled');
  assert.equal(
    reopened.snapshot().mailbox[sourcedNotification.value.event.eventId].sourceActivationId,
    activation.value.activationId,
  );
  assert.equal(reopened.snapshot().mailbox[descendant.value.event.eventId].status, 'accepted');
  assert.equal(reopened.snapshot().mailbox[request.value.route.event.eventId].targetActivationId, undefined);
  assert.equal(
    reopened.snapshot().mailbox[request.value.route.event.eventId].activationId,
    delivery.value.activationId,
  );
  assert.equal(reopened.snapshot().activations[activation.value.activationId].state, 'settled');
  await reopened.close();
});

test('recent activity keeps five settled interactions without retaining their full causal history', async (t) => {
  const { root, store } = await openStore(t);
  try {
    const { sessionDir } = await admitA(store, root);
    const sessionFile = join(sessionDir, 'agent-a.jsonl');
    await writeFile(sessionFile, '');
    await store.bindSession('agent-a', sessionFile);
    const runtime = await store.claimRuntime('agent-a', process.pid, 'recent-activity-test');
    await store.markRuntimeSpawned('agent-a', runtime.value.runtimeOwner, process.pid);
    await store.markRuntimeReady('agent-a', runtime.value.runtimeOwner, process.pid);

    const first = await store.admitPeerEvent(
      { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
      {
        bridgeRequestId: 'recent-activity-origin',
        recipientId: 'agent-a',
        message: 'Completed interaction 0.',
        mode: 'notify_only',
      },
    );
    const expectedMessages = [];
    let causationId = first.value.event.eventId;
    for (let index = 1; index <= 7; index++) {
      const message = `Completed interaction ${index}.`;
      const next = await store.admitSystemEvent({
        dedupeKey: `recent-activity-${index}`,
        type: 'routine',
        senderId: 'root',
        recipientId: 'agent-a',
        message,
        wake: false,
        traceId: first.value.event.traceId,
        causationId,
      });
      causationId = next.value.event.eventId;
      expectedMessages.push(message);
    }
    await store.retireSurfacedNotifications();
    const retained = Object.values(store.snapshot().mailbox).filter(
      (record) => record.lane !== 'direct' && record.status === 'settled' && record.message,
    );
    assert.equal(retained.length, 5);
    assert.deepEqual(retained.map((record) => record.message).sort(), expectedMessages.slice(-5).sort());

    const pending = await store.admitPeerEvent(
      { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
      {
        bridgeRequestId: 'recent-activity-consumed',
        recipientId: 'agent-a',
        message: 'In progress and not yet successful.',
      },
    );
    const delivery = await store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: pending.value.event.eventId,
      runtimeOwner: runtime.value.runtimeOwner,
    });
    await store.applyMailboxIntent({
      kind: 'admit_boundary',
      recordId: pending.value.event.eventId,
      attemptId: delivery.value.attemptId,
    });
    const interactions = projectCommandCenter(store.snapshot()).agents.find(
      (agent) => agent.agentId === 'agent-a',
    ).interactions;
    assert.equal(interactions.length, 5);
    assert.ok(expectedMessages.slice(-5).every((message) => interactions.some((row) => row.endsWith(message))));
    assert.ok(interactions.every((row) => !row.includes('not yet successful')));
    assert.equal(store.snapshot().mailbox[pending.value.event.eventId].message, 'In progress and not yet successful.');
    await store.finishActivation(delivery.value.activationId, delivery.value.activationLeaseToken, 'settled');
    const settledInteractions = projectCommandCenter(store.snapshot()).agents.find(
      (agent) => agent.agentId === 'agent-a',
    ).interactions;
    assert.equal(settledInteractions.length, 5);
    assert.ok(settledInteractions.some((row) => row.endsWith('In progress and not yet successful.')));
  } finally {
    await store.close();
  }
});

test('expired requests survive in-flight retry and retire after late replies and related work finish', async (t) => {
  const { root, statePath, store } = await openStore(t);
  const { sessionDir } = await admitA(store, root);
  const sessionFile = join(sessionDir, 'agent-a.jsonl');
  await writeFile(sessionFile, '');
  await store.bindSession('agent-a', sessionFile);
  const runtime = await store.claimRuntime('agent-a', process.pid, 'deadline-test');
  const runtimeOwner = runtime.value.runtimeOwner;
  await store.markRuntimeSpawned('agent-a', runtimeOwner, process.pid);
  await store.markRuntimeReady('agent-a', runtimeOwner, process.pid);
  const working = await store.startActivation('agent-a', 'existing work');
  const deadlineAtMs = Date.now() + 60_000;
  const request = await store.acceptCorrelatedRequest(
    { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
    {
      bridgeRequestId: 'expiring-follow-up',
      recipientId: 'agent-a',
      message: 'Return the source packet.',
      mode: 'follow_up',
      deadlineAtMs,
    },
  );
  const requestId = request.value.request.requestId;
  const recordId = request.value.route.event.eventId;
  const delivery = await store.applyMailboxIntent({ kind: 'begin_delivery', recordId, runtimeOwner });
  assert.equal(delivery.value.deliveryKind, 'follow_up');
  const expired = await store.timeoutCorrelatedRequest(requestId, deadlineAtMs + 1);
  const resolutionId = expired.value.route.event.eventId;
  const resolution = await store.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: resolutionId,
    runtimeOwner: 'root-runtime',
  });
  await store.applyMailboxIntent({
    kind: 'admit_boundary',
    recordId: resolutionId,
    attemptId: resolution.value.attemptId,
  });
  await store.finishActivation(resolution.value.activationId, resolution.value.activationLeaseToken, 'settled');
  await store.applyMailboxIntent({ kind: 'release_delivery', recordId, attemptId: delivery.value.attemptId });
  assert.equal(store.snapshot().mailbox[recordId].status, 'accepted');
  await store.close();

  const reopened = await SchedulerStore.open({ statePath });
  t.after(() => reopened.close());
  assert.equal(requestStatus(reopened.snapshot(), reopened.snapshot().requests[requestId]), 'timed_out');
  const retried = await reopened.applyMailboxIntent({ kind: 'begin_delivery', recordId, runtimeOwner });
  await reopened.applyMailboxIntent({ kind: 'admit_boundary', recordId, attemptId: retried.value.attemptId });
  const recipientAuth = { agentId: 'agent-a', rootId: 'root', runtimeOwner };
  const consultation = await reopened.acceptCorrelatedRequest(recipientAuth, {
    bridgeRequestId: 'consult-before-answering',
    recipientId: 'root',
    message: 'Confirm the source edition.',
  });
  await reopened.finishActivation(working.value.activationId, working.value.leaseToken, 'settled');
  await reopened.retireSurfacedNotifications();
  assert.equal(requestStatus(reopened.snapshot(), reopened.snapshot().requests[requestId]), 'timed_out');
  const consultationId = consultation.value.route.event.eventId;
  const consulted = await reopened.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: consultationId,
    runtimeOwner: 'root-runtime',
  });
  await reopened.applyMailboxIntent({
    kind: 'admit_boundary',
    recordId: consultationId,
    attemptId: consulted.value.attemptId,
  });
  const answer = await reopened.acceptCorrelatedReply(
    { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
    {
      bridgeRequestId: 'edition-confirmed',
      requestId: consultation.value.request.requestId,
      message: 'Use the first edition.',
    },
  );
  await reopened.finishActivation(consulted.value.activationId, consulted.value.activationLeaseToken, 'settled');
  const answerId = answer.value.route.event.eventId;
  const resumed = await reopened.applyMailboxIntent({ kind: 'begin_delivery', recordId: answerId, runtimeOwner });
  await reopened.applyMailboxIntent({ kind: 'admit_boundary', recordId: answerId, attemptId: resumed.value.attemptId });
  const reply = await reopened.acceptCorrelatedReply(recipientAuth, {
    bridgeRequestId: 'late-source-packet',
    requestId,
    message: 'The completed source packet.',
  });
  assert.equal(reply.value.route.event.recipientId, 'root');
  assert.equal(reply.value.route.disposition, 'notify_only');
  assert.equal(reply.value.route.event.message, 'The completed source packet.');
  assert.equal(requestStatus(reopened.snapshot(), reopened.snapshot().requests[requestId]), 'timed_out');
  assert.equal(
    Object.values(reopened.snapshot().activations).some((item) => item.agentId === 'root' && item.state === 'running'),
    false,
  );
  await reopened.finishActivation(resumed.value.activationId, resumed.value.activationLeaseToken, 'indeterminate');
  await reopened.retireSurfacedNotifications();
  assert.equal(requestStatus(reopened.snapshot(), reopened.snapshot().requests[requestId]), 'timed_out');
  await reopened.releaseRuntime('agent-a', runtimeOwner, 'runtime_parked');
  await reopened.markAgentContinuedAfterIndeterminate('agent-a', { kind: 'agent', agentId: 'root' });
  await reopened.retireSurfacedNotifications();
  assert.equal(reopened.snapshot().requests[requestId], undefined);
});

test('service request no-replay retains correlation across reopen', async (t) => {
  const { root, statePath, store } = await openStore(t);
  const { sessionDir } = await admitA(store, root);
  const sessionFile = join(sessionDir, 'agent-a.jsonl');
  await writeFile(sessionFile, '');
  await store.bindSession('agent-a', sessionFile);
  const runtime = await store.claimRuntime('agent-a', process.pid, 'test-host');
  await store.markRuntimeSpawned('agent-a', runtime.value.runtimeOwner, process.pid);
  await store.markRuntimeReady('agent-a', runtime.value.runtimeOwner, process.pid);
  const auth = { agentId: 'root', rootId: 'root', runtimeOwner: 'service', origin: 'service' };
  const input = {
    bridgeRequestId: 'service-request-indeterminate',
    recipientId: 'agent-a',
    message: 'Retain this service request correlation.',
  };
  const accepted = await store.acceptCorrelatedRequest(auth, input);
  const event = accepted.value.route.event;
  assert.equal(typeof event.requestId, 'string');
  assert.equal(accepted.value.request.requestId, event.requestId);
  assert.equal(event.lane, 'service');
  assert.equal(event.status, 'accepted');
  assert.equal(agentRuntimeState(store.snapshot(), store.snapshot().agents['agent-a']), 'idle');
  const delivery = await store.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: event.eventId,
    runtimeOwner: runtime.value.runtimeOwner,
  });
  await store.applyMailboxIntent({
    kind: 'finish_delivery',
    recordId: event.eventId,
    attemptId: delivery.value.attemptId,
    status: 'indeterminate',
    outcomeCode: 'service_response_lost',
  });
  await store.close();

  const reopened = await SchedulerStore.open({ statePath });
  t.after(() => reopened.close());
  try {
    const duplicate = await reopened.acceptCorrelatedRequest(auth, input);
    assert.equal(duplicate.value.route.duplicate, true);
    assert.equal(duplicate.value.route.event.status, 'indeterminate');
    assert.equal(duplicate.value.request.requestId, accepted.value.request.requestId);
  } finally {
    await reopened.close();
  }
});

test('session binding and immutable activation outcomes are lease-safe and idempotent', async (t) => {
  const { root, store } = await openStore(t);
  const { sessionDir } = await admitA(store, root);
  const sessionFile = join(sessionDir, 'agent-a.jsonl');
  await writeFile(sessionFile, '');
  await writeFile(join(sessionDir, 'other.jsonl'), '');
  const bound = await store.bindSession('agent-a', sessionFile);
  const boundAgain = await store.bindSession('agent-a', sessionFile);
  assert.equal(boundAgain.revision, bound.revision);
  const outsideSessionFile = join(root, 'escape.jsonl');
  await writeFile(outsideSessionFile, '');
  await assert.rejects(store.bindSession('agent-a', outsideSessionFile), /escapes/);
  await assert.rejects(store.bindSession('agent-a', join(sessionDir, 'other.jsonl')), /another session/);
  const activation = await store.startActivation('root', 'prompt');
  await assert.rejects(store.startActivation('root', 'prompt'), /live activation/);
  await assert.rejects(store.finishActivation(activation.value.activationId, 'wrong-token', 'settled'), /lease token/);
  const terminal = await store.finishActivation(
    activation.value.activationId,
    activation.value.leaseToken,
    'indeterminate',
  );
  assert.equal(agentRuntimeState(store.snapshot(), store.snapshot().agents.root), 'needs_attention');
  const terminalAgain = await store.finishActivation(
    activation.value.activationId,
    activation.value.leaseToken,
    'indeterminate',
  );
  assert.equal(terminalAgain.revision, terminal.revision);
  await assert.rejects(
    store.finishActivation(activation.value.activationId, activation.value.leaseToken, 'failed'),
    /immutable/,
  );
  await assert.rejects(store.startActivation('root', 'prompt'), /recovery/);
  await store.close();
});

test('shutdown drains an admitted write before releasing the store', async (t) => {
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { root, statePath, store } = await openStore(t);
  const journal = store.log.journal;
  const sync = journal.sync;
  const admitted = Promise.withResolvers();
  journal.sync = async () => {
    admitted.resolve();
    await release.promise;
    await sync.call(journal);
  };
  const admission = admitA(store, root);
  await admitted.promise;
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false, 'Shutdown must wait for the in-flight durable write');
  release.resolve();
  await admission;
  await closing;
  const reopened = await SchedulerStore.open({ statePath });
  t.after(() => reopened.close());
  assert.ok(reopened.snapshot().agents['agent-a']);
});

test('a reply attached before deadline processing wins over timeout', async (t) => {
  const { root, store: reopened } = await openStore(t);
  await admit(reopened, {
    agentId: 'agent-0',
    parentId: 'root',
    segment: 'a-0',
    cwd: root,
    sessionId: 'agent-0-session',
    sessionDir: join(root, 'agent-0', 'sessions'),
  });
  const agentSessionDir = join(root, 'agent-0', 'sessions');
  const agentSessionFile = join(agentSessionDir, 'agent-0.jsonl');
  await mkdir(agentSessionDir, { recursive: true });
  await writeFile(agentSessionFile, '');
  await reopened.bindSession('agent-0', agentSessionFile);
  const claimed = await reopened.claimRuntime('agent-0', process.pid, 'test-host');
  const runtimeOwner = claimed.value.runtimeOwner;
  await reopened.markRuntimeSpawned('agent-0', runtimeOwner, process.pid);
  await reopened.markRuntimeReady('agent-0', runtimeOwner, process.pid);
  const request = await reopened.acceptCorrelatedRequest(
    { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
    {
      bridgeRequestId: 'deadline-reply-attached',
      recipientId: 'agent-0',
      message: 'Return the durable answer.',
      deadlineAtMs: Date.now() - 1,
    },
  );
  const requestDelivery = await reopened.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: request.value.route.event.eventId,
    runtimeOwner,
  });
  await reopened.applyMailboxIntent({
    kind: 'admit_boundary',
    recordId: request.value.route.event.eventId,
    attemptId: requestDelivery.value.attemptId,
  });
  const reply = await reopened.acceptCorrelatedReply(
    { agentId: 'agent-0', rootId: 'root', runtimeOwner },
    {
      bridgeRequestId: 'deadline-reply-attached-response',
      requestId: request.value.request.requestId,
      message: 'The answer is attached before expiry runs.',
    },
  );
  let timeoutAttempts = 0;
  const timeoutCorrelatedRequest = reopened.timeoutCorrelatedRequest.bind(reopened);
  reopened.timeoutCorrelatedRequest = async (...args) => {
    timeoutAttempts++;
    return timeoutCorrelatedRequest(...args);
  };
  const deadlines = new RequestDeadlineCoordinator(reopened, (error) => {
    throw error;
  });
  try {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(timeoutAttempts, 0);
    const attached = reopened.snapshot().requests[request.value.request.requestId];
    assert.equal(requestStatus(reopened.snapshot(), attached), 'pending');
    assert.equal(attached.terminalEventId, reply.value.route.event.eventId);
    const replyDelivery = await reopened.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: reply.value.route.event.eventId,
      runtimeOwner: 'root-runtime',
    });
    await reopened.applyMailboxIntent({
      kind: 'admit_boundary',
      recordId: reply.value.route.event.eventId,
      attemptId: replyDelivery.value.attemptId,
    });
    assert.equal(reopened.snapshot().requests[request.value.request.requestId], undefined);
  } finally {
    deadlines.close();
    reopened.timeoutCorrelatedRequest = timeoutCorrelatedRequest;
  }
  await reopened.close();
});
