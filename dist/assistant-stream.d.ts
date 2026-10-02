export interface AssistantStreamState {
    message: Record<string, unknown>;
    activityPhase?: 'thinking' | 'writing';
}
export interface AssistantStreamResult {
    message?: Record<string, unknown>;
    state?: AssistantStreamState;
    changed: boolean;
    finished: boolean;
}
export declare function applyAssistantStreamEvent(current: AssistantStreamState | undefined, event: unknown): AssistantStreamResult;
export declare function assistantSnapshotEvent(state: AssistantStreamState | undefined): unknown | undefined;
export declare function eventIsAssistantStart(event: unknown): boolean;
