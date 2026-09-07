import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  acquirePrivateFileLease,
  atomicReplacePrivateFile,
  canonicalPrivateFilePath,
  type PrivateFileLease,
} from './atomic-file.ts';
import {
  SchedulerStateError,
  id,
  integer,
  isLowercaseSha256,
  isRecord,
  peerMailboxRecords,
  sha256,
  type AgentRecord,
  type MailboxRecord,
  type SchedulerState,
} from './scheduler-state.ts';
import { validateSchedulerState } from './scheduler-state-validation.ts';

const FORMAT_VERSION = 1 as const;
const SNAPSHOT_FILE = 'snapshot.jsonl';
const JOURNAL_PREFIX = 'journal.';
const JOURNAL_SUFFIX = '.jsonl';
const DELIVERY_DIRECTORY = 'delivery-payloads';
const RENAME_DELAYS_MS = [50, 100, 250, 500, 1_000, 1_000, 1_000, 1_000] as const;

type RequestRecord = SchedulerState['requests'][string];
export type ControlLogStateCollection = 'agents' | 'activations' | 'mailbox' | 'requests' | 'watches';
type StateCollection = ControlLogStateCollection;
type DurableCollection = StateCollection | 'closed' | 'noReplay' | 'payloads';

const STATE_COLLECTIONS: readonly StateCollection[] = ['agents', 'activations', 'mailbox', 'requests', 'watches'];
const DURABLE_COLLECTIONS: readonly DurableCollection[] = [...STATE_COLLECTIONS, 'closed', 'noReplay', 'payloads'];

export interface ControlLogNoReplayRecord {
  record: MailboxRecord;
  request?: RequestRecord;
  recordHash: string;
}

export interface ControlLogImage {
  state: SchedulerState;
  closed: ReadonlyMap<string, AgentRecord>;
  noReplay: ReadonlyMap<string, ControlLogNoReplayRecord>;
}

export interface ControlLogStateChanges {
  root: boolean;
  records: Partial<Record<ControlLogStateCollection, ReadonlySet<string>>>;
}

export interface ControlLogCommit {
  state: SchedulerState;
  changes: ControlLogStateChanges;
  closedPuts?: readonly AgentRecord[];
  closedDeletes?: readonly string[];
  noReplayPuts?: ReadonlyMap<string, ControlLogNoReplayRecord>;
}

export interface ControlLogOpenOptions {
  statePath: string;
  bootstrap?: SchedulerState;
}

interface JournalSegment {
  base: number;
  path: string;
  bytes: number;
}

interface JournalReplay {
  bytes: number;
  maxRevision: number;
  applied: boolean;
}

interface DurableImage {
  state: SchedulerState;
  closed: Map<string, AgentRecord>;
  noReplay: Map<string, ControlLogNoReplayRecord>;
  payloads: Map<string, string>;
}

interface JournalTransaction {
  type: 'transaction';
  version: typeof FORMAT_VERSION;
  baseRevision: number;
  revision: number;
  nextSeq: number;
  updatedAtMs: number;
  root?: SchedulerState['root'];
  puts?: Partial<Record<DurableCollection, Record<string, unknown>>>;
  deletes?: Partial<Record<Exclude<DurableCollection, 'noReplay'>, string[]>>;
}

interface SnapshotHeader {
  type: 'snapshot';
  version: typeof FORMAT_VERSION;
  stateVersion: SchedulerState['version'];
  revision: number;
  nextSeq: number;
  updatedAtMs: number;
  root: SchedulerState['root'];
}

interface SnapshotRecord {
  type: 'record';
  collection: DurableCollection;
  key: string;
  value: unknown;
}

interface SnapshotEnd {
  type: 'snapshot_end';
  version: typeof FORMAT_VERSION;
  revision: number;
  records: number;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new SchedulerStateError('state_invalid', `${label} has unknown field '${unexpected}'`);
}

function isDecimal(value: string): boolean {
  if (!value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function transactionPath(directory: string, baseRevision: number): string {
  return join(directory, `${JOURNAL_PREFIX}${baseRevision}${JOURNAL_SUFFIX}`);
}

function parseJournalBase(name: string): number | undefined {
  if (!name.startsWith(JOURNAL_PREFIX) || !name.endsWith(JOURNAL_SUFFIX)) return undefined;
  const value = name.slice(JOURNAL_PREFIX.length, -JOURNAL_SUFFIX.length);
  if (!isDecimal(value)) return undefined;
  const base = Number(value);
  return Number.isSafeInteger(base) && base >= 0 ? base : undefined;
}

function isSnapshotTemp(name: string): boolean {
  return name.startsWith('.snapshot.') && name.endsWith('.tmp');
}

function outboxRequired(record: Readonly<MailboxRecord>): boolean {
  return (
    record.lane !== 'direct' &&
    (record.status === 'accepted' ||
      record.status === 'sending' ||
      (record.mode === 'notify_only' && record.status === 'settled'))
  );
}

function operationId(record: Readonly<MailboxRecord>): string {
  return record.lane === 'direct' ? record.requestId : record.bridgeRequestId;
}

function withoutMessage(record: MailboxRecord): MailboxRecord {
  if (record.lane === 'direct' || record.message === undefined) return record;
  const result = { ...record };
  delete result.message;
  return result;
}

function durableState(state: SchedulerState): SchedulerState {
  return {
    ...state,
    agents: { ...state.agents },
    activations: { ...state.activations },
    mailbox: Object.fromEntries(Object.entries(state.mailbox).map(([key, record]) => [key, withoutMessage(record)])),
    requests: { ...state.requests },
    watches: { ...state.watches },
  };
}

function buildDurableImage(image: ControlLogImage): DurableImage {
  const payloads = new Map<string, string>();
  for (const event of peerMailboxRecords(image.state)) {
    if (!outboxRequired(event)) continue;
    const message = event.message;
    if (
      message === undefined ||
      !event.payloadHash ||
      sha256(message) !== event.payloadHash ||
      Buffer.byteLength(message) !== event.payloadBytes
    )
      throw new SchedulerStateError('state_invalid', `Unresolved payload '${event.eventId}' is unavailable`);
    const existing = payloads.get(event.payloadHash);
    if (existing !== undefined && existing !== message)
      throw new SchedulerStateError('state_invalid', `Payload hash '${event.payloadHash}' has conflicting bodies`);
    payloads.set(event.payloadHash, message);
  }
  return {
    state: durableState(image.state),
    closed: new Map(image.closed),
    noReplay: new Map(image.noReplay),
    payloads,
  };
}

function hydrateState(image: DurableImage): SchedulerState {
  const state = structuredClone(image.state);
  const referencedPayloads = new Set<string>();
  for (const event of peerMailboxRecords(state)) {
    if (!outboxRequired(event)) continue;
    const hash = event.payloadHash;
    const message = hash ? image.payloads.get(hash) : undefined;
    if (!hash || message === undefined || sha256(message) !== hash || Buffer.byteLength(message) !== event.payloadBytes)
      throw new SchedulerStateError('state_invalid', `Unresolved payload '${event.eventId}' is inconsistent`);
    event.message = message;
    referencedPayloads.add(hash);
  }
  for (const hash of image.payloads.keys())
    if (!referencedPayloads.has(hash))
      throw new SchedulerStateError('state_invalid', `Payload '${hash}' is not referenced by current work`);
  return state;
}

function validateNoReplay(key: string, value: ControlLogNoReplayRecord): void {
  id(key, 'no-replay operation identity');
  const expectedHash = sha256(
    JSON.stringify({ record: value.record, ...(value.request ? { request: value.request } : {}) }),
  );
  if (!isLowercaseSha256(value.recordHash) || value.recordHash !== expectedHash)
    throw new SchedulerStateError('state_invalid', `No-replay operation '${key}' hash is inconsistent`);
  if (value.record.status !== 'indeterminate' || operationId(value.record) !== key)
    throw new SchedulerStateError('state_invalid', `No-replay operation '${key}' is inconsistent`);
  if (value.request && (value.record.lane === 'direct' || value.record.requestId !== value.request.requestId))
    throw new SchedulerStateError('state_invalid', `No-replay request '${key}' is inconsistent`);
}

function validateImage(image: DurableImage, statePath: string): SchedulerState {
  const state = hydrateState(image);
  const complete = structuredClone(state);
  for (const [agentId, agent] of image.closed) {
    if (agent.agentId !== agentId || agent.lifecycle !== 'closed')
      throw new SchedulerStateError('state_invalid', `Closed collaborator '${agentId}' is inconsistent`);
    const hot = complete.agents[agentId];
    if (hot && !isDeepStrictEqual(hot, agent))
      throw new SchedulerStateError('state_invalid', `Closed collaborator '${agentId}' conflicts with hot state`);
    complete.agents[agentId] = structuredClone(agent);
  }
  for (const [key, value] of image.noReplay) validateNoReplay(key, value);
  validateSchedulerState(complete, { statePath });
  return state;
}

async function readJsonLines(
  path: string,
  repairIncompleteTail: boolean,
  visit: (value: unknown) => void,
): Promise<number> {
  const canonical = await canonicalPrivateFilePath(path);
  const parts: Buffer[] = [];
  let partBytes = 0;
  let totalBytes = 0;
  let completeBytes = 0;
  for await (const value of createReadStream(canonical.path)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) break;
      const part = chunk.subarray(start, newline);
      parts.push(part);
      partBytes += part.byteLength;
      let raw: string;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, partBytes));
      } catch (error) {
        throw new SchedulerStateError('state_invalid', 'Control-log record is not valid UTF-8', { cause: error });
      }
      if (!raw) throw new SchedulerStateError('state_invalid', 'Control-log record is empty');
      try {
        visit(JSON.parse(raw));
      } catch (error) {
        if (error instanceof SchedulerStateError) throw error;
        throw new SchedulerStateError('state_invalid', 'Control-log record is not valid JSON', { cause: error });
      }
      parts.length = 0;
      partBytes = 0;
      completeBytes = totalBytes + newline + 1;
      start = newline + 1;
    }
    if (start < chunk.length) {
      const remainder = chunk.subarray(start);
      parts.push(remainder);
      partBytes += remainder.byteLength;
    }
    totalBytes += chunk.byteLength;
  }
  if (partBytes) {
    if (!repairIncompleteTail)
      throw new SchedulerStateError('state_invalid', 'Control-log snapshot has an incomplete final record');
    const handle = await open(canonical.path, 'r+');
    try {
      await handle.truncate(completeBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return completeBytes;
  }
  return totalBytes;
}

function emptyImage(header: SnapshotHeader): DurableImage {
  return {
    state: {
      version: header.stateVersion,
      revision: header.revision,
      nextSeq: header.nextSeq,
      updatedAtMs: header.updatedAtMs,
      root: header.root,
      agents: {},
      activations: {},
      mailbox: {},
      requests: {},
      watches: {},
    },
    closed: new Map(),
    noReplay: new Map(),
    payloads: new Map(),
  };
}

function parseSnapshotHeader(value: unknown): SnapshotHeader {
  if (!isRecord(value)) throw new SchedulerStateError('state_invalid', 'Control-log snapshot header is invalid');
  exactKeys(value, ['type', 'version', 'stateVersion', 'revision', 'nextSeq', 'updatedAtMs', 'root'], 'snapshot');
  if (
    value.type !== 'snapshot' ||
    value.version !== FORMAT_VERSION ||
    value.stateVersion !== 2 ||
    !isRecord(value.root)
  )
    throw new SchedulerStateError('state_version', 'Unsupported control-log snapshot version');
  return {
    type: 'snapshot',
    version: FORMAT_VERSION,
    stateVersion: 2,
    revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER, 'snapshot.revision'),
    nextSeq: integer(value.nextSeq, 1, Number.MAX_SAFE_INTEGER, 'snapshot.nextSeq'),
    updatedAtMs: integer(value.updatedAtMs, 0, Number.MAX_SAFE_INTEGER, 'snapshot.updatedAtMs'),
    root: value.root as unknown as SchedulerState['root'],
  };
}

function durableCollection(value: unknown, label: string): DurableCollection {
  if (typeof value !== 'string' || !DURABLE_COLLECTIONS.includes(value as DurableCollection))
    throw new SchedulerStateError('state_invalid', `${label} collection is invalid`);
  return value as DurableCollection;
}

function putRecord(image: DurableImage, collection: DurableCollection, key: string, value: unknown): void {
  if (collection === 'payloads') {
    if (!isLowercaseSha256(key) || typeof value !== 'string' || !value || sha256(value) !== key)
      throw new SchedulerStateError('state_invalid', `Payload '${key}' is invalid`);
    image.payloads.set(key, value);
    return;
  }
  if (collection === 'closed') {
    if (!isRecord(value) || value.agentId !== key || value.lifecycle !== 'closed')
      throw new SchedulerStateError('state_invalid', `Closed collaborator '${key}' is invalid`);
    image.closed.set(key, value as unknown as AgentRecord);
    return;
  }
  if (collection === 'noReplay') {
    if (!isRecord(value) || !isRecord(value.record))
      throw new SchedulerStateError('state_invalid', `No-replay operation '${key}' is invalid`);
    exactKeys(value, ['record', 'request', 'recordHash'], `no-replay operation '${key}'`);
    const record = value.record as unknown as MailboxRecord;
    const item: ControlLogNoReplayRecord = {
      record,
      ...(isRecord(value.request) ? { request: value.request as unknown as RequestRecord } : {}),
      recordHash: typeof value.recordHash === 'string' ? value.recordHash : '',
    };
    validateNoReplay(key, item);
    const existing = image.noReplay.get(key);
    if (existing && !isDeepStrictEqual(existing, item))
      throw new SchedulerStateError('state_invalid', `No-replay operation '${key}' was rewritten`);
    image.noReplay.set(key, item);
    return;
  }
  id(key, `${collection} record identity`);
  if (!isRecord(value)) throw new SchedulerStateError('state_invalid', `${collection} record '${key}' is invalid`);
  if (collection === 'agents') image.state.agents[key] = value as unknown as AgentRecord;
  else if (collection === 'activations')
    image.state.activations[key] = value as unknown as SchedulerState['activations'][string];
  else if (collection === 'mailbox') image.state.mailbox[key] = value as unknown as MailboxRecord;
  else if (collection === 'requests') image.state.requests[key] = value as unknown as RequestRecord;
  else image.state.watches[key] = value as unknown as SchedulerState['watches'][string];
}

function validateDeleteKey(collection: Exclude<DurableCollection, 'noReplay'>, key: string): void {
  if (collection === 'payloads') {
    if (!isLowercaseSha256(key)) throw new SchedulerStateError('state_invalid', `Payload delete '${key}' is invalid`);
  } else id(key, `${collection} delete identity`);
}

function deleteRecord(image: DurableImage, collection: Exclude<DurableCollection, 'noReplay'>, key: string): void {
  if (collection === 'payloads') image.payloads.delete(key);
  else if (collection === 'closed') image.closed.delete(key);
  else if (collection === 'agents') delete image.state.agents[key];
  else if (collection === 'activations') delete image.state.activations[key];
  else if (collection === 'mailbox') delete image.state.mailbox[key];
  else if (collection === 'requests') delete image.state.requests[key];
  else delete image.state.watches[key];
}

async function readSnapshot(
  path: string,
  statePath: string,
): Promise<{ image: DurableImage; bytes: number; state: SchedulerState }> {
  let image: DurableImage | undefined;
  let end: SnapshotEnd | undefined;
  let records = 0;
  const bytes = await readJsonLines(path, false, (value) => {
    if (!image) {
      image = emptyImage(parseSnapshotHeader(value));
      return;
    }
    if (!isRecord(value)) throw new SchedulerStateError('state_invalid', 'Control-log snapshot record is invalid');
    if (value.type === 'snapshot_end') {
      exactKeys(value, ['type', 'version', 'revision', 'records'], 'snapshot_end');
      if (end || value.version !== FORMAT_VERSION)
        throw new SchedulerStateError('state_invalid', 'Control-log snapshot has duplicate or invalid end');
      end = {
        type: 'snapshot_end',
        version: FORMAT_VERSION,
        revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER, 'snapshot_end.revision'),
        records: integer(value.records, 0, Number.MAX_SAFE_INTEGER, 'snapshot_end.records'),
      };
      return;
    }
    if (end) throw new SchedulerStateError('state_invalid', 'Control-log snapshot has records after its end');
    exactKeys(value, ['type', 'collection', 'key', 'value'], 'snapshot record');
    if (value.type !== 'record' || typeof value.key !== 'string')
      throw new SchedulerStateError('state_invalid', 'Control-log snapshot record is invalid');
    putRecord(image, durableCollection(value.collection, 'snapshot record'), value.key, value.value);
    records++;
  });
  if (!image || !end || end.revision !== image.state.revision || end.records !== records)
    throw new SchedulerStateError('state_invalid', 'Control-log snapshot is incomplete or inconsistent');
  return { image, bytes, state: validateImage(image, statePath) };
}

function parseTransaction(value: unknown): JournalTransaction {
  if (!isRecord(value)) throw new SchedulerStateError('state_invalid', 'Control-log transaction is invalid');
  exactKeys(
    value,
    ['type', 'version', 'baseRevision', 'revision', 'nextSeq', 'updatedAtMs', 'root', 'puts', 'deletes'],
    'transaction',
  );
  if (value.type !== 'transaction' || value.version !== FORMAT_VERSION)
    throw new SchedulerStateError('state_version', 'Unsupported control-log transaction version');
  const baseRevision = integer(value.baseRevision, 0, Number.MAX_SAFE_INTEGER, 'transaction.baseRevision');
  const revision = integer(value.revision, 1, Number.MAX_SAFE_INTEGER, 'transaction.revision');
  if (revision <= baseRevision)
    throw new SchedulerStateError('state_invalid', 'Control-log transaction revision does not advance');
  if (value.root !== undefined && !isRecord(value.root))
    throw new SchedulerStateError('state_invalid', 'Control-log root replacement is invalid');
  if (value.puts !== undefined && !isRecord(value.puts))
    throw new SchedulerStateError('state_invalid', 'Control-log transaction puts are invalid');
  if (value.deletes !== undefined && !isRecord(value.deletes))
    throw new SchedulerStateError('state_invalid', 'Control-log transaction deletes are invalid');
  for (const collection of Object.keys(value.puts ?? {})) durableCollection(collection, 'transaction put');
  for (const collection of Object.keys(value.deletes ?? {})) {
    const parsed = durableCollection(collection, 'transaction delete');
    if (parsed === 'noReplay') throw new SchedulerStateError('state_invalid', 'No-replay evidence cannot be deleted');
    const keys = value.deletes?.[collection];
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string'))
      throw new SchedulerStateError('state_invalid', `Control-log ${collection} deletes are invalid`);
    for (const key of keys) validateDeleteKey(parsed, key);
  }
  return {
    type: 'transaction',
    version: FORMAT_VERSION,
    baseRevision,
    revision,
    nextSeq: integer(value.nextSeq, 1, Number.MAX_SAFE_INTEGER, 'transaction.nextSeq'),
    updatedAtMs: integer(value.updatedAtMs, 0, Number.MAX_SAFE_INTEGER, 'transaction.updatedAtMs'),
    ...(value.root ? { root: value.root as unknown as SchedulerState['root'] } : {}),
    ...(value.puts ? { puts: value.puts as JournalTransaction['puts'] } : {}),
    ...(value.deletes ? { deletes: value.deletes as JournalTransaction['deletes'] } : {}),
  };
}

function applyTransaction(image: DurableImage, transaction: JournalTransaction): void {
  if (transaction.baseRevision !== image.state.revision)
    throw new SchedulerStateError(
      'state_invalid',
      `Control-log revision gap: expected ${image.state.revision}, received ${transaction.baseRevision}`,
    );
  if (transaction.root) image.state.root = transaction.root;
  for (const [name, values] of Object.entries(transaction.deletes ?? {})) {
    const collection = durableCollection(name, 'transaction delete');
    if (collection === 'noReplay' || !Array.isArray(values) || values.some((key) => typeof key !== 'string'))
      throw new SchedulerStateError('state_invalid', `Control-log ${name} deletes are invalid`);
    for (const key of values) {
      validateDeleteKey(collection, key);
      deleteRecord(image, collection, key);
    }
  }
  for (const [name, values] of Object.entries(transaction.puts ?? {})) {
    const collection = durableCollection(name, 'transaction put');
    if (!isRecord(values)) throw new SchedulerStateError('state_invalid', `Control-log ${name} puts are invalid`);
    for (const [key, value] of Object.entries(values)) putRecord(image, collection, key, value);
  }
  image.state.revision = transaction.revision;
  image.state.nextSeq = transaction.nextSeq;
  image.state.updatedAtMs = transaction.updatedAtMs;
}

async function replayJournal(
  segment: JournalSegment,
  image: DurableImage,
  repairIncompleteTail: boolean,
): Promise<JournalReplay> {
  let expectedBase = segment.base;
  let maxRevision = segment.base;
  let applied = false;
  const bytes = await readJsonLines(segment.path, repairIncompleteTail, (value) => {
    const transaction = parseTransaction(value);
    if (transaction.baseRevision !== expectedBase)
      throw new SchedulerStateError(
        'state_invalid',
        `Control-log journal '${basename(segment.path)}' has a revision gap`,
      );
    expectedBase = transaction.revision;
    maxRevision = transaction.revision;
    if (transaction.revision <= image.state.revision) return;
    applyTransaction(image, transaction);
    applied = true;
  });
  return { bytes, maxRevision, applied };
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<number> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position + written);
    if (result.bytesWritten < 1) throw new Error('Control-log write made no progress');
    written += result.bytesWritten;
  }
  return written;
}

async function openJournal(path: string): Promise<{ handle: FileHandle; bytes: number }> {
  const canonical = await canonicalPrivateFilePath(path);
  let handle: FileHandle;
  try {
    handle = await open(canonical.path, 'wx+', 0o600);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    handle = await open((await canonicalPrivateFilePath(path)).path, 'r+');
  }
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new SchedulerStateError('state_invalid', 'Control-log journal is not a regular file');
  }
  return { handle, bytes: info.size };
}

function collectionMap(image: DurableImage, collection: DurableCollection): ReadonlyMap<string, unknown> {
  if (collection === 'agents') return new Map(Object.entries(image.state.agents));
  if (collection === 'activations') return new Map(Object.entries(image.state.activations));
  if (collection === 'mailbox') return new Map(Object.entries(image.state.mailbox));
  if (collection === 'requests') return new Map(Object.entries(image.state.requests));
  if (collection === 'watches') return new Map(Object.entries(image.state.watches));
  if (collection === 'closed') return image.closed;
  if (collection === 'noReplay') return image.noReplay;
  return image.payloads;
}

async function syncDirectory(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    try {
      await handle.sync();
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EINVAL' && code !== 'EACCES')) throw error;
      return false;
    }
  } finally {
    await handle.close();
  }
}

async function renameSnapshot(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      if ((code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt >= RENAME_DELAYS_MS.length)
        throw error;
      await delay(RENAME_DELAYS_MS[attempt]);
    }
  }
}

async function writeSnapshot(path: string, image: DurableImage, statePath: string): Promise<number> {
  const handle = await open(path, 'wx', 0o600);
  let position = 0;
  let records = 0;
  const line = async (value: SnapshotHeader | SnapshotRecord | SnapshotEnd): Promise<void> => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    position += await writeAll(handle, bytes, position);
  };
  try {
    await line({
      type: 'snapshot',
      version: FORMAT_VERSION,
      stateVersion: image.state.version,
      revision: image.state.revision,
      nextSeq: image.state.nextSeq,
      updatedAtMs: image.state.updatedAtMs,
      root: image.state.root,
    });
    for (const collection of DURABLE_COLLECTIONS) {
      const values = collectionMap(image, collection);
      for (const key of [...values.keys()].sort()) {
        await line({ type: 'record', collection, key, value: values.get(key) });
        records++;
      }
    }
    await line({
      type: 'snapshot_end',
      version: FORMAT_VERSION,
      revision: image.state.revision,
      records,
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await readSnapshot(path, statePath);
  return position;
}

async function existing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoRetiredStorage(statePath: string): Promise<void> {
  const root = dirname(statePath);
  const files = [statePath, `${statePath}.bak`, `${statePath}.corrupt-0`, `${statePath}.corrupt-1`];
  const directories = ['outbox', 'closed', 'indeterminate'].map((name) => join(root, name));
  if ((await Promise.all([...files, ...directories].map(existing))).some(Boolean))
    throw new SchedulerStateError(
      'state_version',
      'This Luminaries root uses the retired whole-state storage layout; remove it explicitly before starting a fresh root',
    );
}

async function controlDirectory(statePath: string): Promise<string> {
  const root = await realpath(dirname(statePath));
  const requested = join(root, 'control');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const directory = await realpath(requested);
  if (!samePath(dirname(directory), root) || basename(directory) !== 'control')
    throw new SchedulerStateError('state_invalid', 'Control-log directory escapes the Luminaries root');
  return directory;
}

async function inspectControlDirectory(directory: string): Promise<readonly JournalSegment[]> {
  const journals: JournalSegment[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === SNAPSHOT_FILE || entry.name === DELIVERY_DIRECTORY) continue;
    if (isSnapshotTemp(entry.name) && entry.isFile()) {
      await rm(join(directory, entry.name), { force: true });
      continue;
    }
    const base = parseJournalBase(entry.name);
    if (!entry.isFile() || base === undefined)
      throw new SchedulerStateError('state_invalid', `Control-log directory contains invalid entry '${entry.name}'`);
    const path = join(directory, entry.name);
    journals.push({ base, path, bytes: (await stat(path)).size });
  }
  journals.sort((left, right) => left.base - right.base);
  for (let index = 1; index < journals.length; index++)
    if (journals[index - 1].base === journals[index].base)
      throw new SchedulerStateError(
        'state_invalid',
        `Control-log journal base '${journals[index].base}' is duplicated`,
      );
  return journals;
}

async function cleanDerivedPayloads(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!samePath(await realpath(directory), directory))
    throw new SchedulerStateError('state_invalid', 'Derived delivery-payload directory escapes control state');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.tmp')) {
      await rm(join(directory, entry.name), { force: true });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json'))
      throw new SchedulerStateError('state_invalid', 'Derived delivery-payload directory contains invalid evidence');
    id(entry.name.slice(0, -5), 'delivery payload eventId');
    await rm(join(directory, entry.name), { force: true });
  }
}

function stateRecord(state: SchedulerState, collection: ControlLogStateCollection, key: string): unknown {
  if (collection === 'agents') return state.agents[key];
  if (collection === 'activations') return state.activations[key];
  if (collection === 'mailbox') return state.mailbox[key];
  if (collection === 'requests') return state.requests[key];
  return state.watches[key];
}

function payloadHash(record: MailboxRecord | undefined): string | undefined {
  return record?.lane !== 'direct' ? record?.payloadHash : undefined;
}

function payloadChanges(
  previous: SchedulerState,
  current: SchedulerState,
  changedMailboxIds: ReadonlySet<string>,
  existing: ReadonlyMap<string, string>,
): { puts: Record<string, unknown>; deletes: string[] } {
  const hashes = new Set<string>();
  for (const eventId of changedMailboxIds) {
    const before = payloadHash(previous.mailbox[eventId]);
    const after = payloadHash(current.mailbox[eventId]);
    if (before) hashes.add(before);
    if (after) hashes.add(after);
  }
  if (!hashes.size) return { puts: {}, deletes: [] };
  const live = new Map<string, string>();
  for (const record of Object.values(current.mailbox)) {
    if (record.lane === 'direct' || !outboxRequired(record) || !record.payloadHash || record.message === undefined)
      continue;
    if (!hashes.has(record.payloadHash)) continue;
    if (sha256(record.message) !== record.payloadHash || Buffer.byteLength(record.message) !== record.payloadBytes)
      throw new SchedulerStateError('state_invalid', `Unresolved payload '${record.eventId}' is unavailable`);
    const prior = live.get(record.payloadHash);
    if (prior !== undefined && prior !== record.message)
      throw new SchedulerStateError('state_invalid', `Payload hash '${record.payloadHash}' has conflicting bodies`);
    live.set(record.payloadHash, record.message);
  }
  const puts: Record<string, unknown> = {};
  const deletes: string[] = [];
  for (const hash of hashes) {
    const message = live.get(hash);
    if (message !== undefined) {
      if (existing.get(hash) !== message) puts[hash] = message;
    } else if (existing.has(hash)) deletes.push(hash);
  }
  return { puts, deletes };
}

function journalTransaction(image: DurableImage, input: ControlLogCommit): JournalTransaction {
  if (input.state.revision <= image.state.revision)
    throw new SchedulerStateError('state_invalid', 'Changed control-log transaction does not advance revision');
  const puts: Partial<Record<DurableCollection, Record<string, unknown>>> = {};
  const deletes: Partial<Record<Exclude<DurableCollection, 'noReplay'>, string[]>> = {};
  for (const collection of STATE_COLLECTIONS) {
    const keys = input.changes.records[collection];
    if (!keys?.size) continue;
    const changed: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const key of [...keys].sort()) {
      const current = stateRecord(input.state, collection, key);
      const previous = stateRecord(image.state, collection, key);
      if (current === undefined) {
        if (previous !== undefined) removed.push(key);
        continue;
      }
      const value = collection === 'mailbox' ? withoutMessage(current as MailboxRecord) : current;
      if (previous === undefined || !isDeepStrictEqual(previous, value)) changed[key] = value;
    }
    if (Object.keys(changed).length) puts[collection] = changed;
    if (removed.length) deletes[collection] = removed;
  }
  const changedMailboxIds = input.changes.records.mailbox;
  if (changedMailboxIds?.size) {
    const payload = payloadChanges(image.state, input.state, changedMailboxIds, image.payloads);
    if (Object.keys(payload.puts).length) puts.payloads = payload.puts;
    if (payload.deletes.length) deletes.payloads = payload.deletes;
  }
  const root =
    input.changes.root && !isDeepStrictEqual(image.state.root, input.state.root) ? input.state.root : undefined;
  for (const agent of input.closedPuts ?? []) {
    if (agent.lifecycle !== 'closed')
      throw new SchedulerStateError('state_invalid', `Closed collaborator '${agent.agentId}' is not closed`);
    (puts.closed ??= {})[agent.agentId] = agent;
  }
  if (input.closedDeletes?.length) deletes.closed = [...input.closedDeletes];
  for (const [key, value] of input.noReplayPuts ?? []) {
    validateNoReplay(key, value);
    const existing = image.noReplay.get(key);
    if (existing && !isDeepStrictEqual(existing, value))
      throw new SchedulerStateError('state_invalid', `No-replay operation '${key}' was rewritten`);
    if (!existing) (puts.noReplay ??= {})[key] = value;
  }
  return {
    type: 'transaction',
    version: FORMAT_VERSION,
    baseRevision: image.state.revision,
    revision: input.state.revision,
    nextSeq: input.state.nextSeq,
    updatedAtMs: input.state.updatedAtMs,
    ...(root ? { root } : {}),
    ...(Object.keys(puts).length ? { puts } : {}),
    ...(Object.keys(deletes).length ? { deletes } : {}),
  };
}

export class ControlLog {
  readonly statePath: string;
  readonly created: boolean;
  readonly deliveryPayloadDirectory: string;
  readonly warnings: readonly string[] = [];
  private readonly lease: PrivateFileLease;
  private readonly directory: string;
  private readonly snapshotPath: string;
  private imageValue: DurableImage;
  private journalPath: string;
  private journal: FileHandle;
  private syncedOffset: number;
  private snapshotBytes: number;
  private snapshotRevision: number;
  private checkpointTask?: Promise<void>;
  private poisoned?: Error;
  private closing = false;
  private readonly diagnosticsRing: string[] = [];

  private constructor(input: {
    lease: PrivateFileLease;
    directory: string;
    image: DurableImage;
    journalPath: string;
    journal: FileHandle;
    journalBytes: number;
    snapshotBytes: number;
    snapshotRevision: number;
    created: boolean;
  }) {
    this.lease = input.lease;
    this.statePath = input.lease.statePath;
    this.directory = input.directory;
    this.snapshotPath = join(input.directory, SNAPSHOT_FILE);
    this.deliveryPayloadDirectory = join(input.directory, DELIVERY_DIRECTORY);
    this.imageValue = input.image;
    this.journalPath = input.journalPath;
    this.journal = input.journal;
    this.syncedOffset = input.journalBytes;
    this.snapshotBytes = input.snapshotBytes;
    this.snapshotRevision = input.snapshotRevision;
    this.created = input.created;
  }

  static async open(options: ControlLogOpenOptions): Promise<ControlLog> {
    const lease = await acquirePrivateFileLease(options.statePath);
    let journal: FileHandle | undefined;
    try {
      await assertNoRetiredStorage(lease.statePath);
      const directory = await controlDirectory(lease.statePath);
      const snapshotPath = join(directory, SNAPSHOT_FILE);
      let journals = await inspectControlDirectory(directory);
      const hasSnapshot = await existing(snapshotPath);
      let image: DurableImage;
      let snapshotBytes: number;
      let snapshotRevision: number;
      let validatedState: SchedulerState;
      let created = false;
      if (!hasSnapshot) {
        if (journals.length)
          throw new SchedulerStateError(
            'state_missing',
            'Control-log snapshot is missing while journal evidence exists',
          );
        if (!options.bootstrap)
          throw new SchedulerStateError(
            'state_missing',
            'Control-log state is missing and no explicit bootstrap was supplied',
          );
        validateSchedulerState(options.bootstrap, { statePath: lease.statePath });
        image = buildDurableImage({ state: options.bootstrap, closed: new Map(), noReplay: new Map() });
        validatedState = options.bootstrap;
        const temp = join(directory, `.snapshot.${randomUUID()}.tmp`);
        snapshotBytes = await writeSnapshot(temp, image, lease.statePath);
        await renameSnapshot(temp, snapshotPath);
        await syncDirectory(directory);
        snapshotRevision = image.state.revision;
        created = true;
        journals = [];
      } else {
        const loaded = await readSnapshot(snapshotPath, lease.statePath);
        image = loaded.image;
        snapshotBytes = loaded.bytes;
        snapshotRevision = image.state.revision;
        validatedState = loaded.state;
      }
      const replayed: { segment: JournalSegment; maxRevision: number }[] = [];
      let replayApplied = false;
      for (let index = 0; index < journals.length; index++) {
        const segment = journals[index];
        if (segment.base > image.state.revision)
          throw new SchedulerStateError(
            'state_invalid',
            `Control-log journal '${basename(segment.path)}' has a revision gap`,
          );
        const replay = await replayJournal(segment, image, index === journals.length - 1 && segment.bytes > 0);
        replayApplied ||= replay.applied;
        replayed.push({ segment, maxRevision: replay.maxRevision });
      }
      image.state = durableState(replayApplied ? validateImage(image, lease.statePath) : validatedState);
      const latestReplay = replayed.at(-1);
      let active = latestReplay?.maxRevision === image.state.revision ? latestReplay.segment : undefined;
      if (!active)
        active = { base: image.state.revision, path: transactionPath(directory, image.state.revision), bytes: 0 };
      const opened = await openJournal(active.path);
      journal = opened.handle;
      await syncDirectory(directory);
      await cleanDerivedPayloads(join(directory, DELIVERY_DIRECTORY));
      const log = new ControlLog({
        lease,
        directory,
        image,
        journalPath: active.path,
        journal,
        journalBytes: opened.bytes,
        snapshotBytes,
        snapshotRevision,
        created,
      });
      const covered = replayed.filter(
        ({ segment, maxRevision }) =>
          segment.path !== active.path && segment.base < snapshotRevision && maxRevision <= snapshotRevision,
      );
      for (const { segment } of covered)
        await rm(segment.path, { force: true }).catch((error) => log.addDiagnostic(error));
      if (covered.length) await syncDirectory(directory).catch((error) => log.addDiagnostic(error));
      return log;
    } catch (error) {
      await journal?.close().catch(() => undefined);
      await lease.release().catch(() => false);
      throw error;
    }
  }

  get diagnostics(): readonly string[] {
    return [...this.diagnosticsRing];
  }

  image(): ControlLogImage {
    return {
      state: hydrateState(this.imageValue),
      closed: new Map(this.imageValue.closed),
      noReplay: new Map(this.imageValue.noReplay),
    };
  }

  async commit(inputs: readonly ControlLogCommit[]): Promise<void> {
    if (this.closing) throw new Error('Control log is closing or closed');
    if (this.poisoned)
      throw new SchedulerStateError('storage_poisoned', 'Control log is poisoned after an unrecoverable append', {
        cause: this.poisoned,
      });
    if (!inputs.length) return;
    const staged: DurableImage = {
      state: durableState(this.imageValue.state),
      closed: new Map(this.imageValue.closed),
      noReplay: new Map(this.imageValue.noReplay),
      payloads: new Map(this.imageValue.payloads),
    };
    const transactions = inputs.map((input) => {
      const transaction = journalTransaction(staged, input);
      applyTransaction(staged, transaction);
      return transaction;
    });
    const bytes = Buffer.from(`${transactions.map((transaction) => JSON.stringify(transaction)).join('\n')}\n`);
    const rollbackOffset = this.syncedOffset;
    try {
      await writeAll(this.journal, bytes, rollbackOffset);
      await this.journal.sync();
      this.syncedOffset += bytes.byteLength;
    } catch (error) {
      try {
        await this.journal.truncate(rollbackOffset);
        await this.journal.sync();
      } catch (repairError) {
        this.poisoned = repairError instanceof Error ? repairError : new Error(String(repairError));
      }
      throw error;
    }
    this.imageValue = staged;
    if (!this.checkpointTask && this.syncedOffset > this.snapshotBytes)
      await this.rotateCheckpoint().catch((error) => this.addDiagnostic(error));
  }

  async materializeDeliveryPayload(eventIdInput: string, payloadHash: string): Promise<void> {
    const eventId = id(eventIdInput, 'delivery payload eventId');
    if (!isLowercaseSha256(payloadHash))
      throw new SchedulerStateError('state_invalid', 'Delivery payload hash is invalid');
    const message = this.imageValue.payloads.get(payloadHash);
    if (message === undefined)
      throw new SchedulerStateError('payload_missing', `Unresolved payload '${eventId}' is unavailable`);
    const value = `${JSON.stringify({ version: 1, eventId, payloadHash, message })}\n`;
    await atomicReplacePrivateFile(join(this.deliveryPayloadDirectory, `${eventId}.json`), value, {
      maxBytes: Buffer.byteLength(value),
    });
  }

  async removeDeliveryPayload(eventIdInput: string): Promise<void> {
    const eventId = id(eventIdInput, 'delivery payload eventId');
    await rm(join(this.deliveryPayloadDirectory, `${eventId}.json`), { force: true });
  }

  async close(): Promise<boolean> {
    if (this.closing) return false;
    this.closing = true;
    if (this.poisoned) return this.closePoisoned();
    await this.checkpointTask;
    if (this.snapshotRevision !== this.imageValue.state.revision || this.syncedOffset > 0) {
      await this.rotateCheckpoint().catch((error) => this.addDiagnostic(error));
      await this.checkpointTask;
    }
    if (this.poisoned) return this.closePoisoned();
    let closeError: unknown;
    try {
      await this.journal.close();
    } catch (error) {
      closeError = error;
    }
    const released = await this.lease.release();
    if (closeError) throw closeError;
    return released;
  }

  private async rotateCheckpoint(): Promise<void> {
    if (this.checkpointTask) return;
    let image: DurableImage;
    try {
      image = structuredClone(this.imageValue);
    } catch (error) {
      this.addDiagnostic(error);
      return;
    }
    const revision = image.state.revision;
    const sealedPath = this.journalPath;
    try {
      await this.journal.close();
    } catch (error) {
      this.poisoned = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
    const nextPath = transactionPath(this.directory, revision);
    let opened: { handle: FileHandle; bytes: number } | undefined;
    try {
      opened = await openJournal(nextPath);
      await syncDirectory(this.directory);
    } catch (error) {
      await opened?.handle.close().catch(() => undefined);
      try {
        const restored = await openJournal(sealedPath);
        this.journal = restored.handle;
        this.syncedOffset = restored.bytes;
      } catch (restoreError) {
        this.poisoned = restoreError instanceof Error ? restoreError : new Error(String(restoreError));
        throw restoreError;
      }
      this.addDiagnostic(error);
      return;
    }
    if (!opened) return;
    this.journal = opened.handle;
    this.journalPath = nextPath;
    this.syncedOffset = opened.bytes;
    let task: Promise<void>;
    task = this.writeCheckpoint(image, sealedPath)
      .catch((error) => this.addDiagnostic(error))
      .finally(() => {
        if (this.checkpointTask === task) this.checkpointTask = undefined;
      });
    this.checkpointTask = task;
  }

  private async writeCheckpoint(image: DurableImage, sealedPath: string): Promise<void> {
    const temp = join(this.directory, `.snapshot.${randomUUID()}.tmp`);
    try {
      const bytes = await writeSnapshot(temp, image, this.statePath);
      if (this.poisoned) return;
      await renameSnapshot(temp, this.snapshotPath);
      const replacementDurable = await syncDirectory(this.directory);
      this.snapshotBytes = bytes;
      this.snapshotRevision = image.state.revision;
      if (!replacementDurable || this.poisoned) return;
      const segments = await inspectControlDirectory(this.directory);
      for (const segment of segments) {
        if (segment.path === this.journalPath || segment.base >= image.state.revision) continue;
        await rm(segment.path, { force: true });
      }
      if (sealedPath !== this.journalPath && parseJournalBase(basename(sealedPath)) !== image.state.revision)
        await rm(sealedPath, { force: true });
      await syncDirectory(this.directory);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async closePoisoned(): Promise<never> {
    const poison = this.poisoned ?? new Error('Control log is poisoned');
    await this.checkpointTask;
    try {
      await this.journal.truncate(this.syncedOffset);
      await this.journal.sync();
    } catch (error) {
      this.addDiagnostic(error);
    }
    await this.journal.close().catch((error) => this.addDiagnostic(error));
    await this.lease.release().catch((error) => {
      this.addDiagnostic(error);
      return false;
    });
    throw new SchedulerStateError('storage_poisoned', 'Control log closed after an unrecoverable append', {
      cause: poison,
    });
  }

  private addDiagnostic(error: unknown): void {
    this.diagnosticsRing.push((error instanceof Error ? error.message : String(error)).slice(0, 500));
    if (this.diagnosticsRing.length > 32) this.diagnosticsRing.splice(0, this.diagnosticsRing.length - 32);
  }
}
