import { DurablePiActor } from './actor-runtime.ts';
import type { AcceptedBuild } from './accepted-build.ts';
import { PeerBridgeServer } from './peer-bridge.ts';
import { type PiInvocation } from './pi-rpc.ts';
import { SchedulerStore, type AgentRecord } from './scheduler-store.ts';
interface ActorPoolOptions {
    store: SchedulerStore;
    bridge: PeerBridgeServer;
    generation: string;
    acceptedBuild?: AcceptedBuild;
    invocation?: PiInvocation;
    provider?: string;
    extension?: string;
    env?: NodeJS.ProcessEnv;
    idleParkDelayMs?: number;
    managerRunning: () => boolean;
    onActorReady?: (actor: DurablePiActor) => void;
    onDiagnostic(error: unknown): void;
}
/** Owns disposable child processes; recipient ordering belongs to RecipientDrain. */
export declare class LuminariesActorPool {
    private readonly options;
    private readonly actorsValue;
    private readonly starts;
    private readonly credentials;
    private readonly parking;
    private readonly cleanups;
    private readonly cleanupByAgent;
    private readonly idleDeadlines;
    private idleTimer?;
    private closing;
    constructor(options: ActorPoolOptions);
    get actors(): ReadonlyMap<string, DurablePiActor>;
    ensure(agent: AgentRecord): Promise<DurablePiActor>;
    closeAgent(agentId: string): Promise<void>;
    private closeAgentImpl;
    closeAll(): Promise<void>;
    parkAll(mode: 'safe' | 'now'): Promise<void>;
    parkAgentAtSafeBoundary(agentId: string): Promise<void>;
    armIdle(agentId: string): void;
    cancelIdle(agentId: string): void;
    private beginParking;
    private scheduleIdleTimer;
    private reapIdle;
    private safeToPark;
    private join;
    private isCurrent;
    private restart;
    private start;
    private scheduleUnavailable;
    private settleIfLive;
}
export {};
