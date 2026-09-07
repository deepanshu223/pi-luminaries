import type { LuminariesCommandCenterHost } from './command-center.ts';
import type { LuminariesCommandCenterAgent, LuminariesCommandCenterProjection } from './command-center-projection.ts';
import type { LuminariesConversationReset, LuminariesConversationUpdate } from './agent-conversations.ts';
import type { LuminariesToolName, LuminariesToolResult } from './luminaries-tools.ts';
import type { PeerBridgeServer } from './peer-bridge.ts';
import type { ModelDescriptor } from './spawn-configuration.ts';
import type { ManagedExtensionSource } from './root-configuration.ts';
export interface AttachmentDescriptor {
    v: 1;
    rootId: string;
    label: string;
    cwd: string;
    sessionId: string;
    sessionLabel: string;
    url: string;
    token: string;
    pid: number;
    hostname: string;
}
interface AttachmentTarget {
    agentId: string;
    projection: LuminariesCommandCenterProjection;
}
export declare class AttachmentTargetError extends Error {
    readonly code?: string;
    constructor(message: string, code?: string);
}
/** Root-lifetime view/control endpoint on the existing authenticated loopback server. */
export declare class LuminariesAttachmentServer {
    private readonly host;
    private readonly bridge;
    private readonly descriptorPath;
    private readonly rootId;
    private readonly epoch;
    private readonly cwd;
    private readonly sessionId;
    private readonly sessionLabel;
    private readonly resolveTarget;
    private readonly token;
    private readonly clients;
    private readonly conversationGroups;
    private directoryUnsubscribe?;
    private started;
    constructor(options: {
        host: LuminariesCommandCenterHost;
        bridge: PeerBridgeServer;
        descriptorPath: string;
        rootId: string;
        epoch: string;
        cwd: string;
        sessionId: string;
        sessionLabel: string;
        resolveTarget(reference: string): Promise<AttachmentTarget>;
    });
    start(): Promise<void>;
    close(): Promise<void>;
    private handle;
    private attachDirectory;
    private attachConversation;
    private broadcastDirectory;
    private writeDirectory;
    private broadcastConversation;
    private writeConversation;
    private disconnectDirectory;
    private disconnectConversation;
    private encodeDirectory;
    private encodeStream;
    private receiptPath;
    private readReceipt;
    private writeReceipt;
    private execute;
    private reply;
}
/** Disposable terminal client. It retains only the latest immutable projection. */
export declare class LuminariesAttachmentClient implements LuminariesCommandCenterHost {
    private readonly descriptorPath;
    private descriptor;
    private readonly listeners;
    private readonly abort;
    private readonly conversationControllers;
    private readonly conversationStreams;
    private readonly conversationSnapshots;
    private directoryEpoch?;
    private projection?;
    private models;
    private thinkingLevels;
    private extensions;
    private extensionSources;
    private offlineReason?;
    private stream?;
    private resolveReady;
    private rejectReady;
    private readonly ready;
    private readonly pendingMutations;
    private constructor();
    static connect(descriptorPath: string): Promise<LuminariesAttachmentClient>;
    commandCenterProjection(): LuminariesCommandCenterProjection;
    onCommandCenterChange(listener: (projection: LuminariesCommandCenterProjection) => void): () => void;
    readOnlyReason(): string | undefined;
    onAgentConversationChange(agentId: string, listener: (update: LuminariesConversationUpdate) => void): () => void;
    agentConversationSnapshot(agentId: string): LuminariesConversationReset;
    operatorInput(agentId: string, message: string, mode: 'auto' | 'follow_up'): Promise<'woken' | 'steered' | 'follow_up_queued'>;
    operatorInterrupt(agentId: string): Promise<'interrupted' | 'already_finished'>;
    operatorExecute(toolName: LuminariesToolName, input: unknown): Promise<LuminariesToolResult>;
    operatorSetCapacity(capacity: number): Promise<void>;
    operatorSetDepth(depth: number): Promise<void>;
    operatorApproveExtension(specifier: string, scope: ManagedExtensionSource['scope'], install: boolean): Promise<void>;
    operatorParkAll(mode: 'safe' | 'now'): Promise<void>;
    operatorDetachSession(agentId: string): Promise<{
        sourceAgentId: string;
        sourceLifecycle: 'closed';
        sessionId: string;
        sessionFile: string;
        sessionName: string;
        command: string;
    } | {
        status: 'not_ready';
        message: string;
    }>;
    operatorAdoptSession(sessionFile: string, options?: {
        name?: string;
        assignment?: string;
        expertise?: string[];
    }): Promise<{
        sourceSessionFile: string;
        agentId: string;
        handle: string;
        sessionId: string;
    }>;
    operatorSessions(): Promise<readonly {
        sessionFile: string;
        sessionId: string;
        cwd: string;
        name?: string;
        modifiedAtMs: number;
        messageCount: number;
        firstMessage: string;
    }[]>;
    operatorInspectSessionReference(reference: string): Promise<{
        sessionFile: string;
        sessionId: string;
        cwd: string;
        name?: string;
    }>;
    operatorClosedHistory(): Promise<{
        revision: number;
        agents: readonly LuminariesCommandCenterAgent[];
        archivedCount: number;
    }>;
    operatorSetArchived(agentId: string, archived: boolean): Promise<void>;
    operatorResume(agentId: string): Promise<void>;
    attachmentInvocation(): string;
    operatorModels(): readonly ModelDescriptor[];
    operatorThinkingLevels(): readonly string[];
    operatorSelectableExtensions(): readonly {
        specifier: string;
        source: string;
    }[];
    operatorExtensionSources(): readonly ManagedExtensionSource[];
    resolveTarget(target: string): Promise<string>;
    resolveTargetIdentity(target: string): Promise<{
        agentId: string;
        handle: string;
    }>;
    close(): Promise<void>;
    private readStream;
    private refreshDescriptor;
    private applyDirectory;
    private readConversation;
    private readFrames;
    private mutate;
    private action;
    private acknowledge;
    private setOffline;
    private publishProjection;
}
export interface AttachmentCandidate {
    descriptorPath: string;
    descriptor: AttachmentDescriptor;
}
export declare function discoverAttachmentDescriptors(agentDir: string, cwd: string): Promise<AttachmentCandidate[]>;
export {};
