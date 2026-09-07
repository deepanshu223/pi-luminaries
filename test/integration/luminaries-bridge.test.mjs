import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { LuminariesManager } from '../../src/luminaries-manager.ts';
import { sendLuminariesToolCall } from '../../src/peer-bridge.ts';
import { createPiSessionHost } from '../../src/pi-session-host.ts';

function parentContext(root, sessionFile) {
  return {
    mode: 'tui',
    cwd: root,
    sessionManager: {
      getSessionId: () => 'parent-session',
      getSessionFile: () => sessionFile,
    },
  };
}

test('authenticated child bridge calls use the manager tool gateway and revoked credentials stop admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-bridge-'));
  const sessionFile = join(root, 'parent.jsonl');
  const manager = new LuminariesManager({
    sessionId: 'parent-session',
    sessionFile,
    cwd: root,
    agentDir: join(root, 'agent-state'),
    invocation: { command: process.execPath, args: [resolve('test/fixtures/fake-actor-rpc.mjs')] },
    env: { FAKE_ACTOR_DELAY_MS: '250' },
    sessionHost: createPiSessionHost(),
  });
  await manager.start();
  try {
    await manager.parentBeforeAgentStart('Exercise the authenticated child bridge.');
    await manager.parentAgentStart();
    const host = manager.hostForParent(parentContext(root, sessionFile));
    const spawned = await host.execute(
      {
        toolName: 'luminaries_spawn',
        input: {
          requestId: 'spawn',
          name: 'bridge-child',
          assignment: 'bridge work',
          ownershipBoundary: 'bridge boundary',
        },
      },
      undefined,
    );
    await manager.parentAgentSettled();
    const agentId = spawned.details.agent.agentId;
    await waitFor(() => manager.actors.has(agentId));
    const actor = manager.actors.get(agentId);
    assert.ok(actor);
    const unscoped = manager.bridge.issue(agentId);
    manager.bridge.bind(unscoped, actor);
    await assert.rejects(
      sendLuminariesToolCall({
        ...unscoped,
        toolCallId: 'unscoped',
        toolName: 'luminaries_directory',
        input: { action: 'list' },
      }),
      /bridge_auth|stale or forged/,
    );
    manager.bridge.revoke(unscoped);

    const credential = manager.bridge.issue(agentId, {
      sessionId: manager.store.snapshot().agents[agentId].sessionId,
      generation: manager.generationId,
    });
    manager.bridge.bind(credential, actor);
    const result = await sendLuminariesToolCall({
      ...credential,
      toolCallId: 'child-list',
      toolName: 'luminaries_directory',
      input: { action: 'list', limit: 1 },
    });
    assert.match(result.message, /directory page/u);
    assert.equal(result.details.capacity.used, 1);
    assert.equal(result.details.page.returned, 1);
    assert.equal(result.details.page.remaining, 1);
    assert.equal(typeof result.details.page.nextCursor, 'string');
    await manager.store.setRootCapacity(11);
    const continuation = await sendLuminariesToolCall({
      ...credential,
      toolCallId: 'child-list-next',
      toolName: 'luminaries_directory',
      input: { action: 'list', limit: 1, cursor: result.details.page.nextCursor },
    });
    assert.equal(continuation.details.page.returned, 1);
    assert.deepEqual(
      [...new Set([...result.details.entries, ...continuation.details.entries].map((entry) => entry.agentId))].sort(),
      [agentId, manager.store.snapshot().root.rootId].sort(),
    );
    let oversizedCommitted = false;
    manager.bridge.setToolHandler(async () => {
      oversizedCommitted = true;
      return { message: 'x'.repeat(50 * 1024), details: { committed: true } };
    });
    await assert.rejects(
      sendLuminariesToolCall({
        ...credential,
        toolCallId: 'oversized-committed-receipt',
        toolName: 'luminaries_message',
        input: { action: 'send', recipientId: agentId, message: 'Commit once despite response loss.' },
      }),
      /outcome is uncertain.*must not be replayed/su,
    );
    assert.equal(oversizedCommitted, true);
    manager.bridge.revoke(credential);
    await assert.rejects(
      sendLuminariesToolCall({
        ...credential,
        toolCallId: 'revoked',
        toolName: 'luminaries_directory',
        input: { action: 'list' },
      }),
      /refused|unauthorized|Bridge/,
    );
  } finally {
    await manager.close();
  }
});

test('manager shutdown stops admission and drains an already admitted bridge handler before Store close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-bridge-drain-'));
  const sessionFile = join(root, 'parent.jsonl');
  const manager = new LuminariesManager({
    sessionId: 'parent-session',
    sessionFile,
    cwd: root,
    agentDir: join(root, 'agent-state'),
  });
  await manager.start();
  const rootId = manager.store.snapshot().root.rootId;
  await manager.store.admitAgent(
    {
      agentId: 'bridge-child',
      parentId: rootId,
      segment: 'bridge-child',
      cwd: root,
      sessionId: 'bridge-session',
      sessionDir: join(root, 'bridge-session'),
      displayName: 'bridge child',
      assignment: 'hold one bridge call',
      ownershipBoundary: 'bridge only',
    },
    { kind: 'agent', agentId: rootId },
  );
  const claimed = await manager.store.claimRuntime('bridge-child', process.pid, 'test-host');
  const runtimeOwner = claimed.value.runtimeOwner;
  await manager.store.markRuntimeSpawned('bridge-child', runtimeOwner, process.pid);
  await manager.store.markRuntimeReady('bridge-child', runtimeOwner, process.pid);
  const credential = manager.bridge.issue('bridge-child', {
    sessionId: 'bridge-session',
    generation: manager.generationId,
  });
  manager.bridge.bind(credential, { runtimeIdentity: { agentId: 'bridge-child', runtimeOwner } });

  let enter;
  let release;
  const entered = new Promise((resolvePromise) => {
    enter = resolvePromise;
  });
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  manager.bridge.setToolHandler(async () => {
    enter();
    await gate;
    return { message: 'done', details: { done: true } };
  });
  const call = sendLuminariesToolCall({
    ...credential,
    toolCallId: 'drain-call',
    toolName: 'luminaries_directory',
    input: { action: 'list' },
    timeoutMs: 500,
  }).catch((error) => error);
  await entered;
  const timeout = await call;
  assert.match(timeout.message, /tool response timed out.*outcome is uncertain/u);
  let closed = false;
  const closing = manager.close().then(() => {
    closed = true;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(manager.lifecycle, 'closed');
});

test('post-dispatch bridge receipt failures forbid semantic replay', async (t) => {
  let admissions = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the committed request body before returning a corrupt receipt.
    }
    admissions++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{invalid');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  await assert.rejects(
    sendLuminariesToolCall({
      url: `http://127.0.0.1:${address.port}/v1/tools`,
      token: 'x'.repeat(43),
      toolCallId: 'lost-receipt',
      toolName: 'luminaries_message',
      input: { action: 'send', recipientId: 'agent-a', message: 'Commit exactly once.' },
    }),
    /outcome is uncertain.*must not be replayed/su,
  );
  assert.equal(admissions, 1);
});

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail('Timed out waiting for bridge state');
}
