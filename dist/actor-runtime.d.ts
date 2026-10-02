import type { ChildProcess } from 'node:child_process';
import { type CancelledExtensionUiRequest, type PiInvocation, type PiRpcLimits } from './pi-rpc.ts';
import type { DeliveryPort, PiDeliveryAttempt, PiInterruptAttempt, PiTurnSettlement } from './peer-delivery.ts';
import { SchedulerStore, type PeerDispatchPlan } from './scheduler-store.ts';
export interface DurablePiActorOptions {
    store: SchedulerStore;
    agentId: string;
    invocation: PiInvocation;
    provider?: string;
    extension?: string;
    env?: NodeJS.ProcessEnv;
    limits?: PiRpcLimits;
    requestTimeoutMs?: number;
    allowRecovery?: boolean;
    onUnavailable?: (actor: DurablePiActor, error: Error) => void;
    onExtensionUiBlocked?: (actor: DurablePiActor, notice: CancelledExtensionUiRequest, sourceActivationId: string) => void;
    onDiagnostic?: (error: unknown) => void;
}
/** One private Pi process. Store transitions are owned by the recipient drain. */
export declare class DurablePiActor implements DeliveryPort {
    readonly agentId: string;
    readonly sessionFile: string;
    readonly runtimeOwner: string;
    private readonly rpc;
    private readonly timeoutMs;
    private readonly boundaries;
    private readonly activeToolEvents;
    private assistantStream?;
    private compacting;
    private readonly diagnosticsRing;
    private readonly uiChangeListeners;
    private readonly seenUiNotices;
    private current?;
    private closing;
    private closePromise?;
    private failure?;
    private recoveryRequired;
    private parkAfterSettlement?;
    private constructor();
    static start(options: DurablePiActorOptions): Promise<DurablePiActor>;
    get activityEvents(): readonly unknown[];
    get diagnostics(): readonly string[];
    get process(): ChildProcess | undefined;
    get isUsable(): boolean;
    get runtimeIdentity(): Readonly<{
        agentId: string;
        runtimeOwner: string;
    }>;
    get needsAttention(): boolean;
    requestParkAtNextSettlement(onSettled: () => void): boolean;
    onUiChange(listener: (event: unknown) => void): () => void;
    subscribeConversation(listener: (event: unknown) => void): {
        snapshot: readonly unknown[];
        unsubscribe: () => void;
    };
    setModel(provider: string, modelId: string): Promise<void>;
    setThinking(level: string): Promise<void>;
    requireRecovery(): void;
    deliver(plan: PeerDispatchPlan): PiDeliveryAttempt;
    interrupt(inputId: string): PiInterruptAttempt;
    close(): Promise<readonly PiTurnSettlement[]>;
    private newTurn;
    private closeImpl;
    private captureRpcEvent;
    private finishCurrent;
    private rejectTurns;
    private managedInput;
    private request;
    private captureActivity;
    private addDiagnostic;
    private assertUsable;
}
