import type { DurablePiActor } from './actor-runtime.ts';
import { type LuminariesPiMessage } from './command-center-projection.ts';
import { type SchedulerStore } from './scheduler-store.ts';
import { type SchedulerState } from './scheduler-state.ts';
export interface LuminariesConversationReset {
    type: 'reset';
    epoch: string;
    agentId: string;
    incarnation: number;
    revision: number;
    hydrated: boolean;
    messages: readonly LuminariesPiMessage[];
    error?: string;
}
export interface LuminariesConversationSplice {
    type: 'splice';
    epoch: string;
    agentId: string;
    incarnation: number;
    revision: number;
    baseRevision: number;
    start: number;
    deleteCount: number;
    messages: readonly LuminariesPiMessage[];
}
export type LuminariesConversationUpdate = LuminariesConversationReset | LuminariesConversationSplice;
interface ConversationStreamOptions {
    store: SchedulerStore;
    epoch: string;
    currentActor: (agentId: string) => DurablePiActor | undefined;
    rootAgentId?: string;
    currentRootEvents?: (listener: (event: unknown) => void) => {
        snapshot: readonly unknown[];
        unsubscribe: () => void;
    };
    readSession?: (agentId: string) => Promise<{
        messages: readonly unknown[];
        state?: Readonly<SchedulerState>;
    }>;
    running: () => boolean;
    onDiagnostic: (error: unknown) => void;
}
/** Demand-driven private Pi conversation publication for selected collaborators only. */
export declare class AgentConversationStreams {
    private readonly options;
    private readonly channels;
    private readonly loads;
    private revision;
    private closing;
    constructor(options: ConversationStreamOptions);
    subscribe(agentId: string, listener: (update: LuminariesConversationUpdate) => void): () => void;
    snapshot(agentId: string): LuminariesConversationReset;
    bindActor(actor: DurablePiActor): void;
    reconcile(): void;
    quiesce(): void;
    close(): Promise<void>;
    private bindChannelSource;
    private sourceChanged;
    private applyEvent;
    private replaceToolResult;
    private reload;
    private load;
    private publishReset;
    private publishSplice;
    private reset;
    private notify;
    private notifyOne;
    private nextRevision;
}
export {};
