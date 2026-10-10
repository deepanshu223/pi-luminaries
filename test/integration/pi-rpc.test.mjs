import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PiRpcCommandError, PiRpcProcess, buildPrivateSessionLaunch } from '../../src/pi-rpc.ts';

const fake = resolve('test/fixtures/fake-rpc.mjs');
const invocation = { command: process.execPath, args: [fake] };
const testRoot = await mkdtemp(join(tmpdir(), 'luminaries-rpc-'));
after(() => rm(testRoot, { recursive: true, force: true }));

async function start(t, mode = 'normal', extra = {}) {
  const root = await mkdtemp(join(testRoot, 'session-'));
  const rpc = new PiRpcProcess({
    invocation,
    env: {
      FAKE_RPC_MODE: mode,
      FAKE_SESSION_ID: 'fixture-session',
      FAKE_SESSION_FILE: join(root, 'session.jsonl'),
      ...(extra.env ?? {}),
    },
    limits: { maxStderrBytes: 1024, ...(extra.limits ?? {}) },
    requestTimeoutMs: extra.requestTimeoutMs ?? 1_000,
  });
  t.after(() => rpc.close());
  rpc.start();
  return { rpc, root };
}

test('correlates out-of-order responses while serializing stdin writes', async (t) => {
  const { rpc } = await start(t);
  const first = rpc.request({ command: 'first' });
  const second = rpc.request({ command: 'second' });
  assert.equal((await second).ok, 'second');
  assert.equal((await first).ok, 'first');
  assert.ok(rpc.stderr.join('').includes('fake diagnostic'));
});

test('inherits ordinary environment while removing stale parent-session metadata', async (t) => {
  const keys = ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  });
  for (const key of keys) process.env[key] = `parent-${key.toLowerCase()}`;
  const { rpc } = await start(t);
  const response = await rpc.request({ command: 'environment' });
  assert.equal(response.inheritedPath, true);
  assert.equal(response.parentSessionId, null);
  assert.equal(response.parentSessionFile, null);
  assert.equal(response.parentProvider, null);
  assert.equal(response.parentModel, null);
  assert.equal(response.parentReasoning, null);
  await assert.rejects(rpc.request({ command: 'bad-id', id: { nested: true } }), /id must be a string or number/);
});

test('verifies exact private get_state provenance', async (t) => {
  const { rpc, root } = await start(t);
  const state = await rpc.getState({ sessionId: 'fixture-session', privateSessionDir: root });
  assert.equal(state.sessionFile, join(root, 'session.jsonl'));
  await assert.rejects(rpc.getState({ sessionId: 'wrong-session', privateSessionDir: root }), /ID mismatch/);
  await assert.rejects(
    rpc.getState({ sessionId: 'fixture-session', privateSessionDir: join(root, 'other') }),
    /inside/,
  );
  const relative = await start(t, 'normal', { env: { FAKE_SESSION_FILE: 'relative.jsonl' } });
  await assert.rejects(
    relative.rpc.getState({ sessionId: 'fixture-session', privateSessionDir: root }),
    /absolute path/,
  );
});

test('carries native-sized multi-image events and large commands while honoring explicit frame limits', async (t) => {
  const { rpc } = await start(t, 'normal', { requestTimeoutMs: 5_000 });
  const received = [];
  let settled = false;
  rpc.on('event', (event) => {
    if (event.type === 'tool_execution_end') received.push(event.result.content);
    if (event.type === 'message_end') received.push(event.message.content);
    if (event.type === 'agent_settled') settled = true;
  });
  const response = await rpc.request({ command: 'native-media' });
  assert.equal(response.data.ok, true);
  assert.equal(settled, true);
  assert.equal(received.length, 2);
  for (const content of received) {
    assert.equal(content.length, 2);
    for (const [index, image] of content.entries()) {
      assert.equal(image.data.length, 4.5 * 1024 * 1024 - 4);
      assert.equal(image.data[0], index === 0 ? 'A' : 'B');
    }
  }
  const echoed = await rpc.request({ command: 'echo-size', message: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(echoed.data.characters, 2 * 1024 * 1024);
  const bounded = await start(t, 'normal', {
    limits: { maxRecordBytes: 1024 * 1024, maxBufferBytes: 2 * 1024 * 1024 },
  });
  await assert.rejects(bounded.rpc.request({ command: 'native-media' }), /JSONL record exceeds/);
});

test('intentional close is truthful, awaited, and emits no failure', async (t) => {
  const { rpc } = await start(t);
  let failures = 0;
  rpc.on('failure', () => {
    failures++;
  });
  await rpc.close(1_000);
  assert.equal(failures, 0);
  assert.ok(rpc.process?.exitCode !== null || rpc.process?.signalCode !== null);
  await rpc.close();
});

test('typed responses reject Pi command errors and id-bearing events remain events', async (t) => {
  const { rpc } = await start(t);
  const events = [];
  rpc.on('event', (event) => events.push(event));
  const result = await rpc.request({ command: 'id-event' });
  assert.equal(result.success, true);
  assert.equal(events[0].type, 'tool_call');
  await assert.rejects(
    rpc.request({ command: 'failed', type: 'steer' }),
    (error) =>
      error instanceof PiRpcCommandError && error.command === 'steer' && /fixture command failed/.test(error.message),
  );
});

test('lost or corrupt RPC outcomes fail pending and later commands', async (t) => {
  for (const [mode, command, error] of [
    ['fail', 'never-answers', /exited|failed|closed|23/],
    ['malformed', 'bad', /Malformed JSONL/],
    ['normal', 'invalid-response', /boolean success/],
    ['normal', 'unknown-response', /unknown request id/],
    ['normal', 'never-answers', /timeout/],
  ]) {
    const { rpc } = await start(t, mode);
    const events = [];
    rpc.on('event', (event) => events.push(event));
    await assert.rejects(
      rpc.request({ command }, command === 'never-answers' && mode === 'normal' ? 100 : 1000),
      error,
    );
    await assert.rejects(rpc.request({ command: 'later' }));
    assert.deepEqual(events, [], 'No event may be trusted after transport failure');
    await rpc.close();
  }
});

test('private launch rejects relative paths, invalid IDs, and reserved argument injection', async () => {
  assert.throws(
    () =>
      buildPrivateSessionLaunch({ privateSessionDir: 'relative', sessionId: 'valid', cwd: resolve('.') }, invocation),
    /absolute/,
  );
  assert.throws(
    () =>
      buildPrivateSessionLaunch(
        { privateSessionDir: resolve('.'), sessionId: '-invalid-', cwd: resolve('.') },
        invocation,
      ),
    /alphanumeric/,
  );
  assert.doesNotThrow(() =>
    buildPrivateSessionLaunch(
      { privateSessionDir: resolve('.'), sessionId: 'valid.with-dots', cwd: resolve('.') },
      invocation,
    ),
  );
  const launch = buildPrivateSessionLaunch(
    { privateSessionDir: resolve('.'), sessionId: 'valid', cwd: resolve('.'), extraArgs: ['--session-dir', 'global'] },
    invocation,
  );
  assert.equal(launch.invocation.args.includes('global'), false);
  assert.throws(
    () =>
      buildPrivateSessionLaunch(
        { privateSessionDir: resolve('.'), sessionId: 'valid', cwd: resolve('.') },
        {
          command: process.execPath,
          args: [fake, '--no-session'],
        },
      ),
    /base invocation arguments/,
  );
});
