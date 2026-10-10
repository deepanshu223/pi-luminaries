import { type CapabilityEnvelope, type CapabilityRequest, type ThinkingLevel } from './capability-policy.ts';
import { type ManagedExtensionPolicy } from './root-configuration.ts';
export type ContextMode = 'fresh' | 'recent' | 'fork' | 'custom';
export type SpawnCapabilityRequest = Omit<CapabilityRequest, 'tools' | 'extensions'>;
export interface ModelDescriptor {
    provider: string;
    id: string;
    contextWindow: number;
    reasoning?: boolean;
    thinkingLevel?: ThinkingLevel;
}
export interface SpawnConfigurationInput {
    context?: ContextMode;
    recentTokens?: number;
    systemPrompt?: string;
    model?: string;
    thinking?: ThinkingLevel;
    cwd?: string;
    extensions?: string[];
    skills?: string[];
    promptTemplates?: string[];
    themes?: string[];
    grants?: SpawnCapabilityRequest;
}
export interface EffectiveSpawnConfiguration {
    context: ContextMode;
    recentTokens?: number;
    systemPrompt?: string;
    provider?: string;
    model?: string;
    modelKey?: string;
    contextWindow?: number;
    thinking?: ThinkingLevel;
    cwd: string;
    extensions?: string[];
    skills?: string[];
    promptTemplates?: string[];
    themes?: string[];
    grants?: SpawnCapabilityRequest;
}
export declare function resolveSpawnConfiguration(options: {
    input: SpawnConfigurationInput;
    parentCapabilities: CapabilityEnvelope;
    parentCwd: string;
    parentProvider?: string;
    parentModel?: string;
    parentThinking?: string;
    models: readonly ModelDescriptor[];
    managedExtensions?: ManagedExtensionPolicy;
}): EffectiveSpawnConfiguration;
