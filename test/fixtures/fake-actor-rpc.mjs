import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

// Used only to inject faults and status events. Queue behavior is tested against real Pi.
const delayMs = Number(process.env.FAKE_ACTOR_DELAY_MS ?? 100);
const managedPrefix = '/luminaries-input ';
let activeTimer;
let active = false;
let sessionParentId = null;
function cliValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const requestedSessionFile = cliValue('--session');
let sessionId = cliValue('--session-id');
if (requestedSessionFile) {
  for (const line of readFileSync(requestedSessionFile, 'utf8').split('\n')) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === 'session') sessionId = record.id;
    else if (record.fixture === 'session') sessionId = record.sessionId;
    else if (record.id) sessionParentId = record.id;
  }
}
const sessionFile = requestedSessionFile ?? join(cliValue('--session-dir'), `${sessionId}.jsonl`);
await mkdir(dirname(sessionFile), { recursive: true });
if (!requestedSessionFile) await writeFile(sessionFile, JSON.stringify({ fixture: 'session', sessionId }) + '\n');

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function response(id, data = {}) {
  emit({ type: 'response', id, success: true, data });
}
function settle(reason) {
  if (!active) return;
  active = false;
  clearTimeout(activeTimer);
  emit({ type: 'agent_settled', reason });
}
function handle(value) {
  if (value.type === 'fixture_emit_event') {
    emit(value.event);
    return;
  }
  if (value.type === 'get_state') {
    response(value.id, { sessionId, sessionFile, isStreaming: active });
    return;
  }
  if (value.type === 'abort') {
    settle('aborted');
    response(value.id);
    return;
  }
  if (value.type === 'prompt' && value.message.startsWith(managedPrefix)) {
    if (process.env.FAKE_INPUT_COMMAND_ERROR === '1') {
      emit({
        type: 'extension_error',
        event: 'command',
        extensionPath: 'command:luminaries-input',
        error: 'fixture input payload was unreadable',
      });
      response(value.id, { disposition: 'handled' });
      return;
    }
    const input = JSON.parse(Buffer.from(value.message.slice(managedPrefix.length), 'base64url').toString('utf8'));
    if (input.delivery !== 'wake') throw new Error('Use real Pi for busy-input tests');
    const payload = JSON.parse(
      readFileSync(join(process.env.LUMINARIES_OUTBOX_DIR, `${input.payloadId}.json`), 'utf8'),
    );
    const message = {
      role: 'custom',
      customType: 'luminaries_protocol_message',
      content: input.startingInput ? payload.message : `From ${input.source}:\n${payload.message}`,
      display: true,
      details: { inputId: input.inputId },
      timestamp: Date.now(),
    };
    const id = randomUUID();
    appendFileSync(
      sessionFile,
      JSON.stringify({
        type: 'message',
        id,
        parentId: sessionParentId,
        timestamp: new Date().toISOString(),
        fixture: 'message',
        message,
      }) + '\n',
    );
    sessionParentId = id;
    active = true;
    emit({ type: 'agent_start' });
    response(value.id, { disposition: 'handled' });
    emit({ type: 'message_start', message });
    if (process.env.FAKE_ACTOR_HOLD !== '1') activeTimer = setTimeout(() => settle('completed'), delayMs);
    return;
  }
  throw new Error(`Unsupported fault-fixture command: ${value.type}`);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => handle(JSON.parse(line)));
lines.on('close', () => clearTimeout(activeTimer));
