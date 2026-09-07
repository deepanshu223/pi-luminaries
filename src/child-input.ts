import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { hasUnsafeHumanFacingControl, isLuminariesId } from './identifiers.ts';
import { isLowercaseSha256, isRecord, sha256 } from './scheduler-state.ts';

const MAX_CHILD_INPUT_BYTES = 256 * 1024;

export type ChildInputDelivery = 'wake' | 'steer' | 'follow_up';

export interface ChildInput {
  inputId: string;
  payloadId: string;
  delivery: ChildInputDelivery;
  payloadHash: string;
  source: string;
  correlationId?: string;
  startingInput: boolean;
  lines?: readonly string[];
  /** Human-rendering kind echoed into the session record; absent on legacy deliveries. */
  presentation?: 'message' | 'notice';
}

export function childInputCommand(input: ChildInput): string {
  const payload = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
  if (Buffer.byteLength(payload) > MAX_CHILD_INPUT_BYTES) throw new Error('Managed child input exceeds its bound');
  return `/${LUMINARIES_IDENTITY.namespace.childInputCommand} ${payload}`;
}

export function parseChildInput(args: string): ChildInput {
  if (!args || Buffer.byteLength(args) > MAX_CHILD_INPUT_BYTES) throw new Error('Managed child input is invalid');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(args, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Managed child input is invalid');
  }
  if (
    !isRecord(value) ||
    typeof value.inputId !== 'string' ||
    !isLuminariesId(value.inputId) ||
    typeof value.payloadId !== 'string' ||
    !isLuminariesId(value.payloadId) ||
    (value.delivery !== 'wake' && value.delivery !== 'steer' && value.delivery !== 'follow_up') ||
    typeof value.payloadHash !== 'string' ||
    !isLowercaseSha256(value.payloadHash) ||
    typeof value.source !== 'string' ||
    !value.source ||
    hasUnsafeHumanFacingControl(value.source) ||
    (value.correlationId !== undefined &&
      (typeof value.correlationId !== 'string' || !isLuminariesId(value.correlationId))) ||
    typeof value.startingInput !== 'boolean'
  )
    throw new Error('Managed child input is invalid');
  if (
    value.lines !== undefined &&
    (!Array.isArray(value.lines) ||
      value.lines.length > 16 ||
      value.lines.some((line) => typeof line !== 'string' || Buffer.byteLength(line) > 4 * 1024))
  )
    throw new Error('Managed child input presentation is invalid');
  if (value.presentation !== undefined && value.presentation !== 'message' && value.presentation !== 'notice')
    throw new Error('Managed child input is invalid');
  const keys = new Set([
    'inputId',
    'payloadId',
    'delivery',
    'payloadHash',
    'source',
    'correlationId',
    'startingInput',
    'lines',
    'presentation',
  ]);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error('Managed child input is invalid');
  return {
    inputId: value.inputId,
    payloadId: value.payloadId,
    delivery: value.delivery,
    payloadHash: value.payloadHash,
    source: value.source,
    ...(typeof value.correlationId === 'string' ? { correlationId: value.correlationId } : {}),
    startingInput: value.startingInput,
    ...(Array.isArray(value.lines) ? { lines: value.lines } : {}),
    ...(value.presentation === 'message' || value.presentation === 'notice'
      ? { presentation: value.presentation }
      : {}),
  };
}

export async function readChildInputContent(
  input: ChildInput,
  outboxDirectory: string,
): Promise<{ prompt: string; presentationContent: string }> {
  if (!isAbsolute(outboxDirectory)) throw new Error('Managed child outbox is invalid');
  const directory = await realpath(resolve(outboxDirectory));
  const requested = join(directory, `${input.payloadId}.json`);
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Managed child payload is invalid');
  const path = await realpath(requested);
  if (dirname(path) !== directory) throw new Error('Managed child payload escapes its outbox');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Managed child payload is invalid');
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['version', 'eventId', 'payloadHash', 'message'].includes(key)) ||
    value.version !== 1 ||
    value.eventId !== input.payloadId ||
    value.payloadHash !== input.payloadHash ||
    typeof value.message !== 'string' ||
    !value.message ||
    sha256(value.message) !== input.payloadHash
  )
    throw new Error('Managed child payload is invalid');
  if (input.startingInput) return { prompt: value.message, presentationContent: value.message };
  return {
    prompt: `From ${input.source}${input.correlationId ? ` (correlationId ${input.correlationId})` : ''}:\n${value.message}`,
    presentationContent: `From ${input.source}:\n${value.message}`,
  };
}
