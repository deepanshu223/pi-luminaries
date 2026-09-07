import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCommandCenter } from '../../src/command-center-projection.ts';
import { agentDepth, agentPath, agentRuntimeState, openCollaboratorCount } from '../../src/scheduler-state.ts';
import { SchedulerStateError, SchedulerStore, validateSchedulerState } from '../../src/scheduler-store.ts';

const operator = { kind: 'operator' };
const agent = (agentId) => ({ kind: 'agent', agentId });

test('changing nesting depth extends the retained team and preserves explicit spawn restrictions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-depth-change-'));
  let store = await SchedulerStore.open({
    statePath: join(root, 'state.json'),
    bootstrap: { rootId: 'root', cwd: root, maxOpenAgents: 8, maxDepth: 2 },
  });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const admission = (agentId, parentId, grants) => ({
    agentId,
    parentId,
    segment: agentId,
    cwd: root,
    sessionId: `${agentId}-session`,
    sessionDir: join(root, 'private', agentId),
    displayName: agentId,
    assignment: 'Review the existing implementation.',
    ownershipBoundary: 'Own this focused review.',
    ...(grants ? { grants } : {}),
  });
  await store.admitAgent(admission('Vega', 'root'), operator);
  await store.admitAgent(admission('Orion', 'Vega'), agent('Vega'));
  await store.admitAgent(admission('Disabled', 'root', { spawn: false }), operator);
  await store.admitAgent(admission('Narrowed', 'root', { spawn: true, maxDepth: 2 }), operator);
  const leaf = admission('Mira', 'Orion');
  await assert.rejects(store.admitAgent(leaf, agent('Orion')), /depth|spawn/u);
  await store.setRootDepth(3);
  assert.equal(store.snapshot().root.rootId, 'root');
  assert.equal(store.snapshot().root.maxDepthSource, 'operator-live');
  assert.equal(store.snapshot().agents.Vega.capabilities.maxDepth, 3);
  assert.equal(store.snapshot().agents.Orion.capabilities.spawn, true);
  assert.equal(store.snapshot().agents.Orion.sessionId, 'Orion-session');
  assert.equal(store.snapshot().agents.Disabled.capabilities.spawn, false);
  assert.equal(store.snapshot().agents.Narrowed.capabilities.maxDepth, 2);
  await store.admitAgent(leaf, agent('Orion'));
  assert.equal(agentDepth(store.snapshot(), 'Mira'), 3);
  await store.closeAgent('Vega', operator, { subtree: true });
  const revision = store.snapshot().revision;
  await assert.rejects(store.setRootDepth(2), /Retained descendants reach level 3/u);
  assert.equal(store.snapshot().revision, revision);
  await store.close();
  store = await SchedulerStore.open({ statePath: join(root, 'state.json') });
  assert.equal(store.snapshot().root.maxDepth, 3);
  assert.equal(store.snapshot().root.maxDepthSource, 'operator-live');
  await store.setRootDepth(4);
  assert.equal(
    (await store.closedAgentLineage('Orion')).find((item) => item.agentId === 'Orion').capabilities.maxDepth,
    4,
  );
  assert.equal(store.snapshot().agents.Narrowed.capabilities.maxDepth, 2);
  await store.setAgentCapabilities('Narrowed', { spawn: true }, operator);
  assert.equal(store.snapshot().agents.Narrowed.capabilities.maxDepth, 4);
  await store.setRootDepth(5);
  assert.equal(store.snapshot().agents.Narrowed.capabilities.maxDepth, 5);
  assert.equal(store.snapshot().agents.Disabled.capabilities.spawn, false);
  validateSchedulerState(store.snapshot());
});

test('root reconciliation narrows retired cwd grants for closed nested work before resume', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-retired-cwd-'));
  const retiredCwdRoot = join(root, '.pi', 'agent', 'luminaries', 'scratch');
  const retainedCwd = join(retiredCwdRoot, 'retained-agent');
  const nestedCwd = join(retiredCwdRoot, 'nested-agent');
  await mkdir(retainedCwd, { recursive: true });
  await mkdir(nestedCwd, { recursive: true });
  let store = await SchedulerStore.open({
    statePath: join(root, 'luminaries', 'state.json'),
    bootstrap: {
      rootId: 'root',
      cwd: root,
      maxOpenAgents: 2,
      maxDepth: 2,
      capabilities: {
        version: 1,
        spawn: true,
        peerInterrupt: false,
        maxDepth: 2,
        cwdRoots: [root, retiredCwdRoot],
      },
    },
  });
  context.after(async () => {
    await store.close().catch(() => false);
    await rm(root, { recursive: true, force: true });
  });
  await store.admitAgent(
    {
      agentId: 'retained',
      parentId: 'root',
      segment: 'retained',
      cwd: retainedCwd,
      sessionId: 'retained-session',
      sessionDir: join(root, '.luminaries-private', 'retained'),
      displayName: 'Retained',
      assignment: 'Keep retained work available',
      ownershipBoundary: 'Own retained work',
      grants: { spawn: true, maxDepth: 2, cwdRoots: [retiredCwdRoot] },
    },
    operator,
  );
  await store.admitAgent(
    {
      agentId: 'nested',
      parentId: 'retained',
      segment: 'nested',
      cwd: nestedCwd,
      sessionId: 'nested-session',
      sessionDir: join(root, '.luminaries-private', 'nested'),
      displayName: 'Nested',
      assignment: 'Keep nested work available',
      ownershipBoundary: 'Own nested work',
      grants: { spawn: false, cwdRoots: [retiredCwdRoot] },
    },
    { kind: 'agent', agentId: 'retained' },
  );
  await store.closeAgent('retained', operator, { subtree: true });
  await store.close();
  store = await SchedulerStore.open({ statePath: join(root, 'luminaries', 'state.json') });

  const snapshot = store.snapshot();
  await store.reconcileRootPolicy({
    capabilities: {
      ...snapshot.agents.root.capabilities,
      cwdRoots: [root, retainedCwd, nestedCwd],
    },
    retiredCwdRoot,
    cwd: root,
    maxOpenAgents: snapshot.root.maxOpenAgents,
    maxOpenAgentsSource: snapshot.root.maxOpenAgentsSource,
    maxDepth: snapshot.root.maxDepth,
    agentExtensions: snapshot.root.agentExtensions,
    serviceGrant: snapshot.root.serviceGrant,
  });

  const reconciled = store.snapshot();
  assert.deepEqual(reconciled.agents.root.capabilities.cwdRoots, [root, nestedCwd, retainedCwd]);
  const closed = await store.closedAgentLineage('nested');
  assert.deepEqual(closed.find((candidate) => candidate.agentId === 'retained').capabilities.cwdRoots, [
    nestedCwd,
    retainedCwd,
  ]);
  assert.deepEqual(closed.find((candidate) => candidate.agentId === 'nested').capabilities.cwdRoots, [nestedCwd]);
  await store.resumeAgent('retained', operator);
  await store.resumeAgent('nested', operator);
  assert.deepEqual(store.snapshot().agents.retained.capabilities.cwdRoots, [nestedCwd, retainedCwd]);
  assert.deepEqual(store.snapshot().agents.nested.capabilities.cwdRoots, [nestedCwd]);
});

// One production-module scenario deliberately covers the complete rooted-directory lifecycle.
test('depth-3 ownership, directory privacy, authority, capacity, close-subtree, and resume stay one atomic truth', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'luminaries-tree-'));
  let store = await SchedulerStore.open({
    statePath: join(root, 'luminaries', 'state.json'),
    bootstrap: { rootId: 'root', cwd: root, maxOpenAgents: 5, maxDepth: 3 },
  });
  context.after(() => store.close().catch(() => false));
  const spawn = (agentId, parentId, segment, requestedBy, expertCard = {}, configuration = {}) =>
    store.admitAgent(
      {
        agentId,
        parentId,
        segment,
        cwd: root,
        sessionId: `${agentId}-session`,
        sessionDir: join(root, '.luminaries-private', agentId),
        displayName: agentId,
        assignment: `Investigate ${agentId}`,
        ownershipBoundary: `Own ${agentId} findings`,
        expertCard,
        ...configuration,
      },
      requestedBy,
    );

  await spawn('A', 'root', 'A', operator, { role: 'branch lead' });
  const aliasedSessionDir = join(root, '.luminaries-private-alias');
  await symlink(
    store.snapshot().agents.A.sessionDir,
    aliasedSessionDir,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    store.admitAgent(
      {
        agentId: 'session-alias',
        parentId: 'root',
        segment: 'session-alias',
        cwd: root,
        sessionId: 'alias-session',
        sessionDir: aliasedSessionDir,
        displayName: 'session-alias',
        assignment: 'invalid alias',
        ownershipBoundary: 'invalid alias',
      },
      operator,
    ),
    (error) => error instanceof SchedulerStateError && error.code === 'session_conflict',
  );
  await assert.rejects(
    spawn('A-alt', 'root', 'A', operator),
    (error) => error instanceof SchedulerStateError && error.code === 'path_exists',
  );
  await assert.rejects(
    spawn('orphan', 'missing', 'orphan', operator),
    (error) => error instanceof SchedulerStateError && error.code === 'parent_unavailable',
  );
  await assert.rejects(
    store.admitAgent(
      {
        agentId: 'forged',
        parentId: 'root',
        segment: 'forged',
        cwd: root,
        sessionId: 'forged-session',
        sessionDir: join(root, 'forged'),
        displayName: 'forged',
        assignment: 'forged',
        ownershipBoundary: 'forged',
        depth: 99,
      },
      operator,
    ),
    /unknown field 'depth'/,
  );
  await assert.rejects(spawn('invalid', 'root', '../bad', operator), /invalid/);

  await spawn('A1', 'A', 'A1', agent('A'), { expertise: ['protocol review'] });
  await spawn(
    'A1a',
    'A1',
    'A1a',
    agent('A1'),
    {
      role: 'specialist',
      focus: 'cross-branch proof',
      expertise: ['causal routing'],
    },
    { provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'high' },
  );
  await assert.rejects(
    spawn('too-deep', 'A1a', 'deep', agent('A1a')),
    (error) => error instanceof SchedulerStateError && error.code === 'depth_exhausted',
  );
  await spawn('B', 'root', 'B', operator, { role: 'branch lead' });
  const aSessionFile = join(store.snapshot().agents.A.sessionDir, 'shared.jsonl');
  const bSessionAlias = join(store.snapshot().agents.B.sessionDir, 'shared.jsonl');
  await writeFile(aSessionFile, 'private session');
  await store.bindSession('A', aSessionFile);
  await link(aSessionFile, bSessionAlias);
  await assert.rejects(store.bindSession('B', bSessionAlias), (error) => error.code === 'session_conflict');
  await rm(bSessionAlias);

  const competing = await Promise.allSettled([
    spawn('B1', 'B', 'B1', agent('B'), { expertise: ['integration'] }),
    spawn('B2', 'B', 'B2', agent('B')),
  ]);
  assert.equal(competing[0].status, 'fulfilled');
  assert.equal(competing[1].status, 'rejected');
  assert.equal(competing[1].reason.code, 'capacity_exhausted');
  assert.equal(openCollaboratorCount(store.snapshot()), 5);
  await assert.rejects(
    spawn('peer-child', 'A1a', 'peer', agent('B1')),
    (error) => error instanceof SchedulerStateError && error.code === 'authority_denied',
  );

  for (const agentId of ['A1a', 'B']) {
    const sessionFile = join(store.snapshot().agents[agentId].sessionDir, `${agentId}.jsonl`);
    await writeFile(sessionFile, '');
    await store.bindSession(agentId, sessionFile);
  }
  const sourceRuntime = await store.claimRuntime('A1a', process.pid, 'test-host');
  await store.markRuntimeSpawned('A1a', sourceRuntime.value.runtimeOwner, process.pid);
  await store.markRuntimeReady('A1a', sourceRuntime.value.runtimeOwner, process.pid);
  const recipientRuntime = await store.claimRuntime('B', process.pid, 'test-host');
  await store.markRuntimeSpawned('B', recipientRuntime.value.runtimeOwner, process.pid);
  await store.markRuntimeReady('B', recipientRuntime.value.runtimeOwner, process.pid);
  const sourceActivation = await store.startActivation('A1a', 'test_source');
  const causal = await store.admitPeerEvent(
    { agentId: 'A1a', rootId: 'root', runtimeOwner: sourceRuntime.value.runtimeOwner },
    { bridgeRequestId: 'cold-close-causal-source', recipientId: 'B', message: 'Causal source.' },
  );
  const recipientActivation = await store.applyMailboxIntent({
    kind: 'begin_delivery',
    recordId: causal.value.event.eventId,
    runtimeOwner: recipientRuntime.value.runtimeOwner,
  });
  assert.ok(recipientActivation.value);
  await store.applyMailboxIntent({
    kind: 'admit_boundary',
    recordId: causal.value.event.eventId,
    attemptId: recipientActivation.value.attemptId,
  });
  const derived = await store.admitPeerEvent(
    { agentId: 'B', rootId: 'root', runtimeOwner: recipientRuntime.value.runtimeOwner },
    {
      bridgeRequestId: 'cold-close-causal-dependent',
      recipientId: 'B1',
      message: 'Current work retaining a cold cause.',
      causationId: causal.value.event.eventId,
    },
  );
  await store.finishActivation(sourceActivation.value.activationId, sourceActivation.value.leaseToken, 'settled');
  await store.releaseRuntime('A1a', sourceRuntime.value.runtimeOwner, 'runtime_parked', 'test_complete');
  await store.applyMailboxIntent({
    kind: 'release_delivery',
    recordId: causal.value.event.eventId,
    attemptId: recipientActivation.value.attemptId,
  });
  await store.releaseRuntime('B', recipientRuntime.value.runtimeOwner, 'runtime_parked', 'test_complete');

  const beforeMetadataPath = agentPath(store.snapshot(), 'A1a');
  await store.updateAgentMetadata(
    'A1a',
    {
      focus: 'peer-safe causal boundary',
      expertise: ['causal routing', 'idempotency'],
      publishedRefs: [join(root, 'artifacts', 'a1a.md')],
    },
    agent('A1a'),
  );
  await assert.rejects(
    store.updateAgentMetadata('A1a', { assignment: 'self rewrite' }, agent('A1a')),
    (error) => error.code === 'authority_denied',
  );
  await assert.rejects(
    store.updateAgentMetadata('A1a', { focus: 'peer rewrite' }, agent('B1')),
    (error) => error.code === 'authority_denied',
  );
  await assert.rejects(
    store.updateAgentMetadata(
      'A1a',
      { publishedRefs: [join(root, '.luminaries-private', 'A1a', 'session.jsonl')] },
      agent('A1a'),
    ),
    (error) => error.code === 'private_reference',
  );
  await assert.rejects(
    store.updateAgentMetadata('A1a', { publishedRefs: ['.luminaries-private/A1a/session.jsonl'] }, agent('A1a')),
    (error) => error.code === 'private_reference',
  );
  await assert.rejects(
    store.updateAgentMetadata('A1a', { publishedRefs: [join(aliasedSessionDir, 'session.jsonl')] }, agent('A1a')),
    (error) => error.code === 'private_reference',
  );
  await store.updateAgentMetadata(
    'A1a',
    { assignment: 'Validate cross-branch routing', focus: 'owner-corrected focus' },
    agent('A'),
  );
  assert.equal(agentPath(store.snapshot(), 'A1a'), beforeMetadataPath);
  assert.equal(store.snapshot().agents.A1a.assignment.source, 'owner');
  assert.equal(store.snapshot().agents.A1a.expertCard.focus.source, 'owner');

  await store.setAgentCapabilities('A1a', { models: [], thinking: [] }, operator);
  await store.close();
  store = await SchedulerStore.open({ statePath: join(root, 'luminaries', 'state.json') });
  const reopenedPolicy = store.snapshot();
  await store.reconcileRootPolicy({
    capabilities: reopenedPolicy.agents.root.capabilities,
    cwd: reopenedPolicy.agents.root.cwd,
    maxOpenAgents: reopenedPolicy.root.maxOpenAgents,
    maxOpenAgentsSource: reopenedPolicy.root.maxOpenAgentsSource,
    maxDepth: reopenedPolicy.root.maxDepth,
    agentNames: reopenedPolicy.root.agentNames,
    agentExtensions: reopenedPolicy.root.agentExtensions,
    serviceGrant: reopenedPolicy.root.serviceGrant,
    provider: reopenedPolicy.agents.root.provider,
    model: reopenedPolicy.agents.root.model,
    thinking: reopenedPolicy.agents.root.thinking,
  });
  const reconciledLeaf = projectCommandCenter(store.snapshot()).agents.find((agent) => agent.agentId === 'A1a');
  assert.equal(reconciledLeaf.health.reasons.includes('model_outside_capability'), false);
  assert.equal(reconciledLeaf.health.reasons.includes('thinking_outside_capability'), false);
  await assert.rejects(
    store.applyOfflineConfiguration(
      {
        changeId: 'forbidden-leaf-model',
        targetId: 'A1a',
        kind: 'model',
        provider: 'openai-codex',
        value: 'gpt-5.6-sol',
      },
      operator,
    ),
    (error) => error.code === 'capability_denied',
  );
  const retainedDescendantCapabilities = structuredClone({
    A1: store.snapshot().agents.A1.capabilities,
    A1a: store.snapshot().agents.A1a.capabilities,
  });
  await store.setAgentCapabilities('A', { spawn: false }, operator);
  assert.deepEqual(
    [store.snapshot().agents.A.capabilities.spawn, store.snapshot().agents.A.capabilities.maxDepth],
    [false, 1],
  );
  assert.deepEqual(store.snapshot().agents.A1.capabilities, retainedDescendantCapabilities.A1);
  assert.deepEqual(store.snapshot().agents.A1a.capabilities, retainedDescendantCapabilities.A1a);
  validateSchedulerState(store.snapshot(), { statePath: store.statePath });
  await store.setAgentCapabilities('A', { spawn: true }, operator);
  assert.deepEqual(
    [store.snapshot().agents.A.capabilities.spawn, store.snapshot().agents.A.capabilities.maxDepth],
    [true, 3],
  );
  assert.deepEqual(store.snapshot().agents.A1.capabilities, retainedDescendantCapabilities.A1);
  assert.deepEqual(store.snapshot().agents.A1a.capabilities, retainedDescendantCapabilities.A1a);

  const immutable = structuredClone(store.snapshot());
  immutable.agents.A1a.path = 'root/B/A1a';
  assert.throws(() => validateSchedulerState(immutable), /unknown field/);
  const leaked = structuredClone(store.snapshot());
  leaked.agents.A1a.expertCard.publishedRefs = {
    value: ['.luminaries-private/A1a/session.jsonl'],
    source: 'self',
    updatedAtMs: Date.now(),
  };
  assert.throws(
    () => validateSchedulerState(leaked, { statePath: store.statePath }),
    /private Pi Luminaries reference/,
  );

  await assert.rejects(store.closeAgent('A1a', agent('B1')), (error) => error.code === 'authority_denied');
  await assert.rejects(
    store.closeAgent('B', agent('A'), { subtree: true }),
    (error) => error.code === 'authority_denied',
  );
  const beforeRefusal = store.snapshot();
  await assert.rejects(
    store.closeAgent('A', agent('root')),
    (error) => error.code === 'descendants_open' && /A1, A1a/.test(error.message),
  );
  assert.equal(store.snapshot().revision, beforeRefusal.revision);
  assert.equal(openCollaboratorCount(store.snapshot()), 5);

  for (const ownerId of ['A', 'A1', 'A1a'])
    await store.registerWatch({ watchId: `watch-${ownerId}`, agentIds: [ownerId] }, agent(ownerId));
  await store.registerWatch({ watchId: 'watch-B', agentIds: ['B'] }, agent('B'));
  await store.registerWatch(
    { watchId: 'watch-root-closed-targets', agentIds: ['A', 'A1a'], eventKinds: ['message'] },
    agent('root'),
  );
  await store.registerWatch(
    { watchId: 'watch-root-open-alternative', agentIds: ['A1a', 'B'], eventKinds: ['message'] },
    agent('root'),
  );
  const closed = await store.closeAgent('A', agent('root'), { subtree: true });
  assert.deepEqual(closed.value, ['A', 'A1', 'A1a']);
  assert.equal(openCollaboratorCount(store.snapshot()), 2);
  assert.deepEqual(
    ['A', 'A1', 'A1a'].map((ownerId) => store.snapshot().watches[`watch-${ownerId}`]),
    [undefined, undefined, undefined],
  );
  assert.equal(store.snapshot().watches['watch-B'].status, 'active');
  assert.equal(store.snapshot().watches['watch-root-closed-targets'], undefined);
  assert.equal(store.snapshot().watches['watch-root-open-alternative'].status, 'active');
  assert.deepEqual(store.snapshot().watches['watch-root-open-alternative'].agentIds, ['B']);
  assert.equal(store.snapshot().mailbox[derived.value.event.eventId].status, 'accepted');
  assert.equal(store.snapshot().mailbox[causal.value.event.eventId].status, 'indeterminate');
  assert.equal(store.snapshot().agents.A1a.lifecycle, 'closed');
  validateSchedulerState(store.snapshot(), { statePath: store.statePath });
  await assert.rejects(store.resumeAgent('A1', agent('root')), (error) => error.code === 'parent_unavailable');
  await assert.rejects(store.setAgentArchived('A', true, agent('root')), (error) => error.code === 'authority_denied');
  await store.setAgentArchived('A', true, operator);
  let cold = store.closedCatalogSnapshot().agents;
  assert.deepEqual(
    ['A', 'A1', 'A1a'].map((agentId) => cold.find((agent) => agent.agentId === agentId)?.archive?.archived),
    [true, true, true],
  );
  let historyState = structuredClone(store.snapshot());
  for (const agent of cold) historyState.agents[agent.agentId] = agent;
  assert.equal(projectCommandCenter(historyState).archivedCount, 3);
  assert.equal(
    projectCommandCenter(historyState).directory.some((entry) => entry.agentId === 'A'),
    true,
  );
  await store.setAgentArchived('A1', false, operator);
  cold = store.closedCatalogSnapshot().agents;
  assert.deepEqual(
    ['A', 'A1', 'A1a'].map((agentId) => cold.find((agent) => agent.agentId === agentId)?.archive?.archived),
    [false, false, false],
  );
  await store.setAgentArchived('A', true, operator);
  await store.resumeArchivedAgent('A1a', operator);
  const resumed = store.snapshot();
  assert.equal(openCollaboratorCount(resumed), 5);
  assert.deepEqual(
    ['A', 'A1', 'A1a'].map((agentId) => resumed.agents[agentId].archive),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    ['A', 'A1', 'A1a'].map((id) => [resumed.agents[id].parentId, agentPath(resumed, id), agentDepth(resumed, id)]),
    [
      ['root', 'root/A', 1],
      ['A', 'root/A/A1', 2],
      ['A1', 'root/A/A1/A1a', 3],
    ],
  );
  await assert.rejects(
    store.closeAgent('root', operator, { subtree: true }),
    (error) => error.code === 'root_control_denied',
  );
  await assert.rejects(store.setAgentArchived('root', true, operator), (error) => error.code === 'root_control_denied');
  assert.equal(agentRuntimeState(store.snapshot(), store.snapshot().agents.B1), 'starting');
  assert.equal(openCollaboratorCount(store.snapshot()), 5);
  await assert.rejects(store.startActivation('B1', 'prompt'), (error) => error.code === 'runtime_unavailable');
  await store.closeAgent('A', operator, { subtree: true });
  await store.closeAgent('B', operator, { subtree: true });
  await store.resumeAgent('A', operator);
  await spawn('A2', 'A', 'A2', agent('A'));
  assert.equal(store.snapshot().agents.A2.parentId, 'A');
  await store.closeAgent('A', operator, { subtree: true });
  assert.equal(openCollaboratorCount(store.snapshot()), 0);
  assert.deepEqual(Object.keys(store.snapshot().agents), ['root']);
  await store.close();
  const reopened = await SchedulerStore.open({ statePath: join(root, 'luminaries', 'state.json') });
  assert.equal(openCollaboratorCount(reopened.snapshot()), 0);
  assert.deepEqual(Object.keys(reopened.snapshot().agents), ['root']);
  assert.equal(reopened.closedCatalogSnapshot().agents.length, 6);
  await reopened.close();
});
