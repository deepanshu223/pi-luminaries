import type { LuminariesActorPool } from './actor-pool.ts';
import type { ModelDescriptor } from './spawn-configuration.ts';
import { type ManagedExtensionPolicy } from './root-configuration.ts';
import { type AgentRecord, type SchedulerPrincipal, type SchedulerStore } from './scheduler-store.ts';
import type { LuminariesControlRequest } from './luminaries-tools.ts';
export interface ConfigurationRuntimeResult {
    status: 'applied' | 'pending' | 'saved' | 'not_ready' | 'refused' | 'indeterminate';
    duplicate: boolean;
    agent?: Readonly<AgentRecord>;
    error?: string;
}
interface ConfigurationRuntimeOptions {
    store: SchedulerStore;
    actorPool: LuminariesActorPool;
    rootId: string;
    rootRuntime?: {
        setModel: (provider: string, modelId: string) => Promise<boolean>;
        setThinking: (level: string) => Promise<boolean>;
    };
    models: () => readonly ModelDescriptor[];
    managedExtensions: () => ManagedExtensionPolicy;
    onDiagnostic: (error: unknown) => void;
}
/** Owns the durable scheduler-to-live-Pi model/thinking transition and its crash boundary. */
export declare class AgentConfigurationCoordinator {
    private readonly options;
    private readonly extensionChanges;
    constructor(options: ConfigurationRuntimeOptions);
    apply(input: LuminariesControlRequest, principal: SchedulerPrincipal, targetId: string, ownerId: string, changeId: string, signal?: AbortSignal): Promise<ConfigurationRuntimeResult>;
    extensionChange(agentId: string): Promise<void> | undefined;
    settled(): Promise<void>;
    private applyExtensions;
    private finishExtensionChange;
    private resolve;
    private notice;
}
export {};
