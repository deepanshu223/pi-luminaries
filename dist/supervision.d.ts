import type { SchedulerStore } from './scheduler-store.ts';
export declare class SupervisionCoordinator {
    private readonly store;
    private readonly onDiagnostic;
    private readonly warningEscalationMs;
    private readonly episodes;
    private unsubscribe?;
    private pending;
    private running?;
    private closing;
    constructor(store: SchedulerStore, onDiagnostic: (error: Error) => void, warningEscalationMs?: number);
    close(): void;
    settled(): Promise<void>;
    private schedule;
    private scanLoop;
    private publish;
    private escalatePersistent;
    private clearEpisode;
    private emit;
}
