export type ChildInputDelivery = 'wake' | 'steer' | 'follow_up';
export interface ChildInput {
    inputId: string;
    payloadId: string;
    delivery: ChildInputDelivery;
    payloadHash: string;
    source: string;
    correlationId?: string;
    startingInput: boolean;
    lines?: readonly string[];
    /** Human-rendering kind echoed into the session record; absent on legacy deliveries. */
    presentation?: 'message' | 'notice';
}
export declare function childInputCommand(input: ChildInput): string;
export declare function parseChildInput(args: string): ChildInput;
export declare function readChildInputContent(input: ChildInput, outboxDirectory: string): Promise<{
    prompt: string;
    presentationContent: string;
}>;
