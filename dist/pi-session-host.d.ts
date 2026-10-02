export interface SeededSessionInput {
    sessionId: string;
    sessionDir: string;
    cwd: string;
    parentSession?: string;
    messages: readonly unknown[];
}
export interface PiSessionHost {
    createSeededSession(input: SeededSessionInput): Promise<string>;
    readContext(sessionFile: string, cwd: string, expectedSessionId: string): Promise<{
        entries: readonly unknown[];
        messages: readonly unknown[];
    }>;
    readMessages(sessionFile: string, cwd: string, expectedSessionId: string): Promise<readonly unknown[]>;
    inspectSession(sessionFile: string): Promise<PiSessionInfo>;
    listSessions(): Promise<readonly PiSessionChoice[]>;
    forkSession(input: ForkSessionInput): Promise<PiSessionInfo>;
}
export interface PiSessionInfo {
    sessionId: string;
    sessionFile: string;
    cwd: string;
    parentSession?: string;
    name?: string;
    model?: {
        provider: string;
        modelId: string;
    };
    thinking: string;
    entries: readonly unknown[];
    messages: readonly unknown[];
    contentHash: string;
}
export interface PiSessionChoice {
    sessionFile: string;
    sessionId: string;
    cwd: string;
    name?: string;
    modifiedAtMs: number;
    messageCount: number;
    firstMessage: string;
}
export interface ForkSessionInput {
    sourceFile: string;
    targetCwd: string;
    targetSessionDir?: string;
    sessionId: string;
    operationId: string;
    kind: 'detach' | 'adopt';
    contextNote: string;
    destinationName: string;
}
/** Estimate context using the same public message accounting Pi uses for compaction. */
export declare function estimatePiSessionMessages(messages: readonly unknown[]): number;
/** Lazy supported Pi API adapter; no Pi runtime object is retained across extension replacement. */
export declare function createPiSessionHost(): PiSessionHost;
