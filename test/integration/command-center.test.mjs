import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth, Text, Spacer } from '@earendil-works/pi-tui';
import * as piUi from '@earendil-works/pi-coding-agent';
import {
  LuminariesCommandCenterComponent,
  LuminariesCommandCenterController,
  projectCommandCenter,
  renderAmbientWidget,
} from '../../src/command-center.ts';
import { AgentConversationStreams } from '../../src/agent-conversations.ts';
import { projectConversationMessages } from '../../src/command-center-projection.ts';
import { SchedulerStore } from '../../src/scheduler-store.ts';

const theme = { fg: (_color, text) => text, bold: (text) => text };
piUi.initTheme('dark', false);
const keybindings = {
  matches(data, action) {
    const bindings = {
      'tui.select.up': ['\x1b[A'],
      'tui.select.down': ['\x1b[B'],
      'tui.select.pageUp': ['\x1b[5~'],
      'tui.select.pageDown': ['\x1b[6~'],
      'tui.altScreen.pageUp': ['\x1b[5~'],
      'tui.altScreen.pageDown': ['\x1b[6~'],
      'tui.editor.pageUp': ['\x1b[5;5~'],
      'tui.editor.pageDown': ['\x1b[6;5~'],
      'tui.select.confirm': ['\r', '\n'],
      'tui.select.cancel': ['\x1b', '\x03'],
      'tui.editor.deleteCharBackward': ['\x7f', '\b'],
      'app.interrupt': ['\x1b'],
      'app.clear': ['\x03'],
      'app.tools.expand': ['\x0f'],
      'app.thinking.toggle': ['\x14'],
    };
    return bindings[action]?.includes(data) === true;
  },
};

function nativeModule() {
  return { ...piUi, Text, Spacer };
}

function nativeUi(columns = 80, rows = 40, mode = 'regular') {
  const terminal = {
    columns,
    rows,
    start() {},
    stop() {},
    write() {},
    hideCursor() {},
    showCursor() {},
  };
  return {
    tui: {
      mode,
      requestRender() {},
      getShowHardwareCursor: () => false,
      setFocus(component) {
        if (component) component.focused = true;
      },
      start() {},
      stop() {},
      terminal,
    },
    keybindings,
    markdownTheme: piUi.getMarkdownTheme(),
    selectListTheme: piUi.getSelectListTheme(),
    ...nativeModule(),
  };
}

test('ambient widget shows working and attention states without idle clutter', async (t) => {
  const { root, store } = await uiStore(t);
  try {
    await admit(store, root, 'agent-a', 'root', 'a', 'Altair');
    await admit(store, root, 'agent-a1', 'agent-a', 'a1', 'Deneb');
    await admit(store, root, 'agent-idle', 'root', 'idle', 'Polaris');
    await ready(store, 'agent-idle');
    await store.setAgentAttention('agent-a', 'needs_attention', 'test_attention');
    await ready(store, 'agent-a1');
    await store.startActivation('agent-a1', 'test');
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    const projection = projectCommandCenter(store.snapshot());
    assert.equal(projection.visible, true);
    assert.equal(projection.agents.find((agent) => agent.agentId === 'root')?.runtimeResident, true);
    assert.deepEqual(projection.counts, { working: 1, waiting: 0, idle: 2, attention: 1 });
    assert.equal(projection.agents.find((agent) => agent.agentId === 'agent-a')?.state, 'runtime_parked');
    assert.equal(projection.agents.find((agent) => agent.agentId === 'agent-a')?.attention, true);
    const lines = renderAmbientWidget(projection, 52, 2, theme);
    assert.ok(lines.some((line) => /Altair/.test(line)));
    assert.ok(lines.some((line) => /Deneb/.test(line)));
    assert.ok(lines.some((line) => /Needs you/.test(line)));
    assert.ok(lines.every((line) => !/warning/iu.test(line)));
    assert.ok(lines.every((line) => !/Polaris|idle|open|\d+\/10|agent-a1/u.test(line)));
    assert.ok(lines.every((line) => visibleWidth(line) <= 52));
  } finally {
    await store.close();
  }
});

test('conversation streams replace compacted history and clear settled activity', async (t) => {
  const { root, store } = await uiStore(t);
  await admit(store, root, 'child', 'root', 'child', 'Vega');
  await ready(store, 'child');
  const activation = await store.startActivation('child', 'test');
  const activityEvents = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Draft' } },
  ];
  await store.finishActivation(activation.value.activationId, activation.value.leaseToken, 'settled');
  assert.notEqual(
    projectCommandCenter(store.snapshot(), new Map([['child', { activityEvents }]])).agents[1].activity,
    'Writing a response',
  );
  for (const id of ['root', 'child']) {
    let emit;
    let history = [{ role: 'assistant', content: [{ type: 'text', text: 'Before compaction' }] }];
    const subscribe = (listener) => {
      emit = listener;
      return { snapshot: [], unsubscribe() {} };
    };
    const streams = new AgentConversationStreams({
      store,
      epoch: 'test',
      rootAgentId: 'root',
      currentActor: () => ({ subscribeConversation: subscribe }),
      currentRootEvents: subscribe,
      readSession: async () => ({ messages: history }),
      running: () => true,
      onDiagnostic: (error) => {
        throw error;
      },
    });
    t.after(() => streams.close());
    const unsubscribe = streams.subscribe(id, () => {});
    await new Promise(setImmediate);
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Live response' },
    });
    assert.match(JSON.stringify(streams.snapshot(id).messages), /Live response/);
    if (id === 'child') {
      emit({ type: 'compaction_end', aborted: true });
      await new Promise(setImmediate);
      assert.match(JSON.stringify(streams.snapshot(id).messages), /Live response/);
    }
    history = [{ role: 'assistant', content: [{ type: 'text', text: 'Compacted history' }] }];
    emit(
      id === 'root'
        ? { type: 'session_compact', compactionEntry: { id: 'compact' } }
        : { type: 'compaction_end', result: { summary: 'Compact' }, aborted: false },
    );
    await new Promise(setImmediate);
    assert.deepEqual(streams.snapshot(id).messages, history);
    unsubscribe();
  }
});

test('projection separates queued delivery, intentional waiting, and live work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-command-posture-'));
  let store = await SchedulerStore.open({
    statePath: join(root, 'state.json'),
    bootstrap: { rootId: 'root', cwd: root, maxOpenAgents: 2, maxDepth: 1 },
  });
  try {
    await admit(store, root, 'agent-a', 'root', 'a', 'Altair');
    const runtimeOwner = await ready(store, 'agent-a');
    await store.admitPeerEvent(
      { agentId: 'root', rootId: 'root', runtimeOwner: 'operator', origin: 'operator' },
      { bridgeRequestId: 'queued-delivery', recipientId: 'agent-a', message: 'Review this next.' },
    );
    let projected = projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'agent-a');
    assert.equal(projected.humanState, 'idle');
    assert.equal(projected.activity, '');
    assert.equal(projected.dependency, 'Message from Luminaries is queued');
    assert.deepEqual(projected.interactions, []);

    const requestActivation = await store.startActivation('agent-a', 'request');
    await store.acceptCorrelatedRequest(
      { agentId: 'agent-a', rootId: 'root', runtimeOwner },
      { bridgeRequestId: 'pending-request', recipientId: 'root', message: 'Please decide.' },
    );
    await store.finishActivation(requestActivation.value.activationId, requestActivation.value.leaseToken, 'settled');
    projected = projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'agent-a');
    assert.equal(projected.humanState, 'waiting');
    assert.equal(projected.activity, '');
    assert.equal(projected.dependency, 'Waiting on Root');

    await store.startActivation('agent-a', 'test');
    projected = projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'agent-a');
    assert.equal(projected.humanState, 'working');
    assert.equal(projected.activity, '');
    assert.equal(projected.dependency, 'Waiting on Root');

    const rootWait = await store.startActivation('root', 'parent_prompt');
    await store.registerWatch(
      {
        watchId: 'root-wait',
        agentIds: ['agent-a'],
        registeringActivationId: rootWait.value.activationId,
      },
      { kind: 'operator' },
    );
    await store.finishActivation(rootWait.value.activationId, rootWait.value.leaseToken, 'settled');
    let projectedRoot = projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'root');
    assert.equal(projectedRoot.dependency, 'Waiting on Altair · gent-a');
    const laterRootTurn = await store.startActivation('root', 'parent_prompt');
    projectedRoot = projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'root');
    assert.equal(projectedRoot.dependency, 'Message from Altair · gent-a is queued');
    await store.finishActivation(laterRootTurn.value.activationId, laterRootTurn.value.leaseToken, 'settled');
    projectedRoot = projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'root');
    assert.equal(projectedRoot.humanState, 'idle');
    assert.equal(projectedRoot.dependency, 'Message from Altair · gent-a is queued');
    assert.notEqual(store.snapshot().watches['root-wait']?.status, 'active');
    assert.equal(
      projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'agent-a').dependency,
      'Waiting on Root',
      'resuming Root must preserve the child’s pending request',
    );
    const interrupted = await store.startActivation('root', 'parent_prompt');
    await store.registerWatch(
      { watchId: 'interrupted-wait', agentIds: ['agent-a'], registeringActivationId: interrupted.value.activationId },
      { kind: 'operator' },
    );
    await store.finishActivation(interrupted.value.activationId, interrupted.value.leaseToken, 'aborted');
    assert.notEqual(store.snapshot().watches['interrupted-wait']?.status, 'active');
    assert.equal(
      projectCommandCenter(store.snapshot()).agents.find((candidate) => candidate.agentId === 'root').humanState,
      'idle',
    );
    await store.registerWatch({ watchId: 'independent-wait', agentIds: ['agent-a'] }, { kind: 'operator' });
    const unrelatedTurn = await store.startActivation('root', 'parent_prompt');
    await store.finishActivation(unrelatedTurn.value.activationId, unrelatedTurn.value.leaseToken, 'settled');
    assert.equal(store.snapshot().watches['independent-wait'].status, 'active');
    await store.close();
    store = await SchedulerStore.open({ statePath: join(root, 'state.json') });
    assert.notEqual(store.snapshot().watches['root-wait']?.status, 'active');
    assert.notEqual(store.snapshot().watches['interrupted-wait']?.status, 'active');
    assert.equal(store.snapshot().watches['independent-wait'].status, 'active');
    await store.registerWatch(
      { watchId: 'foreground-message-wait', agentIds: ['agent-a'], eventKinds: ['message'], owned: true },
      { kind: 'operator' },
    );
    const foregroundMessage = await store.admitPeerEvent(
      { agentId: 'agent-a', rootId: 'root', runtimeOwner },
      { bridgeRequestId: 'foreground-child-finding', recipientId: 'root', message: 'The useful child finding.' },
    );
    let watchSnapshot = store.snapshot();
    let watchActivity = Object.values(watchSnapshot.mailbox).find(
      (record) => record.lane !== 'direct' && record.causationId === foregroundMessage.value.event.eventId,
    );
    assert.equal(foregroundMessage.value.event.status, 'accepted');
    assert.equal(watchActivity?.systemType, 'watch_activity');
    assert.equal(watchActivity?.status, 'settled');
    assert.equal(watchActivity?.mode, 'notify_only');

    await store.registerWatch(
      { watchId: 'notify-only-message-wait', agentIds: ['agent-a'], eventKinds: ['message'], owned: true },
      { kind: 'operator' },
    );
    const quietMessage = await store.admitPeerEvent(
      { agentId: 'agent-a', rootId: 'root', runtimeOwner },
      {
        bridgeRequestId: 'quiet-child-finding',
        recipientId: 'root',
        message: 'A quiet child finding.',
        mode: 'notify_only',
      },
    );
    watchSnapshot = store.snapshot();
    watchActivity = Object.values(watchSnapshot.mailbox).find(
      (record) => record.lane !== 'direct' && record.causationId === quietMessage.value.event.eventId,
    );
    assert.equal(quietMessage.value.event.status, 'settled');
    assert.equal(watchActivity?.systemType, 'watch_activity');
    assert.equal(watchActivity?.status, 'accepted');
    assert.equal(watchActivity?.mode, 'default');
    assert.ok(quietMessage.affectedRecipientIds.includes('root'));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation hydration retries when Pi persists a new session after selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-conversation-retry-'));
  const store = await SchedulerStore.open({
    statePath: join(root, 'state.json'),
    bootstrap: { rootId: 'root', cwd: root, maxOpenAgents: 1, maxDepth: 1 },
  });
  let publishRootEvent;
  let sessionAvailable = false;
  const streams = new AgentConversationStreams({
    store,
    epoch: 'retry-test',
    currentActor: () => undefined,
    rootAgentId: 'root',
    currentRootEvents: (listener) => {
      publishRootEvent = listener;
      return { snapshot: [], unsubscribe() {} };
    },
    readSession: async () => {
      if (!sessionAvailable) throw new Error('Pi session file is not written yet');
      return { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Persisted history' }] }] };
    },
    running: () => true,
    onDiagnostic: () => undefined,
  });
  try {
    streams.subscribe('root', () => undefined);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(streams.snapshot('root').hydrated, false);

    sessionAvailable = true;
    publishRootEvent?.({ type: 'agent_settled' });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(streams.snapshot('root').hydrated, true);
    assert.match(JSON.stringify(streams.snapshot('root').messages), /Persisted history/);
  } finally {
    await streams.close();
    await store.close();
  }
});

test('conversation projection preserves content and separates sender identity from private routing', async (t) => {
  const { root, store } = await uiStore(t);
  await admit(store, root, 'child', 'root', 'child', 'Vega');
  const privatePath = store.snapshot().agents.child.sessionFile;
  const messages = [
    {
      role: 'custom',
      customType: 'luminaries_protocol_message',
      content: 'From Deneb (correlationId private-request):\nFirst line.\nSecond line.',
      details: { inputId: 'delivery', presentation: 'message', content: 'From Deneb:\nFirst line.\nSecond line.' },
    },
    { role: 'assistant', content: [{ type: 'text', text: `Result in ${privatePath}` }] },
    { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(5 * 1024 * 1024) }] },
  ];
  const rendered = projectConversationMessages(messages, store.snapshot(), 'child');
  const text = JSON.stringify(rendered);
  assert.match(text, /From Deneb.*Second line/s);
  assert.ok(!text.includes(privatePath));
  assert.ok(!text.includes('private-request'));
  assert.deepEqual(rendered.at(-1).content, messages.at(-1).content);
});

test('workspace remains height-bounded through resize and the native editor', (t) => {
  let rows = 7;
  let conversationListener;
  const child = agent('child', 'root', 1, 'Altair', 'working');
  const toolAssistant = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'tool-read', name: 'read', arguments: { path: 'result.txt' } }],
  };
  const toolResult = {
    role: 'toolResult',
    toolCallId: 'tool-read',
    toolName: 'read',
    content: [{ type: 'text', text: 'Current tool output' }],
  };
  const conversation = Array.from({ length: 10 }, (_, index) => ({
    role: 'assistant',
    content: [{ type: 'text', text: `Readable conversation update ${index + 1}` }],
  })).concat(toolAssistant, toolResult);
  const projection = projectionWith([agent('root', null, 0, 'Root', 'idle'), child]);
  const component = new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    {
      subscribe(agentId, listener) {
        conversationListener = listener;
        listener({
          type: 'reset',
          epoch: 'test',
          agentId,
          incarnation: 1,
          revision: 1,
          hydrated: true,
          messages: conversation,
        });
        return () => undefined;
      },
      async send() {},
      async interrupt() {},
    },
    () => undefined,
    () => undefined,
    () => rows,
    undefined,
    nativeUi(),
  );
  t.after(() => component.dispose());
  const directory = component.render(52);
  assert.ok(directory.length <= rows);
  assert.match(directory.join('\n'), /v archived/);
  component.handleInput('v');
  assert.match(component.render(52).join('\n'), /No archived collaborators/);
  assert.match(component.render(52).join('\n'), /v current/);
  component.handleInput('v');
  rows = 10;
  component.handleInput('\r');
  const hydrated = component.render(52);
  assert.ok(hydrated.length <= rows);
  assert.ok(hydrated.every((line) => visibleWidth(line) <= 52));
  assert.match(hydrated.join('\n'), /Current tool output/);
  component.scrollBy(-2);
  const anchored = component.render(52);
  conversationListener({
    type: 'splice',
    epoch: 'test',
    agentId: 'child',
    incarnation: 1,
    revision: 2,
    baseRevision: 1,
    start: conversation.length,
    deleteCount: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: `Streaming ${'x'.repeat(500)}` }] }],
  });
  conversationListener({
    type: 'reset',
    epoch: 'test',
    agentId: 'child',
    incarnation: 1,
    revision: 3,
    hydrated: true,
    messages: [...conversation, { role: 'assistant', content: [{ type: 'text', text: 'Later update' }] }],
  });
  assert.deepEqual(component.render(52), anchored);
  assert.ok(component.render(52).length <= rows);
  conversationListener({
    type: 'splice',
    epoch: 'test',
    agentId: 'child',
    incarnation: 1,
    revision: 4,
    baseRevision: 3,
    start: conversation.indexOf(toolResult),
    deleteCount: 1,
    messages: [],
  });
  component.scrollBy(1_000);
  assert.doesNotMatch(component.render(52).join('\n'), /Current tool output/);
});

test('selected inspector is passive, ordered, and excludes internal identifiers', (t) => {
  const child = agent('luminaries-agent-private-hash', 'luminaries-root-private-hash', 1, 'Altair', 'idle');
  child.interactions = Array.from({ length: 10 }, (_, index) => `Readable update ${index + 1} from a collaborator`);
  child.interactions[0] += ` ${'Review detail. '.repeat(70)}ACTIVITY_TAIL`;
  child.assignment = 'Altair assignment\nwith multiline detail';
  child.expertise = ['protocol review'];
  child.artifacts = ['docs/result.md'];
  child.attention = true;
  child.health = {
    level: 'critical',
    attention: 'critical',
    summary: 'Delivery outcome is uncertain',
    reasons: ['delivery_indeterminate'],
    observations: [],
  };
  const projection = projectionWith([agent('luminaries-root-private-hash', null, 0, 'Root', 'idle'), child]);
  const component = new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    { async send() {}, async interrupt() {} },
    () => undefined,
    () => undefined,
    () => 30,
    undefined,
    nativeUi(92, 30),
  );
  t.after(() => component.dispose());
  component.handleInput('\x1b[B');
  const preview = component.render(92).join('\n');
  assert.match(preview, /Readable update 1/u);
  assert.doesNotMatch(preview, /Readable update 10/u);
  assert.doesNotMatch(preview, /ACTIVITY_TAIL/u);
  component.handleInput('i');
  const sheet = component.render(92).join('\n');
  assert.match(sheet, /Health.*Next.*Role.*Model.*Focus.*Recent activity/su);
  assert.match(sheet, /Readable update 1/u);
  assert.ok(component.render(92).every((line) => !line.includes('\n')));
  assert.doesNotMatch(sheet, /luminaries-agent|luminaries-root|private-hash/u);
  const fullCard = new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    { async send() {}, async interrupt() {} },
    () => undefined,
    () => undefined,
    () => 160,
    undefined,
    nativeUi(100, 160),
  );
  t.after(() => fullCard.dispose());
  fullCard.handleInput('i');
  assert.match(fullCard.render(100).join('\n'), /ACTIVITY_TAIL.*Expertise.*Outputs/su);
  fullCard.dispose();
  component.scrollBy(1_000);
  const tail = component.render(92).join('\n');
  assert.match(tail, /Altair assignment.*with multiline detail/su);
  assert.match(tail, /Outputs.*Assignment.*Scope of work.*Context.*Permissions.*Runtime/su);
  assert.doesNotMatch(tail, /luminaries-agent|luminaries-root|private-hash/u);
  component.handleInput('\x1b');
  component.handleInput('/');
});

test('multicast picker commits temporary marks and clears them on commit or cancel', async (t) => {
  const calls = [];
  const projection = projectionWith([
    agent('root', null, 0, 'Root', 'idle'),
    agent('altair', 'root', 1, 'Altair', 'idle'),
    agent('mira', 'root', 1, 'Mira', 'idle'),
  ]);
  const component = new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    {
      async send() {},
      async interrupt() {},
      async palette() {},
      async multicast(agentIds) {
        calls.push(agentIds);
      },
    },
    () => undefined,
    () => undefined,
    () => 16,
    undefined,
    nativeUi(92, 16),
  );
  t.after(() => component.dispose());

  component.handleInput('b');
  component.handleInput(' ');
  component.handleInput('\x1b[B');
  component.handleInput(' ');
  assert.match(component.render(92).join('\n'), /\[✓\].*Altair.*\[✓\].*Mira/su);
  component.handleInput('\r');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(calls, [['altair', 'mira']]);
  assert.doesNotMatch(component.render(92).join('\n'), /\[✓\]/u);

  component.handleInput('b');
  component.handleInput('t');
  assert.match(component.render(92).join('\n'), /\[ \].*Altair.*\[✓\].*Mira/su);
  assert.match(component.render(92).join('\n'), /Space\/t mark · a all-or-none/u);
  component.handleInput('a');
  assert.match(component.render(92).join('\n'), /\[✓\].*Altair.*\[✓\].*Mira/su);
  component.handleInput('a');
  assert.doesNotMatch(component.render(92).join('\n'), /\[✓\]/u);
  component.handleInput('t');
  component.handleInput('\x1b');
  assert.doesNotMatch(component.render(92).join('\n'), /\[✓\]/u);
  assert.equal(calls.length, 1);
});

test('handoff receipt survives directory refresh and terminal focus until dismissed', async (t) => {
  const root = agent('root', null, 0, 'Root', 'idle');
  const vega = agent('vega-abc123', 'root', 1, 'Vega', 'idle');
  let projection = projectionWith([root, vega]);
  let closed = false;
  const receipt = 'Standalone Pi session created.\npi --session 57ea84ae-660c-5a35-b077-044efc97c444';
  const component = new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    {
      async palette() {
        return { text: receipt, tone: 'success', persistent: true };
      },
    },
    () => undefined,
    () => {
      closed = true;
    },
    () => 20,
    undefined,
    nativeUi(100, 20),
  );
  t.after(() => component.dispose());
  t.after(() => component.dispose());
  component.handleInput('a');
  await new Promise((done) => setImmediate(done));
  projection = projectionWith([root]);
  component.invalidate();
  assert.match(
    component.render(100).join('\n'),
    /57ea84ae-660c-5a35-b077-044efc97c444/u,
    'live-directory removal retains the result',
  );
  vega.lifecycle = 'closed';
  vega.humanState = 'closed';
  projection = projectionWith([root, vega]);
  component.invalidate();
  assert.match(
    component.render(100).join('\n'),
    /57ea84ae-660c-5a35-b077-044efc97c444/u,
    'closed-history arrival retains the result',
  );
  component.handleInput('\x1b[I');
  assert.match(
    component.render(100).join('\n'),
    /57ea84ae-660c-5a35-b077-044efc97c444/u,
    'terminal focus is not a dismissal',
  );
  component.handleInput('\x1b');
  assert.doesNotMatch(component.render(100).join('\n'), /57ea84ae-660c-5a35-b077-044efc97c444/u);
  assert.equal(closed, false, 'first Escape dismisses the receipt');
  component.handleInput('\x1b');
  assert.equal(closed, true, 'second Escape returns to Pi');
});

async function controllerFixture(t, host = {}, mode = 'regular') {
  const state = {
    projection: projectionWith([agent('root', null, 0, 'Root', 'idle'), agent('child', 'root', 1, 'Vega', 'idle')]),
    writes: [],
    notifications: [],
  };
  const tui = nativeUi(80, 24, mode).tui;
  tui.terminal.write = (value) => state.writes.push(value);
  tui.addInputListener = (listener) => {
    state.mouse = listener;
    return () => {
      state.mouse = undefined;
    };
  };
  const overlay = (onHide) => {
    let hidden = false;
    return {
      hide() {
        hidden = true;
        onHide?.();
      },
      setHidden(value) {
        hidden = value;
      },
      isHidden: () => hidden,
      focus() {
        hidden = false;
      },
      unfocus() {},
      isFocused: () => !hidden,
    };
  };
  tui.showOverlay = (dialog) => {
    state.dialog = dialog;
    return overlay(() => {
      if (state.dialog === dialog) state.dialog = undefined;
    });
  };
  const context = {
    mode: 'tui',
    parentConversation: true,
    ui: {
      setWidget(_id, value) {
        state.widget = value;
      },
      notify(message, level) {
        state.notifications.push({ message, level });
      },
      custom(factory, options) {
        return new Promise((done) => {
          state.component = factory(tui, theme, keybindings, done);
          options.onHandle?.(overlay());
        });
      },
    },
  };
  const controller = new LuminariesCommandCenterController(async () => nativeModule());
  t.after(() => controller.dispose());
  controller.attach(context, {
    commandCenterProjection: () => state.projection,
    onCommandCenterChange(listener) {
      state.publish = listener;
      return () => {};
    },
    operatorClosedHistory: async () => ({ revision: 1, agents: [], archivedCount: 0 }),
    ...host,
  });
  const opened = controller.open(context);
  await new Promise((done) => setImmediate(done));
  return {
    state,
    tui,
    controller,
    opened,
    async choose(value) {
      const dialog = state.dialog;
      if (dialog.options) {
        const index = dialog.options.indexOf(value);
        assert.ok(index >= 0, `No such option: ${value}`);
        for (let step = 0; step < index; step++) dialog.handleInput('\x1b[B');
      } else if (dialog.editor) dialog.editor.setText(value);
      else dialog.input.setValue(value);
      dialog.handleInput('\r');
      await new Promise((done) => setImmediate(done));
    },
    async key(value) {
      state.component.handleInput(value);
      await new Promise((done) => setImmediate(done));
    },
  };
}

test('adoption scrolls in other projects and validates references before asking for a name', async (t) => {
  const sessions = Array.from({ length: 30 }, (_, index) => ({
    sessionFile: join(process.cwd(), 'other', `${index}.jsonl`),
    sessionId: `session-${index}`,
    cwd: join(process.cwd(), 'other'),
    name: `Session ${index}`,
    modifiedAtMs: index,
    messageCount: 1,
    firstMessage: '',
  }));
  const adopted = [];
  const { state, tui, key, choose } = await controllerFixture(t, {
    operatorSessions: async () => sessions,
    async operatorInspectSessionReference(reference) {
      if (reference === 'not-a-session') throw new Error('Pi session is unavailable');
      return sessions.find((session) => session.sessionFile === reference);
    },
    async operatorAdoptSession(...args) {
      adopted.push(args);
      return { handle: 'Imported', sessionId: 'imported' };
    },
  });
  await key('\x1b[A');
  await key('a');
  await choose('Bring in a Pi session');
  state.dialog.handleInput('\r');
  await new Promise((done) => setImmediate(done));
  tui.terminal.rows = 12;
  for (let index = 0; index < 25; index++) state.dialog.handleInput('\x1b[<65;10;10M');
  assert.match(state.dialog.render(60).join('\n'), /Session 25/u);
  assert.ok(state.dialog.render(60).length <= tui.terminal.rows);
  state.dialog.handleInput('\r');
  await new Promise((done) => setImmediate(done));
  await choose('');
  assert.deepEqual(adopted, [[sessions[25].sessionFile, {}]]);
  await key('\x1b');
  sessions.length = 0;
  await key('a');
  await choose('Bring in a Pi session');
  state.dialog.handleInput('\r');
  await new Promise((done) => setImmediate(done));
  await choose('not-a-session');
  assert.equal(state.dialog, undefined);
  assert.match(state.component.render(80).join('\n'), /Pi session is unavailable/u);
  assert.equal(adopted.length, 1);
});

test('busy configuration is blocked and a multiline card survives save and reopen', async (t) => {
  const { root, store } = await uiStore(t);
  await admit(store, root, 'child', 'root', 'child', 'Vega');
  const changes = [];
  const { state, key, choose } = await controllerFixture(t, {
    operatorModels: () => [{ provider: 'test', id: 'model' }],
    operatorExpertCard: async () => ({ displayName: 'Vega', focus: 'Original', expertise: [], publishedRefs: [] }),
    operatorExecute: async (...args) => {
      changes.push(args);
      await store.updateAgentMetadata(args[1].agentId, args[1].patch, { kind: 'operator' });
      return { details: {} };
    },
  });
  const expert = state.projection.agents[1];
  expert.humanState = 'working';
  expert.state = 'running';
  expert.active = true;
  state.publish(state.projection);
  await key('a');
  await choose('Change model');
  assert.deepEqual(changes, []);
  assert.match(state.component.render(80).join('\n'), /Ready or Parked/u);
  expert.humanState = 'idle';
  expert.state = 'idle';
  expert.active = false;
  state.publish(state.projection);
  await key('\x1b');
  await key('a');
  await choose('Edit expert card');
  await choose('Focus');
  await choose('Set value');
  await choose('First finding\nSecond finding');
  assert.deepEqual(changes, [
    ['luminaries_directory', { action: 'update', agentId: 'child', patch: { focus: 'First finding\nSecond finding' } }],
  ]);
  await store.close();
  const reopened = await SchedulerStore.open({ statePath: store.statePath });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().agents.child.expertCard.focus.value, 'First finding\nSecond finding');
});

test('closing the workspace restores its widget and leaves fullscreen mouse ownership with Pi', async (t) => {
  for (const mode of ['regular', 'fullscreen']) {
    const { state, key, opened, controller } = await controllerFixture(t, {}, mode);
    state.projection = projectionWith([
      agent('root', null, 0, 'Root', 'idle'),
      agent('child', 'root', 1, 'Vega', 'working'),
    ]);
    state.publish(state.projection);
    assert.equal(state.widget, undefined);
    assert.deepEqual(state.mouse('\x1b[<65;10;10M'), { consume: true });
    await key('\x1b');
    await opened;
    assert.equal(typeof state.widget, 'function');
    if (mode === 'fullscreen') assert.deepEqual(state.writes, []);
    else assert.match(state.writes.at(-1), /1006l.*1000l/u);
    controller.dispose();
    assert.equal(state.mouse, undefined);
  }
});

test('native Pi tool output collapses independently of the thinking preference', async (t) => {
  const projection = projectionWith([
    agent('root', null, 0, 'Root', 'idle'),
    agent('child', 'root', 1, 'Expert', 'idle'),
  ]);
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Consider the retained context.' },
        { type: 'toolCall', id: 'shell', name: 'bash', arguments: { command: 'inspect' } },
        { type: 'toolCall', id: 'extension', name: 'external_lookup', arguments: { query: 'inspect' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'shell',
      toolName: 'bash',
      isError: false,
      content: [{ type: 'text', text: Array.from({ length: 40 }, (_, index) => `Output row ${index}`).join('\n') }],
    },
    {
      role: 'toolResult',
      toolCallId: 'extension',
      toolName: 'external_lookup',
      isError: false,
      content: [{ type: 'text', text: Array.from({ length: 40 }, (_, index) => `Extension row ${index}`).join('\n') }],
    },
  ];
  const controller = new LuminariesCommandCenterController();
  t.after(() => controller.dispose());
  const tui = nativeUi(100, 160).tui;
  tui.addInputListener = () => () => undefined;
  // Older Pi versions show unknown-tool output in full even when collapsed.
  const { ToolExecutionComponent } = await import('@earendil-works/pi-coding-agent');
  const nativeFallback = new ToolExecutionComponent(
    'external_lookup',
    'extension',
    { query: 'inspect' },
    undefined,
    {},
    tui,
    process.cwd(),
  );
  nativeFallback.updateResult({ content: messages[2].content, details: undefined, isError: false });
  nativeFallback.setExpanded(false);
  const nativePreviewShowsMiddle = nativeFallback.render(100).join('\n').includes('Extension row 20');
  controller.attach(
    {
      mode: 'tui',
      hideThinkingBlock: true,
      ui: {
        setWidget() {},
        async custom(factory) {
          verify(factory(tui, theme, keybindings, () => undefined));
        },
      },
    },
    {
      commandCenterProjection: () => projection,
      onCommandCenterChange: () => () => undefined,
      operatorClosedHistory: async () => ({ revision: 1, agents: [], archivedCount: 0 }),
      onAgentConversationChange(agentId, listener) {
        listener({ type: 'reset', epoch: 'test', agentId, incarnation: 1, revision: 1, hydrated: true, messages });
        return () => undefined;
      },
    },
  );
  await controller.open(undefined, 'child');
  function verify(component) {
    const collapsed = component.render(100).join('\n');
    assert.doesNotMatch(collapsed, /Output row 20|Consider the retained context/);
    assert.equal(collapsed.includes('Extension row 20'), nativePreviewShowsMiddle);
    assert.match(collapsed, /to expand/);
    component.handleInput('\x0f');
    const expanded = component.render(100).join('\n');
    assert.match(expanded, /Output row 20/);
    assert.match(expanded, /Extension row 20/);
    assert.doesNotMatch(expanded, /Consider the retained context/);
    component.handleInput('\x14');
    assert.match(component.render(100).join('\n'), /Consider the retained context/);
    component.handleInput('\x0f');
    const recollapsed = component.render(100).join('\n');
    assert.doesNotMatch(recollapsed, /Output row 20/);
    assert.equal(recollapsed.includes('Extension row 20'), nativePreviewShowsMiddle);
    assert.match(recollapsed, /Consider the retained context/);
  }
});

test('direct closed-collaborator open fails instead of falling back when retained history is unavailable', async (t) => {
  const projection = projectionWith([agent('root-private-id', null, 0, 'Root', 'idle')]);
  let customCalls = 0;
  const controller = new LuminariesCommandCenterController(async () => nativeModule());
  t.after(() => controller.dispose());
  controller.attach(
    {
      mode: 'tui',
      parentConversation: true,
      ui: {
        setWidget() {},
        custom() {
          customCalls++;
          return Promise.resolve();
        },
        notify() {},
      },
    },
    {
      commandCenterProjection: () => projection,
      onCommandCenterChange: () => () => undefined,
      async operatorClosedHistory() {
        throw new Error('retained history unavailable');
      },
    },
  );

  await assert.rejects(
    controller.open(undefined, 'closed-private-id'),
    /requested collaborator could not be opened because retained history is unavailable/u,
  );
  assert.equal(customCalls, 0);
});

test('closed conversations page without routing keys through the hidden editor', (t) => {
  const child = agent('closed-child', 'root', 1, 'Altair', 'idle');
  child.lifecycle = 'closed';
  child.state = 'closed';
  const projection = projectionWith([agent('root', null, 0, 'Root', 'idle'), child]);
  projection.closedAgents = [child];
  const history = Array.from({ length: 48 }, (_, index) => ({
    role: 'assistant',
    content: [{ type: 'text', text: `History ${index + 1}` }],
  }));
  const component = componentFor(projection, new Map([[child.agentId, history]]), {
    initialAgentId: child.agentId,
  });
  t.after(() => component.dispose());

  assert.match(component.render(80).join('\n'), /History 48/);
  component.handleInput('\x1b[5~');
  const paged = component.render(80).join('\n');
  assert.doesNotMatch(paged, /History 48/);
  assert.match(paged, /History 40/);
  component.handleInput('\x1b');
  const retained = component.render(80).join('\n');
  assert.match(retained, /1 retained luminary/u);
  assert.match(retained, /Altair.*a actions/su);
});

test('waiting experts explain why there is no active turn to interrupt', (t) => {
  const calls = [];
  const projection = projectionWith([
    agent('root', null, 0, 'Root', 'idle'),
    agent('child', 'root', 1, 'Altair', 'waiting'),
  ]);
  const component = new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    {
      async send(...args) {
        calls.push(['send', ...args]);
      },
      async interrupt(...args) {
        calls.push(['interrupt', ...args]);
      },
    },
    () => undefined,
    () => undefined,
    () => 24,
    undefined,
    nativeUi(),
  );
  t.after(() => component.dispose());
  component.handleInput('\r');
  component.handleInput('\x03');
  assert.match(component.render(72).join('\n'), /no active turn to interrupt/);
  assert.deepEqual(calls, []);
});

test('foreground workspace pages history while preserving the native editor in regular and fullscreen TUI', async (t) => {
  const child = agent('child-hash', 'root-hash', 1, 'Altair', 'idle');
  child.interactions = ['The keyboard review is complete.'];
  const projection = projectionWith([agent('root-hash', null, 0, 'Root', 'idle'), child]);
  const history = Array.from({ length: 48 }, (_, index) => ({
    role: 'assistant',
    content: [{ type: 'text', text: `History ${index + 1}` }],
  }));
  for (const tuiMode of ['regular', 'fullscreen']) {
    const calls = [];
    let renders = 0;
    let closed = false;
    const ui = nativeUi(80, 30, tuiMode);
    const component = new LuminariesCommandCenterComponent(
      () => projection,
      () => 0,
      theme,
      {
        subscribe(agentId, listener) {
          listener({
            type: 'reset',
            epoch: 'test',
            agentId,
            incarnation: 1,
            revision: 1,
            hydrated: true,
            messages: history,
          });
          return () => undefined;
        },
        async send(agentId, message, mode) {
          calls.push({ action: 'send', agentId, message, mode });
        },
        async interrupt(agentId) {
          calls.push({ action: 'interrupt', agentId });
        },
      },
      () => renders++,
      () => {
        closed = true;
      },
      () => 30,
      undefined,
      ui,
    );
    t.after(() => component.dispose());

    component.handleInput('\r');
    assert.match(component.render(80).join('\n'), /Altair · d-hash.*Esc directory/su);
    assert.match(component.render(80).join('\n'), /Root › Altair · d-hash/);
    assert.match(component.render(80).join('\n'), /History 48/u);
    assert.doesNotMatch(component.render(80).join('\n'), /root-hash|child-hash/u);
    const message = 'First draft line\nSecond draft line TAIL_VISIBLE_Ω';
    component.handleInput(`\x1b[200~${message}\x1b[201~`);
    component.handleInput('\x1b[5~');
    const paged = component.render(80).join('\n');
    assert.match(paged, /History 40/u);
    assert.match(paged, /TAIL_VISIBLE_Ω/u);
    component.handleInput('\x1b[6~');
    assert.match(component.render(80).join('\n'), /History 48/u);
    component.handleInput('\x1b[5;5~');
    component.handleInput('\x1b[6;5~');
    assert.equal(component.editor.getText(), message);
    component.handleInput('\r');
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(calls[0], { action: 'send', agentId: 'child-hash', message, mode: 'auto' });
    component.handleInput('\x1b');
    assert.ok(component.render(80).some((line) => /a actions/.test(line)));
    component.handleInput('\x1b');
    assert.equal(closed, true);
    assert.ok(renders > 0);
  }
});

async function admit(store, root, agentId, parentId, segment, displayName) {
  const sessionDir = join(root, agentId);
  const sessionFile = join(sessionDir, 'session.jsonl');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, '{}\n');
  await store.admitAgent(
    {
      agentId,
      parentId,
      segment,
      cwd: root,
      sessionId: `${agentId}-session`,
      sessionDir,
      displayName,
      assignment: `${displayName} assignment`,
      ownershipBoundary: `${displayName} boundary`,
      expertCard: { focus: `${displayName} focus`, role: 'specialist' },
    },
    { kind: 'agent', agentId: parentId },
  );
  await store.bindSession(agentId, sessionFile);
}

async function ready(store, agentId) {
  const claim = await store.claimRuntime(agentId, process.pid, 'command-center-test');
  await store.markRuntimeSpawned(agentId, claim.value.runtimeOwner, process.pid);
  await store.markRuntimeReady(agentId, claim.value.runtimeOwner, process.pid);
  return claim.value.runtimeOwner;
}

function agent(agentId, parentId, depth, name, humanState) {
  const active = humanState === 'working' || humanState === 'starting' || humanState === 'waiting';
  return {
    agentId,
    parentId,
    depth,
    lifecycle: 'open',
    name,
    shortId: agentId.slice(-6).toLowerCase(),
    handle: parentId ? `${name} · ${agentId.slice(-6).toLowerCase()}` : name,
    breadcrumb: [],
    role: parentId ? 'specialist' : undefined,
    focus: parentId ? `${name} focus` : 'Your parent Pi conversation',
    focusSource: 'spawn',
    assignment: parentId ? `${name} assignment` : 'Owns and supervises this Luminaries.',
    ownershipBoundary: parentId ? `${name} boundary` : 'Owns this Luminaries root',
    expertise: [],
    artifacts: [],
    contextMode: 'fresh',
    maxDepth: 3,
    canSpawn: true,
    canPeerInterrupt: true,
    state:
      humanState === 'working'
        ? 'running'
        : humanState === 'starting'
          ? 'starting'
          : humanState === 'waiting'
            ? 'waiting'
            : 'idle',
    humanState,
    runtimeResident: humanState !== 'closed',
    ...(humanState === 'waiting' ? { dependency: 'Waiting for collaborator activity' } : {}),
    selectedExtensions: [],
    alwaysExtensions: [],
    extensionChangePending: false,
    canContinueWithMessage: false,
    active,
    attention: false,
    health: {
      level: 'ok',
      attention: 'none',
      summary: 'No health issues',
      reasons: [],
      observations: [],
    },
    activity: humanState === 'working' ? `${name} focus` : humanState === 'starting' ? 'Starting collaborator' : '',
    interactions: [],
    cwd: process.cwd(),
    treePrefix: depth === 0 ? '▾ ' : `${'  '.repeat(depth)}└─ `,
  };
}

function projectionWith(agents) {
  const byId = new Map(agents.map((candidate) => [candidate.agentId, candidate]));
  for (const agent of agents) {
    const lineage = [];
    let current = agent;
    while (current) {
      lineage.unshift(current.handle);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    agent.breadcrumb = lineage;
  }
  const open = agents.filter((candidate) => candidate.lifecycle === 'open');
  const closed = agents.filter((candidate) => candidate.lifecycle === 'closed');
  const nonRoot = open.filter((candidate) => candidate.parentId !== null);
  const active = nonRoot.filter((candidate) => candidate.active);
  const ambient = active.map((candidate) => ({
    agent: candidate,
    prefix: '└─ ',
    name:
      candidate.depth > 1 && !active.some((parent) => parent.agentId === candidate.parentId)
        ? candidate.breadcrumb.slice(1).join(' › ')
        : candidate.handle,
  }));
  return {
    revision: 1,
    historyRevision: 1,
    rootId: agents[0].agentId,
    capacity: { used: nonRoot.length, limit: 10, available: 10 - nonRoot.length },
    configuration: {
      maxOpenAgents: 10,
      maxDepth: 3,
      namePoolSource: 'built-in',
      sources: {
        maxOpenAgents: 'built-in',
        maxDepth: 'built-in',
        serviceGrant: 'built-in',
      },
      agentExtensions: [],
      serviceGrant: [],
    },
    counts: {
      working: nonRoot.filter((candidate) => candidate.humanState === 'working' || candidate.humanState === 'starting')
        .length,
      waiting: nonRoot.filter((candidate) => candidate.humanState === 'waiting').length,
      idle: nonRoot.filter((candidate) => candidate.humanState === 'idle').length,
      attention: nonRoot.filter((candidate) => candidate.attention).length,
    },
    visible: active.length > 0,
    agents: open,
    closedAgents: closed,
    directory: agents,
    archivedCount: closed.filter((candidate) => candidate.archived).length,
    ambient,
  };
}

function componentFor(projection, conversations = new Map(), options) {
  return new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    {
      subscribe(agentId, listener) {
        listener({
          type: 'reset',
          epoch: 'test',
          agentId,
          incarnation: 1,
          revision: 1,
          hydrated: true,
          messages: conversations.get(agentId) ?? [],
        });
        return () => undefined;
      },
      async send() {},
      async interrupt() {},
    },
    () => undefined,
    () => undefined,
    () => 32,
    undefined,
    nativeUi(),
    options,
  );
}

async function uiStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-ui-'));
  const store = await SchedulerStore.open({
    statePath: join(root, 'state.json'),
    bootstrap: { rootId: 'root', cwd: root, maxOpenAgents: 10, maxDepth: 3 },
  });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}
