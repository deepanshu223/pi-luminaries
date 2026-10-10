import { type LuminariesServicePermission } from './scheduler-state.ts';
export type { LuminariesServicePermission } from './scheduler-state.ts';
export type RootSettingSource = 'built-in' | 'global' | 'trusted-project';
export type ManagedExtensionState = 'always' | 'allow' | 'deny';
export interface ResolvedManagedExtension {
    specifier: string;
    state: ManagedExtensionState;
    source: RootSettingSource;
    paths: readonly string[];
    unavailable?: string;
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
    approve(specifier: string, scope: ManagedExtensionSource['scope'], install: boolean): Promise<ResolvedManagedExtension>;
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
interface LoadedPiSettings {
    global: unknown;
    project: unknown;
    resolveExtension(specifier: string, source: RootSettingSource): Promise<readonly string[]>;
}
export interface RootConfigurationHost {
    load(cwd: string, agentDir: string, projectTrusted: boolean): Promise<LoadedPiSettings>;
}
export declare function managedExtensionSpecifier(value: unknown, label?: string): string;
export declare function resolveManagedExtensionEntry(specifier: string, state: ManagedExtensionState, source: RootSettingSource, resolvePaths: LoadedPiSettings['resolveExtension']): Promise<ResolvedManagedExtension>;
export declare function resolveRootConfiguration(options: {
    cwd: string;
    agentDir: string;
    projectTrusted: boolean;
    host: RootConfigurationHost;
}): Promise<RootConfigurationSnapshot>;
export declare function resolveManagedExtensionSelection(policy: ManagedExtensionPolicy, selected: readonly string[] | undefined): {
    extensions: string[];
};
export declare function selectedManagedExtensionSpecifiers(policy: ManagedExtensionPolicy, loadedPaths: readonly string[], recordedSources?: readonly string[]): string[];
