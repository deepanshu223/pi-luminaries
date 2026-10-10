import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { type JsonlLimits } from './jsonl.ts';
export interface PiInvocation {
    command: string;
    args?: readonly string[];
}
export interface PrivateLaunchOptions {
    privateSessionDir: string;
    sessionId: string;
    cwd: string;
    agentId?: string;
    model?: string;
    thinking?: string;
    provider?: string;
    extension?: string;
    noExtensions?: boolean;
    tools?: readonly string[];
    extensions?: readonly string[];
    skills?: readonly string[];
    promptTemplates?: readonly string[];
    themes?: readonly string[];
    noContextFiles?: boolean;
    systemPrompt?: string;
    sessionFile?: string;
}
export interface PrivateLaunch {
    invocation: PiInvocation;
    sessionId: string;
    privateSessionDir: string;
    sessionFile?: string;
    cwd: string;
}
export interface PiState {
    sessionId?: string;
    sessionFile?: string;
    [key: string]: unknown;
}
export interface PiRpcLimits extends JsonlLimits {
    maxPendingRequests?: number;
    maxQueuedCommands?: number;
    maxStderrBytes?: number;
    maxDiagnostics?: number;
}
export interface PiRpcOptions {
    invocation: PiInvocation;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    limits?: PiRpcLimits;
    requestTimeoutMs?: number;
}
export interface RpcResponse {
    id?: string | number;
    [key: string]: unknown;
}
export interface CancelledExtensionUiRequest {
    id: string;
    method: 'select' | 'confirm' | 'input' | 'editor';
    title: string;
}
export declare class PiRpcCommandError extends Error {
    readonly command: string;
    constructor(command: string, message: string);
}
/** Build a private, fresh or exact-resume Pi RPC invocation. */
export declare function buildPrivateSessionLaunch(options: PrivateLaunchOptions, invocation: PiInvocation): PrivateLaunch;
/** Resolve an explicit invocation, or the exact executable/script running this Pi owner. */
export declare function resolvePiInvocation(explicit?: PiInvocation): PiInvocation;
export declare function verifyPrivateSessionState(value: unknown, expected: {
    sessionId: string;
    privateSessionDir: string;
    sessionFile?: string;
}): PiState;
/** One Pi RPC process. Command writes are serialized; responses/events are independent. */
export declare class PiRpcProcess extends EventEmitter {
    private child?;
    private reader?;
    private readonly pending;
    private writeChain;
    private queuedCommands;
    private sequence;
    private closed;
    private intentionalClose;
    private exited;
    private exitError?;
    private failureEmitted;
    private closePromise?;
    private terminationPromise?;
    private readonly stderrRing;
    private readonly diagnosticsRing;
    private readonly limits;
    private readonly options;
    constructor(options: PiRpcOptions);
    start(): void;
    request(command: Record<string, unknown>, timeoutMs?: number | null): Promise<RpcResponse>;
    getState(expected: {
        sessionId: string;
        privateSessionDir: string;
        sessionFile?: string;
    }, timeoutMs?: number): Promise<PiState>;
    get stderr(): readonly string[];
    get diagnostics(): readonly string[];
    get process(): ChildProcess | undefined;
    close(timeoutMs?: number): Promise<void>;
    private closeImpl;
    private write;
    private handleRecord;
    private captureStderr;
    private rejectPending;
    private recordFailure;
    private safeEmit;
    private addDiagnostic;
    private terminateChild;
    private waitForExit;
    private removeChildListeners;
}
