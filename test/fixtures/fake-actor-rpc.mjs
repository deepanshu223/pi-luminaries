import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const decoder = new StringDecoder('utf8');
let buffer = '';
let activeTimer;
let active = false;
let promptCount = 0;
const pendingFollowUps = [];
const managedPrefix = '/luminaries-input ';
const delayMs = Number(process.env.FAKE_ACTOR_DELAY_MS ?? 100);
const failAfterPrompt = process.env.FAKE_ACTOR_FAIL_AFTER_PROMPT === '1';
const controlDelayMs = Number(process.env.FAKE_CONTROL_DELAY_MS ?? 0);
const failingControl = process.env.FAKE_CONTROL_FAIL;
const failAfterControl = process.env.FAKE_FAIL_AFTER_CONTROL;
const abortAccepted = process.env.FAKE_ABORT_ACCEPTED !== '0';
const steerAccepted = process.env.FAKE_STEER_ACCEPTED !== '0';
const steerConsumed = process.env.FAKE_STEER_CONSUMED !== '0';
const followUpConsumed = process.env.FAKE_FOLLOWUP_CONSUMED !== '0';
const steerDecoys = process.env.FAKE_STEER_DECOYS === '1';
const steerConsumeDelayMs = Number(process.env.FAKE_STEER_CONSUME_DELAY_MS ?? 0);
const stateStreaming = process.env.FAKE_STATE_STREAMING === '1';
const stateDelayMs = Number(process.env.FAKE_STATE_DELAY_MS ?? 0);
const extensionUiAudit = process.env.FAKE_EXTENSION_UI_AUDIT;
const extensionUiRequests = extensionUiAudit ? (process.env.FAKE_EXTENSION_UI_DUPLICATE === '1' ? 2 : 1) : 0;
let extensionUiResponses = 0;
function cliValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const requestedSessionFile = process.env.FAKE_SESSION_FILE ?? cliValue('--session');
const requestedSessionId = process.env.FAKE_SESSION_ID ?? cliValue('--session-id');
const sessionDir = cliValue('--session-dir');
let persistedSessionId;
let sessionParentId = null;
if (requestedSessionFile) {
  try {
    for (const line of readFileSync(requestedSessionFile, 'utf8').split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line);
      const storedSessionId =
        record?.type === 'session' ? record.id : record?.fixture === 'session' ? record.sessionId : undefined;
      if (typeof storedSessionId === 'string') persistedSessionId = storedSessionId;
      if (record?.type !== 'session' && typeof record?.id === 'string') sessionParentId = record.id;
    }
  } catch {
    // The fixture creates a fresh file below when needed.
  }
}
const sessionId = requestedSessionId ?? persistedSessionId;
const sessionFile =
  requestedSessionFile ?? (sessionDir && sessionId ? join(sessionDir, `${sessionId}.jsonl`) : undefined);
if (sessionFile) {
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, '', { flag: 'a', mode: 0o600 });
  if (sessionId && !persistedSessionId)
    appendFileSync(sessionFile, `${JSON.stringify({ fixture: 'session', sessionId })}\n`);
}
function persistMessage(message) {
  if (!sessionFile) return;
  const id = randomUUID();
  appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'message', id, parentId: sessionParentId, timestamp: new Date().toISOString(), fixture: 'message', message })}\n`,
  );
  sessionParentId = id;
}
function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function response(id, data = {}) {
  emit({ type: 'response', id, success: true, ...data });
}
function failedResponse(id, error) {
  emit({ type: 'response', id, success: false, error });
}
function messageStart(text, role = 'user', inputId) {
  emit({
    type: 'message_start',
    ...(inputId === undefined ? {} : { inputId }),
    message: { role, content: [{ type: 'text', text }], timestamp: Date.now() },
  });
}
function managedMessage(input) {
  const payload = JSON.parse(readFileSync(join(process.env.LUMINARIES_OUTBOX_DIR, `${input.payloadId}.json`), 'utf8'));
  const content = input.startingInput
    ? payload.message
    : `From ${input.source}${input.correlationId ? ` (correlationId ${input.correlationId})` : ''}:\n${payload.message}`;
  return {
    role: 'custom',
    customType: 'luminaries_protocol_message',
    content,
    display: true,
    details: { inputId: input.inputId, ...(input.lines ? { lines: input.lines } : {}) },
    timestamp: Date.now(),
  };
}
function parseManagedInput(message) {
  if (typeof message !== 'string' || !message.startsWith(managedPrefix)) return undefined;
  try {
    return JSON.parse(Buffer.from(message.slice(managedPrefix.length), 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}
function abortedAssistantStart() {
  emit({
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      stopReason: 'aborted',
      timestamp: Date.now(),
    },
  });
}
function settle(reason) {
  if (!active) return;
  if (pendingFollowUps.length) {
    clearTimeout(activeTimer);
    for (const message of pendingFollowUps.splice(0)) {
      persistMessage(message);
      emit({ type: 'message_start', message });
    }
    activeTimer = setTimeout(() => settle(reason), delayMs);
    return;
  }
  active = false;
  clearTimeout(activeTimer);
  emit({ type: 'agent_settled', reason });
}
function handle(value) {
  if (value.type === 'fixture_emit_event') {
    emit(value.event);
    return;
  }
  if (value.type === 'extension_ui_response' && extensionUiAudit) {
    appendFileSync(extensionUiAudit, `${JSON.stringify(value)}\n`);
    extensionUiResponses++;
    if (extensionUiResponses === extensionUiRequests) activeTimer = setTimeout(() => settle('completed'), delayMs);
    return;
  }
  if (value.type === 'get_state') {
    const send = () => response(value.id, { data: { sessionId, sessionFile, isStreaming: stateStreaming || active } });
    if (stateDelayMs > 0) setTimeout(send, stateDelayMs);
    else send();
    return;
  }
  const managed = value.type === 'prompt' ? parseManagedInput(value.message) : undefined;
  if (managed) {
    if (managed.delivery === 'wake') {
      promptCount++;
      active = true;
      const message = managedMessage(managed);
      persistMessage(message);
      emit({ type: 'agent_start', reason: 'fixture', promptCount });
      response(value.id, { data: { accepted: true } });
      emit({ type: 'message_start', message });
      if (failAfterPrompt) {
        setTimeout(() => process.exit(37), 15);
        return;
      }
      if (extensionUiRequests) {
        for (let index = 0; index < extensionUiRequests; index++)
          emit({
            type: 'extension_ui_request',
            id: 'fixture-ui-request',
            method: 'input',
            title: 'Need owner input',
          });
        return;
      }
      activeTimer = setTimeout(() => settle('completed'), delayMs);
      return;
    }
    const control = managed.delivery === 'follow_up' ? 'follow_up' : 'steer';
    const accepted = active && (control !== 'steer' || steerAccepted);
    const boundaryDelayMs = controlDelayMs + (control === 'steer' ? steerConsumeDelayMs : 0);
    if (accepted && control === 'steer') {
      clearTimeout(activeTimer);
      activeTimer = setTimeout(() => settle('completed'), boundaryDelayMs + delayMs);
    }
    setTimeout(() => {
      emit({ type: 'fixture_control', control, message: managed.content });
      if (failAfterControl === control) {
        setTimeout(() => process.exit(41), 5);
        return;
      }
      if (failingControl === control) {
        failedResponse(value.id, `fixture ${control} failure`);
        return;
      }
      response(value.id, { data: { accepted } });
      if (accepted && control === 'steer') {
        clearTimeout(activeTimer);
        activeTimer = setTimeout(() => settle('completed'), delayMs);
      }
      const consumed = control === 'steer' ? steerConsumed : followUpConsumed;
      if (accepted && consumed) {
        if (control === 'follow_up') pendingFollowUps.push(managedMessage(managed));
        else if (steerDecoys) {
          emit({ type: 'message_start', message: { ...managedMessage(managed), role: 'assistant' } });
          emit({
            type: 'message_start',
            message: { ...managedMessage(managed), details: { inputId: 'wrong-dispatch' } },
          });
          emit({ type: 'message_start', message: { role: 'user', content: managed.content } });
        }
        if (control === 'steer') {
          const message = managedMessage(managed);
          persistMessage(message);
          emit({ type: 'message_start', message });
        }
      }
    }, boundaryDelayMs);
    return;
  }
  if (value.type === 'prompt') {
    promptCount++;
    active = true;
    persistMessage({ role: 'user', content: [{ type: 'text', text: value.message }], timestamp: Date.now() });
    emit({ type: 'agent_start', reason: 'fixture', promptCount });
    messageStart(value.message, 'user', value.id);
    response(value.id, { data: { accepted: true } });
    if (failAfterPrompt) {
      setTimeout(() => process.exit(37), 15);
      return;
    }
    if (extensionUiRequests) {
      for (let index = 0; index < extensionUiRequests; index++)
        emit({
          type: 'extension_ui_request',
          id: 'fixture-ui-request',
          method: 'input',
          title: 'Need owner input',
        });
      return;
    }
    activeTimer = setTimeout(() => settle('completed'), delayMs);
    return;
  }
  if (value.type === 'steer' || value.type === 'follow_up') {
    const accepted = active && (value.type !== 'steer' || steerAccepted);
    setTimeout(() => {
      emit({ type: 'fixture_control', control: value.type, message: value.message });
      if (failAfterControl === value.type) {
        setTimeout(() => process.exit(41), 5);
        return;
      }
      if (value.type === 'steer' && accepted && steerDecoys) {
        messageStart(value.message, 'assistant');
        messageStart(value.message.slice(0, -1));
        const identityDecoy = value.message.replace(/"eventId": "[^"]+"/, '"eventId": "decoy-event"');
        messageStart(identityDecoy === value.message ? `${value.message}\n[decoy]` : identityDecoy);
      }
      const finish = () => {
        if (value.type === 'steer' && accepted && steerConsumed) {
          persistMessage({ role: 'user', content: [{ type: 'text', text: value.message }], timestamp: Date.now() });
          messageStart(value.message, 'user', value.id);
        } else if (value.type === 'follow_up' && accepted && followUpConsumed) {
          persistMessage({ role: 'user', content: [{ type: 'text', text: value.message }], timestamp: Date.now() });
          messageStart(value.message, 'user', value.id);
        }
        if (failingControl === value.type) failedResponse(value.id, `fixture ${value.type} failure`);
        else response(value.id, { data: { accepted } });
      };
      if (value.type === 'steer' && steerConsumeDelayMs > 0) setTimeout(finish, steerConsumeDelayMs);
      else finish();
    }, controlDelayMs);
    return;
  }
  if (value.type === 'abort') {
    setTimeout(() => {
      const accepted = abortAccepted && active;
      if (accepted) {
        abortedAssistantStart();
        settle('aborted');
      }
      response(value.id, { data: { accepted } });
    }, controlDelayMs);
    return;
  }
  response(value.id, { data: { ok: true } });
}
process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk);
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    handle(JSON.parse(line));
  }
});
