import type { DeliveryPort, PiInterruptAttempt, PiTurnSettlement } from './peer-delivery.ts';
import { type SchedulerStore } from './scheduler-store.ts';
export interface RootTransport {
    sendMessage(message: {
        customType: string;
        content: string;
        display: boolean;
        details: unknown;
    }, options?: {
        triggerTurn?: boolean;
        deliverAs?: 'steer' | 'followUp' | 'nextTurn';
    }): void | Promise<void>;
    abort?(): void | Promise<void>;
}
interface RootRuntimeOptions {
    store: SchedulerStore;
    rootId: string;
    incarnation: string;
    transport: () => RootTransport | undefined;
}
/** Stock parent-Pi transport adapter. The manager lease is the root runtime authority. */
export declare class RootRuntime {
    readonly agentId: string;
    readonly runtimeOwner: string;
    private readonly store;
    private readonly transportValue;
    private readonly boundaries;
    private readonly settlements;
    private readonly uiChangeListeners;
    private readonly activeToolEvents;
    private assistantStream?;
    private activationId?;
    private nativeTurnSequence;
    private nativeAbortSeen;
    private closing;
    constructor(options: RootRuntimeOptions);
    deliveryPort(): DeliveryPort;
    onUiChange(listener: (event: unknown) => void): () => void;
    subscribeConversation(listener: (event: unknown) => void): {
        snapshot: readonly unknown[];
        unsubscribe: () => void;
    };
    beforeAgentStartRequiresGate(): boolean;
    beforeAgentStart(_prompt: string): Promise<void>;
    messageStart(message: unknown): void;
    messageUpdate(event: unknown): void;
    messageEnd(message: unknown): void;
    agentSettled(outcome?: PiTurnSettlement['outcome']): PiTurnSettlement | undefined;
    private deliverAtSequence;
    interrupt(inputId: string): PiInterruptAttempt;
    close(): Promise<readonly PiTurnSettlement[]>;
    private liveActivation;
    private currentActivation;
    private assertOpen;
    private captureEvent;
}
export {};
