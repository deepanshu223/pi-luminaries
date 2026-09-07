import { isAbsolute, relative, resolve } from 'node:path';
import { hasUnsafeHumanFacingControl } from './identifiers.ts';

export const CAPABILITY_VERSION = 1 as const;
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_SET = new Set<string>(THINKING_LEVELS);

export interface CapabilityEnvelope {
  version: typeof CAPABILITY_VERSION;
  spawn: boolean;
  peerInterrupt: boolean;
  maxDepth: number;
  models?: string[];
  thinking?: ThinkingLevel[];
  tools?: string[];
  extensions?: string[];
  skills?: string[];
  promptTemplates?: string[];
  themes?: string[];
  cwdRoots?: string[];
}

export interface CapabilityRequest {
  spawn?: boolean;
  peerInterrupt?: boolean;
  maxDepth?: number;
  models?: string[];
  thinking?: ThinkingLevel[];
  tools?: string[];
  extensions?: string[];
  skills?: string[];
  promptTemplates?: string[];
  themes?: string[];
  cwdRoots?: string[];
}

export class CapabilityError extends Error {
  readonly code: 'capability_invalid' | 'capability_escalation';

  constructor(code: CapabilityError['code'], message: string) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CapabilityError('capability_invalid', `${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value))
    if (!keys.has(key)) throw new CapabilityError('capability_invalid', `${label} contains unknown field '${key}'`);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new CapabilityError('capability_invalid', `${label} must be boolean`);
  return value;
}

function integer(value: unknown, minimum: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new CapabilityError('capability_invalid', `${label} is outside its integer bound`);
  return value;
}

function cleanText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new CapabilityError('capability_invalid', `${label} must be nonempty text`);
  if (hasUnsafeHumanFacingControl(value))
    throw new CapabilityError('capability_invalid', `${label} contains a presentation control`);
  return value;
}

function list(value: unknown, label: string, paths = false): string[] {
  if (!Array.isArray(value)) throw new CapabilityError('capability_invalid', `${label} must be a list`);
  const result = value.map((item, index) => {
    const text = cleanText(item, `${label}[${index}]`);
    if (paths && !isAbsolute(text))
      throw new CapabilityError('capability_invalid', `${label}[${index}] must be an absolute path`);
    return paths ? resolve(text) : text;
  });
  return [...new Set(result)].sort();
}

function thinkingLevel(value: string): ThinkingLevel {
  if (!THINKING_SET.has(value))
    throw new CapabilityError('capability_invalid', `Unsupported thinking level '${value}'`);
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value;
  }
  throw new CapabilityError('capability_invalid', `Unsupported thinking level '${value}'`);
}

function thinkingList(value: unknown): ThinkingLevel[] {
  return list(value, 'capabilities.thinking').map((item) => thinkingLevel(item));
}

const FIELDS = [
  'version',
  'spawn',
  'peerInterrupt',
  'maxDepth',
  'models',
  'thinking',
  'tools',
  'extensions',
  'skills',
  'promptTemplates',
  'themes',
  'cwdRoots',
] as const;

export function normalizeCapabilityEnvelope(value: unknown): CapabilityEnvelope {
  const input = record(value, 'capabilities');
  exact(input, FIELDS, 'capabilities');
  if (input.version !== CAPABILITY_VERSION)
    throw new CapabilityError('capability_invalid', `Unsupported capability version: ${String(input.version)}`);
  return {
    version: CAPABILITY_VERSION,
    spawn: boolean(input.spawn, 'capabilities.spawn'),
    peerInterrupt: boolean(input.peerInterrupt, 'capabilities.peerInterrupt'),
    maxDepth: integer(input.maxDepth, 0, 'capabilities.maxDepth'),
    ...(input.models === undefined ? {} : { models: list(input.models, 'capabilities.models') }),
    ...(input.thinking === undefined ? {} : { thinking: thinkingList(input.thinking) }),
    ...(input.tools === undefined ? {} : { tools: list(input.tools, 'capabilities.tools') }),
    ...(input.extensions === undefined ? {} : { extensions: list(input.extensions, 'capabilities.extensions', true) }),
    ...(input.skills === undefined ? {} : { skills: list(input.skills, 'capabilities.skills', true) }),
    ...(input.promptTemplates === undefined
      ? {}
      : { promptTemplates: list(input.promptTemplates, 'capabilities.promptTemplates', true) }),
    ...(input.themes === undefined ? {} : { themes: list(input.themes, 'capabilities.themes', true) }),
    ...(input.cwdRoots === undefined ? {} : { cwdRoots: list(input.cwdRoots, 'capabilities.cwdRoots', true) }),
  };
}

export function normalizeCapabilityRequest(value: unknown): CapabilityRequest {
  const input = record(value, 'capability grant');
  exact(
    input,
    FIELDS.filter((field) => field !== 'version'),
    'capability grant',
  );
  return {
    ...(input.spawn === undefined ? {} : { spawn: boolean(input.spawn, 'grant.spawn') }),
    ...(input.peerInterrupt === undefined
      ? {}
      : { peerInterrupt: boolean(input.peerInterrupt, 'grant.peerInterrupt') }),
    ...(input.maxDepth === undefined ? {} : { maxDepth: integer(input.maxDepth, 0, 'grant.maxDepth') }),
    ...(input.models === undefined ? {} : { models: list(input.models, 'grant.models') }),
    ...(input.thinking === undefined ? {} : { thinking: thinkingList(input.thinking) }),
    ...(input.tools === undefined ? {} : { tools: list(input.tools, 'grant.tools') }),
    ...(input.extensions === undefined ? {} : { extensions: list(input.extensions, 'grant.extensions', true) }),
    ...(input.skills === undefined ? {} : { skills: list(input.skills, 'grant.skills', true) }),
    ...(input.promptTemplates === undefined
      ? {}
      : { promptTemplates: list(input.promptTemplates, 'grant.promptTemplates', true) }),
    ...(input.themes === undefined ? {} : { themes: list(input.themes, 'grant.themes', true) }),
    ...(input.cwdRoots === undefined ? {} : { cwdRoots: list(input.cwdRoots, 'grant.cwdRoots', true) }),
  };
}

export function defaultCapabilityEnvelope(cwd: string, maxDepth: number): CapabilityEnvelope {
  if (!isAbsolute(cwd)) throw new CapabilityError('capability_invalid', 'Root capability cwd must be absolute');
  return {
    version: CAPABILITY_VERSION,
    spawn: maxDepth > 0,
    peerInterrupt: true,
    maxDepth,
    cwdRoots: [resolve(cwd)],
  };
}

export function sameCapabilityCwd(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function within(child: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}

function narrowList(parent: readonly string[] | undefined, requested: readonly string[] | undefined, label: string) {
  if (requested === undefined) return parent === undefined ? undefined : [...parent];
  if (parent === undefined) return [...requested];
  const allowed = new Set(parent);
  const denied = requested.find((value) => !allowed.has(value));
  if (denied !== undefined)
    throw new CapabilityError('capability_escalation', `${label} '${denied}' is outside the ancestor ceiling`);
  return [...requested];
}

function narrowRoots(
  parent: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): string[] | undefined {
  if (requested === undefined) return parent === undefined ? undefined : [...parent];
  if (parent === undefined) return [...requested];
  const denied = requested.find((candidate) => !parent.some((root) => within(candidate, root)));
  if (denied !== undefined)
    throw new CapabilityError('capability_escalation', `cwd root '${denied}' is outside the ancestor ceiling`);
  return [...requested];
}

function narrowedInteger(requested: number | undefined, parent: number, label: string): number {
  if (requested === undefined) return parent;
  if (requested > parent)
    throw new CapabilityError('capability_escalation', `${label} cannot exceed the ancestor ceiling ${parent}`);
  return requested;
}

export function narrowCapabilityEnvelope(
  parent: CapabilityEnvelope,
  request: CapabilityRequest | undefined,
  childDepth: number,
): CapabilityEnvelope {
  const normalizedParent = normalizeCapabilityEnvelope(parent);
  const normalized = request === undefined ? {} : normalizeCapabilityRequest(request);
  const requestedSpawn = normalized.spawn ?? normalizedParent.spawn;
  const peerInterrupt = normalized.peerInterrupt ?? normalizedParent.peerInterrupt;
  if (requestedSpawn && !normalizedParent.spawn)
    throw new CapabilityError('capability_escalation', 'Spawn authority is outside the ancestor ceiling');
  if (peerInterrupt && !normalizedParent.peerInterrupt)
    throw new CapabilityError('capability_escalation', 'Peer interrupt is outside the ancestor ceiling');
  if (normalizedParent.maxDepth < childDepth)
    throw new CapabilityError(
      'capability_invalid',
      `grant.maxDepth is an absolute tree depth; ancestor depth ${normalizedParent.maxDepth} cannot contain child depth ${childDepth}`,
    );
  const candidateMaxDepth = requestedSpawn
    ? narrowedInteger(normalized.maxDepth, normalizedParent.maxDepth, 'grant.maxDepth (absolute tree depth)')
    : childDepth;
  if (candidateMaxDepth < childDepth)
    throw new CapabilityError(
      'capability_invalid',
      `grant.maxDepth is an absolute tree depth and cannot be below child depth ${childDepth}`,
    );
  const spawn = requestedSpawn && childDepth < candidateMaxDepth;
  const maxDepth = spawn ? candidateMaxDepth : childDepth;
  return normalizeCapabilityEnvelope({
    version: CAPABILITY_VERSION,
    spawn,
    peerInterrupt,
    maxDepth,
    models: narrowList(normalizedParent.models, normalized.models, 'model'),
    thinking: narrowList(normalizedParent.thinking, normalized.thinking, 'thinking level'),
    tools: narrowList(normalizedParent.tools, normalized.tools, 'tool'),
    extensions: narrowList(normalizedParent.extensions, normalized.extensions, 'extension'),
    skills: narrowList(normalizedParent.skills, normalized.skills, 'skill'),
    promptTemplates: narrowList(normalizedParent.promptTemplates, normalized.promptTemplates, 'prompt template'),
    themes: narrowList(normalizedParent.themes, normalized.themes, 'theme'),
    cwdRoots: narrowRoots(normalizedParent.cwdRoots, normalized.cwdRoots),
  });
}

export function capabilityAllows(
  envelope: CapabilityEnvelope,
  field: 'models' | 'thinking' | 'tools',
  value: string,
): boolean {
  const allowed = envelope[field];
  return allowed === undefined || allowed.some((candidate) => candidate === value);
}

export function capabilityAllowsCwd(envelope: CapabilityEnvelope, cwd: string): boolean {
  return envelope.cwdRoots === undefined || envelope.cwdRoots.some((root) => within(cwd, root));
}
