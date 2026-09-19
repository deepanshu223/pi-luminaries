import type { ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { type LuminariesNativeConversationModule } from './command-center-view.ts';
import type { LuminariesCommandCenterAgent, LuminariesCommandCenterProjection } from './command-center-projection.ts';
import type { LuminariesConversationReset, LuminariesConversationUpdate } from './agent-conversations.ts';
import type { LuminariesToolDefinition, LuminariesToolName, LuminariesToolResult } from './luminaries-tools.ts';
import type { ModelDescriptor } from './spawn-configuration.ts';
import type { ManagedExtensionSource } from './root-configuration.ts';
export { projectCommandCenter } from './command-center-projection.ts';
export type { LuminariesCommandCenterAgent, LuminariesCommandCenterProjection, LuminariesHumanState, LuminariesPiMessage, } from './command-center-projection.ts';
export { LuminariesCommandCenterComponent, renderAmbientWidget } from './command-center-view.ts';
export type { LuminariesCommandCenterActions, LuminariesComponent, LuminariesNativeConversationUi, LuminariesTheme, } from './command-center-view.ts';
export type { LuminariesConversationSplice } from './agent-conversations.ts';
export type { LuminariesConversationReset, LuminariesConversationUpdate };
export type { LuminariesTerminalWidth } from './terminal-width.ts';
type LuminariesExtensionUi = Pick<ExtensionUIContext, 'setWidget'> & Partial<Pick<ExtensionUIContext, 'custom' | 'notify' | 'select'>>;
export interface LuminariesUiContext {
    mode?: ExtensionContext['mode'];
    parentConversation?: boolean;
    ui?: LuminariesExtensionUi;
}
export interface LuminariesCommandCenterHost {
    commandCenterProjection(): LuminariesCommandCenterProjection;
    onCommandCenterChange(listener: (projection: LuminariesCommandCenterProjection) => void): () => void;
    readOnlyReason?(): string | undefined;
    onAgentConversationChange(agentId: string, listener: (update: LuminariesConversationUpdate) => void): () => void;
    agentConversationSnapshot(agentId: string): LuminariesConversationReset;
    operatorInput(agentId: string, message: string, mode: 'auto' | 'follow_up', operationId?: string): Promise<'woken' | 'steered' | 'follow_up_queued'>;
    operatorInterrupt(agentId: string, operationId?: string): Promise<'interrupted' | 'already_finished'>;
    operatorSetCapacity(capacity: number, operationId?: string): Promise<void>;
    operatorSetDepth(depth: number, operationId?: string): Promise<void>;
    operatorParkAll(mode: 'safe' | 'now', operationId?: string): Promise<void>;
    operatorDetachSession(agentId: string, operationId?: string): Promise<{
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
    operatorAdoptSession(sessionFile: string, options?: {
        name?: string;
        assignment?: string;
        expertise?: string[];
    }, operationId?: string): Promise<{
        sourceSessionFile: string;
        agentId: string;
        handle: string;
        sessionId: string;
    }>;
    operatorClosedHistory(): Promise<{
        revision: number;
        agents: readonly LuminariesCommandCenterAgent[];
        archivedCount: number;
    }>;
    operatorSetArchived(agentId: string, archived: boolean, operationId?: string): Promise<void>;
    operatorResume(agentId: string, operationId?: string): Promise<void>;
    operatorExecute(toolName: LuminariesToolName, input: unknown, operationId?: string): Promise<LuminariesToolResult>;
    attachmentInvocation(): string;
    operatorModels(): readonly ModelDescriptor[];
    operatorThinkingLevels(): readonly string[];
    operatorSelectableExtensions(): readonly {
        specifier: string;
        source: string;
    }[];
    operatorExtensionSources(): readonly ManagedExtensionSource[];
    operatorApproveExtension(specifier: string, scope: ManagedExtensionSource['scope'], install: boolean, operationId?: string): Promise<void>;
}
/** Session-bound owner of the active-only widget, shared motion clock, and foreground workspace. */
export declare class LuminariesCommandCenterController {
    private readonly loadPiConversation;
    private readonly luminariesToolDefinitions?;
    private context?;
    private manager?;
    private unsubscribe?;
    private timer?;
    private phase;
    private motionEnabled;
    private widgetRender?;
    private workspaceRender?;
    private widgetRegistered;
    private workspaceOpen;
    private openPromise?;
    private workspaceDone?;
    private workspaceComponent?;
    private workspaceDialogClose?;
    private workspaceMouse?;
    private workspaceTui?;
    private workspaceKeybindings?;
    private nativeUi?;
    private terminalWidth;
    private projection?;
    private closedHistory?;
    private closedHistoryRefresh?;
    private closedHistoryRefreshRequested;
    private uiViewGeneration;
    private renderQueued;
    private pendingWorkspaceInvalidate;
    private timerIntervalMs?;
    constructor(loadPiConversation?: () => Promise<LuminariesNativeConversationModule>, luminariesToolDefinitions?: ReadonlyMap<string, LuminariesToolDefinition>);
    attach(context: LuminariesUiContext, manager: LuminariesCommandCenterHost): void;
    open(context?: LuminariesUiContext, initialAgentId?: string): Promise<void>;
    dispose(): void;
    private dialogUi;
    private dialogInput;
    private dialogEditor;
    private dialogSelect;
    private dialogSessionSelect;
    private dialogConfirm;
    private workspaceDialog;
    private dialogNumber;
    private spawnFromCommandCenter;
    private multicastFromCommandCenter;
    private messageFromCommandCenter;
    private openActionPalette;
    private approveExtensionSource;
    private changeExtensions;
    private detachSession;
    private refresh;
    private syncTimer;
    private withClosedHistory;
    private refreshClosedHistory;
    private ensureWidget;
    private clearWidget;
    private isCurrent;
    private queueRender;
}
