export declare const FORK_BOUNDARY_TEXT: Readonly<{
    selected: "[Pi Luminaries fork boundary] This luminaries_spawn call created the current child. Its visible assignment follows.";
    unresolved: "[Pi Luminaries fork boundary] This earlier parallel tool call was unresolved here; its result was not transferred.";
}>;
export declare const RECENT_BOUNDARY_TEXT: Readonly<{
    selected: "[Pi Luminaries recent boundary] This luminaries_spawn call created the current child. Its visible assignment follows.";
    unresolved: "[Pi Luminaries recent boundary] This earlier parallel tool call was unresolved here; its result was not transferred.";
}>;
export interface ForkProjection {
    messages: readonly unknown[];
    selectedToolCallId: string;
    omittedContentItems: number;
    repairedToolCalls: number;
}
/** Project Pi context directly through one exact spawn tool call. */
export declare function projectForkThroughToolCall(messages: readonly unknown[], toolCallId: string): ForkProjection;
export declare function projectRecentThroughToolCall(messages: readonly unknown[], toolCallId: string): ForkProjection;
