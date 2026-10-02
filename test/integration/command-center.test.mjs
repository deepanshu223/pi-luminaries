import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import {
  LuminariesCommandCenterComponent,
  LuminariesCommandCenterController,
  projectCommandCenter,
  renderAmbientWidget,
} from '../../src/command-center.ts';
import { AgentConversationStreams } from '../../src/agent-conversations.ts';
import { projectConversationMessages } from '../../src/command-center-projection.ts';
import { formatPeerPrompt, peerPresentationDetails } from '../../src/peer-prompt.ts';
import { agentPath } from '../../src/scheduler-state.ts';
import { SchedulerStore } from '../../src/scheduler-store.ts';

const theme = { fg: (_color, text) => text, bold: (text) => text };
initTheme('dark', false);
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
    };
    return bindings[action]?.includes(data) === true;
  },
};

class NativeText {
  constructor(text = '') {
    this.text = text;
  }
  render() {
    return this.text ? [this.text] : [];
  }
  invalidate() {}
}

class NativeUser extends NativeText {
  constructor(text) {
    super(text);
  }
}

class NativeAssistant extends NativeText {
  constructor(message) {
    super(messageText(message));
  }
  setHideThinkingBlock() {}
}

class NativeTool extends NativeText {
  constructor(name, _id, args, _options, definition) {
    super(definition ? definition.renderCall(args, theme).render(100).join('\n') : `Tool: ${name}`);
    this.args = args;
    this.definition = definition;
    this.expanded = false;
  }
  updateResult(result) {
    this.result = result;
    if (this.definition) {
      this.text = this.definition
        .renderResult(result, { expanded: this.expanded, isPartial: false }, theme, {
          args: this.args,
          isError: result.isError === true,
        })
        .render(100)
        .join('\n');
      return;
    }
    const output = result.content
      .map((part) => part.text)
      .filter(Boolean)
      .join('');
    if (output) this.text += `\n${output}`;
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    if (this.result) this.updateResult(this.result);
  }
  setExpanded() {}
}

class NativeExpandable extends NativeText {
  constructor(message, renderer) {
    super(
      renderer?.(message, { expanded: false }, theme)?.render(100).join('\n') ??
        messageText(message) ??
        message?.summary ??
        '',
    );
  }
  setExpanded() {}
}

class NativeSpacer extends NativeText {
  constructor(lines = 1) {
    super();
    this.lines = lines;
  }
  render() {
    return Array.from({ length: this.lines }, () => '');
  }
}

class NativeBash extends NativeExpandable {
  appendOutput(output) {
    this.text += `\n${output}`;
  }
  setComplete() {}
}

class NativeEditor extends NativeText {
  focused = true;
  text = '';
  inputs = [];
  actions = new Map();
  getText() {
    return this.text;
  }
  setText(text) {
    this.text = text;
  }
  isShowingAutocomplete() {
    return false;
  }
  onAction(action, handler) {
    this.actions.set(action, handler);
  }
  handleInput(data) {
    this.inputs.push(data);
    if (data === '\x1b') this.onEscape?.();
    else if (data === '\x03') this.actions.get('app.clear')?.();
    else if (data === '\r' || data === '\n') this.onSubmit?.(this.text);
    else if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) this.text += data.slice(6, -6);
    else if (data === '\x1b[5;5~' || data === '\x1b[6;5~') return;
    else this.text += data;
  }
  render() {
    return [`> ${this.text}`];
  }
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content)
    ? message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
    : undefined;
}

function nativeModule(dialog = {}) {
  class NativeSelector {
    constructor(title, options, onSelect, onCancel) {
      this.title = title;
      this.options = options;
      this.onSelect = onSelect;
      this.onCancel = onCancel;
      dialog.select?.(title, options, onSelect, onCancel);
    }
    render() {
      return [this.title, ...this.options];
    }
    handleInput() {}
    invalidate() {}
    dispose() {}
  }
  class NativeDialogInput {
    constructor(title, _placeholder, onSubmit, onCancel) {
      this.title = title;
      this.onSubmit = onSubmit;
      this.onCancel = onCancel;
      dialog.input?.(title, onSubmit, onCancel);
    }
    render() {
      return [this.title];
    }
    handleInput() {}
    invalidate() {}
    dispose() {}
  }
  class NativeDialogEditor {
    constructor(_tui, _keybindings, title, prefill, onSubmit, onCancel) {
      this.title = title;
      this.prefill = prefill;
      this.onSubmit = onSubmit;
      this.onCancel = onCancel;
      dialog.editor?.(title, prefill, onSubmit, onCancel);
    }
    render() {
      return [this.title, this.prefill ?? ''];
    }
    handleInput() {}
    invalidate() {}
    dispose() {}
  }
  return {
    getMarkdownTheme: () => ({}),
    getSelectListTheme: () => ({
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    }),
    UserMessageComponent: NativeUser,
    AssistantMessageComponent: NativeAssistant,
    ToolExecutionComponent: NativeTool,
    CustomMessageComponent: NativeExpandable,
    BranchSummaryMessageComponent: NativeExpandable,
    CompactionSummaryMessageComponent: NativeExpandable,
    BashExecutionComponent: NativeBash,
    parseSkillBlock: () => null,
    SkillInvocationMessageComponent: NativeExpandable,
    Spacer: NativeSpacer,
    Text: NativeText,
    CustomEditor: NativeEditor,
    ExtensionEditorComponent: NativeDialogEditor,
    ExtensionInputComponent: NativeDialogInput,
    ExtensionSelectorComponent: NativeSelector,
  };
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
    markdownTheme: {},
    selectListTheme: {},
    ...nativeModule(),
  };
}

test('ambient widget shows only active nested agents and never exposes idle capacity or internal identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-command-center-'));
  const store = await SchedulerStore.open({
    statePath: join(root, 'state.json'),
    bootstrap: { rootId: 'root', cwd: root, maxOpenAgents: 10, maxDepth: 3 },
  });
  let changes = 0;
  const unsubscribe = store.onChange(() => changes++);
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
    assert.ok(changes >= 5);
  } finally {
    unsubscribe();
    await store.close();
  }
});

test('authoritative settlement clears stale streaming activity from the command center', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-command-activity-'));
  const store = await SchedulerStore.open({
    statePath: join(root, 'state.json'),
    bootstrap: { rootId: 'root', cwd: root, maxOpenAgents: 10, maxDepth: 1 },
  });
  try {
    await admit(store, root, 'agent-a', 'root', 'a', 'Altair');
    await ready(store, 'agent-a');
    const activation = await store.startActivation('agent-a', 'test_activity');
    const actor = {
      activityEvents: [
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'still writing' },
        },
      ],
    };
    const working = projectCommandCenter(store.snapshot(), new Map([['agent-a', actor]]));
    assert.equal(working.agents.find((agent) => agent.agentId === 'agent-a')?.activity, 'Writing a response');
    await store.finishActivation(activation.value.activationId, activation.value.leaseToken, 'settled');
    const settled = projectCommandCenter(store.snapshot(), new Map([['agent-a', actor]]));
    assert.notEqual(settled.agents.find((agent) => agent.agentId === 'agent-a')?.activity, 'Writing a response');

    let publishEvent;
    let publishRootEvent;
    let actorSnapshot = [];
    let rootSnapshot = [];
    const histories = new Map([
      ['agent-a', []],
      [
        'root',
        [
          {
            role: 'assistant',
            responseId: 'root-before-compaction',
            content: [{ type: 'text', text: 'Root before compaction' }],
          },
        ],
      ],
    ]);
    const streamActor = {
      subscribeConversation(listener) {
        publishEvent = listener;
        return {
          snapshot: actorSnapshot,
          unsubscribe() {
            publishEvent = undefined;
          },
        };
      },
    };
    const streams = new AgentConversationStreams({
      store,
      epoch: 'stream-test',
      currentActor: (agentId) => (agentId === 'agent-a' ? streamActor : undefined),
      rootAgentId: 'root',
      currentRootEvents: (listener) => {
        publishRootEvent = listener;
        return {
          snapshot: rootSnapshot,
          unsubscribe() {
            publishRootEvent = undefined;
          },
        };
      },
      readSession: async (agentId) => ({ messages: histories.get(agentId) ?? [] }),
      running: () => true,
      onDiagnostic: (error) => {
        throw error;
      },
    });
    const updates = [];
    let unsubscribe = streams.subscribe('agent-a', (update) => updates.push(update));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const emit = (event) => publishEvent?.(event);
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'live ' },
    });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 1 } });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'plan' },
    });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2 } });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{"action":"list"}' },
    });
    emit({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 2,
        toolCall: { type: 'toolCall', id: 'call-1', name: 'luminaries_directory', arguments: { action: 'list' } },
      },
    });
    const live = streams.snapshot('agent-a').messages;
    assert.equal(live.length, 1);
    assert.match(JSON.stringify(live[0]), /live/);
    assert.match(JSON.stringify(live[0]), /plan/);
    assert.match(JSON.stringify(live[0]), /luminaries_directory/);
    actorSnapshot = [
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'live ' },
            { type: 'thinking', thinking: 'plan' },
            { type: 'toolCall', id: 'call-1', name: 'luminaries_directory', arguments: { action: 'list' } },
          ],
        },
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        toolName: 'luminaries_directory',
        args: { action: 'list' },
        partialResult: { content: [{ type: 'text', text: 'live tool result' }] },
      },
    ];
    unsubscribe();
    unsubscribe = streams.subscribe('agent-a', (update) => updates.push(update));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.match(JSON.stringify(streams.snapshot('agent-a').messages), /live/);
    assert.match(JSON.stringify(streams.snapshot('agent-a').messages), /luminaries_directory/);
    assert.match(JSON.stringify(streams.snapshot('agent-a').messages), /live tool result/);
    actorSnapshot = [];
    emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'live final' },
          { type: 'toolCall', id: 'call-1', name: 'luminaries_directory', arguments: { action: 'list' } },
        ],
      },
    });
    const final = streams.snapshot('agent-a').messages;
    assert.equal(final.filter((message) => message.role === 'assistant').length, 1);
    assert.match(JSON.stringify(final[0]), /live final/);
    assert.ok(updates.some((update) => update.type === 'splice'));

    const resetsBeforeFailure = updates.filter((update) => update.type === 'reset').length;
    emit({ type: 'compaction_end', aborted: true, result: undefined });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(updates.filter((update) => update.type === 'reset').length, resetsBeforeFailure);
    histories.set('agent-a', [{ role: 'assistant', content: [{ type: 'text', text: 'Child compacted history' }] }]);
    emit({ type: 'compaction_end', aborted: false, result: { summary: 'child summary' } });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(streams.snapshot('agent-a').messages.length, 1);
    assert.match(JSON.stringify(streams.snapshot('agent-a').messages), /Child compacted history/);
    assert.doesNotMatch(JSON.stringify(streams.snapshot('agent-a').messages), /live final/);

    const rootUpdates = [];
    const secondRootUpdates = [];
    const unsubscribeRoot = streams.subscribe('root', (update) => rootUpdates.push(update));
    const unsubscribeSecondRoot = streams.subscribe('root', (update) => secondRootUpdates.push(update));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    publishRootEvent?.({
      type: 'message_start',
      message: { role: 'assistant', timestamp: 1_725_000_000_000, content: [] },
    });
    publishRootEvent?.({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Root live draft' },
    });
    assert.match(JSON.stringify(streams.snapshot('root').messages), /Root live draft/);
    rootSnapshot = [
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          timestamp: 1_725_000_000_000,
          content: [{ type: 'text', text: 'Root live draft' }],
        },
      },
    ];
    histories.set('root', [
      {
        role: 'assistant',
        timestamp: 1_725_000_000_000,
        content: [{ type: 'text', text: 'Root live draft' }],
      },
    ]);
    unsubscribeRoot();
    unsubscribeSecondRoot();
    const reselectedRootUpdates = [];
    const unsubscribeReselectedRoot = streams.subscribe('root', (update) => reselectedRootUpdates.push(update));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.match(JSON.stringify(streams.snapshot('root').messages), /Root live draft/);
    assert.equal(
      streams
        .snapshot('root')
        .messages.filter((message) => message.role === 'assistant' && message.timestamp === 1_725_000_000_000).length,
      1,
    );
    histories.set('root', [{ role: 'assistant', content: [{ type: 'text', text: 'Root compacted history' }] }]);
    rootSnapshot = [];
    const rootResets = reselectedRootUpdates.filter((update) => update.type === 'reset').length;
    publishRootEvent?.({ type: 'session_compact', compactionEntry: { id: 'root-compaction' } });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(streams.snapshot('root').messages.length, 1);
    assert.match(JSON.stringify(streams.snapshot('root').messages), /Root compacted history/);
    assert.doesNotMatch(JSON.stringify(streams.snapshot('root').messages), /Root before compaction|Root live draft/);
    assert.equal(reselectedRootUpdates.filter((update) => update.type === 'reset').length, rootResets + 1);
    unsubscribeReselectedRoot();
    unsubscribe();
    await streams.close();
  } finally {
    await store.close();
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
    assert.equal(projected.dependency, 'Message from Human operator is queued');
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

test('ambient widget preserves nested lineage when an idle ancestor collapses', () => {
  const child = agent('child', 'parent', 2, 'Deneb', 'working');
  const projection = projectionWith([
    agent('root', null, 0, 'Root', 'idle'),
    agent('parent', 'root', 1, 'Altair', 'idle'),
    child,
  ]);
  const rendered = renderAmbientWidget(projection, 72, 0, theme).join('\n');
  assert.match(rendered, /Altair · parent › Deneb · child/);
  assert.equal(rendered.match(/Altair/gu)?.length, 1);
});

test('ambient widget keeps every active depth-3 agent visible at the ten-agent operating target', () => {
  const agents = [agent('root', null, 0, 'Root', 'idle')];
  for (let index = 1; index < 10; index++) {
    const parentId = index <= 3 ? (index === 1 ? 'root' : `agent-${index - 1}`) : 'root';
    const parent = agents.find((candidate) => candidate.agentId === parentId) ?? agents[0];
    agents.push(agent(`agent-${index}`, parentId, Math.min(3, parent.depth + 1), `Agent ${index}`, 'working'));
  }
  const projection = projectionWith(agents);
  const lines = renderAmbientWidget(projection, 72, 1, theme);
  for (let index = 1; index < 10; index++) assert.ok(lines.some((line) => line.includes(`Agent ${index}`)));
  assert.equal(lines.length, 10);
  assert.ok(lines.every((line) => !/10\/10|\d+\/10|idle/u.test(line)));
});

test('projection keeps semantic content while replacing control envelopes and private paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-command-human-'));
  const store = await SchedulerStore.open({
    statePath: join(root, 'state.json'),
    bootstrap: { rootId: 'luminaries-root-deadbeef', cwd: root, maxOpenAgents: 10, maxDepth: 3 },
  });
  try {
    await admit(store, root, 'luminaries-agent-acde1234', 'luminaries-root-deadbeef', 'agent-acde1234', 'Altair');
    await admit(
      store,
      root,
      'luminaries-agent-peer-secret-hash',
      'luminaries-root-deadbeef',
      'peer-secret-hash',
      'Deneb',
    );
    const targetRuntimeOwner = await ready(store, 'luminaries-agent-acde1234');
    const senderRuntimeOwner = await ready(store, 'luminaries-agent-peer-secret-hash');
    await store.startActivation('luminaries-agent-peer-secret-hash', 'test');
    const privateSessionPath = store.snapshot().agents['luminaries-agent-acde1234'].sessionFile;
    const privateStatePath = join(root, '.pi', 'agent', 'luminaries', 'roots', 'state.json');
    const routed = await store.admitPeerEvent(
      {
        agentId: 'luminaries-agent-peer-secret-hash',
        rootId: 'luminaries-root-deadbeef',
        runtimeOwner: senderRuntimeOwner,
      },
      {
        bridgeRequestId: 'command-center-peer',
        recipientId: 'luminaries-agent-acde1234',
        message: `Please verify the readable transcript. Internal lineage: ${agentPath(store.snapshot(), 'luminaries-agent-acde1234')}.`,
      },
    );
    const admittedState = store.snapshot();
    const peerPrompt = formatPeerPrompt([admittedState.mailbox[routed.value.event.eventId]], admittedState);
    const delivery = await store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: routed.value.event.eventId,
      runtimeOwner: targetRuntimeOwner,
    });
    await store.applyMailboxIntent({
      kind: 'admit_boundary',
      recordId: routed.value.event.eventId,
      attemptId: delivery.value.attemptId,
    });
    const projectionState = store.snapshot();
    const actor = {
      activityEvents: [
        {
          type: 'message_end',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: peerPrompt,
              },
            ],
          },
        },
        {
          type: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'tool-secret-hash',
          args: { path: join(root, 'fieldnotes', 'README.md') },
        },
        {
          type: 'message_update',
          message: { role: 'assistant', content: [{ type: 'text', text: 'I am checking the readable UI.' }] },
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `Private records ${privateSessionPath} and ${privateStatePath} stay hidden.`,
              },
            ],
          },
        },
      ],
    };
    const sessionMessages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: peerPrompt,
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Private records ${privateSessionPath} and ${privateStatePath} stay hidden.`,
          },
          {
            type: 'toolCall',
            id: 'tool-secret-hash',
            name: 'read',
            arguments: {
              path: 'README.md',
              items: Array.from({ length: 129 }, (_, index) => `item-${index}`),
              nested: Array.from({ length: 13 }).reduce((value) => ({ nested: value }), { value: 'deepest' }),
            },
          },
        ],
      },
      { role: 'toolResult', toolCallId: 'tool-secret-hash', toolName: 'read', content: [], isError: false },
      {
        role: 'custom',
        customType: 'luminaries_protocol_message',
        content:
          'From Deneb · et-hash (correlationId luminaries-request-private):\nComplete first line.\nComplete second line.',
        details: {
          inputId: 'luminaries-input-private',
          presentation: 'message',
          content: 'From Deneb · et-hash:\nComplete first line.\nComplete second line.',
        },
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'assistant',
        content: [{ type: 'text', text: `Historical private-session turn ${index + 1}` }],
      })),
    ];
    const projection = projectCommandCenter(projectionState, new Map([['luminaries-agent-acde1234', actor]]));
    const conversation = projectConversationMessages(sessionMessages, projectionState, 'luminaries-agent-acde1234');
    const child = projection.agents.find((candidate) => candidate.name === 'Altair');
    assert.deepEqual(child.breadcrumb, ['Root', 'Altair · de1234']);
    assert.equal(child.activity, 'Reading fieldnotes/README.md');
    assert.equal(child.focusSource, 'spawn');
    assert.equal(child.ownershipBoundary, 'Altair boundary');
    assert.ok(conversation.length > 24);
    assert.ok(
      conversation.some(
        (message) =>
          messageText(message)?.includes('Deneb') &&
          messageText(message)?.includes('Please verify the readable transcript.'),
      ),
    );
    assert.ok(conversation.some((message) => messageText(message)?.includes('Luminaries private state')));
    assert.ok(conversation.some((message) => messageText(message)?.includes('Internal lineage: root/agent-acde1234')));
    assert.match(JSON.stringify(conversation), /item-128/);
    assert.match(JSON.stringify(conversation), /deepest/);
    assert.match(JSON.stringify(conversation), /From Deneb · et-hash.*Complete second line/su);
    assert.doesNotMatch(JSON.stringify(conversation), /luminaries-request-private/u);
    assert.doesNotMatch(JSON.stringify(conversation), /Nested content omitted/);
    const displayedText = conversation.map(messageText).join('\n');
    assert.ok(!displayedText.includes(privateSessionPath));
    assert.ok(!displayedText.includes(privateStatePath));
    assert.doesNotMatch(
      JSON.stringify(conversation),
      /luminaries-trace-secret-hash|luminaries-event-secret-hash|peer-secret-hash/u,
    );

    const component = componentFor(projection, new Map([[child.agentId, conversation]]));
    const directory = component.render(100).join('\n');
    assert.match(directory, /Pi Luminaries · Constellation/);
    assert.match(directory, /Root/);
    assert.match(directory, /Altair/);
    assert.match(directory, /specialist/);
    assert.match(directory, /\[Current\] Archived/);
    assert.match(directory, /Current action.*Reading fieldnotes\/README\.md.*Focus.*Altair focus/su);
    assert.doesNotMatch(directory, /Altair boundary/su);
    assert.doesNotMatch(directory, /luminaries-root|luminaries-agent|deadbeef/u);
    component.handleInput('i');
    const facts = component.render(100).join('\n');
    assert.match(facts, /Altair · de1234/);
    assert.match(facts, /Assignment.*Altair assignment/su);
    assert.match(facts, /Focus.*Altair focus/su);
    assert.doesNotMatch(facts, /luminaries-root|luminaries-agent|deadbeef/u);
    component.scrollBy(1_000);
    const factTail = component.render(100).join('\n');
    assert.match(factTail, /Scope of work.*Altair boundary/su);
    assert.match(factTail, /Runtime/su);
    component.handleInput('i');
    component.handleInput('\r');
    const liveTail = component.render(100).join('\n');
    assert.match(liveTail, /Altair · de1234 · specialist.*Esc directory/su);
    assert.match(liveTail, /Root › Altair · de1234/);
    assert.match(liveTail, /Historical private-session turn 30/);
    component.scrollBy(-1_000);
    const renderedConversation = component.render(100).join('\n');
    assert.match(renderedConversation, /Tool: read/);
    assert.match(renderedConversation, /Please verify the readable transcript/);
    assert.match(renderedConversation, /Internal lineage: root\/agent-acde1234/u);
    assert.doesNotMatch(renderedConversation, /luminaries-control|tool-secret/u);

    const rootComponent = componentFor(
      projection,
      new Map([[projection.rootId, [{ role: 'assistant', content: [{ type: 'text', text: 'Root history.' }] }]]]),
      { initialAgentId: projection.rootId, rootEnter: 'conversation' },
    );
    rootComponent.handleInput('\r');
    const renderedRoot = rootComponent.render(100).join('\n');
    assert.match(renderedRoot, /Root.*Esc directory/su);

    const deadline = Date.now() + 1_000;
    const request = await store.acceptCorrelatedRequest(
      {
        agentId: 'luminaries-agent-peer-secret-hash',
        rootId: 'luminaries-root-deadbeef',
        runtimeOwner: senderRuntimeOwner,
      },
      {
        bridgeRequestId: 'private-timeout-review',
        recipientId: 'luminaries-agent-acde1234',
        message: 'Review keyboard focus.',
        deadlineAtMs: deadline,
      },
    );
    const timedOut = await store.timeoutCorrelatedRequest(request.value.request.requestId, deadline);
    const resolution = timedOut.value.route.event;
    const notice = peerPresentationDetails([resolution], store.snapshot());
    assert.match(notice.lines.join('\n'), /Luminaries update · Request to Altair · de1234 timed out without a reply/u);
    assert.ok(!notice.content.includes(request.value.request.requestId));
    assert.ok(formatPeerPrompt([resolution], store.snapshot()).includes(request.value.request.requestId));
    const noticeDelivery = await store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: resolution.eventId,
      runtimeOwner: senderRuntimeOwner,
    });
    await store.applyMailboxIntent({
      kind: 'admit_boundary',
      recordId: resolution.eventId,
      attemptId: noticeDelivery.value.attemptId,
    });
    await store.finishActivation(
      noticeDelivery.value.activationId,
      noticeDelivery.value.activationLeaseToken,
      'settled',
    );
    const activity = projectCommandCenter(store.snapshot())
      .agents.find((candidate) => candidate.agentId === 'luminaries-agent-peer-secret-hash')
      .interactions.join('\n');
    assert.match(activity, /Luminaries update · Request to Altair · de1234 timed out without a reply/u);
    assert.ok(!activity.includes(request.value.request.requestId));
    assert.equal(
      activity.toLowerCase().split('completed a turn').length - 1,
      1,
      'one completion occupies one activity entry',
    );

    const uncertain = await store.admitPeerMulticast(
      {
        agentId: 'luminaries-root-deadbeef',
        rootId: 'luminaries-root-deadbeef',
        runtimeOwner: 'operator',
        origin: 'operator',
      },
      {
        bridgeRequestId: 'command-center-multicast-indeterminate',
        recipientIds: ['luminaries-agent-acde1234', 'luminaries-agent-peer-secret-hash'],
        message: 'One recipient-side delivery outcome is uncertain.',
      },
    );
    const uncertainEvent = uncertain.value[0].event;
    const uncertainDelivery = await store.applyMailboxIntent({
      kind: 'begin_delivery',
      recordId: uncertainEvent.eventId,
      runtimeOwner: targetRuntimeOwner,
    });
    await store.applyMailboxIntent({
      kind: 'finish_delivery',
      recordId: uncertainEvent.eventId,
      attemptId: uncertainDelivery.value.attemptId,
      status: 'indeterminate',
      outcomeCode: 'recipient_delivery_unconfirmed',
    });
    const healthProjection = projectCommandCenter(store.snapshot());
    assert.equal(
      healthProjection.agents.find((agent) => agent.agentId === 'luminaries-root-deadbeef')?.attention,
      false,
    );
    assert.equal(
      healthProjection.agents.find((agent) => agent.agentId === 'luminaries-root-deadbeef')?.canContinueWithMessage,
      false,
    );
    assert.equal(
      healthProjection.agents.find((agent) => agent.agentId === 'luminaries-agent-peer-secret-hash')?.attention,
      false,
    );
    assert.equal(
      healthProjection.agents.find((agent) => agent.agentId === 'luminaries-agent-acde1234')?.attention,
      true,
    );
    assert.equal(
      healthProjection.agents.find((agent) => agent.agentId === 'luminaries-agent-acde1234')?.canContinueWithMessage,
      false,
    );
    const activation = store.snapshot().activations[uncertainDelivery.value.activationId];
    await store.finishActivation(activation.activationId, activation.leaseToken, 'indeterminate');
    await store.setAgentAttention('luminaries-root-deadbeef', 'needs_attention', 'runtime_owner_unavailable');
    const projectWithEvidence = () => {
      const snapshot = store.snapshot();
      return projectCommandCenter(
        snapshot,
        new Map(),
        snapshot.revision,
        undefined,
        snapshot.revision,
        store.indeterminateEvidenceSnapshot(['luminaries-agent-acde1234', 'luminaries-root-deadbeef']),
      );
    };
    const eligibleProjection = projectWithEvidence();
    assert.equal(
      eligibleProjection.agents.find((agent) => agent.agentId === 'luminaries-agent-acde1234')?.canContinueWithMessage,
      true,
    );
    assert.equal(
      eligibleProjection.agents.find((agent) => agent.agentId === 'luminaries-root-deadbeef')?.canContinueWithMessage,
      false,
    );
    await store.setAgentAttention('luminaries-agent-acde1234', 'needs_attention', 'runtime_owner_unavailable');
    const blockedProjection = projectWithEvidence();
    const blockedAgent = blockedProjection.agents.find((agent) => agent.agentId === 'luminaries-agent-acde1234');
    assert.equal(blockedAgent?.canContinueWithMessage, false);
    assert.equal(blockedAgent?.health.summary, 'Runtime ownership is unavailable');
    await store.markAgentContinuedAfterIndeterminate('luminaries-agent-acde1234', { kind: 'operator' });
    const continuedProjection = projectWithEvidence();
    assert.equal(
      continuedProjection.agents.find((agent) => agent.agentId === 'luminaries-agent-acde1234')?.canContinueWithMessage,
      false,
    );
    assert.equal(
      continuedProjection.agents.find((agent) => agent.agentId === 'luminaries-agent-acde1234')?.attention,
      true,
    );
  } finally {
    await store.close();
  }
});

test('conversation fits a long expert assignment within the terminal width', () => {
  const width = 209;
  const child = agent('child', 'root', 1, 'Deneb', 'idle');
  child.assignment =
    'Read README.md and docs/synchronization.md. Trace how offline notebook edits are reconciled when another person deletes the same note. Explain the recovery choices, identify any user-visible failure cases, and send the parent a concise recommendation without changing files.';
  child.role = 'Synchronization expert';
  child.focus = 'Offline notebook recovery';
  child.ownershipBoundary =
    'Inspect note storage, synchronization, and recovery behavior. Consult the existing keyboard expert before recommending changes.';
  child.expertise = ['Offline edits', 'Shared notebook recovery'];
  child.interactions = [
    'Deletion can race with unsynchronized edits. Preserve the local draft and offer a recovery choice before removing it from the notebook.',
  ];
  const projection = projectionWith([agent('root', null, 0, 'Root', 'idle'), child]);
  const component = new LuminariesCommandCenterComponent(
    () => projection,
    () => 0,
    theme,
    { async send() {}, async interrupt() {} },
    () => undefined,
    () => undefined,
    () => 30,
    undefined,
    nativeUi(),
  );
  component.handleInput('\r');
  const lines = component.render(width);
  const rendered = lines.join('\n');
  assert.match(rendered, /Deneb · child · Synchronization expert.*Ready · Esc directory/su);
  assert.match(rendered, /Root › Deneb · child/u);
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
});

test('workspace remains height-bounded through resize and the native editor', () => {
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

test('selected inspector is passive, ordered, and excludes internal identifiers', () => {
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

test('root attention directs continuation through the Root conversation', () => {
  const root = agent('root', null, 0, 'Root', 'idle');
  root.attention = true;
  root.canContinueWithMessage = true;
  root.active = true;
  root.health = {
    level: 'critical',
    attention: 'critical',
    summary: 'Delivery outcome is uncertain',
    reasons: ['indeterminate_effect'],
    observations: [{ code: 'indeterminate_effect', level: 'critical', message: 'Delivery outcome is uncertain' }],
  };
  const component = componentFor(projectionWith([root]));
  const rendered = component.render(92).join('\n');
  assert.match(rendered, /Health.*Delivery outcome is uncertain.*Next.*Press Enter to continue from the/su);
  assert.match(rendered, /Press Enter to continue from the Root.*conversation/su);
});

test('multicast picker commits temporary marks and clears them on commit or cancel', async () => {
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

test('controller dynamically removes the idle widget and opens the stock-Pi foreground workspace', async (t) => {
  let projection = projectionWith([
    agent('root', null, 0, 'Root', 'idle'),
    agent('child', 'root', 1, 'Altair', 'idle'),
  ]);
  const retired = agent('retired', 'root', 1, 'Retired', 'idle');
  retired.lifecycle = 'closed';
  retired.state = 'closed';
  const archived = agent('archived', 'root', 1, 'Archived', 'idle');
  archived.lifecycle = 'closed';
  archived.state = 'closed';
  archived.archived = true;
  let closedHistory = { revision: 1, agents: [retired, archived], archivedCount: 1 };
  let closedHistoryCalls = 0;
  let closedHistoryFailures = 0;
  let closedHistoryDelay;
  let listener;
  let widget;
  let component;
  let customCalls = 0;
  let customArgumentCount = 0;
  let customOptions;
  let inputDispatch = false;
  let closePhase;
  let workspaceRenders = 0;
  let workspaceVisibleDuringDialog;
  let overlayHandle;
  let overlayFocuses = 0;
  let dialogOverlayCalls = 0;
  let mouseInput;
  const terminalWrites = [];
  let holdDialog = false;
  let tuiMode = 'regular';
  let dialogCancelled = false;
  let activeDialog;
  let workspaceTui;
  let availableSessions = [];
  const selectResponses = [];
  const inputResponses = [];
  const confirmResponses = [];
  const notifications = [];
  const selectOptions = [];
  const selectTitles = [];
  const inputTitles = [];
  const operatorInputs = [];
  const operatorExecutions = [];
  let operatorResult = { details: {} };
  const extensionApprovals = [];
  let selectableExtensions = [];
  const sessionPreviews = [];
  const adoptionCalls = [];
  const capacityUpdates = [];
  const depthUpdates = [];
  const resumedAgents = [];
  let resumeFailures = 1;
  let selectedAgentId;
  let conversationListener;
  const dialogModule = nativeModule({
    select(title, options, onSelect) {
      workspaceVisibleDuringDialog = overlayHandle?.isHidden() === false;
      selectTitles.push(title);
      selectOptions.push(options);
      if (holdDialog) return;
      const response =
        options.length === 2 && options[0] === 'Yes' && options[1] === 'No'
          ? confirmResponses.shift()
            ? 'Yes'
            : 'No'
          : (selectResponses.shift() ?? 'Cancel');
      queueMicrotask(() => onSelect(response));
    },
    input(title, onSubmit, onCancel) {
      inputTitles.push(title);
      workspaceVisibleDuringDialog = overlayHandle?.isHidden() === false;
      const response = inputResponses.shift();
      queueMicrotask(() => (response === undefined ? onCancel() : onSubmit(response)));
    },
    editor(title, _prefill, onSubmit, onCancel) {
      inputTitles.push(title);
      workspaceVisibleDuringDialog = overlayHandle?.isHidden() === false;
      const response = inputResponses.shift();
      queueMicrotask(() => (response === undefined ? onCancel() : onSubmit(response)));
    },
  });
  const manager = {
    commandCenterProjection: () => projection,
    onCommandCenterChange(value) {
      listener = value;
      return () => {
        listener = undefined;
      };
    },
    onAgentConversationChange(agentId, publish) {
      selectedAgentId = agentId;
      conversationListener = publish;
      publish({
        type: 'reset',
        epoch: 'test',
        agentId,
        incarnation: 1,
        revision: 1,
        hydrated: true,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hydrated from the private Pi session.' }] }],
      });
      return () => {
        conversationListener = undefined;
      };
    },
    async operatorInput(...args) {
      operatorInputs.push(args);
    },
    async operatorExecute(...args) {
      operatorExecutions.push(args);
      return operatorResult;
    },
    operatorModels: () => [{ provider: 'test', id: 'model' }],
    operatorThinkingLevels: () => ['off', 'low', 'high'],
    operatorSelectableExtensions: () => selectableExtensions,
    operatorExtensionSources: () => [{ specifier: 'npm:pi-web-access', scope: 'user' }],
    async operatorApproveExtension(...args) {
      extensionApprovals.push(args);
    },
    async operatorSessions() {
      return availableSessions;
    },
    async operatorInspectSessionReference(reference) {
      sessionPreviews.push(reference);
      if (reference === 'not-a-session') throw new Error('Pi session is unavailable');
      return { sessionFile: reference, sessionId: 'preview-session', cwd: process.cwd() };
    },
    async operatorAdoptSession(...args) {
      adoptionCalls.push(args);
      return { sourceSessionFile: args[0], agentId: 'adopted', handle: 'Adopted · opted', sessionId: 'adopted' };
    },
    async operatorInterrupt() {},
    async operatorSetCapacity(capacity) {
      capacityUpdates.push(capacity);
    },
    async operatorSetDepth(depth) {
      depthUpdates.push(depth);
    },
    async operatorResume(agentId) {
      resumedAgents.push(agentId);
      if (resumeFailures > 0) {
        resumeFailures--;
        throw new Error('capacity was consumed concurrently');
      }
    },
    async operatorClosedHistory() {
      closedHistoryCalls++;
      const delay = closedHistoryDelay;
      if (delay) await delay;
      if (closedHistoryFailures > 0) {
        closedHistoryFailures--;
        throw new Error('closed history unavailable');
      }
      return closedHistory;
    },
  };
  const context = {
    mode: 'tui',
    parentConversation: true,
    ui: {
      setWidget(_id, value) {
        widget = value;
      },
      notify(message, level) {
        notifications.push([message, level]);
      },
      custom(...args) {
        customCalls++;
        const [factory, options] = args;
        customArgumentCount = args.length;
        customOptions = options;
        return new Promise((resolvePromise) => {
          const ui = nativeUi(100, 30).tui;
          workspaceTui = ui;
          ui.mode = tuiMode;
          ui.requestRender = () => workspaceRenders++;
          ui.start = () => {
            throw new Error('The command center must not start the host TUI');
          };
          ui.stop = () => {
            throw new Error('The command center must not stop the host TUI');
          };
          ui.terminal.write = (value) => terminalWrites.push(value);
          ui.addInputListener = (listener) => {
            mouseInput = listener;
            return () => {
              if (mouseInput === listener) mouseInput = undefined;
            };
          };
          ui.showOverlay = (dialog) => {
            dialogOverlayCalls++;
            activeDialog = dialog;
            let hidden = false;
            return {
              hide() {
                hidden = true;
                if (activeDialog === dialog) activeDialog = undefined;
                if (holdDialog) dialogCancelled = true;
              },
              setHidden(value) {
                hidden = value;
              },
              isHidden: () => hidden,
              focus() {
                overlayFocuses++;
              },
              unfocus() {},
              isFocused: () => !hidden,
            };
          };
          let hidden = false;
          let focused = true;
          const handle = {
            hide() {
              hidden = true;
              focused = false;
            },
            setHidden(value) {
              hidden = value;
              if (value) focused = false;
            },
            isHidden: () => hidden,
            focus() {
              hidden = false;
              focused = true;
              overlayFocuses++;
            },
            unfocus() {
              focused = false;
            },
            isFocused: () => focused,
          };
          const created = factory(ui, theme, keybindings, (value) => {
            closePhase = inputDispatch ? 'input' : 'after';
            handle.hide();
            resolvePromise(value);
          });
          component = created;
          overlayHandle = handle;
          options.onHandle?.(handle);
        });
      },
    },
  };
  let releaseNativeUi = () => undefined;
  const nativeUiReady = new Promise((resolvePromise) => {
    releaseNativeUi = resolvePromise;
  });
  const controller = new LuminariesCommandCenterController(async () => {
    await nativeUiReady;
    return dialogModule;
  });
  t.after(() => controller.dispose());
  controller.attach(context, manager);
  assert.equal(widget, undefined);

  projection = projectionWith([agent('root', null, 0, 'Root', 'idle'), agent('child', 'root', 1, 'Altair', 'working')]);
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const widgetComponent = widget({ requestRender() {} }, theme);
  assert.ok(widgetComponent.render(60).some((line) => /Altair/.test(line)));

  const opened = controller.open(context);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(customCalls, 0);
  assert.ok(notifications.some(([, level]) => level === 'info'));
  releaseNativeUi();
  for (let index = 0; index < 2; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  notifications.length = 0;
  assert.equal(customCalls, 1);
  assert.equal(customArgumentCount, 2);
  assert.equal(customOptions.overlay, true);
  assert.equal(customOptions.overlayOptions.width, '100%');
  assert.equal(customOptions.overlayOptions.maxHeight, '100%');
  assert.equal(typeof customOptions.onHandle, 'function');
  assert.equal(overlayHandle.isFocused(), true);
  assert.match(terminalWrites.at(-1), /1000h.*1006h/u);
  assert.equal(widget, undefined);
  const directoryLines = component.render(80);
  assert.match(directoryLines[0], /Constellation/);
  assert.ok(directoryLines.length <= 30, 'fullscreen workspace must fit the terminal viewport');
  assert.match(directoryLines.slice(-2).join(' '), /i details/u);
  assert.match(directoryLines.slice(-2).join(' '), /Esc/u);
  assert.ok(directoryLines.some((line) => /\[Current\] Archived/.test(line)));
  assert.match(directoryLines.join('\n'), /Retired/);
  assert.doesNotMatch(directoryLines.join('\n'), /Archived · chived/u);
  inputResponses.push('Review the launch path.', 'Only the launch path.');
  selectResponses.push('Cancel');
  component.handleInput('n');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.match(selectTitles.at(-1), /New luminary.*Model:.*Thinking:.*Context: fresh.*Project:/su);
  assert.deepEqual(selectOptions.at(-1), ['Create with these settings', 'Customize', 'Cancel']);
  assert.deepEqual(operatorExecutions, []);
  const rootExpert = projection.agents.find((candidate) => candidate.agentId === projection.rootId);
  assert.ok(rootExpert);
  rootExpert.state = 'running';
  rootExpert.humanState = 'working';
  rootExpert.active = true;
  listener?.(projection);
  inputResponses.push('Review the active branch.', 'Only the active branch.', '');
  selectResponses.push('Customize', 'Recent · newest compatible parent context');
  component.handleInput('n');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(operatorExecutions, []);
  assert.equal(inputResponses.length, 0);
  assert.equal(selectResponses.length, 0);
  rootExpert.state = 'idle';
  rootExpert.humanState = 'idle';
  rootExpert.active = false;
  listener?.(projection);
  component.handleInput('\x1b');
  for (const [cancelIndex, title] of ['Custom system prompt', 'Skills', 'Prompt templates', 'Themes'].entries()) {
    inputResponses.push(
      'Review the launch path.',
      'Only the launch path.',
      '',
      ...Array(cancelIndex).fill(''),
      undefined,
    );
    selectResponses.push('Customize', 'Custom · isolated startup');
    if (cancelIndex > 0) {
      selectResponses.push('Use parent directory · current', 'Use parent model', 'Use parent thinking');
      confirmResponses.push(true);
    }
    component.handleInput('n');
    for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.ok(inputTitles.at(-1).startsWith(title), `Esc must stop at ${title}`);
    assert.equal(selectResponses.length, 0);
    assert.equal(inputResponses.length, 0);
    assert.deepEqual(operatorExecutions, [], `Esc in ${title} must stop creation`);
  }
  inputResponses.push('Review the launch path.', 'Only the launch path.', '', '', '', '', '');
  selectResponses.push(
    'Customize',
    'Custom · isolated startup',
    'Use parent directory · current',
    'Use parent model',
    'Use parent thinking',
    'Do not allow',
  );
  confirmResponses.push(true);
  component.handleInput('n');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(operatorExecutions.pop(), [
    'luminaries_spawn',
    { assignment: 'Review the launch path.', ownershipBoundary: 'Only the launch path.', context: 'custom' },
  ]);
  const configurableExpert = projection.agents.find((candidate) => candidate.agentId === 'child');
  assert.ok(configurableExpert);
  configurableExpert.humanState = 'idle';
  configurableExpert.state = 'idle';
  configurableExpert.active = false;
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  for (const [action, status, error] of [
    ['Change model', 'indeterminate', 'Pi changed model but did not confirm thinking.'],
    ['Change thinking', 'refused', 'Pi refused the requested thinking level.'],
  ]) {
    operatorResult = { details: { status, error } };
    selectResponses.push(action, action === 'Change model' ? 'test/model' : 'high');
    component.handleInput('a');
    for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const rendered = component.render(120).join('\n');
    assert.match(rendered, /refused|could not be confirmed/u);
    assert.ok(rendered.includes(error));
    assert.doesNotMatch(rendered, /now uses/u);
    operatorExecutions.pop();
  }
  operatorResult = { details: { status: 'applied', effectiveConfiguration: { model: 'test/model', thinking: 'off' } } };
  selectResponses.push('Change model', 'test/model');
  component.handleInput('a');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.match(component.render(120).join('\n'), /now uses test\/model · thinking off/u);
  operatorExecutions.pop();
  selectableExtensions = [{ specifier: 'npm:pi-web-access', source: 'global' }];
  operatorResult = { details: { status: 'pending' } };
  selectResponses.push('Extensions', '  npm:pi-web-access · global', 'Apply selection');
  component.handleInput('a');
  for (let index = 0; index < 5; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(operatorExecutions.pop(), [
    'luminaries_control',
    { action: 'set_extensions', agentId: 'child', extensions: ['npm:pi-web-access'] },
  ]);
  assert.match(component.render(120).join('\n'), /finish its current turn and park/u);
  configurableExpert.humanState = 'working';
  configurableExpert.state = 'running';
  configurableExpert.active = true;
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const executionsBeforeBusyChange = operatorExecutions.length;
  selectResponses.push('Change model');
  component.handleInput('a');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(operatorExecutions.length, executionsBeforeBusyChange);
  assert.match(component.render(120).join('\n'), /is working.*Ready or Parked/su);
  configurableExpert.humanState = 'idle';
  configurableExpert.state = 'idle';
  configurableExpert.active = false;
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  component.handleInput('\x1b');
  const priorProjection = projection;
  projection = projectionWith([...projection.agents, agent('second', 'root', 1, 'Sirius', 'idle')]);
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  operatorResult = {
    details: {
      legs: [
        { recipient: { humanHandle: 'Altair · abc123' }, status: 'accepted' },
        { recipient: { humanHandle: 'Sirius · def456' }, status: 'refused', outcomeCode: 'recipient_closed' },
      ],
    },
  };
  inputResponses.push('Review this.');
  selectResponses.push('Send now · wake or guide the current turn');
  component.handleInput('b');
  component.handleInput('a');
  component.handleInput('\r');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const multicastReceipt = component.render(120).join('\n');
  assert.match(multicastReceipt, /1 accepted · 1 refused/u);
  assert.match(multicastReceipt, /Sirius · def456 · refused · recipient closed/u);
  assert.equal(operatorExecutions.pop()[1].action, 'multicast');
  projection = priorProjection;
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  operatorResult = { details: {} };
  closedHistory = { revision: 2, agents: [archived], archivedCount: 1 };
  projection = { ...projection, revision: 2, historyRevision: 2 };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.doesNotMatch(component.render(80).join('\n'), /Retired/);
  assert.equal(closedHistoryCalls, 2);
  closedHistory = { revision: 3, agents: [archived], archivedCount: 1 };
  closedHistoryFailures = 1;
  projection = { ...projection, revision: 3, historyRevision: 3 };
  listener?.(projection);
  for (let index = 0; index < 5; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(closedHistoryCalls, 3);
  assert.deepEqual(notifications, [['closed history unavailable', 'warning']]);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
  assert.equal(closedHistoryCalls, 3, 'a rejected history read does not start a recurring retry');
  closedHistoryFailures = 0;
  projection = { ...projection, revision: 4 };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(closedHistoryCalls, 4, 'a later projection change retries through the ordinary refresh path');
  component.handleInput('\r');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(selectedAgentId, 'child');
  assert.match(component.render(80).join('\n'), /Hydrated from the private Pi session/);
  const editor = component.editor;
  editor.setText('client-local draft');
  conversationListener?.({
    type: 'splice',
    epoch: 'test',
    agentId: 'child',
    incarnation: 1,
    revision: 2,
    baseRevision: 1,
    start: 1,
    deleteCount: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Live selected update.' }] }],
  });
  assert.equal(component.editor, editor);
  assert.equal(editor.getText(), 'client-local draft');
  assert.match(component.render(80).join('\n'), /Live selected update/);
  const searchableWorker = agent('worker', 'root', 1, 'Mira', 'working');
  searchableWorker.expertise = ['session handoff'];
  searchableWorker.artifacts = ['notes/handoff-proof.md'];
  projection = projectionWith([
    agent('root', null, 0, 'Root', 'idle'),
    agent('child', 'root', 1, 'Altair', 'idle'),
    searchableWorker,
  ]);
  projection = { ...projection, historyRevision: 3 };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const settledConversationRenders = workspaceRenders;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 380));
  assert.equal(
    workspaceRenders,
    settledConversationRenders,
    'unrelated collaborator motion must not repaint a settled direct conversation',
  );
  component.handleInput('\x1b');
  component.handleInput('\x1b[B');
  component.handleInput('\r');
  assert.equal(component.editor.getText(), '', 'a draft must not cross into another collaborator conversation');
  component.handleInput('\x1b');
  component.handleInput('/');
  for (const character of 'handoff-proof') component.handleInput(character);
  assert.match(component.render(80).join('\n'), /Mira/u);
  component.handleInput('\x1b');
  component.handleInput('\x1b[A');
  selectResponses.push('Message');
  inputResponses.push('Please follow up directly.');
  component.handleInput('a');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(customCalls, 1, 'action dialogs reuse the command-center TUI');
  assert.ok(dialogOverlayCalls >= 2, 'action dialogs use Pi overlay components');
  assert.equal(workspaceVisibleDuringDialog, true);
  assert.equal(overlayHandle.isHidden(), false);
  assert.equal(overlayHandle.isFocused(), true);
  assert.ok(overlayFocuses >= 1);
  assert.equal(selectOptions.at(-1)?.[0], 'Message');
  assert.deepEqual(operatorInputs.at(-1), ['child', 'Please follow up directly.', 'auto']);
  assert.match(component.render(80).join('\n'), /Altair/);
  const attendedChild = projection.agents.find((candidate) => candidate.agentId === 'child');
  assert.ok(attendedChild);
  attendedChild.attention = true;
  attendedChild.active = true;
  attendedChild.health = {
    level: 'critical',
    attention: 'critical',
    summary: 'Configuration outcome is uncertain',
    reasons: ['runtime_attention'],
    observations: [{ code: 'runtime_attention', level: 'critical', message: 'Configuration outcome is uncertain' }],
  };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  component.handleInput('a');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(selectTitles.at(-1), `${attendedChild.handle} · Configuration outcome is uncertain`);
  assert.equal(selectOptions.at(-1)?.includes('Continue with a message'), false);
  assert.equal(selectOptions.at(-1)?.includes('Edit expert card'), true);
  attendedChild.canContinueWithMessage = true;
  attendedChild.health = {
    level: 'critical',
    attention: 'critical',
    summary: 'Delivery outcome is uncertain',
    reasons: ['indeterminate_effect'],
    observations: [{ code: 'indeterminate_effect', level: 'critical', message: 'Delivery outcome is uncertain' }],
  };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  component.handleInput('a');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(selectOptions.at(-1)?.[0], 'Continue with a message');
  attendedChild.attention = false;
  attendedChild.active = false;
  attendedChild.canContinueWithMessage = false;
  attendedChild.health = {
    level: 'ok',
    attention: 'none',
    summary: 'No health issues',
    reasons: [],
    observations: [],
  };
  const rendersBeforeWheel = workspaceRenders;
  assert.deepEqual(mouseInput('\x1b[<65;10;10M'), { consume: true });
  assert.ok(workspaceRenders > rendersBeforeWheel);
  component.handleInput('\r');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  component.handleInput('\x1b');
  component.handleInput('\x1b[A');
  component.handleInput('\x1b[A');
  assert.match(component.render(80).join('\n'), /Enter Pi/);
  selectResponses.push('Cancel');
  component.handleInput('a');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(selectOptions.at(-1)?.includes('Bring in a Pi session'), true);
  assert.equal(selectOptions.at(-1)?.includes('Set nesting depth'), true);
  selectResponses.push('Root settings', 'Extension availability · 0 rules', 'npm:pi-web-access · user');
  confirmResponses.push(true);
  component.handleInput('a');
  for (let index = 0; index < 6; index++) await new Promise((done) => setImmediate(done));
  assert.deepEqual(extensionApprovals, [['npm:pi-web-access', 'user', false]]);
  assert.match(component.render(100).join('\n'), /available for expert selection.*No expert was restarted/su);
  component.handleInput('\x1b');
  availableSessions = Array.from({ length: 30 }, (_, index) => ({
    sessionFile: join(process.cwd(), 'sessions', `session-${String(index).padStart(2, '0')}.jsonl`),
    sessionId: `session-${String(index).padStart(2, '0')}`,
    cwd: process.cwd(),
    name: `Session ${index}`,
    modifiedAtMs: index,
    messageCount: 1,
    firstMessage: '',
  }));
  selectResponses.push('Bring in a Pi session');
  component.handleInput('a');
  for (let index = 0; index < 3; index++) await new Promise((done) => setImmediate(done));
  assert.ok(activeDialog);
  workspaceTui.terminal.rows = 12;
  activeDialog.render(60);
  for (let index = 0; index < 8; index++) activeDialog.handleInput('\x1b[B');
  assert.match(activeDialog.render(60).join('\n'), /Session 8/u);
  const wheel = '\x1b[<65;10;10M';
  assert.equal(mouseInput(wheel), undefined);
  activeDialog.handleInput(wheel);
  workspaceTui.terminal.rows = 8;
  const resizedList = activeDialog.render(30);
  assert.ok(resizedList.length <= Math.floor(workspaceTui.terminal.rows * 0.8));
  assert.match(resizedList.join('\n'), /Session 9/u);
  inputResponses.push('');
  activeDialog.handleInput('\r');
  for (let index = 0; index < 3; index++) await new Promise((done) => setImmediate(done));
  assert.equal(sessionPreviews.at(-1), availableSessions[9].sessionFile);
  assert.deepEqual(adoptionCalls, [[availableSessions[9].sessionFile, {}]]);
  component.handleInput('\x1b');

  availableSessions = availableSessions.map((session) => ({ ...session, cwd: join(process.cwd(), 'other-project') }));
  workspaceTui.terminal.rows = 20;
  selectResponses.push('Bring in a Pi session');
  component.handleInput('a');
  for (let index = 0; index < 3; index++) await new Promise((done) => setImmediate(done));
  activeDialog.handleInput('\r');
  for (let index = 0; index < 3; index++) await new Promise((done) => setImmediate(done));
  activeDialog.render(80);
  for (let index = 0; index < 25; index++) activeDialog.handleInput(wheel);
  assert.match(activeDialog.render(80).join('\n'), /Session 25/u);
  inputResponses.push('');
  activeDialog.handleInput('\r');
  for (let index = 0; index < 3; index++) await new Promise((done) => setImmediate(done));
  assert.deepEqual(adoptionCalls.at(-1), [availableSessions[25].sessionFile, {}]);
  component.handleInput('\x1b');
  availableSessions = [];
  workspaceTui.terminal.rows = 30;
  const namePromptsBeforeInvalidSession = inputTitles.filter((title) => title === 'Luminary name').length;
  selectResponses.push('Bring in a Pi session');
  inputResponses.push('not-a-session');
  component.handleInput('a');
  for (let index = 0; index < 3; index++) await new Promise((done) => setImmediate(done));
  assert.ok(activeDialog);
  activeDialog.handleInput('\r');
  for (let index = 0; index < 5; index++) await new Promise((done) => setImmediate(done));
  assert.deepEqual(sessionPreviews.slice(-1), ['not-a-session']);
  assert.equal(inputTitles.filter((title) => title === 'Luminary name').length, namePromptsBeforeInvalidSession);
  assert.equal(adoptionCalls.length, 2);
  selectResponses.push('Root settings', 'Change nesting depth · 3');
  inputResponses.push('4');
  component.handleInput('a');
  for (let index = 0; index < 4; index++) await new Promise((done) => setImmediate(done));
  assert.deepEqual(depthUpdates, [4]);
  assert.match(component.render(100).join('\n'), /Nesting depth is now 4/u);
  projection = { ...projection, capacity: { used: 2, limit: 2, available: 0 } };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  component.handleInput('v');
  assert.match(component.render(80).join('\n'), /Current \[Archived\].*Archived · chived/su);
  selectResponses.push('Increase capacity to 3 and resume');
  confirmResponses.push(true);
  component.handleInput('a');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(
    selectOptions.findLast((options) => options.includes('Unarchive subtree')),
    ['Unarchive subtree', 'Continue in standalone Pi', 'Increase capacity to 3 and resume', 'Cancel'],
  );
  assert.deepEqual(capacityUpdates, [3]);
  assert.deepEqual(resumedAgents, [archived.agentId]);
  assert.match(component.render(80).join('\n'), /Capacity increased to 3, but Archived · chived was not resumed/u);
  projection = { ...projection, capacity: { used: 2, limit: 3, available: 1 } };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  selectResponses.push('Resume collaborator');
  component.handleInput('a');
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(
    selectOptions.findLast((options) => options.includes('Unarchive subtree')),
    ['Unarchive subtree', 'Continue in standalone Pi', 'Resume collaborator', 'Cancel'],
  );
  assert.deepEqual(capacityUpdates, [3]);
  assert.deepEqual(resumedAgents, [archived.agentId, archived.agentId]);
  component.handleInput('\r');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(selectedAgentId, archived.agentId);
  assert.match(component.render(80).join('\n'), /Archived/);
  let releaseClosedHistory = () => undefined;
  closedHistoryDelay = new Promise((resolvePromise) => {
    releaseClosedHistory = resolvePromise;
  });
  closedHistory = { revision: 4, agents: [], archivedCount: 0 };
  projection = { ...projection, revision: 4, historyRevision: 4 };
  listener?.(projection);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.match(component.render(80).join('\n'), /Hydrated from the private Pi session/);
  closedHistoryDelay = undefined;
  releaseClosedHistory();
  for (let index = 0; index < 4; index++) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.doesNotMatch(component.render(80).join('\n'), /Hydrated from the private Pi session/);
  assert.match(component.render(80).join('\n'), /No archived collaborators/u);
  component.handleInput('v');
  assert.doesNotMatch(component.render(80).join('\n'), /Archived · chived/u);
  inputDispatch = true;
  component.handleInput('\r');
  inputDispatch = false;
  assert.equal(closePhase, 'input', 'the host custom UI owns its synchronous close lifecycle');
  await opened;
  assert.equal(closePhase, 'input');
  assert.match(terminalWrites.at(-1), /1006l.*1000l/u);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(typeof widget, 'function');

  tuiMode = 'fullscreen';
  terminalWrites.length = 0;
  const reopened = controller.open(context);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(mouseInput('\x1b[<64;10;10M'), { consume: true });
  holdDialog = true;
  component.handleInput('a');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  controller.dispose();
  await reopened;
  assert.equal(dialogCancelled, true);
  assert.equal(overlayHandle.isHidden(), true);
  assert.equal(mouseInput, undefined);
  assert.equal(terminalWrites.length, 0, 'the fullscreen host retains terminal mouse ownership');
  assert.equal(widget, undefined);
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

test('closed conversations page without routing keys through the hidden editor', () => {
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

test('waiting collaborators use new-turn input and refuse misleading interrupt actions', () => {
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
  component.handleInput('\r');
  component.handleInput('\x03');
  assert.match(component.render(72).join('\n'), /no active turn to interrupt/);
  assert.deepEqual(calls, []);
});

test('foreground workspace pages history while preserving the native editor in regular and fullscreen TUI', async () => {
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
    assert.deepEqual(component.editor.inputs.slice(-2), ['\x1b[5;5~', '\x1b[6;5~']);
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
