import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LuminariesManager } from '../../src/luminaries-manager.ts';
import { agentRuntimeState, sha256 } from '../../src/scheduler-state.ts';
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
  const attention = manager.commandCenterProjection().agents.find((item) => item.agentId === ready.agentId);
  assert.equal(attention.attention, true);
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
  const resumedAgent = manager.store.snapshot().agents[ready.agentId];
  assert.equal(resumedAgent.sessionFile, agent.sessionFile);
  const after = await fixtureMessages(resumedAgent.sessionFile);
  assert.equal(
    after.filter((message) => JSON.stringify(message).includes('UNCERTAIN_INPUT_MUST_NOT_REPLAY')).length,
    1,
  );
  assert.equal(after.filter((message) => JSON.stringify(message).includes('RECOVERY_INPUT_AFTER_CRASH')).length, 1);
  await waitFor(
    () => manager.commandCenterProjection().agents.find((item) => item.agentId === ready.agentId)?.attention === false,
  );

  await manager.close();
  manager = new LuminariesManager({ ...options, invocation });
  await manager.start();
  const restarted = manager.commandCenterProjection().agents.find((item) => item.agentId === ready.agentId);
  assert.ok(restarted);
  assert.equal(restarted.attention, false);
});
