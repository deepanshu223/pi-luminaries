import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { SchedulerStateError, within, type SchedulerState } from './scheduler-state.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

interface PhysicalCandidate {
  path: string;
  fileIdentity?: string;
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function pathKey(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function fileIdentity(info: { dev: bigint; ino: bigint }): string {
  return `${String(info.dev)}:${String(info.ino)}`;
}

async function canonicalDirectory(input: string, create: boolean): Promise<string> {
  if (!isAbsolute(input)) throw new SchedulerStateError('input_invalid', 'Private session directory must be absolute');
  const absolute = resolve(input);
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 });
  const canonical = resolve(await realpath(absolute));
  const info = await stat(canonical);
  if (!info.isDirectory())
    throw new SchedulerStateError('session_conflict', 'Private session directory is not a directory');
  return canonical;
}

async function canonicalExistingFile(input: string): Promise<PhysicalCandidate> {
  if (!isAbsolute(input)) throw new SchedulerStateError('input_invalid', 'Private session file must be absolute');
  const absolute = resolve(input);
  const linkInfo = await lstat(absolute);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile() || linkInfo.nlink !== 1)
    throw new SchedulerStateError(
      'session_conflict',
      'Private session file must be one physical single-link regular file',
    );
  const canonical = resolve(await realpath(absolute));
  const info = await stat(canonical, { bigint: true });
  return { path: canonical, fileIdentity: fileIdentity(info) };
}

async function canonicalPotentialPath(input: string): Promise<PhysicalCandidate> {
  let cursor = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      const linkInfo = await lstat(cursor);
      const canonical = resolve(await realpath(cursor));
      const path = missing.length ? resolve(canonical, ...missing) : canonical;
      return {
        path,
        ...(!missing.length && linkInfo.isFile()
          ? { fileIdentity: fileIdentity(await stat(canonical, { bigint: true })) }
          : {}),
      };
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      const parsed = parse(cursor);
      if (samePath(cursor, parsed.root)) return { path: resolve(parsed.root, ...missing) };
      missing.unshift(parsed.base);
      cursor = parsed.dir;
    }
  }
}

async function physicalSessionDirectories(
  state: Readonly<SchedulerState>,
  subjectId: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  await Promise.all(
    Object.values(state.agents).map(async (agent) => {
      if (!agent.sessionDir) return;
      try {
        result.set(agent.agentId, await canonicalDirectory(agent.sessionDir, false));
      } catch (error) {
        if (agent.agentId === subjectId) throw error;
      }
    }),
  );
  return result;
}

async function physicalSessionFiles(
  state: Readonly<SchedulerState>,
  subjectId: string,
): Promise<Map<string, PhysicalCandidate>> {
  const result = new Map<string, PhysicalCandidate>();
  await Promise.all(
    Object.values(state.agents).map(async (agent) => {
      if (!agent.sessionFile) return;
      try {
        result.set(agent.agentId, await canonicalExistingFile(agent.sessionFile));
      } catch (error) {
        if (agent.agentId === subjectId) throw error;
      }
    }),
  );
  return result;
}

export async function canonicalizeSessionDirectory(input: string): Promise<string> {
  try {
    return await canonicalDirectory(input, true);
  } catch (error) {
    if (error instanceof SchedulerStateError) throw error;
    throw new SchedulerStateError('session_conflict', 'Private session directory cannot be canonicalized', {
      cause: error,
    });
  }
}

export async function canonicalizeSessionFile(input: string, sessionDirectory: string): Promise<string> {
  try {
    const directory = await canonicalDirectory(sessionDirectory, false);
    const candidate = await canonicalExistingFile(input);
    if (!within(candidate.path, directory))
      throw new SchedulerStateError('session_escape', 'Session file escapes the physical private session directory');
    return candidate.path;
  } catch (error) {
    if (error instanceof SchedulerStateError) throw error;
    throw new SchedulerStateError('session_conflict', 'Private session file cannot be canonicalized', { cause: error });
  }
}

export async function validatePhysicalSessionNamespace(
  state: Readonly<SchedulerState>,
  agentId: string,
  failureCode: 'session_conflict' | 'state_invalid',
): Promise<void> {
  try {
    const agent = state.agents[agentId];
    if (!agent?.sessionDir)
      throw new SchedulerStateError(failureCode, `Agent '${agentId}' session directory is missing`);
    const directories = await physicalSessionDirectories(state, agentId);
    const directory = directories.get(agentId);
    if (!directory) throw new SchedulerStateError(failureCode, `Agent '${agentId}' session directory is missing`);
    if (!samePath(agent.sessionDir, directory))
      throw new SchedulerStateError(failureCode, `Agent '${agentId}' session directory is not canonical`);
    for (const [otherId, otherDirectory] of directories) {
      if (otherId === agentId) continue;
      if (within(directory, otherDirectory) || within(otherDirectory, directory))
        throw new SchedulerStateError(
          failureCode,
          `Agents '${agentId}' and '${otherId}' share an overlapping physical session namespace`,
        );
    }
    if (!agent.sessionFile) return;
    const files = await physicalSessionFiles(state, agentId);
    const candidate = files.get(agentId);
    if (!candidate) throw new SchedulerStateError(failureCode, `Agent '${agentId}' session file is missing`);
    if (!samePath(agent.sessionFile, candidate.path))
      throw new SchedulerStateError(failureCode, `Agent '${agentId}' session file is not canonical`);
    if (!within(candidate.path, directory))
      throw new SchedulerStateError(failureCode, `Agent '${agentId}' session file escapes its physical directory`);
    const identity = candidate.fileIdentity ?? pathKey(candidate.path);
    for (const [otherId, otherFile] of files) {
      if (otherId === agentId) continue;
      if ((otherFile.fileIdentity ?? pathKey(otherFile.path)) === identity)
        throw new SchedulerStateError(
          failureCode,
          `Agents '${agentId}' and '${otherId}' share one physical session file`,
        );
    }
  } catch (error) {
    if (error instanceof SchedulerStateError) throw error;
    throw new SchedulerStateError(failureCode, 'Physical private-session validation failed', { cause: error });
  }
}

export async function assertPhysicalReferencesPublic(
  references: readonly string[],
  cwd: string,
  agentId: string,
  state: Readonly<SchedulerState>,
  statePath: string,
): Promise<void> {
  if (!references.length) return;
  try {
    const privateDirectories = [
      await canonicalDirectory(dirname(statePath), false),
      ...(await physicalSessionDirectories(state, agentId)).values(),
    ];
    const candidates: PhysicalCandidate[] = [];
    for (const reference of references) {
      if (reference.includes('\0'))
        throw new SchedulerStateError('private_reference', 'Published reference contains a NUL byte');
      const candidate = await canonicalPotentialPath(resolve(cwd, reference));
      if (privateDirectories.some((directory) => within(candidate.path, directory)))
        throw new SchedulerStateError(
          'private_reference',
          `Published reference resolves into ${LUMINARIES_IDENTITY.label} private state`,
        );
      candidates.push(candidate);
    }
    const publicFiles = new Set(
      candidates.map((candidate) => candidate.fileIdentity).filter((identity): identity is string => !!identity),
    );
    if (!publicFiles.size) return;
    if (
      [...(await physicalSessionFiles(state, agentId)).values()].some(
        (candidate) => candidate.fileIdentity !== undefined && publicFiles.has(candidate.fileIdentity),
      )
    )
      throw new SchedulerStateError(
        'private_reference',
        `Published reference resolves into ${LUMINARIES_IDENTITY.label} private state`,
      );
  } catch (error) {
    if (error instanceof SchedulerStateError) throw error;
    throw new SchedulerStateError('private_reference', 'Published reference cannot be physically validated', {
      cause: error,
    });
  }
}

export async function validatePhysicalPublishedReferences(
  state: Readonly<SchedulerState>,
  statePath: string,
): Promise<void> {
  for (const agent of Object.values(state.agents))
    try {
      await assertPhysicalReferencesPublic(
        agent.expertCard.publishedRefs?.value ?? [],
        agent.cwd,
        agent.agentId,
        state,
        statePath,
      );
    } catch (error) {
      if (agent.parentId === null) throw error;
    }
}
