import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../../src/extension.ts';
import { isLuminariesId } from '../../src/identifiers.ts';
import { createLuminariesTools, renderLuminariesProtocolMessage } from '../../src/luminaries-tools.ts';
import { CustomMessageComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { stripVTControlCharacters } from 'node:util';

test('child extension keeps its binding on reload after clearing bridge secrets', async () => {
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
  const prior = Object.fromEntries(Object.keys(binding).map((key) => [key, process.env[key]]));
  Object.assign(process.env, binding);
  const handlers = new Map();
  const commands = new Map();
  try {
    extension({
      registerTool: () => undefined,
      registerMessageRenderer: () => undefined,
      registerFlag: () => undefined,
      registerCommand: (name, command) => commands.set(name, command),
      registerShortcut: () => assert.fail('child must not register a parent shortcut'),
      on: (event, handler) => handlers.set(event, handler),
      sendMessage: async () => undefined,
    });
    for (const key of Object.keys(binding)) assert.equal(process.env[key], undefined);
    assert.deepEqual([...commands.keys()], ['luminaries-input']);
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
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test('tool input preserves ordinary text and rejects model-supplied routing metadata', async () => {
  const calls = [];
  const tools = createLuminariesTools(() => ({
    async execute(command) {
      calls.push(command);
      return { message: command.toolName, details: {} };
    },
  }));
  await tools[0].execute(
    'spawn-call',
    { assignment: 'work\nacross two ordinary lines', ownershipBoundary: 'boundary' },
    undefined,
    undefined,
    {},
  );
  assert.equal(calls[0].input.assignment, 'work\nacross two ordinary lines');
  await tools[1].execute('call|native/id', { action: 'list' }, undefined, undefined, {});
  const requestId = calls.at(-1).input.requestId;
  assert.equal(isLuminariesId(requestId), true);
  await tools[1].execute('call|native/id', { action: 'list' }, undefined, undefined, {});
  assert.equal(calls.at(-1).input.requestId, requestId);
  for (const [tool, input] of [
    [tools[1], { action: 'list', requestId: 'model-owned' }],
    [tools[1], { action: 'inspect', agentId: 'child', patch: { focus: 'ignored' } }],
    [tools[2], { action: 'send', recipientId: 'child', message: 'hello', correlationId: 'request-1' }],
    [tools[2], { action: 'reply', correlationId: 'request-1', message: 'hello', recipientId: 'child' }],
    [tools[3], { action: 'interrupt', agentId: 'child', model: 'provider/model' }],
  ])
    await assert.rejects(
      tool.execute('invalid-fields', input, undefined, undefined, {}),
      /unknown field|does not accept|accepts|unrelated fields|requires/u,
    );
});

test('tool receipts distinguish uncertain and partial outcomes while keeping internal identifiers out of compact text', () => {
  const tools = createLuminariesTools(() => {
    throw new Error('Rendering should not execute a tool');
  });
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
