import { StringDecoder } from 'node:string_decoder';

const decoder = new StringDecoder('utf8');
let buffer = '';
const mode = process.env.FAKE_RPC_MODE ?? 'normal';
process.stderr.write(process.env.FAKE_STDERR ?? 'fake diagnostic\n');
function response(id, data = {}, success = true, error) {
  process.stdout.write(JSON.stringify({ type: 'response', id, success, ...(success ? data : { error }) }) + '\n');
}
function handle(value) {
  const operation = value.command ?? value.type;
  if (mode === 'fail') {
    setTimeout(() => process.exit(23), 5);
    return;
  }
  if (mode === 'ignore') return;
  if (mode === 'malformed') {
    process.stdout.write('{not-json}\n');
    return;
  }
  if (operation === 'failed') {
    response(value.id, {}, false, 'fixture command failed');
    return;
  }
  if (operation === 'invalid-response') {
    process.stdout.write(
      JSON.stringify({ type: 'response', id: value.id }) + '\n' + JSON.stringify({ type: 'late-after-failure' }) + '\n',
    );
    return;
  }
  if (operation === 'response-only') {
    response(value.id, { accepted: true });
    return;
  }
  if (operation === 'environment') {
    response(value.id, {
      inheritedPath: typeof process.env.PATH === 'string',
      parentSessionId: process.env.PI_SESSION_ID ?? null,
      parentSessionFile: process.env.PI_SESSION_FILE ?? null,
      parentProvider: process.env.PI_PROVIDER ?? null,
      parentModel: process.env.PI_MODEL ?? null,
      parentReasoning: process.env.PI_REASONING_LEVEL ?? null,
      appendSystem: process.env.APPEND_SYSTEM ?? null,
      piAppendSystem: process.env.PI_APPEND_SYSTEM ?? null,
      piSystemPrompt: process.env.PI_SYSTEM_PROMPT ?? null,
    });
    return;
  }
  if (operation === 'get_state' && process.env.FAKE_SESSION_ID) {
    response(value.id, {
      data: {
        sessionId: process.env.FAKE_SESSION_ID,
        sessionFile: process.env.FAKE_SESSION_FILE,
        cwd: process.env.FAKE_CWD,
      },
    });
    return;
  }
  if (operation === 'settle') {
    process.stdout.write(JSON.stringify({ type: 'agent_start', reason: 'fixture' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'agent_settled', reason: 'fixture' }) + '\n');
    response(value.id, { data: { ok: true }, ok: true });
    return;
  }
  if (operation === 'oversized-agent-end') {
    process.stdout.write(JSON.stringify({ type: 'agent_start', reason: 'fixture' }) + '\n');
    process.stdout.write(
      JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: 'x'.repeat(1024 * 1024) }] }) + '\n',
    );
    process.stdout.write(JSON.stringify({ type: 'agent_settled', reason: 'fixture' }) + '\n');
    response(value.id, { data: { ok: true }, ok: true });
    return;
  }
  if (operation === 'stale-settle') {
    process.stdout.write(JSON.stringify({ type: 'agent_settled', reason: 'stale' }) + '\n');
    response(value.id, { ok: true });
    return;
  }
  if (operation === 'id-event') {
    process.stdout.write(JSON.stringify({ type: 'tool_call', id: value.id, name: 'not-a-response' }) + '\n');
    response(value.id, { ok: true });
    return;
  }
  if (operation === 'unknown-response') {
    response('not-pending', { ok: true });
    return;
  }
  if (operation === 'never-answers') return;
  if (operation === 'first') {
    setTimeout(() => response(value.id, { ok: 'first' }), 30);
    return;
  }
  if (operation === 'second') {
    setTimeout(() => response(value.id, { ok: 'second' }), 1);
    return;
  }
  response(value.id, { ok: true, command: value.command });
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
