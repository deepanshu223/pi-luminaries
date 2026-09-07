import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasUnsafeHumanFacingControl } from './identifiers.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { deepFreeze, isRecord } from './scheduler-state.ts';

export type RootSettingSource = 'built-in' | 'global' | 'trusted-project';
export type ManagedExtensionState = 'always' | 'allow' | 'deny';
export type LuminariesServicePermission =
  | 'spawn'
  | 'directory'
  | 'message'
  | 'watch'
  | 'steer'
  | 'follow_up'
  | 'interrupt'
  | 'close'
  | 'close_subtree'
  | 'resume'
  | 'set_model'
  | 'set_thinking'
  | 'set_extensions'
  | 'set_grants';

export interface ResolvedManagedExtension {
  specifier: string;
  state: ManagedExtensionState;
  source: RootSettingSource;
  paths: readonly string[];
}

export interface ManagedExtensionPolicy {
  entries: readonly ResolvedManagedExtension[];
  allowedPaths: readonly string[];
}

export interface ManagedExtensionSource {
  specifier: string;
  scope: 'user' | 'project';
}

export interface ManagedExtensionHost {
  sources(): readonly ManagedExtensionSource[];
  resolve(settings: Readonly<Record<string, ManagedExtensionState>>): Promise<ManagedExtensionPolicy>;
  approve(
    specifier: string,
    scope: ManagedExtensionSource['scope'],
    install: boolean,
  ): Promise<ResolvedManagedExtension>;
}

export interface RootConfigurationSnapshot {
  maxOpenAgents: number;
  maxDepth: number;
  agentNames?: readonly string[];
  serviceGrant: readonly LuminariesServicePermission[];
  extensions: ManagedExtensionPolicy;
  sources: {
    maxOpenAgents: RootSettingSource;
    maxDepth: RootSettingSource;
    agentNames: RootSettingSource;
    serviceGrant: RootSettingSource;
  };
}

interface SettingsView {
  maxOpenAgents?: unknown;
  maxDepth?: unknown;
  agentNames?: unknown;
  agentExtensions: Map<string, { state: ManagedExtensionState; source: RootSettingSource }>;
  serviceGrant?: unknown;
}

interface LoadedPiSettings {
  global: unknown;
  project: unknown;
  resolveExtension(specifier: string, source: RootSettingSource): Promise<readonly string[]>;
}

export interface RootConfigurationHost {
  load(cwd: string, agentDir: string, projectTrusted: boolean): Promise<LoadedPiSettings>;
}

const DEFAULT_SERVICE_GRANT: readonly LuminariesServicePermission[] = [
  'spawn',
  'directory',
  'message',
  'watch',
  'steer',
  'follow_up',
  'interrupt',
];
const SERVICE_PERMISSIONS = new Set<LuminariesServicePermission>([
  ...DEFAULT_SERVICE_GRANT,
  'close',
  'close_subtree',
  'resume',
  'set_model',
  'set_thinking',
  'set_extensions',
  'set_grants',
]);
const SETTING_KEYS = new Set(['maxOpenAgents', 'maxDepth', 'agentNames', 'agentExtensions', 'serviceGrant']);

function settingSection(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const section = value[LUMINARIES_IDENTITY.settingsKey];
  if (section === undefined) return {};
  if (!isRecord(section)) throw new Error(`${source} ${LUMINARIES_IDENTITY.settingsKey} settings must be an object`);
  const unknown = Object.keys(section).find((key) => !SETTING_KEYS.has(key));
  if (unknown) throw new Error(`${source} ${LUMINARIES_IDENTITY.settingsKey} setting '${unknown}' is unsupported`);
  return section;
}

function extensionSettings(value: unknown, source: RootSettingSource): SettingsView['agentExtensions'] {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw new Error(`${source} agentExtensions must be an object`);
  const result: SettingsView['agentExtensions'] = new Map();
  for (const [specifier, state] of Object.entries(value)) {
    managedExtensionSpecifier(specifier, `${source} agentExtensions`);
    if (state !== 'always' && state !== 'allow' && state !== 'deny')
      throw new Error(`${source} agentExtensions '${specifier}' must be always, allow, or deny`);
    result.set(specifier, { state, source });
  }
  return result;
}

export function managedExtensionSpecifier(value: unknown, label = 'Pi extension source'): string {
  if (typeof value !== 'string' || !value || value === '*' || value.length > 4096 || hasUnsafeHumanFacingControl(value))
    throw new Error(`${label} contains an invalid Pi extension specifier`);
  return value;
}

function settingsView(value: unknown, source: RootSettingSource): SettingsView {
  const section = settingSection(value, source);
  return {
    maxOpenAgents: section.maxOpenAgents,
    maxDepth: section.maxDepth,
    agentNames: section.agentNames,
    agentExtensions: extensionSettings(section.agentExtensions, source),
    serviceGrant: section.serviceGrant,
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label} must be a positive finite integer`);
  return value;
}

function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim() || hasUnsafeHumanFacingControl(item))
      throw new Error(`${label}[${index}] is invalid`);
    return item;
  });
}

function serviceGrant(value: unknown, label: string): LuminariesServicePermission[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const result: LuminariesServicePermission[] = [];
  for (const permission of value) {
    if (typeof permission !== 'string' || !SERVICE_PERMISSIONS.has(permission as LuminariesServicePermission))
      throw new Error(`${label} contains unsupported permission '${String(permission)}'`);
    if (result.includes(permission as LuminariesServicePermission)) throw new Error(`${label} contains duplicates`);
    result.push(permission as LuminariesServicePermission);
  }
  return result;
}

export async function resolveRootConfiguration(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  host: RootConfigurationHost;
}): Promise<RootConfigurationSnapshot> {
  const loaded = await options.host.load(options.cwd, options.agentDir, options.projectTrusted);
  const global = settingsView(loaded.global, 'global');
  const project: SettingsView = options.projectTrusted
    ? settingsView(loaded.project, 'trusted-project')
    : { agentExtensions: new Map<string, { state: ManagedExtensionState; source: RootSettingSource }>() };
  const value = (key: 'maxOpenAgents' | 'maxDepth' | 'agentNames' | 'serviceGrant', fallback: unknown) => {
    if (project[key] !== undefined) return { value: project[key], source: 'trusted-project' as const };
    if (global[key] !== undefined) return { value: global[key], source: 'global' as const };
    return { value: fallback, source: 'built-in' as const };
  };
  const maxOpenAgents = value('maxOpenAgents', 10);
  const maxDepth = value('maxDepth', 1);
  const agentNames = value('agentNames', undefined);
  const configuredServiceGrant = value('serviceGrant', DEFAULT_SERVICE_GRANT);
  const effectiveMaxOpenAgents = positiveInteger(maxOpenAgents.value, `${maxOpenAgents.source} maxOpenAgents`);
  const effectiveMaxDepth = positiveInteger(maxDepth.value, `${maxDepth.source} maxDepth`);
  const effectiveAgentNames =
    agentNames.value === undefined ? undefined : names(agentNames.value, `${agentNames.source} agentNames`);
  const effectiveServiceGrant = serviceGrant(
    configuredServiceGrant.value,
    `${configuredServiceGrant.source} serviceGrant`,
  );
  const extensionSettings = new Map(global.agentExtensions);
  for (const [specifier, setting] of project.agentExtensions) extensionSettings.set(specifier, setting);

  const entries: ResolvedManagedExtension[] = [];
  for (const [specifier, setting] of extensionSettings) {
    if (setting.state === 'deny') {
      entries.push({ specifier, ...setting, paths: [] });
      continue;
    }
    const resolvedPaths = await loaded.resolveExtension(specifier, setting.source);
    if (resolvedPaths.length === 0) throw new Error(`Pi extension '${specifier}' resolved no loadable extensions`);
    const paths = [
      ...new Set(await Promise.all(resolvedPaths.map(async (path) => resolve(await realpath(path))))),
    ].sort();
    entries.push({ specifier, ...setting, paths });
  }
  entries.sort((left, right) => left.specifier.localeCompare(right.specifier));
  const permitted = entries.filter((entry) => entry.state !== 'deny');
  const extensions: ManagedExtensionPolicy = {
    entries,
    allowedPaths: [...new Set(permitted.flatMap((entry) => entry.paths))].sort(),
  };
  const snapshot: RootConfigurationSnapshot = {
    maxOpenAgents: effectiveMaxOpenAgents,
    maxDepth: effectiveMaxDepth,
    ...(effectiveAgentNames ? { agentNames: effectiveAgentNames } : {}),
    serviceGrant: effectiveServiceGrant,
    extensions,
    sources: {
      maxOpenAgents: maxOpenAgents.source,
      maxDepth: maxDepth.source,
      agentNames: agentNames.source,
      serviceGrant: configuredServiceGrant.source,
    },
  };
  return deepFreeze(snapshot);
}

export function resolveManagedExtensionSelection(
  policy: ManagedExtensionPolicy,
  selected: readonly string[] | undefined,
): { extensions: string[] } {
  const requested = [...new Set(selected ?? [])];
  const selectedEntries = requested.map((specifier) => {
    const entry = policy.entries.find((candidate) => candidate.specifier === specifier);
    if (!entry || entry.state !== 'allow')
      throw new Error(`Pi extension '${specifier}' is not allowed for explicit child selection`);
    return entry;
  });
  const loaded = [...policy.entries.filter((entry) => entry.state === 'always'), ...selectedEntries];
  return {
    extensions: [...new Set(loaded.flatMap((entry) => entry.paths))].sort(),
  };
}

export function selectedManagedExtensionSpecifiers(
  policy: ManagedExtensionPolicy,
  loadedPaths: readonly string[],
  recordedSources?: readonly string[],
): string[] {
  if (recordedSources)
    return recordedSources.filter(
      (specifier) => policy.entries.find((entry) => entry.specifier === specifier)?.state === 'allow',
    );
  const loaded = new Set(loadedPaths);
  return policy.entries
    .filter(
      (entry) => entry.state === 'allow' && entry.paths.length > 0 && entry.paths.every((path) => loaded.has(path)),
    )
    .map((entry) => entry.specifier);
}
