import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PiRpcProcess } from '../../src/pi-rpc.ts';
import { discoverAttachmentDescriptors, LuminariesAttachmentClient } from '../../src/attachment.ts';

export function textOf(message) {
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

export function waitFor(read, subscribe, signal) {
  return new Promise((resolveWait, reject) => {
    let unsubscribe = () => {};
    const cleanup = () => {
      unsubscribe();
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const check = () => {
      try {
        const result = read();
        if (result) {
          cleanup();
          resolveWait(result);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    unsubscribe = subscribe(check);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else check();
  });
}

export async function nativePi(t, { luminaries = true, respond, appendSystemPrompt } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-native-'));
  const profile = join(root, 'profile');
  const calls = [];
  const changes = new EventEmitter();
  const processes = [];
  let client;
  let providerError;
  const provider = resolve('test/fixtures/scripted-provider.mjs');
  const extension = process.env.LUMINARIES_TEST_EXTENSION ?? resolve('src/extension.ts');
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const call = JSON.parse(body);
      call.respond = (content = [{ type: 'text', text: 'Done.' }]) => response.end(JSON.stringify(content));
      calls.push(call);
      queueMicrotask(() => changes.emit('change'));
      const last = call.messages.at(-1);
      const text = textOf(last);
      if (respond?.(call) === false) return;
      const instruction = text.indexOf('TEST_CALL ');
      if (last?.role === 'user' && instruction >= 0) {
        const { tool, args } = JSON.parse(text.slice(instruction + 'TEST_CALL '.length));
        call.respond([{ type: 'toolCall', id: randomUUID(), name: tool, arguments: args }]);
      } else call.respond();
    } catch (error) {
      providerError = error;
      response.destroy();
      changes.emit('change');
    }
  });
  t.after(async () => {
    if (client && !client.readOnlyReason()) await client.operatorParkAll('now').catch(() => {});
    const cleanup = await Promise.allSettled([client?.close(), ...processes.map((pi) => pi.close())]);
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Pi test cleanup failed',
      );
  });
  await mkdir(profile);
  if (appendSystemPrompt) await writeFile(join(profile, 'APPEND_SYSTEM.md'), appendSystemPrompt);
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
      luminaries: { maxDepth: 3, agentExtensions: { [provider]: 'always' } },
    }),
  );
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const providerUrl = `http://127.0.0.1:${server.address().port}`;
  const signal = t.signal;
  async function launch({ session, withLuminaries = luminaries } = {}) {
    const rpc = new PiRpcProcess({
      invocation: {
        command: process.execPath,
        args: [
          process.env.LUMINARIES_TEST_PI ?? resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
          '--mode',
          'rpc',
          '--no-extensions',
          '--extension',
          provider,
          ...(withLuminaries ? ['--extension', extension] : []),
          ...(session ? [] : ['--provider', 'luminaries-test', '--model', 'scripted', '--thinking', 'off']),
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          ...(session ? ['--session', session] : ['--session-dir', join(root, 'sessions')]),
        ],
      },
      cwd: root,
      env: { PI_CODING_AGENT_DIR: profile, LUMINARIES_TEST_PROVIDER: providerUrl },
    });
    processes.push(rpc);
    const events = [];
    rpc.on('event', (event) => {
      events.push(event);
      changes.emit('change');
    });
    rpc.on('failure', () => changes.emit('change'));
    const wait = (read) =>
      waitFor(
        () => {
          if (providerError) throw providerError;
          const value = read();
          if (!value && rpc.diagnostics.length) throw new Error(rpc.diagnostics.join('\n'));
          return value;
        },
        (check) => {
          changes.on('change', check);
          return () => changes.off('change', check);
        },
        signal,
      );
    rpc.start();
    const state = (await rpc.request({ type: 'get_state' })).data;
    async function turn(message) {
      const offset = events.length;
      await rpc.request({ type: 'prompt', message });
      await wait(() => events.slice(offset).some((event) => event.type === 'agent_settled'));
      const failures = events.slice(offset).filter((event) => event.type === 'extension_error');
      assert.deepEqual(failures, []);
      return events.slice(offset);
    }
    return { rpc, events, state, turn, wait };
  }
  let pi = await launch();
  async function tool(toolName, args) {
    const events = await pi.turn(`TEST_CALL ${JSON.stringify({ tool: toolName, args })}`);
    const result = events.find((event) => event.type === 'tool_execution_end' && event.toolName === toolName);
    assert.ok(result, `Pi did not execute ${toolName}`);
    assert.equal(result.isError, false, JSON.stringify(result.result));
    return result.result.details;
  }
  async function connect() {
    const [descriptor] = await discoverAttachmentDescriptors(profile, root);
    assert.ok(descriptor, 'Root did not publish its attachment');
    client = await LuminariesAttachmentClient.connect(descriptor.descriptorPath);
    client.onCommandCenterChange(() => changes.emit('change'));
  }
  if (luminaries) {
    await assert.rejects(stat(join(profile, 'luminaries', 'roots')), { code: 'ENOENT' });
    await tool('luminaries_directory', { action: 'list' });
    await connect();
  }
  async function restart() {
    await client.operatorParkAll('safe');
    const session = (await pi.rpc.request({ type: 'get_state' })).data.sessionFile;
    await client.close();
    await pi.rpc.close();
    pi = await launch({ session });
    await connect();
  }
  const waitState = (read) => waitFor(read, (check) => client.onCommandCenterChange(check), signal);
  const agent = (id) => client.commandCenterProjection().agents.find((item) => item.agentId === id);
  const settled = (id) => waitState(() => agent(id)?.humanState === 'idle');
  return {
    root,
    profile,
    calls,
    tool,
    launch,
    restart,
    waitState,
    agent,
    settled,
    get rpc() {
      return pi.rpc;
    },
    get events() {
      return pi.events;
    },
    get client() {
      return client;
    },
    turn: (message) => pi.turn(message),
    wait: (read) => pi.wait(read),
  };
}
