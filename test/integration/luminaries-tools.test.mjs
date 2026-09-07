import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../../src/extension.ts';
import { childInputCommand } from '../../src/child-input.ts';
import { isLuminariesId } from '../../src/identifiers.ts';
import { createLuminariesTools, renderLuminariesProtocolMessage } from '../../src/luminaries-tools.ts';
import { CustomMessageComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { stripVTControlCharacters } from 'node:util';
import { sha256 } from '../../src/scheduler-state.ts';

const names = [
  'luminaries_spawn',
  'luminaries_directory',
  'luminaries_message',
  'luminaries_control',
  'luminaries_await',
];
const ownedTools = (tools) => tools.map((tool) => ({ name: tool.name }));
const emptyConfigurationHost = {
  async load() {
    return { global: {}, project: {}, resolveExtension: async () => [] };
  },
};

test('extension factory registers only the five production tools without opening a session resource', () => {
  const tools = [];
  const commands = [];
  const flags = [];
  const shortcuts = [];
  const events = new Set();
  extension({
    registerTool: (tool) => tools.push(tool),
    registerMessageRenderer: () => undefined,
    registerFlag: (name, options) => flags.push([name, options.type]),
    registerCommand: (name) => commands.push(name),
    registerShortcut: (shortcut) => shortcuts.push(shortcut),
    on: (event) => events.add(event),
    sendMessage: async () => undefined,
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    names,
  );
  assert.deepEqual(commands, ['luminaries']);
  assert.deepEqual(flags, [
    ['luminaries', 'boolean'],
    ['luminary', 'string'],
  ]);
  assert.deepEqual(shortcuts, ['alt+l']);
  for (const event of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'session_compact'])
    assert.ok(events.has(event), `Missing Pi activity handler: ${event}`);
});

test('an unused parent session starts and stops without creating Luminaries state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-unused-session-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const handlers = new Map();
  const tools = [];
  try {
    extension(
      {
        registerTool: (tool) => tools.push(tool),
        registerMessageRenderer: () => undefined,
        registerFlag: () => undefined,
        getFlag: () => undefined,
        registerCommand: () => undefined,
        registerShortcut: () => undefined,
        on: (event, handler) => handlers.set(event, handler),
        sendMessage: () => undefined,
      },
      emptyConfigurationHost,
    );
    await handlers.get('session_start')(
      {},
      {
        mode: 'tui',
        cwd: root,
        isProjectTrusted: () => true,
        getSystemPrompt: () => 'Test Pi startup prompt.',
        scopedModels: [],
        modelRegistry: { getAvailable: () => [] },
        sessionManager: {
          getSessionId: () => 'unused-parent-session',
          getSessionFile: () => join(root, 'parent.jsonl'),
          getBranch: () => [],
        },
      },
    );
    await handlers.get('session_shutdown')({}, {});
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('first Luminaries tool use during an already-started parent turn preserves the current root activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-first-use-mid-turn-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const handlers = new Map();
  const tools = [];
  const extensionContext = {
    mode: 'tui',
    cwd: root,
    isProjectTrusted: () => true,
    model: { provider: 'test-provider', id: 'test-model' },
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [
        {
          provider: 'test-provider',
          id: 'test-model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: true,
        },
      ],
    },
    thinkingLevel: 'low',
    getSystemPrompt: () => 'Test Pi startup prompt.',
    sessionManager: {
      getSessionId: () => 'mid-turn-parent-session',
      getSessionFile: () => join(root, 'parent.jsonl'),
      getBranch: () => [],
    },
  };
  try {
    extension(
      {
        registerTool: (tool) => tools.push(tool),
        registerMessageRenderer: () => undefined,
        registerFlag: () => undefined,
        registerCommand: () => undefined,
        registerShortcut: () => undefined,
        on: (event, handler) => handlers.set(event, handler),
        sendMessage: () => undefined,
        getAllTools: () => ownedTools(tools),
        getActiveTools: () => tools.map((tool) => tool.name),
        getThinkingLevel: () => 'low',
      },
      emptyConfigurationHost,
    );
    await handlers.get('before_agent_start')({ prompt: 'The parent turn is already beginning.' }, extensionContext);
    await handlers.get('agent_start')({}, extensionContext);
    const agentsTool = tools.find((tool) => tool.name === 'luminaries_directory');
    const result = await agentsTool.execute(
      'mid-turn-list',
      { action: 'list' },
      undefined,
      undefined,
      extensionContext,
    );
    const details = JSON.parse(result.content[0].text.split('\n').at(-1));
    assert.equal(details.entries.length, 1);
    assert.equal(details.entries[0].activity.state, 'working');
    await handlers.get('agent_settled')({}, extensionContext);
    await handlers.get('session_shutdown')({}, extensionContext);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('child extension authenticates its session and clears bridge secrets without prompt injection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-child-extension-'));
  const outbox = join(root, 'outbox');
  await mkdir(outbox);
  const binding = {
    LUMINARIES_BRIDGE_URL: 'http://127.0.0.1:43210/v1/tools',
    LUMINARIES_BRIDGE_TOKEN: 'x'.repeat(43),
    LUMINARIES_AGENT_ID: 'child-agent',
    LUMINARIES_ROOT_ID: 'root-agent',
    LUMINARIES_SESSION_ID: 'child-session',
    LUMINARIES_GENERATION: 'generation-1',
    LUMINARIES_PARENT_ID: 'parent-agent',
    LUMINARIES_AGENT_PATH: 'root/parent/child',
    LUMINARIES_OUTBOX_DIR: outbox,
  };
  Object.assign(process.env, binding);
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  const tools = [];
  try {
    extension({
      registerTool: (tool) => tools.push(tool),
      registerMessageRenderer: () => undefined,
      registerFlag: () => undefined,
      registerCommand: (name, command) => commands.set(name, command),
      registerShortcut: () => assert.fail('child must not register a parent shortcut'),
      on: (event, handler) => handlers.set(event, handler),
      sendMessage: async (...args) => messages.push(args),
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      names,
    );
    for (const key of Object.keys(binding)) assert.equal(process.env[key], undefined);
    assert.deepEqual([...commands.keys()], ['luminaries-input']);
    const firstPayload = 'Private child input.';
    const firstPayloadId = 'dispatch-payload-1';
    const firstPayloadHash = sha256(firstPayload);
    await writeFile(
      join(outbox, `${firstPayloadId}.json`),
      JSON.stringify({
        version: 1,
        eventId: firstPayloadId,
        payloadHash: firstPayloadHash,
        message: firstPayload,
      }),
    );
    const encoded = childInputCommand({
      inputId: 'dispatch-1',
      payloadId: firstPayloadId,
      delivery: 'steer',
      payloadHash: firstPayloadHash,
      source: 'Root',
      startingInput: false,
      lines: ['From Root'],
    }).split(' ')[1];
    await commands.get('luminaries-input').handler(encoded, {});
    assert.deepEqual(messages, [
      [
        {
          customType: 'luminaries_protocol_message',
          content: 'From Root:\nPrivate child input.',
          display: true,
          details: {
            inputId: 'dispatch-1',
            source: 'Root',
            content: 'From Root:\nPrivate child input.',
            lines: ['From Root'],
          },
        },
        { deliverAs: 'steer', triggerTurn: true },
      ],
    ]);
    const followUpPayload = 'Private child follow-up.';
    const followUpPayloadId = 'dispatch-payload-2';
    const followUpPayloadHash = sha256(followUpPayload);
    await writeFile(
      join(outbox, `${followUpPayloadId}.json`),
      JSON.stringify({
        version: 1,
        eventId: followUpPayloadId,
        payloadHash: followUpPayloadHash,
        message: followUpPayload,
      }),
    );
    const followUp = childInputCommand({
      inputId: 'dispatch-2',
      payloadId: followUpPayloadId,
      delivery: 'follow_up',
      payloadHash: followUpPayloadHash,
      source: 'Root',
      startingInput: false,
      lines: ['From Root'],
    }).split(' ')[1];
    await commands.get('luminaries-input').handler(followUp, {});
    assert.deepEqual(messages[1]?.[1], { deliverAs: 'followUp', triggerTurn: true });
    await handlers.get('session_start')({}, childContext('child-session'));
    await handlers.get('session_shutdown')({ reason: 'reload' }, {});
    for (const key of Object.keys(binding)) assert.equal(process.env[key], undefined);
    const reloadedCommands = new Map();
    extension({
      registerTool: () => undefined,
      registerMessageRenderer: () => undefined,
      registerFlag: () => undefined,
      registerCommand: (name, command) => reloadedCommands.set(name, command),
      registerShortcut: () => assert.fail('reloaded child must not register a parent shortcut'),
      on: () => undefined,
      sendMessage: async () => undefined,
    });
    assert.deepEqual([...reloadedCommands.keys()], ['luminaries-input']);
    for (const key of Object.keys(binding)) assert.equal(process.env[key], undefined);
  } finally {
    for (const key of Object.keys(binding)) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});

test('native peer messages distinguish their sender and expand without losing content', () => {
  initTheme('dark', false);
  const body =
    'The focus review is complete.\n\n- Pinning preserves focus.\n- Filtering keeps a usable target.\n\nUse `focus()` for the fallback.\n\nFINAL_DETAIL';
  const message = {
    role: 'custom',
    customType: 'luminaries_protocol_message',
    display: true,
    content: `From Deneb · e7b37d (correlationId private-correlation):\n${body}`,
    details: { source: 'Deneb · e7b37d', presentation: 'message', content: `From Deneb · e7b37d:\n${body}` },
  };
  const component = new CustomMessageComponent(message, renderLuminariesProtocolMessage);
  const collapsed = stripVTControlCharacters(component.render(80).join('\n'));
  assert.match(collapsed, /From Deneb · e7b37d/u);
  assert.match(collapsed, /│.*focus review/u);
  assert.match(collapsed, /expand message/u);
  assert.doesNotMatch(collapsed, /FINAL_DETAIL|private-correlation/u);
  component.setExpanded(true);
  const expanded = stripVTControlCharacters(component.render(80).join('\n'));
  assert.match(expanded, /FINAL_DETAIL/u);
  assert.match(expanded, /Filtering keeps a usable target/u);
  assert.doesNotMatch(expanded, /private-correlation|expand message/u);
  component.setExpanded(false);
  assert.equal(stripVTControlCharacters(component.render(80).join('\n')), collapsed);
  assert.match(message.content, /private-correlation/u, 'display expansion never rewrites model input');
  const short = new CustomMessageComponent(
    { ...message, details: { ...message.details, content: 'From Deneb · e7b37d:\nReady to review.' } },
    renderLuminariesProtocolMessage,
  );
  assert.match(stripVTControlCharacters(short.render(80).join('\n')), /Ready to review/u);
  assert.doesNotMatch(stripVTControlCharacters(short.render(80).join('\n')), /expand message/u);
});

test('the five tools use strict parallel schemas and normalize untrusted input once', async () => {
  const calls = [];
  const tools = createLuminariesTools(() => ({
    async execute(command) {
      calls.push(command);
      return {
        message: command.toolName,
        details: { toolName: command.toolName },
        ...(command.toolName === 'luminaries_message' ? { terminate: true } : {}),
      };
    },
  }));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    names,
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.executionMode, 'parallel');
    assert.equal(tool.renderShell, 'self');
  }
  await tools[0].execute(
    'spawn-call',
    { name: 'child', assignment: 'work\nacross two ordinary lines', ownershipBoundary: 'boundary' },
    undefined,
    undefined,
    {},
  );
  await tools[1].execute('agents-call', { action: 'inspect', agentId: 'Writer · b35ac8' }, undefined, undefined, {});
  await tools[2].execute(
    'message-call',
    { action: 'send', recipientId: 'Writer · b35ac8', message: 'hello', mode: 'notify_only' },
    undefined,
    undefined,
    {},
  );
  await tools[3].execute(
    'control-call',
    { action: 'set_grants', agentId: 'Writer · b35ac8', grants: { spawn: false } },
    undefined,
    undefined,
    {},
  );
  await tools[4].execute('await-call', { action: 'wait', agentIds: ['Writer · b35ac8'] }, undefined, undefined, {});
  assert.deepEqual(
    calls.map((call) => call.toolName),
    names,
  );
  await tools[3].execute(
    'extension-control-call',
    { action: 'set_extensions', agentId: 'Writer · b35ac8', extensions: ['npm:pi-web-access'] },
    undefined,
    undefined,
    {},
  );
  assert.deepEqual(tools[2].parameters.properties.action.enum, [
    'send',
    'multicast',
    'request',
    'request_many',
    'reply',
    'cancel',
  ]);
  assert.equal(tools[2].parameters.oneOf, undefined);
  assert.ok(tools[2].parameters.properties.mode.enum.includes('notify_only'));
  assert.equal(calls[2].input.requestId, 'message-call');
  assert.equal(calls[0].input.assignment, 'work\nacross two ordinary lines');
  assert.equal(calls[2].input.recipientId, 'Writer · b35ac8');
  assert.equal(calls[2].input.mode, 'notify_only');
  assert.deepEqual(calls.at(-1).input.extensions, ['npm:pi-web-access']);
  const renderTheme = { fg: (_tone, text) => text };
  assert.match(
    tools[2]
      .renderCall({ action: 'send', recipientId: 'Writer · b35ac8', message: 'hello' }, renderTheme)
      .render(80)[0],
    /Message · Writer · b35ac8/u,
  );
  const rootCall = tools[2]
    .renderCall(
      { action: 'send', recipientId: 'luminaries-root-337058076365619e52410bc7bad229c2e2a857ff', message: 'hello' },
      renderTheme,
    )
    .render(100)[0];
  assert.match(rootCall, /Message · Root/u);
  assert.doesNotMatch(rootCall, /337058076365/u);
  for (const name of ['Arcturus', 'Aldebaran'])
    assert.ok(
      tools[2]
        .renderCall({ action: 'send', recipientId: name, message: 'hello' }, renderTheme)
        .render(100)[0]
        .includes(`Message · ${name}`),
    );
  const unresolvedFullId = tools[2]
    .renderCall(
      { action: 'send', recipientId: 'luminaries-agent-337058076365619e52410bc7bad229c2e2a857ff', message: 'hello' },
      renderTheme,
    )
    .render(100)[0];
  assert.match(unresolvedFullId, /Message · luminary/u);
  assert.doesNotMatch(unresolvedFullId, /a857ff/u);
  const multiline = 'First finding\nSecond finding\twith detail';
  const expanded = tools[2]
    .renderResult(
      { content: [{ type: 'text', text: 'Message accepted for delivery.' }], details: { status: 'admitted' } },
      { expanded: true, isPartial: false },
      renderTheme,
      { args: { action: 'send', recipientId: 'Writer · b35ac8', message: multiline }, isError: false },
    )
    .render(80)
    .join('\n');
  assert.match(expanded, /accepted/u);
  assert.match(expanded, /First finding/u);
  assert.match(expanded, /Second finding.*with detail/su);
  const partialGroup = tools[2]
    .renderResult(
      {
        content: [{ type: 'text', text: 'One message accepted; one refused.\n{"legs":["private"]}' }],
        details: {
          action: 'multicast',
          legs: [
            { recipient: { humanHandle: 'Vega · 11aa22' }, status: 'accepted' },
            {
              recipient: { humanHandle: 'Sirius · 33bb44' },
              status: 'refused',
              outcomeCode: 'recipient_closed',
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      renderTheme,
      { args: { action: 'multicast', message: 'Review this.' }, isError: false },
    )
    .render(100)
    .join('\n');
  assert.match(partialGroup, /1 accepted · 1 refused/u);
  assert.match(partialGroup, /Sirius · 33bb44 · refused · recipient closed/u);
  assert.doesNotMatch(partialGroup, /"legs"|private/u);
  const mixedOutcomes = tools[2]
    .renderResult(
      {
        details: {
          action: 'request_many',
          legs: [
            { recipient: { humanHandle: 'Vega · abc123' }, status: 'settled', requestStatus: 'timed_out' },
            { recipient: { humanHandle: 'Sirius · def456' }, status: 'settled', requestStatus: 'cancelled' },
            { recipient: { humanHandle: 'Altair · fed321' }, status: 'aborted' },
            { recipient: { humanHandle: 'Deneb · cba654' }, status: 'settled', requestStatus: 'replied' },
          ],
        },
      },
      { expanded: true, isPartial: false },
      renderTheme,
      { args: { action: 'request_many' }, isError: false },
    )
    .render(160)
    .join('\n');
  assert.match(mixedOutcomes, /Requests to 4 luminaries · 1 timed out · 1 cancelled · 1 interrupted · 1 replied/u);
  assert.match(mixedOutcomes, /Vega · abc123 · timed out/u);
  assert.match(mixedOutcomes, /Sirius · def456 · cancelled/u);
  assert.match(mixedOutcomes, /Altair · fed321 · interrupted/u);
  assert.doesNotMatch(mixedOutcomes, /accepted/u);
  const uncertainConfiguration = tools[3]
    .renderResult(
      {
        content: [{ type: 'text', text: 'Internal receipt\n{"private":"metadata"}' }],
        details: {
          action: 'set_model',
          status: 'indeterminate',
          error: 'Pi changed model but did not confirm thinking.',
        },
      },
      { expanded: true, isPartial: false },
      renderTheme,
      { args: { action: 'set_model', agentId: 'Root' }, isError: false },
    )
    .render(160)
    .join('\n');
  assert.match(uncertainConfiguration, /Pi changed model but did not confirm thinking\./u);
  assert.doesNotMatch(uncertainConfiguration, /private|metadata/u);
  const controlResult = tools[3]
    .renderResult(
      {
        content: [{ type: 'text', text: 'Model changed.' }],
        details: { action: 'set_model', status: 'applied', target: { humanHandle: 'Arcturus · 12abef' } },
      },
      { expanded: false, isPartial: false },
      renderTheme,
      { args: { action: 'set_model', agentId: 'Arcturus' }, isError: false },
    )
    .render(100)
    .join('\n');
  assert.equal(controlResult.match(/Arcturus/gu)?.length, 1);
  const failed = tools[3]
    .renderResult(
      { content: [{ type: 'text', text: 'No running turn exists.' }], details: {} },
      { expanded: false, isPartial: false },
      renderTheme,
      { args: { action: 'interrupt', agentId: 'Writer · b35ac8' }, isError: true },
    )
    .render(80)
    .join('\n');
  assert.match(failed, /No running turn exists/u);
  await tools[1].execute('call|native/id', { action: 'list' }, undefined, undefined, {});
  const nativeDerivedId = calls.at(-1).input.requestId;
  assert.match(nativeDerivedId, /^pi-tool-[a-f0-9]{56}$/u);
  assert.equal(isLuminariesId(nativeDerivedId), true);
  await tools[1].execute('call|native/id', { action: 'list' }, undefined, undefined, {});
  assert.equal(calls.at(-1).input.requestId, nativeDerivedId);
  await assert.rejects(
    tools[1].execute('bad-call', { action: 'list', requestId: 'model-owned' }, undefined, undefined, {}),
    /unknown field/,
  );
  await assert.rejects(
    tools[0].execute(
      'bad-spawn-call',
      { assignment: 'work', ownershipBoundary: 'boundary', unexpected: true },
      undefined,
      undefined,
      {},
    ),
    /unknown field/,
  );
  await assert.rejects(
    tools[2].execute(
      'bad-call',
      { action: 'send', recipientId: 'child', message: 'hello', recipients: ['child'] },
      undefined,
      undefined,
      {},
    ),
    /unknown field/,
  );
  for (const [tool, input] of [
    [tools[1], { action: 'inspect', agentId: 'child', patch: { focus: 'ignored' } }],
    [tools[2], { action: 'send', recipientId: 'child', message: 'hello', correlationId: 'request-1' }],
    [tools[2], { action: 'request', recipientId: 'child', message: 'hello', correlationId: 'request-1' }],
    [tools[2], { action: 'reply', correlationId: 'request-1', message: 'hello', recipientId: 'child' }],
    [tools[3], { action: 'interrupt', agentId: 'child', model: 'provider/model' }],
  ])
    await assert.rejects(
      tool.execute('ignored-field', input, undefined, undefined, {}),
      /(does not accept|accepts|unrelated fields|requires)/,
    );
});

function childContext(sessionId) {
  return {
    mode: 'rpc',
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(tmpdir(), 'luminaries-fixture', 'session.jsonl'),
      getBranch: () => [],
    },
  };
}
