import { randomUUID } from 'node:crypto';
import { open, mkdir, lstat, realpath, rename, rm, readdir, readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isLuminariesId, isUuid } from './identifiers.ts';
import { processAlive } from './process-liveness.ts';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
// Windows scanners and short-lived readers can temporarily deny replacement even
// after both files are closed. Keep the retry window bounded but long enough to
// cross ordinary contention instead of turning a healthy Store commit into EPERM.
const DEFAULT_RENAME_DELAYS = [50, 100, 250, 500, 1_000, 1_000, 1_000, 1_000] as const;
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_OWNER_BYTES = 4096;
const MAX_STALE_TEMPS = 16;
const MAX_RETAINED_TOMBSTONES = 8;
const reservedNamespaces = new Set<string>();
const runtimeStartIdentity = `runtime:${Math.round(Date.now() - process.uptime() * 1000)}`;

export type AtomicWriteData = string | Uint8Array;
export type AtomicWritePhase = 'temp-synced' | 'renamed' | 'directory-synced';
export interface AtomicWriteHooks {
  beforeRename?: (attempt: number) => void | Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
  observe?: (phase: AtomicWritePhase) => void | Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}
export interface AtomicWriteOptions {
  maxBytes?: number;
  renameDelaysMs?: readonly number[];
  hooks?: AtomicWriteHooks;
}
export interface AtomicWriteResult {
  path: string;
  bytes: number;
  postCommitWarning?: string;
}

export interface FileLeaseOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  processStartIdentity?: string;
  acquiredAtMs: number;
}
export interface FileLeaseHooks {
  beforeReleaseRename?: () => void | Promise<void>;
}
export interface FileLeaseOptions {
  hooks?: FileLeaseHooks;
}
export interface PrivateFileLease {
  readonly statePath: string;
  readonly lockPath: string;
  readonly owner: FileLeaseOwner;
  replace(data: AtomicWriteData, options?: AtomicWriteOptions): Promise<AtomicWriteResult>;
  replaceSibling(suffix: string, data: AtomicWriteData, options?: AtomicWriteOptions): Promise<AtomicWriteResult>;
  release(): Promise<boolean>;
}
export class FileLeaseConflictError extends Error {
  readonly owner?: FileLeaseOwner;
  readonly ownerIsLiveOrIndeterminate: boolean;
  constructor(message: string, owner?: FileLeaseOwner, ownerIsLiveOrIndeterminate = false) {
    super(message);
    this.name = 'FileLeaseConflictError';
    this.owner = owner;
    this.ownerIsLiveOrIndeterminate = ownerIsLiveOrIndeterminate;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function codeOf(error: unknown): string | undefined {
  const code = recordOf(error)?.code;
  return typeof code === 'string' ? code : undefined;
}
function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
function keyFor(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}
function positiveBound(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
}
function samePath(left: string, right: string): boolean {
  return keyFor(resolve(left)) === keyFor(resolve(right));
}
function isAsciiWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}
function splitAsciiWhitespace(value: string): string[] {
  const parts: string[] = [];
  let start = -1;
  for (let index = 0; index <= value.length; index++) {
    const boundary = index === value.length || isAsciiWhitespace(value.charCodeAt(index));
    if (!boundary && start < 0) start = index;
    else if (boundary && start >= 0) {
      parts.push(value.slice(start, index));
      start = -1;
    }
  }
  return parts;
}
function isDecimal(value: string): boolean {
  if (!value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}
function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  return value.length >= prefix.length && value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}
function hasUuidSuffix(value: string, prefix: string): boolean {
  return startsWithCaseInsensitive(value, prefix) && isUuid(value.slice(prefix.length));
}
function isTemporaryArtifact(value: string, base: string): boolean {
  const prefix = `.${base}.`;
  if (!startsWithCaseInsensitive(value, prefix) || !value.toLowerCase().endsWith('.tmp')) return false;
  const body = value.slice(prefix.length, -4);
  const separator = body.indexOf('.');
  return separator > 0 && isDecimal(body.slice(0, separator)) && isUuid(body.slice(separator + 1));
}

/** Resolve one private file namespace. The final target must be absent or a single-link regular file, never a symlink. */
export async function canonicalPrivateFilePath(input: string): Promise<{ path: string; key: string }> {
  if (!isAbsolute(input)) throw new TypeError('Private state path must be absolute');
  const absolute = resolve(input);
  const requestedParent = dirname(absolute);
  await mkdir(requestedParent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(requestedParent);
  const requestedTarget = join(requestedParent, basename(absolute));
  let canonicalTarget = join(canonicalParent, basename(absolute));
  try {
    const info = await lstat(requestedTarget);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
      throw new Error('Private state target must be a single-link regular file');
    canonicalTarget = await realpath(requestedTarget);
    if (!samePath(dirname(canonicalTarget), canonicalParent))
      throw new Error('Private state target escapes its canonical parent');
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
  return { path: canonicalTarget, key: keyFor(canonicalTarget) };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (process.platform !== 'win32' || codeOf(error) !== 'EPERM') throw error;
    }
  } finally {
    await handle.close();
  }
}

async function renameWithRetry(
  source: string,
  target: string,
  delays: readonly number[],
  hooks: AtomicWriteHooks,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await hooks.beforeRename?.(attempt);
      await rename(source, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(codeOf(error) ?? '') || attempt >= delays.length) throw error;
      await (hooks.wait ?? delay)(delays[attempt]);
    }
  }
}

/** Commit complete bytes by canonical same-directory private replacement. */
export async function atomicReplacePrivateFile(
  filePath: string,
  data: AtomicWriteData,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const { path: target } = await canonicalPrivateFilePath(filePath);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  positiveBound('Atomic file maxBytes', maxBytes);
  const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  if (bytes > maxBytes) throw new RangeError(`Atomic file payload exceeds ${maxBytes} bytes`);
  const delays = options.renameDelaysMs ?? DEFAULT_RENAME_DELAYS;
  if (delays.length > 8 || delays.some((item) => !Number.isSafeInteger(item) || item < 0 || item > 1000))
    throw new RangeError('Atomic rename delays must contain at most eight integers from 0 through 1000');
  const hooks = options.hooks ?? {};
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      if (typeof data === 'string') await handle.writeFile(data, 'utf8');
      else await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.observe?.('temp-synced');
    await renameWithRetry(temp, target, delays, hooks);
    committed = true;
    let warning: string | undefined;
    try {
      await hooks.observe?.('renamed');
    } catch (error) {
      warning = `Atomic rename committed but observer failed: ${boundedMessage(error)}`.slice(0, 500);
    }
    try {
      await (hooks.syncDirectory ?? syncDirectory)(dirname(target));
    } catch (error) {
      const next = `Atomic rename committed but directory sync failed: ${boundedMessage(error)}`;
      warning = warning ? `${warning}; ${next}`.slice(0, 500) : next.slice(0, 500);
    }
    try {
      await hooks.observe?.('directory-synced');
    } catch (error) {
      const next = `Atomic rename committed but observer failed: ${boundedMessage(error)}`;
      warning = warning ? `${warning}; ${next}`.slice(0, 500) : next.slice(0, 500);
    }
    return { path: target, bytes, ...(warning ? { postCommitWarning: warning } : {}) };
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return pid === process.pid ? runtimeStartIdentity : undefined;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    const startTicks = end < 0 ? undefined : splitAsciiWhitespace(raw.slice(end + 1))[19];
    return startTicks ? `linux:${startTicks}` : undefined;
  } catch {
    return undefined;
  }
}
function parseOwner(raw: string): FileLeaseOwner | undefined {
  try {
    const value = recordOf(JSON.parse(raw));
    if (!value) return undefined;
    const token = value.token;
    const pid = value.pid;
    const ownerHostname = value.hostname;
    const acquiredAtMs = value.acquiredAtMs;
    const processStartIdentity = value.processStartIdentity;
    if (
      value.version !== 1 ||
      typeof token !== 'string' ||
      !isUuid(token) ||
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      typeof ownerHostname !== 'string' ||
      !ownerHostname ||
      typeof acquiredAtMs !== 'number' ||
      !Number.isSafeInteger(acquiredAtMs) ||
      acquiredAtMs < 0 ||
      (processStartIdentity !== undefined && typeof processStartIdentity !== 'string')
    )
      return undefined;
    return {
      version: 1,
      token,
      pid,
      hostname: ownerHostname,
      acquiredAtMs,
      ...(processStartIdentity ? { processStartIdentity } : {}),
    };
  } catch {
    return undefined;
  }
}
async function readOwner(lockPath: string): Promise<FileLeaseOwner | undefined> {
  try {
    const ownerPath = join(lockPath, 'owner.json');
    if ((await stat(ownerPath)).size > MAX_OWNER_BYTES) return undefined;
    return parseOwner(await readFile(ownerPath, 'utf8'));
  } catch {
    return undefined;
  }
}
async function demonstrablyDead(owner: FileLeaseOwner): Promise<boolean> {
  if (owner.hostname !== hostname()) return false;
  const alive = processAlive(owner.pid);
  if (alive === false) return true;
  if (alive !== true || !owner.processStartIdentity) return false;
  const current = await processStartIdentity(owner.pid);
  return current !== undefined && current !== owner.processStartIdentity;
}

async function releaseOwnedLock(lockPath: string, token: string, hooks: FileLeaseHooks = {}): Promise<boolean> {
  const current = await readOwner(lockPath);
  if (!current || current.token !== token) return false;
  await hooks.beforeReleaseRename?.();
  const quarantine = `${lockPath}.release-${token}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
  const moved = await readOwner(quarantine);
  if (!moved || moved.token !== token) {
    try {
      await rename(quarantine, lockPath);
    } catch {
      /* Preserve mismatched evidence; never delete it. */
    }
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function createLeaseDirectory(lockPath: string, owner: FileLeaseOwner): Promise<boolean> {
  const candidate = `${lockPath}.candidate-${owner.token}`;
  await rm(candidate, { recursive: true, force: true });
  await mkdir(candidate, { mode: 0o700 });
  try {
    const handle = await open(join(candidate, 'owner.json'), 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(candidate, lockPath);
      return true;
    } catch (error) {
      if (
        await stat(lockPath).then(
          () => true,
          () => false,
        )
      )
        return false;
      throw error;
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function reclaimDeadTombstones(statePath: string): Promise<void> {
  const directory = dirname(statePath);
  const prefix = `${basename(statePath)}.lock.stale-`;
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) =>
    startsWithCaseInsensitive(entry.name, prefix),
  );
  for (const entry of entries) {
    if (!hasUuidSuffix(entry.name, prefix) || !entry.isDirectory())
      throw new Error('Malformed private-state lease tombstone exists');
    const tombstone = join(directory, entry.name);
    const contents = await readdir(tombstone, { withFileTypes: true });
    if (contents.length !== 1 || contents[0].name !== 'owner.json' || !contents[0].isFile())
      throw new Error('Malformed private-state lease tombstone exists');
    if ((await stat(join(tombstone, 'owner.json'))).size > MAX_OWNER_BYTES)
      throw new Error('Private-state lease tombstone owner exceeds its byte bound');
    const owner = await readOwner(tombstone);
    if (!owner || entry.name !== `${prefix}${owner.token}`)
      throw new Error('Malformed private-state lease tombstone exists');
    if (await demonstrablyDead(owner)) await rm(tombstone, { recursive: true, force: true });
  }
}

async function inspectBoundedArtifacts(statePath: string): Promise<void> {
  await reclaimDeadTombstones(statePath);
  const directory = dirname(statePath);
  const base = basename(statePath);
  const candidatePrefix = `${base}.lock.candidate-`;
  const releasePrefix = `${base}.lock.release-`;
  const tombstonePrefix = `${base}.lock.stale-`;
  const entries = await readdir(directory, { withFileTypes: true });
  const temps = entries.filter((entry) => isTemporaryArtifact(entry.name, base));
  const candidates = entries.filter((entry) => hasUuidSuffix(entry.name, candidatePrefix));
  const releases = entries.filter((entry) => hasUuidSuffix(entry.name, releasePrefix));
  const tombstones = entries.filter((entry) => hasUuidSuffix(entry.name, tombstonePrefix));
  const suspicious = entries.filter(
    (entry) =>
      (startsWithCaseInsensitive(entry.name, `.${base}.`) &&
        entry.name.toLowerCase().endsWith('.tmp') &&
        !isTemporaryArtifact(entry.name, base)) ||
      (startsWithCaseInsensitive(entry.name, candidatePrefix) && !hasUuidSuffix(entry.name, candidatePrefix)) ||
      (startsWithCaseInsensitive(entry.name, releasePrefix) && !hasUuidSuffix(entry.name, releasePrefix)) ||
      (startsWithCaseInsensitive(entry.name, tombstonePrefix) && !hasUuidSuffix(entry.name, tombstonePrefix)),
  );
  if (suspicious.length) throw new Error('Malformed private-state temporary or lease evidence exists');
  if (tombstones.length > MAX_RETAINED_TOMBSTONES)
    throw new Error('Private-state lease evidence could not be proven dead; preserved it and refused ownership');
  if (temps.length + candidates.length + releases.length > MAX_STALE_TEMPS)
    throw new Error('Private-state artifact capacity exhausted');
  for (const entry of temps) {
    if (!entry.isFile()) throw new Error('Private-state temporary artifact is not a file');
  }
  for (const entry of candidates) {
    if (!entry.isDirectory()) throw new Error('Private-state lease candidate is not a directory');
    const candidatePath = join(directory, entry.name);
    const contents = await readdir(candidatePath, { withFileTypes: true });
    if (contents.length > 1 || (contents.length === 1 && (contents[0].name !== 'owner.json' || !contents[0].isFile())))
      throw new Error('Malformed private-state lease candidate exists');
    if (contents.length === 1) {
      const ownerBytes = (await stat(join(candidatePath, 'owner.json'))).size;
      if (ownerBytes > MAX_OWNER_BYTES) throw new Error('Private-state lease candidate owner exceeds its byte bound');
    }
  }
  for (const entry of releases) {
    if (!entry.isDirectory()) throw new Error('Private-state release quarantine is not a directory');
    const releasePath = join(directory, entry.name);
    const contents = await readdir(releasePath, { withFileTypes: true });
    if (contents.length !== 1 || contents[0].name !== 'owner.json' || !contents[0].isFile())
      throw new Error('Malformed private-state release quarantine exists');
    const ownerBytes = (await stat(join(releasePath, 'owner.json'))).size;
    if (ownerBytes > MAX_OWNER_BYTES) throw new Error('Private-state release owner exceeds its byte bound');
  }
  for (const entry of tombstones) {
    if (!entry.isDirectory()) throw new Error('Private-state lease tombstone is not a directory');
    const owner = await readOwner(join(directory, entry.name));
    if (!owner || entry.name !== `${basename(statePath)}.lock.stale-${owner.token}`)
      throw new Error('Malformed private-state lease tombstone exists');
  }
  const releaseOwners = new Map<string, FileLeaseOwner>();
  for (const entry of releases) {
    const owner = await readOwner(join(directory, entry.name));
    if (!owner || entry.name !== `${basename(statePath)}.lock.release-${owner.token}`)
      throw new Error('Malformed private-state release quarantine exists');
    releaseOwners.set(entry.name, owner);
  }
  for (const entry of temps) await rm(join(directory, entry.name), { force: true });
  for (const entry of candidates) {
    // A candidate is never authoritative. Once this process owns the canonical
    // lock, no concurrent or crash-left candidate can win and exact bounded shapes are safe to remove.
    await rm(join(directory, entry.name), { recursive: true, force: true });
  }
  for (const entry of releases) {
    const owner = releaseOwners.get(entry.name);
    if (!owner) throw new Error('Private-state release quarantine lost its validated owner');
    if (await demonstrablyDead(owner)) await rm(join(directory, entry.name), { recursive: true, force: true });
  }
}

/** Acquire one lifetime writer lease for a canonical private state namespace. */
export async function acquirePrivateFileLease(
  input: string,
  options: FileLeaseOptions = {},
): Promise<PrivateFileLease> {
  const canonical = await canonicalPrivateFilePath(input);
  if (reservedNamespaces.has(canonical.key))
    throw new FileLeaseConflictError(`Private state is already owned in this process: ${canonical.path}`);
  reservedNamespaces.add(canonical.key);
  const lockPath = `${canonical.path}.lock`;
  const owner: FileLeaseOwner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    processStartIdentity: await processStartIdentity(process.pid),
    acquiredAtMs: Date.now(),
  };
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await createLeaseDirectory(lockPath, owner)) {
        acquired = true;
        break;
      }
      const existing = await readOwner(lockPath);
      if (!existing || !(await demonstrablyDead(existing)))
        throw new FileLeaseConflictError(
          `Private state lease is occupied or unreadable: ${canonical.path}`,
          existing,
          existing !== undefined,
        );
      await reclaimDeadTombstones(canonical.path);
      const tombstone = `${lockPath}.stale-${existing.token}`;
      try {
        await rename(lockPath, tombstone);
      } catch (error) {
        if (
          codeOf(error) === 'ENOENT' ||
          (await stat(tombstone).then(
            () => true,
            () => false,
          ))
        )
          continue;
        throw error;
      }
    }
    if (!acquired) throw new FileLeaseConflictError(`Private state lease could not be acquired: ${canonical.path}`);
    await inspectBoundedArtifacts(canonical.path);
    let resourceClosing = false;
    async function assertOwnership(): Promise<void> {
      const current = await readOwner(lockPath);
      if (!current || current.token !== owner.token)
        throw new FileLeaseConflictError(`Private state lease ownership changed: ${canonical.path}`, current);
    }
    async function runOwned<T>(operation: () => Promise<T>): Promise<T> {
      if (resourceClosing) throw new Error('Private state lease is closing or released');
      await assertOwnership();
      if (resourceClosing) throw new Error('Private state lease is closing or released');
      return operation();
    }
    return {
      statePath: canonical.path,
      lockPath,
      owner,
      replace(data, options) {
        return runOwned(() => atomicReplacePrivateFile(canonical.path, data, options));
      },
      replaceSibling(suffix, data, options) {
        const normalized = suffix.toLowerCase();
        if (!isLuminariesId(suffix) || normalized === 'lock' || normalized.startsWith('lock.'))
          return Promise.reject(new TypeError('Private state sibling suffix is invalid or reserved'));
        return runOwned(() => atomicReplacePrivateFile(`${canonical.path}.${suffix}`, data, options));
      },
      async release() {
        if (resourceClosing) return false;
        resourceClosing = true;
        try {
          return await releaseOwnedLock(lockPath, owner.token, options.hooks);
        } finally {
          reservedNamespaces.delete(canonical.key);
        }
      },
    };
  } catch (error) {
    if (acquired) await releaseOwnedLock(lockPath, owner.token).catch(() => false);
    reservedNamespaces.delete(canonical.key);
    throw error;
  }
}
