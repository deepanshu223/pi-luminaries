import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultCapabilityEnvelope } from '../../src/capability-policy.ts';
import { LuminariesManager } from '../../src/luminaries-manager.ts';
import { agentRuntimeState, openCollaboratorCount, sha256 } from '../../src/scheduler-state.ts';
import { event as mailboxEvent } from '../helpers/mailbox.mjs';

const invocation = { command: process.execPath, args: [resolve('test/fixtures/fake-actor-rpc.mjs')] };

function runtimeState(store, agentId) {
  const snapshot = store.snapshot();
  return agentRuntimeState(snapshot, snapshot.agents[agentId]);
}

async function waitFor(read, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) assert.fail('Timed out waiting for assembled Luminaries state');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function firstJsonLine(child, timeoutMs = 8_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const timer = setTimeout(() => rejectPromise(new Error('Manager crash fixture did not become ready')), timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        rejectPromise(error);
      }
    });
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (!buffer.includes('\n')) rejectPromise(new Error(`Manager crash fixture exited early (${String(code)})`));
    });
  });
}

async function waitForExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('Child process did not exit')), timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function fixtureMessages(sessionFile) {
  const messages = [];
  for (const line of (await readFile(sessionFile, 'utf8')).split('\n')) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.fixture === 'message' && record.message) messages.push(record.message);
  }
  return messages;
}

test('manager crash reconciliation preserves indeterminate truth and resumes without replay', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-manager-crash-assembly-'));
  const options = {
    sessionId: 'crash-parent',
    sessionFile: join(root, 'parent.jsonl'),
    cwd: root,
    agentDir: join(root, 'agent-state'),
  };
  const child = spawn(process.execPath, [resolve('test/fixtures/manager-crash-child.mjs')], {
    cwd: resolve('.'),
    env: { ...process.env, LUMINARIES_MANAGER_CRASH_OPTIONS: JSON.stringify(options) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let manager;
  context.after(async () => {
    child.kill('SIGKILL');
    await waitForExit(child).catch(() => undefined);
    await manager?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const ready = await firstJsonLine(child);
  assert.equal(ready.ready, true);
  child.kill('SIGKILL');
  await waitForExit(child);
  try {
    process.kill(ready.actorPid, 'SIGKILL');
  } catch {
    // The orphan already exited after losing its manager pipe.
  }
  await waitFor(() => {
    try {
      process.kill(ready.actorPid, 0);
      return false;
    } catch {
      return true;
    }
  });

  manager = new LuminariesManager({
    ...options,
    invocation,
    env: { FAKE_ACTOR_DELAY_MS: '100' },
  });
  await manager.start();
  const recovered = manager.store.snapshot();
  const recoveredEvent = mailboxEvent(recovered, ready.eventId);
  assert.equal(recoveredEvent, undefined);
  assert.equal(recovered.activations[ready.activationId], undefined);
  const agent = recovered.agents[ready.agentId];
  assert.equal(agent.attention?.kind, 'needs_attention');
  assert.equal(agent.attention?.code, 'runtime_stale_reconciled');
  assert.ok(agent.sessionFile);
  const before = await fixtureMessages(agent.sessionFile);
  assert.equal(
    before.filter((message) => JSON.stringify(message).includes('UNCERTAIN_INPUT_MUST_NOT_REPLAY')).length,
    1,
  );
  const recoveryOperationId = '66666666-6666-4666-8666-666666666666';
  const recoveryBridgeRequestId = `luminaries-ui-${sha256(recoveryOperationId).slice(0, 40)}`;
  await manager.operatorInput(ready.agentId, 'RECOVERY_INPUT_AFTER_CRASH', 'auto', recoveryOperationId);
  const recoveryEvent = Object.values(manager.store.snapshot().mailbox).find(
    (record) =>
      record.lane !== 'direct' &&
      record.recipientId === ready.agentId &&
      record.bridgeRequestId === recoveryBridgeRequestId,
  );
  assert.ok(recoveryEvent);
  await waitFor(() => mailboxEvent(manager.store.snapshot(), recoveryEvent.eventId)?.consumedSeq !== undefined);
  await waitFor(() => runtimeState(manager.store, ready.agentId) === 'idle');
  assert.equal(manager.bridge.activeCredentialCount, 1);
  const resumedAgent = manager.store.snapshot().agents[ready.agentId];
  assert.equal(resumedAgent.sessionFile, agent.sessionFile);
  const after = await fixtureMessages(resumedAgent.sessionFile);
  assert.equal(
    after.filter((message) => JSON.stringify(message).includes('UNCERTAIN_INPUT_MUST_NOT_REPLAY')).length,
    1,
  );
  assert.equal(after.filter((message) => JSON.stringify(message).includes('RECOVERY_INPUT_AFTER_CRASH')).length, 1);
});

test('the ten-agent manager loop stays coherent across operator motion, close history, and resume', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-release-assembly-'));
  const parentSession = join(root, 'parent.jsonl');
  const manager = new LuminariesManager({
    sessionId: 'release-parent',
    sessionFile: parentSession,
    cwd: root,
    agentDir: join(root, 'agent-state'),
    maxOpenAgents: 10,
    maxDepth: 1,
    capabilities: defaultCapabilityEnvelope(root, 1),
    provider: 'test-provider',
    model: 'test-model',
    thinking: 'low',
    models: [
      { provider: 'test-provider', id: 'test-model', contextWindow: 128_000, maxOutputTokens: 8_000 },
      { provider: 'test-provider', id: 'tiny-model', contextWindow: 16_000, maxOutputTokens: 4_000 },
    ],
    operatorContextSnapshot: () => ({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Bounded parent context.' }] }],
      selectedToolCallId: 'settled-operator-boundary',
    }),
    invocation,
    env: { FAKE_ACTOR_DELAY_MS: '1500' },
    sessionHost: {
      async createSeededSession(input) {
        await mkdir(input.sessionDir, { recursive: true });
        const sessionFile = join(input.sessionDir, `${input.sessionId}.jsonl`);
        const records = [
          { fixture: 'session', sessionId: input.sessionId },
          ...input.messages.map((message) => ({ fixture: 'message', message })),
        ];
        await writeFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
          mode: 0o600,
        });
        return sessionFile;
      },
      async readContext(sessionFile) {
        const messages = await fixtureMessages(sessionFile);
        return {
          messages,
          entries: messages.map((_, index) => ({ id: `fixture-${index}` })),
        };
      },
      readMessages: fixtureMessages,
      async listSessions() {
        return [
          {
            sessionFile: parentSession,
            sessionId: 'release-parent',
            cwd: root,
            name: 'Owning Root',
            modifiedAtMs: 2,
            messageCount: 1,
            firstMessage: 'Own this constellation.',
          },
          {
            sessionFile: join(root, 'standalone.jsonl'),
            sessionId: 'standalone-session',
            cwd: root,
            name: 'Standalone source',
            modifiedAtMs: 1,
            messageCount: 1,
            firstMessage: 'Independent work.',
          },
        ];
      },
    },
  });
  context.after(async () => {
    await manager.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();
  assert.deepEqual(
    (await manager.operatorSessions()).map((session) => session.sessionId),
    ['standalone-session'],
  );
  await assert.rejects(
    manager.operatorExecute('luminaries_spawn', {
      name: 'Oversized recent',
      assignment: 'Must refuse before admission.',
      ownershipBoundary: 'No slot may be reserved.',
      context: 'recent',
      model: 'test-provider/tiny-model',
      recentTokens: 8_000,
    }),
    /Bounded recent context is unavailable/u,
  );
  await assert.rejects(
    manager.operatorExecute('luminaries_spawn', {
      name: 'Unavailable model',
      assignment: 'Must refuse before admission.',
      ownershipBoundary: 'No slot may be reserved.',
      model: 'test-provider/not-available',
    }),
    /not available/i,
  );
  assert.equal(openCollaboratorCount(manager.store.snapshot()), 0);
  const firstSpawn = manager.operatorExecute('luminaries_spawn', {
    assignment: 'Own release workstream 1',
    ownershipBoundary: 'Only workstream 1',
    context: 'fresh',
  });
  const startingAgent = await waitFor(() =>
    Object.values(manager.store.snapshot().agents).find((agent) => agent.parentId !== null),
  );
  const joinedInput = manager.operatorInput(
    startingAgent.agentId,
    'Operator input that must join the admitted spawn instead of racing its starting activation.',
    'auto',
  );
  const [firstReceipt] = await Promise.all([firstSpawn, joinedInput]);
  const remainingReceipts = await Promise.all(
    Array.from({ length: 9 }, (_, offset) => {
      const index = offset + 1;
      return manager.operatorExecute('luminaries_spawn', {
        ...(index < 4 ? {} : { name: `Specialist ${index + 1}` }),
        assignment: `Own release workstream ${index + 1}`,
        ownershipBoundary: `Only workstream ${index + 1}`,
        context: index === 8 ? 'custom' : 'fresh',
      });
    }),
  );
  const spawnReceipts = [firstReceipt, ...remainingReceipts];
  const agentIds = spawnReceipts.map((receipt) => receipt.details.agent.agentId);
  assert.equal(new Set(agentIds).size, 10);
  assert.equal(new Set(spawnReceipts.slice(0, 4).map((receipt) => receipt.details.agent.displayName)).size, 4);
  assert.equal(openCollaboratorCount(manager.store.snapshot()), 10);
  assert.equal(new Set(agentIds.map((agentId) => manager.store.snapshot().agents[agentId].sessionId)).size, 10);
  await waitFor(() => manager.commandCenterProjection().agents.length === 11);
  assert.equal(manager.commandCenterProjection().agents.length, 11);
  await assert.rejects(manager.operatorSetCapacity(9), /cannot contain 10 open collaborators/u);
  assert.equal(manager.store.snapshot().root.maxOpenAgents, 10);
  assert.equal(manager.store.snapshot().root.maxOpenAgentsSource, 'startup');
  await waitFor(() => {
    const state = manager.store.snapshot();
    return agentIds.every((agentId) => agentRuntimeState(state, state.agents[agentId]) === 'idle');
  });
  assert.equal(manager.actors.size, 10);

  const fixedReceiptInput = {
    requestId: 'release-post-commit-receipt',
    action: 'send',
    recipientId: agentIds[6],
    message: 'One durable operator receipt.',
    mode: 'notify_only',
  };
  const operatorHost = manager.hostForOperator();
  const firstOperatorReceipt = await operatorHost.execute(
    { toolName: 'luminaries_message', input: fixedReceiptInput },
    undefined,
  );
  const retriedOperatorReceipt = await operatorHost.execute(
    { toolName: 'luminaries_message', input: fixedReceiptInput },
    undefined,
  );
  assert.equal(retriedOperatorReceipt.details.duplicate, true);
  assert.equal(retriedOperatorReceipt.details.eventId, firstOperatorReceipt.details.eventId);

  const listed = [];
  let cursor;
  do {
    const page = await manager.operatorExecute('luminaries_directory', {
      action: 'list',
      limit: 3,
      ...(cursor ? { cursor } : {}),
    });
    listed.push(...page.details.entries);
    assert.ok(Buffer.byteLength(JSON.stringify(page.details)) <= 48 * 1024);
    cursor = page.details.page.nextCursor;
  } while (cursor);
  assert.deepEqual(
    new Set(listed.map((entry) => entry.agentId)),
    new Set([manager.store.snapshot().root.rootId, ...agentIds]),
  );
  assert.ok(listed.every((entry) => entry.parentId !== undefined && entry.depth !== undefined));

  const activeRuns = agentIds
    .slice(0, 3)
    .map((agentId, index) => manager.operatorInput(agentId, `Run release activity ${index + 1}.`, 'auto'));
  await waitFor(() => manager.commandCenterProjection().counts.working === 3);
  try {
    await waitFor(() => {
      const state = manager.store.snapshot();
      return agentIds
        .slice(0, 3)
        .every((agentId) =>
          Object.values(state.activations).some(
            (activation) => activation.agentId === agentId && activation.state === 'running',
          ),
        );
    });
  } catch (error) {
    const state = manager.store.snapshot();
    throw new Error(
      `Three actors did not overlap at durable dispatch: ${JSON.stringify(
        agentIds.slice(0, 3).map((agentId) => ({
          agentId,
          runtimeState: agentRuntimeState(state, state.agents[agentId]),
          activations: Object.values(state.activations)
            .filter((activation) => activation.agentId === agentId)
            .map((activation) => activation.state),
        })),
      )}`,
      { cause: error },
    );
  }
  const postActivityRuns = agentIds
    .slice(3, 6)
    .map((agentId, index) => manager.operatorInput(agentId, `Run post-activity work ${index + 1}.`, 'auto'));
  await waitFor(() => manager.commandCenterProjection().counts.working === 6);
  const postActivityDirectory = await manager.operatorExecute('luminaries_directory', { action: 'list', limit: 16 });
  const postActivityEntries = new Map(postActivityDirectory.details.entries.map((entry) => [entry.agentId, entry]));
  assert.ok(
    agentIds
      .slice(0, 6)
      .every((agentId) => ['working', 'waiting'].includes(postActivityEntries.get(agentId)?.activity.state)),
  );
  const multicast = await manager.operatorExecute('luminaries_message', {
    action: 'multicast',
    recipientIds: agentIds.slice(0, 3),
    message: 'Operator release checkpoint.',
    mode: 'default',
  });
  assert.equal(multicast.details.legs.length, 3);
  const multicastEvents = multicast.details.legs.map((leg) => mailboxEvent(manager.store.snapshot(), leg.eventId));
  assert.ok(multicastEvents.every((event) => event.origin === 'operator'));
  assert.equal(new Set(multicastEvents.map((event) => event.traceId)).size, 1);
  await Promise.all([...activeRuns, ...postActivityRuns]);
  for (const leg of multicast.details.legs) {
    try {
      await waitFor(() => mailboxEvent(manager.store.snapshot(), leg.eventId)?.status === 'settled');
    } catch (error) {
      const event = mailboxEvent(manager.store.snapshot(), leg.eventId);
      throw new Error(
        `Operator multicast leg did not settle: ${JSON.stringify({
          eventId: leg.eventId,
          status: event?.status,
          deliveryKind: event?.deliveryKind,
          outcomeCode: event?.outcomeCode,
          activationId: event?.activationId,
          consumedSeq: event?.consumedSeq,
        })}`,
        { cause: error },
      );
    }
  }

  const selected = agentIds[0];
  await manager.operatorExecute('luminaries_control', { action: 'close', agentId: selected });
  assert.equal(manager.store.snapshot().agents[selected]?.lifecycle, 'closed');
  assert.equal(openCollaboratorCount(manager.store.snapshot()), 9);
  await waitFor(() => manager.store.snapshot().agents[selected] === undefined);
  const closedAgent = (await manager.store.closedAgentLineage(selected)).find((agent) => agent.agentId === selected);
  assert.equal(closedAgent?.lifecycle, 'closed');
  assert.ok(closedAgent.sessionFile);
  const parentHost = manager.hostForParent({
    mode: 'tui',
    cwd: root,
    sessionManager: {
      getSessionId: () => 'release-parent',
      getSessionFile: () => parentSession,
    },
  });
  const closedCapabilities = await parentHost.execute(
    {
      toolName: 'luminaries_directory',
      input: { requestId: 'closed-owner-capabilities', action: 'inspect', agentId: selected, view: 'capabilities' },
    },
    undefined,
  );
  assert.equal(closedCapabilities.details.agentId, selected);
  const priorSession = await readFile(closedAgent.sessionFile, 'utf8');
  const oversizedTranscript = 'Oversized closed transcript '.repeat(2_000);
  const privatePathMessage = JSON.stringify({
    fixture: 'message',
    message: { role: 'user', content: [{ type: 'text', text: `Private session path ${closedAgent.sessionFile}` }] },
  });
  const oversizedMessage = JSON.stringify({
    fixture: 'message',
    message: { role: 'user', content: [{ type: 'text', text: oversizedTranscript }] },
  });
  await writeFile(closedAgent.sessionFile, `${priorSession}${privatePathMessage}\n${oversizedMessage}\n`);
  const actorsBeforeClosedReview = manager.actors.size;
  const closedTranscript = [];
  let closedCursor;
  do {
    const page = await manager.operatorExecute('luminaries_directory', {
      action: 'inspect',
      agentId: selected,
      view: 'transcript',
      limit: 1,
      ...(closedCursor ? { cursor: closedCursor } : {}),
    });
    assert.equal(page.details.lifecycle, 'closed');
    assert.ok(Buffer.byteLength(JSON.stringify(page.details)) <= 48 * 1024);
    closedTranscript.push(...page.details.transcript);
    closedCursor = page.details.page.nextCursor;
  } while (closedCursor);
  assert.ok(closedTranscript.some((message) => JSON.stringify(message).includes('Run release activity 1.')));
  assert.ok(!JSON.stringify(closedTranscript).includes(closedAgent.sessionFile));
  assert.equal(
    closedTranscript
      .filter((message) => message.parts > 1)
      .map((message) => message.text)
      .join(''),
    oversizedTranscript.trim(),
  );
  assert.equal(manager.actors.size, actorsBeforeClosedReview);

  await manager.operatorExecute('luminaries_control', { action: 'resume', agentId: selected });
  assert.equal(openCollaboratorCount(manager.store.snapshot()), 10);
  assert.equal(runtimeState(manager.store, selected), 'runtime_parked');
  await manager.operatorInput(selected, 'Resume on the exact retained private session.', 'auto');
  await waitFor(() => runtimeState(manager.store, selected) === 'idle');
  assert.equal(manager.store.snapshot().agents[selected].lifecycle, 'open');
  assert.equal(manager.actors.size, 10);
});
