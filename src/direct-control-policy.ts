import { randomUUID } from 'node:crypto';
import {
  TERMINAL_DIRECT_CONTROL_STATES,
  SchedulerStateError,
  beginMailboxAttemptState,
  consumeMailboxAtBoundaryState,
  directMailboxRecord,
  directMailboxRecords,
  exactKeys,
  id,
  isRecord,
  isStrictAncestor,
  nextSequence,
  normalizePrincipal,
  sha256,
  terminalizeMailboxRecordState,
  type DirectControlRecord,
  type SchedulerPrincipal,
  type SchedulerState,
} from './scheduler-state.ts';

export interface DirectControlInput {
  requestId: string;
  targetId: string;
  sourceActivationId: string;
  action: 'interrupt';
}

export interface DirectControlAdmission {
  control: DirectControlRecord;
  duplicate: boolean;
}

export interface DirectControlPolicyResult<T> {
  changed: boolean;
  value: T;
}

type NormalizedDirectControlInput = DirectControlInput;

export function normalizeDirectControlInput(value: DirectControlInput): NormalizedDirectControlInput {
  if (!isRecord(value)) throw new SchedulerStateError('input_invalid', 'Direct control input must be an object');
  exactKeys(value, ['requestId', 'targetId', 'sourceActivationId', 'action'], 'direct control input');
  if (value.action !== 'interrupt')
    throw new SchedulerStateError('input_invalid', `Direct control action '${String(value.action)}' is invalid`);
  return {
    requestId: id(value.requestId, 'direct control requestId'),
    targetId: id(value.targetId, 'direct control targetId'),
    sourceActivationId: id(value.sourceActivationId, 'direct control sourceActivationId'),
    action: 'interrupt',
  };
}

function assertAuthority(state: SchedulerState, targetId: string, principal: SchedulerPrincipal): void {
  if (principal.kind === 'operator') return;
  const caller = state.agents[principal.agentId];
  if (!caller || caller.lifecycle !== 'open')
    throw new SchedulerStateError('authority_denied', `Direct-control principal '${principal.agentId}' is not open`);
  const peerInterrupt =
    caller.capabilities.peerInterrupt &&
    caller.agentId !== targetId &&
    Object.values(state.activations).some(
      (activation) => activation.agentId === caller.agentId && activation.state === 'running',
    );
  if (!isStrictAncestor(state, caller.agentId, targetId) && !peerInterrupt)
    throw new SchedulerStateError('authority_denied', `Agent '${caller.agentId}' does not own '${targetId}'`);
}

function requestHash(input: NormalizedDirectControlInput, principal: SchedulerPrincipal): string {
  return sha256(
    JSON.stringify({
      issuer: principal,
      targetId: input.targetId,
      sourceActivationId: input.sourceActivationId,
      action: input.action,
    }),
  );
}

function requiredControl(state: SchedulerState, controlId: string): DirectControlRecord {
  const control = directMailboxRecord(state, controlId);
  if (!control) throw new SchedulerStateError('control_missing', `Direct control '${controlId}' does not exist`);
  return control;
}

export function hasDirectInputFence(state: SchedulerState, targetId: string, activationId?: string): boolean {
  return directMailboxRecords(state).some(
    (control) =>
      control.targetId === targetId &&
      (activationId === undefined || control.activationId === activationId) &&
      !TERMINAL_DIRECT_CONTROL_STATES.has(control.status),
  );
}

export function admitDirectControlState(
  state: SchedulerState,
  input: NormalizedDirectControlInput,
  requestedBy: SchedulerPrincipal,
  randomId: () => string,
): DirectControlPolicyResult<DirectControlAdmission> {
  const principal = normalizePrincipal(requestedBy);
  const hash = requestHash(input, principal);
  const duplicate = directMailboxRecords(state).find((control) => control.requestId === input.requestId);
  if (duplicate) {
    if (duplicate.requestHash !== hash)
      throw new SchedulerStateError('command_id_reuse', `Direct-control request '${input.requestId}' was reused`);
    return { changed: false, value: { control: duplicate, duplicate: true } };
  }
  const target = state.agents[input.targetId];
  if (!target || target.lifecycle !== 'open')
    throw new SchedulerStateError('agent_unavailable', `Direct-control target '${input.targetId}' is not open`);
  assertAuthority(state, target.agentId, principal);
  const activation = state.activations[input.sourceActivationId];
  if (!activation || activation.agentId !== target.agentId || activation.state !== 'running')
    throw new SchedulerStateError(
      'stale_activation',
      `Activation '${input.sourceActivationId}' is not live for '${target.agentId}'`,
    );
  if (target.pendingConfiguration)
    throw new SchedulerStateError('configuration_busy', `Agent '${target.agentId}' is changing configuration`);
  if (hasDirectInputFence(state, target.agentId))
    throw new SchedulerStateError('control_fenced', `Agent '${target.agentId}' has an interrupt in progress`);
  const controlId = id(randomId(), 'generated controlId');
  const acceptedSeq = nextSequence(state);
  const control: DirectControlRecord = {
    lane: 'direct',
    controlId,
    requestId: input.requestId,
    requestHash: hash,
    issuer: principal,
    targetId: target.agentId,
    activationId: activation.activationId,
    action: 'interrupt',
    status: 'accepted',
    acceptedSeq,
  };
  state.mailbox[controlId] = control;
  return { changed: true, value: { control, duplicate: false } };
}

export function beginDirectControlAttemptState(
  state: SchedulerState,
  controlId: string,
  runtimeOwner: string,
): DirectControlPolicyResult<DirectControlRecord> {
  const control = requiredControl(state, controlId);
  const target = state.agents[control.targetId];
  if (
    !target ||
    (target.parentId !== null && (target.runtimeOwner !== runtimeOwner || target.runtimePhase !== 'ready'))
  )
    throw new SchedulerStateError('runtime_owner', `Direct control '${controlId}' runtime owner does not match`);
  const activation = state.activations[control.activationId];
  if (!activation || activation.agentId !== control.targetId || activation.state !== 'running')
    throw new SchedulerStateError('stale_activation', `Direct control '${controlId}' source activation is not running`);
  beginMailboxAttemptState(state, [control], {
    attemptId: randomUUID(),
    activationId: activation.activationId,
    deliveryKind: 'interrupt',
  });
  return { changed: true, value: control };
}

export function markDirectInterruptBoundaryState(
  state: SchedulerState,
  controlId: string,
  attemptId: string,
  aborted: boolean,
): DirectControlPolicyResult<DirectControlRecord> {
  const control = requiredControl(state, controlId);
  if (control.attemptId !== attemptId)
    throw new SchedulerStateError('delivery_race', `Direct control '${controlId}' attempt is stale`);
  if (TERMINAL_DIRECT_CONTROL_STATES.has(control.status)) return { changed: false, value: control };
  if (!aborted) return terminalizeMailboxRecordState(state, control, 'refused', 'target_settled_before_interrupt');
  const consumed = consumeMailboxAtBoundaryState(state, [control], attemptId);
  return { changed: consumed.changed, value: control };
}

export function finishDirectControlState(
  state: SchedulerState,
  controlId: string,
  attemptId: string,
  status: 'refused' | 'failed' | 'indeterminate',
  outcomeCode: string,
): DirectControlPolicyResult<DirectControlRecord> {
  const control = requiredControl(state, controlId);
  if (control.attemptId !== attemptId && control.status !== 'accepted')
    throw new SchedulerStateError('delivery_race', `Direct control '${controlId}' attempt is stale`);
  const result = terminalizeMailboxRecordState(state, control, status, outcomeCode);
  return { changed: result.changed, value: control };
}

export function prepareDirectControlsForActivationFinishState(
  state: SchedulerState,
  activationId: string,
): DirectControlRecord[] {
  const changed: DirectControlRecord[] = [];
  for (const control of directMailboxRecords(state)) {
    if (control.activationId !== activationId || TERMINAL_DIRECT_CONTROL_STATES.has(control.status)) continue;
    if (control.status === 'sending') continue;
    const result = terminalizeMailboxRecordState(
      state,
      control,
      control.status === 'accepted' ? 'failed' : 'indeterminate',
      control.status === 'accepted'
        ? 'activation_settled_before_control_dispatch'
        : 'control_unsettled_at_activation_boundary',
    );
    changed.push(result.value);
  }
  return changed;
}

export function reconcileDirectControlState(
  state: SchedulerState,
  controlId: string,
): DirectControlPolicyResult<DirectControlRecord> {
  const control = requiredControl(state, controlId);
  if (TERMINAL_DIRECT_CONTROL_STATES.has(control.status)) return { changed: false, value: control };
  const result = terminalizeMailboxRecordState(
    state,
    control,
    control.status === 'accepted' ? 'failed' : 'indeterminate',
    control.status === 'accepted' ? 'recovered_before_control_dispatch' : 'recovered_uncertain_control_dispatch',
  );
  return { changed: result.changed, value: control };
}
