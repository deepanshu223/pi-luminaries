import type { SchedulerStore } from './scheduler-store.ts';
export declare class RequestDeadlineCoordinator {
    private readonly store;
    private readonly onDiagnostic;
    private timer?;
    private unsubscribe?;
    private closing;
    private running?;
    private rescheduleRequested;
    constructor(store: SchedulerStore, onDiagnostic: (error: Error) => void);
    close(): void;
    settled(): Promise<void>;
    private schedule;
    private arm;
    private nextDeadline;
    private expireDue;
}
