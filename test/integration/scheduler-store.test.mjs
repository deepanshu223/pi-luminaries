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
test('bootstraps, appends current control truth, checkpoints on close, and reopens', async (t) => {
  const { root, statePath, store } = await openStore(t);
  const controlDirectory = join(root, 'luminaries', 'control');
  const snapshotPath = join(controlDirectory, 'snapshot.jsonl');
  assert.equal(store.startup.created, true);
  assert.equal(openCollaboratorCount(store.snapshot()), 0);
  assert.equal(JSON.parse((await readFile(snapshotPath, 'utf8')).split('\n')[0]).revision, 1);
  const { sessionDir } = await admitA(store, root);
  assert.equal(store.snapshot().revision, 2);
  const journalName = (await readdir(controlDirectory)).find((name) => name.startsWith('journal.'));
  assert.ok(journalName);
  const journal = JSON.parse((await readFile(join(controlDirectory, journalName), 'utf8')).trim());
  assert.equal(journal.puts.agents['agent-a'].agentId, 'agent-a');
  const sessionFile = join(sessionDir, 'agent-a.jsonl');
  await writeFile(sessionFile, '');
  await store.bindSession('agent-a', sessionFile);
  const runtime = await store.claimRuntime('agent-a', process.pid, 'test-host');
  await store.markRuntimeSpawned('agent-a', runtime.value.runtimeOwner, process.pid);
  await store.markRuntimeReady('agent-a', runtime.value.runtimeOwner, process.pid);
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
  assert.equal(request.value.route.event.targetActivationId, activation.value.activationId);
  const delivery = await store.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: request.value.route.event.eventId,
    runtimeOwner: runtime.value.runtimeOwner,
  });
  assert.equal(delivery.value.activationId, activation.value.activationId);
  await store.applyMailboxIntent({
    kind: 'admit_boundary',
    recordId: request.value.route.event.eventId,
    attemptId: delivery.value.attemptId,
  });
  await store.finishActivation(activation.value.activationId, activation.value.leaseToken, 'settled');
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
  await store.markAgentContinuedAfterIndeterminate('agent-a', operator);
  assert.equal(store.snapshot().agents['agent-a'].attention, undefined);
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
  assert.equal(agentPath(reopened.snapshot(), 'agent-a'), 'root/a');
  assert.equal(reopened.snapshot().mailbox[notification.value.event.eventId].status, 'settled');
  assert.equal(
    reopened.snapshot().mailbox[sourcedNotification.value.event.eventId].sourceActivationId,
    activation.value.activationId,
  );
  assert.equal(reopened.snapshot().mailbox[descendant.value.event.eventId].status, 'accepted');
  assert.equal(
    reopened.snapshot().mailbox[request.value.route.event.eventId].targetActivationId,
    activation.value.activationId,
  );
  assert.equal(
    reopened.snapshot().mailbox[request.value.route.event.eventId].activationId,
    activation.value.activationId,
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

test('admission enforces immutable path, depth, capacity, and normalized private inputs', async (t) => {
  const capacityContext = await fresh();
  const capacityStore = await SchedulerStore.open({
    statePath: capacityContext.statePath,
    bootstrap: { rootId: 'root', cwd: capacityContext.root, maxOpenAgents: 1, maxDepth: 3 },
  });
  t.after(() => capacityStore.close());
  await admitA(capacityStore, capacityContext.root);
  const before = capacityStore.snapshot();
  await assert.rejects(
    admit(capacityStore, {
      agentId: 'agent-b',
      parentId: 'root',
      segment: 'b',
      cwd: capacityContext.root,
      sessionId: 'b-session',
      sessionDir: join(capacityContext.root, 'b'),
    }),
    /capacity/,
  );
  assert.equal(capacityStore.snapshot().revision, before.revision);
  assert.equal(openCollaboratorCount(capacityStore.snapshot()), 1);
  await assert.rejects(
    admit(capacityStore, {
      agentId: 'toString',
      parentId: 'root',
      segment: 'bad',
      cwd: capacityContext.root,
      sessionId: 'bad-session',
      sessionDir: join(capacityContext.root, 'bad'),
    }),
    /invalid/,
  );
  await capacityStore.close();

  const depthContext = await fresh();
  const depthStore = await SchedulerStore.open({
    statePath: depthContext.statePath,
    bootstrap: { rootId: 'root', cwd: depthContext.root, maxOpenAgents: 4, maxDepth: 1 },
  });
  t.after(() => depthStore.close());
  await admitA(depthStore, depthContext.root);
  await assert.rejects(
    admit(
      depthStore,
      {
        agentId: 'agent-a1',
        parentId: 'agent-a',
        segment: 'a1',
        cwd: depthContext.root,
        sessionId: 'a1-session',
        sessionDir: join(depthContext.root, 'a1'),
      },
      { kind: 'agent', agentId: 'agent-a' },
    ),
    /depth/,
  );
  await assert.rejects(
    admit(depthStore, {
      agentId: 'relative',
      parentId: 'root',
      segment: 'relative',
      cwd: 'relative',
      sessionId: 'relative-session',
      sessionDir: join(depthContext.root, 'relative'),
    }),
    /absolute/,
  );
  await depthStore.close();
});

test('session binding and immutable activation outcomes are lease-safe and idempotent', async (t) => {
  const { root, store } = await openStore(t);
  const { sessionDir } = await admitA(store, root);
  const sessionFile = join(sessionDir, 'agent-a.jsonl');
  await writeFile(sessionFile, '');
  await writeFile(join(sessionDir, 'other.jsonl'), '');
  const bound = await store.bindSession('agent-a', sessionFile);
  const snapshot = store.snapshot();
  let publications = 0;
  const unsubscribe = store.onChange(() => publications++);
  const boundAgain = await store.bindSession('agent-a', sessionFile);
  assert.equal(boundAgain.revision, bound.revision);
  assert.strictEqual(store.snapshot(), snapshot);
  assert.equal(publications, 0);
  unsubscribe();
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

test('callers cannot mutate the canonical snapshot', async (t) => {
  const { root, store } = await openStore(t);
  await admitA(store, root);
  const snapshot = store.snapshot();
  assert.throws(() => {
    snapshot.root.maxDepth = 99;
  }, TypeError);
  assert.equal(store.snapshot().root.maxDepth, 3);
  await store.close();
});

test('the serialized queue stays responsive and resource close waits admitted mutations', async (t) => {
  const { root, statePath, store } = await openStore(t, { bootstrap: { maxOpenAgents: 10, maxDepth: 1 } });
  const publishedRevisions = [];
  const stopListening = store.onChange((revision) => publishedRevisions.push(revision));
  const journal = store.log.journal;
  const sync = journal.sync;
  let durabilityFlushes = 0;
  journal.sync = async () => {
    durabilityFlushes++;
    await sync.call(journal);
  };
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 1);
  t.after(() => clearInterval(timer));
  const admissions = Array.from({ length: 5 }, (_, index) =>
    admit(store, {
      agentId: `agent-${index}`,
      parentId: 'root',
      segment: `a-${index}`,
      cwd: root,
      sessionId: `agent-${index}-session`,
      sessionDir: join(root, `agent-${index}`, 'sessions'),
    }),
  );
  let commits;
  try {
    commits = await Promise.all(admissions);
  } finally {
    journal.sync = sync;
    stopListening();
  }
  const closing = store.close();
  assert.equal(await closing, true);
  clearInterval(timer);
  assert.ok(ticks > 0);
  assert.deepEqual(
    commits.map((commit) => commit.revision),
    [2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    commits.map((commit) => commit.value.agentId),
    ['agent-0', 'agent-1', 'agent-2', 'agent-3', 'agent-4'],
  );
  assert.deepEqual(publishedRevisions, [2, 3, 4, 5, 6]);
  assert.equal(durabilityFlushes, 1);
  const reopened = await SchedulerStore.open({ statePath });
  t.after(() => reopened.close());
  assert.equal(openCollaboratorCount(reopened.snapshot()), 5);
  assert.equal(reopened.snapshot().revision, 6);
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
