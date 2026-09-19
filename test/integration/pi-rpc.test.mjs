import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PiRpcCommandError,
  PiRpcProcess,
  buildPrivateSessionLaunch,
  verifyPrivateSessionState,
} from '../../src/pi-rpc.ts';

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
    unsetEnv: extra.unsetEnv,
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
  assert.deepEqual(await second, { type: 'response', id: 'luminaries-2', success: true, ok: 'second' });
  assert.deepEqual(await first, { type: 'response', id: 'luminaries-1', success: true, ok: 'first' });
  assert.ok(rpc.stderr.join('').includes('fake diagnostic'));
});

test('custom clean-room launches can remove ambient appended system context without changing normal inheritance', async (t) => {
  const { rpc } = await start(t, 'normal', {
    env: {
      APPEND_SYSTEM: 'ambient append',
      PI_APPEND_SYSTEM: 'ambient pi append',
      PI_SYSTEM_PROMPT: 'ambient prompt',
    },
    unsetEnv: ['APPEND_SYSTEM', 'PI_APPEND_SYSTEM', 'PI_SYSTEM_PROMPT'],
  });
  const response = await rpc.request({ command: 'environment' });
  assert.equal(response.appendSystem, null);
  assert.equal(response.piAppendSystem, null);
  assert.equal(response.piSystemPrompt, null);
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
});

test('preserves individual messages and settlement when turn and run summaries exceed the record limit', async (t) => {
  const { rpc } = await start(t);
  const messages = [];
  rpc.on('event', (event) => {
    if (event.type === 'message_end') messages.push(event.message);
  });
  const result = await rpc.requestAndWaitForSettled({ command: 'oversized-summaries' });
  assert.equal(result.response.data.ok, true);
  assert.equal(result.settled.type, 'agent_settled');
  assert.equal(messages.length, 6);
  assert.equal(messages[0].content[0].text, 'Inspecting five images.');
  assert.ok(messages.slice(1).every((message) => message.content[0].data.length === 300 * 1024));
});

test('carries native-sized multi-image events and large commands while honoring explicit frame limits', async (t) => {
  const { rpc } = await start(t, 'normal', { requestTimeoutMs: 5_000 });
  const received = [];
  rpc.on('event', (event) => {
    if (event.type === 'tool_execution_end') received.push(event.result.content);
    if (event.type === 'message_end') received.push(event.message.content);
  });
  const result = await rpc.requestAndWaitForSettled({ command: 'native-media' }, 5_000);
  assert.equal(result.settled.type, 'agent_settled');
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
  await assert.rejects(bounded.rpc.requestAndWaitForSettled({ command: 'native-media' }), /JSONL record exceeds/);
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

test('rejects pending requests when the child exits', async (t) => {
  const { rpc } = await start(t, 'fail');
  const pending = rpc.request({ command: 'never-answers' });
  await assert.rejects(pending, /exited|failed|closed|23/);
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

test('malformed typed responses are terminal before later records in the same chunk', async (t) => {
  const { rpc } = await start(t);
  let events = 0;
  rpc.on('event', () => events++);
  await assert.rejects(rpc.request({ command: 'invalid-response' }), /boolean success/);
  assert.equal(events, 0);
  await assert.rejects(rpc.request({ command: 'later' }), /boolean success|not running|closed/);
});

test('unknown typed response is a terminal command-outcome failure', async (t) => {
  const { rpc } = await start(t);
  await assert.rejects(rpc.request({ command: 'unknown-response' }), /unknown request id/);
});

test('malformed stdout is terminal and later requests are refused', async (t) => {
  const { rpc } = await start(t, 'malformed');
  await assert.rejects(rpc.request({ command: 'bad' }), /Malformed JSONL/);
  await assert.rejects(rpc.request({ command: 'later' }), /Malformed JSONL|not running|closed/);
});

test('settlement requires a newly observed start and refuses overlap', async (t) => {
  const { rpc } = await start(t);
  const active = rpc.waitForAgentSettled(40);
  const activeResult = assert.rejects(active, /timeout/);
  const stale = rpc.request({ command: 'stale-settle' });
  await assert.rejects(rpc.requestAndWaitForSettled({ command: 'second' }), /settlement wait already active/);
  await stale;
  await activeResult;
});

test('settlement timeout is handled, terminal, and reports an indeterminate command boundary', async (t) => {
  const { rpc } = await start(t);
  await assert.rejects(rpc.requestAndWaitForSettled({ command: 'response-only' }, 40), /outcome is indeterminate/);
  await assert.rejects(rpc.request({ command: 'later' }), /indeterminate|not running|closed/);
});

test('process failure does not leave an unhandled settlement rejection', async (t) => {
  const { rpc } = await start(t, 'fail');
  await assert.rejects(rpc.requestAndWaitForSettled({ command: 'never-answers' }, 1_000), /exited|23/);
});

test('intentional close promptly cancels a standalone settlement wait', async (t) => {
  const { rpc } = await start(t);
  const wait = assert.rejects(rpc.waitForAgentSettled(1_000), /closed/);
  const started = Date.now();
  await rpc.close(500);
  await wait;
  assert.ok(Date.now() - started < 900);
});

test('listener exceptions are isolated and retained as diagnostics', async (t) => {
  const { rpc } = await start(t);
  rpc.on('event', () => {
    throw new Error('listener boom');
  });
  await rpc.request({ command: 'id-event' });
  assert.match(rpc.diagnostics.join(' '), /listener boom/);
});

test('timeouts begin at admission, make unknown outcomes terminal, and stderr keeps newest bytes', async (t) => {
  const { rpc } = await start(t);
  await assert.rejects(rpc.request({ command: 'never-answers' }, 20), /timeout/);
  await assert.rejects(rpc.request({ command: 'later' }), /timeout|not running|closed/);
  const { rpc: noisy } = await start(t, 'normal', {
    env: { FAKE_STDERR: '0123456789abcdef' },
    limits: { maxStderrBytes: 8 },
  });
  await new Promise((resolve) => noisy.once('stderr', resolve));
  assert.equal(Buffer.byteLength(noisy.stderr.join('')), 8);
  assert.equal(noisy.stderr.join(''), '89abcdef');
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

test('private launch uses exact private session path and provenance checks', async () => {
  const root = await mkdtemp(join(testRoot, 'private-'));
  const sessions = join(root, 'agent-a', 'pi-sessions');
  await mkdir(sessions, { recursive: true });
  const launch = buildPrivateSessionLaunch(
    {
      privateSessionDir: sessions,
      sessionId: 'agent-session-a',
      cwd: root,
      agentId: 'agent-a',
      model: 'provider/model',
      thinking: 'low',
    },
    invocation,
  );
  assert.deepEqual(launch.invocation.args.slice(-13), [
    '--mode',
    'rpc',
    '--session-dir',
    sessions,
    '--session-id',
    'agent-session-a',
    '--name',
    'agent-a',
    '--model',
    'provider/model',
    '--thinking',
    'low',
    '--no-extensions',
  ]);
  const state = verifyPrivateSessionState(
    { sessionId: 'agent-session-a', sessionFile: join(sessions, 'new.jsonl') },
    {
      sessionId: 'agent-session-a',
      privateSessionDir: sessions,
    },
  );
  assert.equal(state.sessionId, 'agent-session-a');
  const isolated = buildPrivateSessionLaunch(
    {
      privateSessionDir: sessions,
      sessionId: 'resource-session',
      cwd: root,
      noContextFiles: true,
      skills: [join(root, 'skill.md')],
      promptTemplates: [join(root, 'prompt.md')],
      themes: [join(root, 'theme.json')],
    },
    invocation,
  );
  assert.ok(isolated.invocation.args.includes('--no-context-files'));
  const appendOverride = isolated.invocation.args.indexOf('--append-system-prompt');
  assert.ok(appendOverride >= 0);
  assert.equal(isolated.invocation.args[appendOverride + 1], '');
  assert.ok(isolated.invocation.args.includes('--skill'));
  assert.ok(isolated.invocation.args.includes('--prompt-template'));
  assert.ok(isolated.invocation.args.includes('--theme'));
  assert.throws(
    () =>
      verifyPrivateSessionState(
        { sessionId: 'wrong', sessionFile: join(sessions, 'new.jsonl') },
        {
          sessionId: 'agent-session-a',
          privateSessionDir: sessions,
        },
      ),
    /ID mismatch/,
  );
  assert.throws(
    () =>
      verifyPrivateSessionState(
        { sessionId: 'agent-session-a', sessionFile: join(root, 'other.jsonl') },
        {
          sessionId: 'agent-session-a',
          privateSessionDir: sessions,
        },
      ),
    /inside/,
  );
  assert.throws(
    () =>
      verifyPrivateSessionState(
        { sessionId: 'agent-session-a', sessionFile: 'relative.jsonl' },
        {
          sessionId: 'agent-session-a',
          privateSessionDir: sessions,
        },
      ),
    /absolute path/,
  );
});

test('transport limits reject malformed public values', () => {
  assert.throws(() => new PiRpcProcess({ invocation, limits: { maxPendingRequests: 0 } }), /positive safe integer/);
  assert.throws(
    () => new PiRpcProcess({ invocation, limits: { maxRecordBytes: 100, maxBufferBytes: 99 } }),
    /hold one record/,
  );
});
