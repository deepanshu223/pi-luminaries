export interface ModelBoundaryWait {
    inputId: string;
    promise: Promise<boolean>;
    cancel: () => void;
}
/** Correlates private Pi events only. Durable transitions remain with the recipient drain. */
export declare class ModelBoundaryTracker {
    private readonly pending;
    get hasPendingInput(): boolean;
    observe(inputId: string): ModelBoundaryWait;
    observeInterrupt(inputId: string): ModelBoundaryWait;
    captureEvent(event: unknown, queuedInputsCleared?: boolean): boolean;
    reject(error: Error): void;
    private add;
    private captureInput;
    private settle;
}
