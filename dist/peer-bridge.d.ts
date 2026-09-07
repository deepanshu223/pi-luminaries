import { type IncomingMessage, type ServerResponse } from 'node:http';
import { SchedulerStore } from './scheduler-store.ts';
import { DurablePiActor } from './actor-runtime.ts';
import type { LuminariesReceipt } from './luminaries-tools.ts';
import type { ParentContextSnapshot } from './context-session.ts';
export interface PeerBridgeCredential {
    url: string;
    token: string;
    agentId: string;
    rootId: string;
    sessionId?: string;
    generation?: string;
    buildId?: string;
}
export interface PeerBridgeBinding {
    agentId: string;
    rootId: string;
    runtimeOwner: string;
    sessionId?: string;
    generation?: string;
    buildId?: string;
}
export interface PeerBridgeToolCall {
    toolCallId: string;
    toolName: string;
    input: unknown;
    parentContext?: ParentContextSnapshot;
}
export type PeerBridgeToolHandler = (binding: Readonly<PeerBridgeBinding>, call: PeerBridgeToolCall, signal: AbortSignal) => Promise<LuminariesReceipt>;
export type PeerBridgeAttachmentHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
/** Bounded loopback framing/authentication. SchedulerStore remains the only durable authority. */
export declare class PeerBridgeServer {
    private readonly store;
    private readonly onDiagnostic?;
    private readonly bindings;
    private readonly sockets;
    private server?;
    private baseUrl?;
    private closePromise?;
    private toolHandler?;
    private attachmentHandler?;
    private attachmentObserver?;
    private readonly inFlightRequests;
    private readonly observerRequests;
    private readonly observerSockets;
    private accepting;
    constructor(options: {
        store: SchedulerStore;
        onDiagnostic?: (error: unknown) => void;
    });
    get url(): string;
    get activeCredentialCount(): number;
    setToolHandler(handler: PeerBridgeToolHandler | undefined): void;
    setAttachmentHandler(handler: PeerBridgeAttachmentHandler | undefined, observer?: (request: IncomingMessage) => boolean): void;
    start(): Promise<string>;
    issue(agentId: string, options?: {
        sessionId?: string;
        generation?: string;
        buildId?: string;
    }): PeerBridgeCredential;
    bind(credential: PeerBridgeCredential, actor: DurablePiActor): void;
    revoke(credential: PeerBridgeCredential): boolean;
    revokeAgent(agentId: string): number;
    close(): Promise<void>;
    private handle;
    private reply;
}
export declare function sendLuminariesToolCall(options: {
    url: string;
    token: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
    parentContext?: ParentContextSnapshot;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<LuminariesReceipt>;
export declare function sendLuminariesBuildIdentity(options: {
    url: string;
    token: string;
    buildId: string;
}): Promise<void>;
