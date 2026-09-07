import { resolve } from 'node:path';
import { LuminariesManager } from '../../src/luminaries-manager.ts';
import { createPiSessionHost } from '../../src/pi-session-host.ts';
import { sha256 } from '../../src/scheduler-state.ts';
import { events as mailboxEvents } from '../helpers/mailbox.mjs';

const options = JSON.parse(process.env.LUMINARIES_MANAGER_CRASH_OPTIONS ?? '{}');
const manager = new LuminariesManager({
  sessionId: options.sessionId,
  sessionFile: options.sessionFile,
  cwd: options.cwd,
  agentDir: options.agentDir,
  invocation: { command: process.execPath, args: [resolve('test/fixtures/fake-actor-rpc.mjs')] },
  env: { FAKE_ACTOR_DELAY_MS: '1000' },
  sessionHost: createPiSessionHost(),
});
await manager.start();
const spawned = await manager.operatorExecute('luminaries_spawn', {
  name: 'Crash witness',
  assignment: 'Preserve the exact private session across a manager crash.',
  ownershipBoundary: 'Crash recovery only.',
});
const agentId = spawned.details.agent.agentId;
const operationId = '55555555-5555-4555-8555-555555555555';
const bridgeRequestId = `luminaries-ui-${sha256(operationId).slice(0, 40)}`;
await manager.operatorInput(agentId, 'UNCERTAIN_INPUT_MUST_NOT_REPLAY', 'auto', operationId);
const event = await new Promise((resolveEvent, rejectEvent) => {
  let stop = () => undefined;
  const timer = setTimeout(() => {
    stop();
    rejectEvent(new Error('Crash fixture input did not reach its exact model boundary'));
  }, 10_000);
  const inspect = () => {
    const current = mailboxEvents(manager.store.snapshot()).find(
      (candidate) => candidate.recipientId === agentId && candidate.bridgeRequestId === bridgeRequestId,
    );
    if (!current?.activationId || current.consumedSeq === undefined) return;
    clearTimeout(timer);
    stop();
    resolveEvent(current);
  };
  stop = manager.store.onChange(inspect);
  inspect();
});
const actor = manager.actors.get(agentId);
if (!actor?.process.pid) throw new Error('Crash fixture actor did not start');
process.stdout.write(
  `${JSON.stringify({
    ready: true,
    agentId,
    actorPid: actor.process.pid,
    eventId: event.eventId,
    activationId: event.activationId,
  })}\n`,
);
await new Promise(() => undefined);
