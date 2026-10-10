import { SchedulerStateError, exactKeys, isRecord, sha256 } from './scheduler-state.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

export const PUBLIC_RESULT_BYTES = 48 * 1024;

export function receiptWireBytes(
  toolCallId: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
  terminate = false,
): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        v: 1,
        ok: true,
        toolCallId,
        result: { message, details, ...(terminate ? { terminate: true } : {}) },
      }),
    ) + 1
  );
}

export interface ProjectionCursorScope {
  rootId: string;
  callerId: string;
  view: string;
  filter: string;
  revision: number;
}

interface ProjectionCursor extends ProjectionCursorScope {
  v: 1;
  key: string;
}

function cursorError(): SchedulerStateError {
  return new SchedulerStateError(
    'cursor_invalid',
    `This ${LUMINARIES_IDENTITY.label} page cursor is invalid or stale. Request a fresh page without the cursor.`,
  );
}

export function encodeProjectionCursor(scope: ProjectionCursorScope, key: string): string {
  const payload: ProjectionCursor = { v: 1, ...scope, key };
  const body = JSON.stringify(payload);
  return Buffer.from(`${body}.${sha256(body).slice(0, 32)}`).toString('base64url');
}

export function decodeProjectionCursor(value: string | undefined, expected: ProjectionCursorScope): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) throw cursorError();
  let decoded: string;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < 1 || bytes.toString('base64url') !== value) throw cursorError();
    decoded = bytes.toString('utf8');
  } catch (error) {
    if (error instanceof SchedulerStateError) throw error;
    throw cursorError();
  }
  const separator = decoded.lastIndexOf('.');
  if (separator < 1 || separator === decoded.length - 1) throw cursorError();
  const body = decoded.slice(0, separator);
  const checksum = decoded.slice(separator + 1);
  if (sha256(body).slice(0, 32) !== checksum) throw cursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw cursorError();
  }
  if (!isRecord(parsed)) throw cursorError();
  try {
    exactKeys(parsed, ['v', 'rootId', 'callerId', 'view', 'filter', 'revision', 'key'], 'projection cursor');
  } catch {
    throw cursorError();
  }
  if (
    parsed.v !== 1 ||
    parsed.rootId !== expected.rootId ||
    parsed.callerId !== expected.callerId ||
    parsed.view !== expected.view ||
    parsed.filter !== expected.filter ||
    parsed.revision !== expected.revision ||
    typeof parsed.key !== 'string' ||
    parsed.key.length < 1
  )
    throw cursorError();
  return parsed.key;
}

export function buildBytePage<T>(options: {
  items: readonly T[];
  afterKey?: string;
  keyOf: (item: T) => string;
  requestedLimit: number;
  scope: ProjectionCursorScope;
  buildDetails: (items: readonly T[], nextCursor: string | undefined, remaining: number) => Record<string, unknown>;
  measureDetails: (details: Readonly<Record<string, unknown>>) => number;
}): Record<string, unknown> {
  const start =
    options.afterKey === undefined
      ? 0
      : options.items.findIndex((item) => options.keyOf(item) === options.afterKey) + 1;
  if (options.afterKey !== undefined && start === 0) throw cursorError();
  const available = options.items.length - start;
  const requestedLimit = Math.min(options.requestedLimit, Math.max(1, available || options.requestedLimit));
  const maxCount = Math.min(requestedLimit, available);
  for (let count = maxCount; count >= 0; count--) {
    const pageItems = options.items.slice(start, start + count);
    const remaining = Math.max(0, options.items.length - start - count);
    const nextCursor =
      remaining && count > 0
        ? encodeProjectionCursor(options.scope, options.keyOf(options.items[start + count - 1]))
        : undefined;
    const details = options.buildDetails(pageItems, nextCursor, remaining);
    const measuredBytes = options.measureDetails(details);
    if (measuredBytes <= PUBLIC_RESULT_BYTES || count === 0) {
      if (count === 0 && (remaining > 0 || measuredBytes > PUBLIC_RESULT_BYTES))
        throw new SchedulerStateError(
          'result_bound',
          `The ${String(options.scope.view)} view cannot fit its first item within ${PUBLIC_RESULT_BYTES} bytes. Retry with a narrower view or fresh page.`,
        );
      return details;
    }
  }
  throw new SchedulerStateError(
    'result_bound',
    `The ${String(options.scope.view)} page cannot fit its measured bound.`,
  );
}
