import { SchedulerStore, type PeerDispatchPlan } from './scheduler-store.ts';
import { type ActivationState } from './scheduler-state.ts';
export interface PiTurnSettlement {
    activationId: string;
    leaseToken: string;
    outcome: Exclude<ActivationState, 'running'>;
}
export interface PiDeliveryAttempt {
    eventId: string;
    deliveryKind: PeerDispatchPlan['deliveryKind'];
    activationId: string;
    accepted: Promise<void>;
    consumed: Promise<boolean>;
    settled: Promise<PiTurnSettlement>;
    cancelBoundary(outcome?: 'known' | 'indeterminate'): void;
}
export interface PiInterruptAttempt {
    accepted: Promise<void>;
    settled: Promise<PiTurnSettlement>;
    aborted: Promise<boolean>;
    cancelBoundary(outcome?: 'known' | 'indeterminate'): void;
}
/** Private transport seam. Durable selection and current-turn truth stay outside it. */
export interface DeliveryPort {
    readonly agentId: string;
    readonly runtimeOwner: string;
    deliver(plan: PeerDispatchPlan): PiDeliveryAttempt;
    interrupt(inputId: string): PiInterruptAttempt;
    close(): Promise<readonly PiTurnSettlement[]>;
}
interface RecipientDrainOptions {
    store: SchedulerStore;
    acquirePort(agentId: string): Promise<DeliveryPort>;
    onRecipientIdle?(agentId: string): void;
    onDiagnostic(error: unknown): void;
}
export declare function waitForPiEvidence<T>(promise: Promise<T>, label: string, timeoutMs?: number | null): Promise<T>;
/** One disposable per-recipient drain over the canonical Store inbox. */
export declare class RecipientDrain {
    private readonly options;
    private rootGate;
    private readonly pumps;
    private readonly pendingHints;
    private readonly dormantRecipients;
    private readonly quarantinedRecipients;
    private readonly background;
    private readonly pendingSettlements;
    private readonly diagnosticsRing;
    private readonly unsubscribe;
    private closing;
    constructor(options: RecipientDrainOptions);
    get diagnostics(): readonly string[];
    hint(recipientId: string): void;
    setDormant(recipientId: string, dormant: boolean): void;
    scanOnce(): void;
    runRoot<T>(operation: () => Promise<T>): Promise<T>;
    settle(settlement: PiTurnSettlement): Promise<void>;
    quiesce(): void;
    drain(): Promise<void>;
    observeSettlement(settlement: Promise<PiTurnSettlement>): void;
    close(): Promise<void>;
    private pump;
    private dispatchOne;
    private requeueBeforeBoundary;
    private consumeLater;
    private failAttempt;
    private removeDerivedPayload;
    private track;
    private hasRecoveryInput;
    private addDiagnostic;
}
export { formatPeerPrompt } from './peer-prompt.ts';
