import type { AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, CustomEditor, CustomMessageComponent, ExtensionEditorComponent, ExtensionInputComponent, ExtensionSelectorComponent, getMarkdownTheme, getSelectListTheme, KeybindingsManager, parseSkillBlock, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent } from '@earendil-works/pi-coding-agent';
import { type MarkdownTheme, type SelectListTheme, type Spacer, type Text, type TUI } from '@earendil-works/pi-tui';
import type { LuminariesCommandCenterProjection } from './command-center-projection.ts';
import type { LuminariesConversationUpdate } from './agent-conversations.ts';
import { type LuminariesTerminalWidth } from './terminal-width.ts';
export interface LuminariesTheme {
    fg(color: string, text: string): string;
    bold(text: string): string;
}
export interface LuminariesCommandCenterActions {
    subscribe?(agentId: string, listener: (update: LuminariesConversationUpdate) => void): () => void;
    readOnlyReason?(): string | undefined;
    send(agentId: string, message: string, mode: 'auto' | 'follow_up'): Promise<'woken' | 'steered' | 'follow_up_queued'>;
    interrupt(agentId: string): Promise<'interrupted' | 'already_finished'>;
    spawn?(): Promise<LuminariesActionResult | undefined>;
    multicast?(recipientIds: readonly string[]): Promise<LuminariesActionResult | undefined>;
    palette?(agentId: string): Promise<LuminariesActionResult | undefined>;
    motionChanged?(): void;
}
export interface LuminariesActionStatus {
    text: string;
    tone: string;
    persistent?: boolean;
}
export type LuminariesActionResult = string | LuminariesActionStatus;
export interface LuminariesComponent {
    focused: boolean;
    render(width: number): string[];
    handleInput(data: string): void;
    scrollBy?(lines: number): void;
    invalidate(): void;
    dispose?(): void;
}
type NativeToolDefinition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
export interface LuminariesNativeConversationModule {
    getMarkdownTheme: typeof getMarkdownTheme;
    getSelectListTheme: typeof getSelectListTheme;
    UserMessageComponent: typeof UserMessageComponent;
    AssistantMessageComponent: typeof AssistantMessageComponent;
    ToolExecutionComponent: typeof ToolExecutionComponent;
    CustomMessageComponent: typeof CustomMessageComponent;
    BranchSummaryMessageComponent: typeof BranchSummaryMessageComponent;
    CompactionSummaryMessageComponent: typeof CompactionSummaryMessageComponent;
    BashExecutionComponent: typeof BashExecutionComponent;
    parseSkillBlock: typeof parseSkillBlock;
    SkillInvocationMessageComponent: typeof SkillInvocationMessageComponent;
    Spacer: typeof Spacer;
    Text: typeof Text;
    CustomEditor: typeof CustomEditor;
    ExtensionEditorComponent: typeof ExtensionEditorComponent;
    ExtensionInputComponent: typeof ExtensionInputComponent;
    ExtensionSelectorComponent: typeof ExtensionSelectorComponent;
}
type LuminariesNativeComponents = Omit<LuminariesNativeConversationModule, 'getMarkdownTheme' | 'getSelectListTheme'>;
export interface LuminariesNativeConversationUi extends LuminariesNativeComponents {
    tui: TUI;
    keybindings: KeybindingsManager;
    markdownTheme: MarkdownTheme;
    selectListTheme: SelectListTheme;
    toolDefinitions?: ReadonlyMap<string, NativeToolDefinition>;
}
export declare function friendlyError(value: unknown): string;
export declare function renderAmbientWidget(projection: LuminariesCommandCenterProjection, width: number, phase: number, theme: LuminariesTheme, terminalWidth?: LuminariesTerminalWidth): string[];
export declare class LuminariesCommandCenterComponent implements LuminariesComponent {
    focused: boolean;
    private view;
    private directoryView;
    private selectedId;
    private readonly selectedByView;
    private searchQuery?;
    private searchRestoreId?;
    private factSheetOpen;
    private factSheetOffset;
    private pickerMarks?;
    private status?;
    private statusTimer?;
    private busy;
    private conversationTailOffset;
    private visibleMotion;
    private disposed;
    private toolsExpanded;
    private thinkingHidden;
    private conversation;
    private conversationEpoch?;
    private conversationIncarnation?;
    private conversationRevision;
    private conversationHydrated;
    private conversationUnsubscribe?;
    private nativeAgentId?;
    /** One component group per conversation message; unchanged messages reuse their Pi-native components. */
    private nativeGroups;
    private nativeGroupWidth;
    private nativeLineTotal?;
    private directoryRenderWidth?;
    private readonly editor?;
    private editorAgentId?;
    private readonly getProjection;
    private readonly getPhase;
    private readonly theme;
    private readonly actions;
    private readonly requestRender;
    private readonly done;
    private readonly getTerminalRows;
    private readonly terminalWidth;
    private readonly nativeUi?;
    private readonly rootEnter;
    constructor(getProjection: () => LuminariesCommandCenterProjection, getPhase: () => number, theme: LuminariesTheme, actions: LuminariesCommandCenterActions, requestRender: () => void, done: () => void, getTerminalRows?: () => number, terminalWidth?: LuminariesTerminalWidth, nativeUi?: LuminariesNativeConversationUi, options?: {
        initialAgentId?: string;
        rootEnter?: 'return' | 'manage' | 'conversation';
    });
    render(width: number): string[];
    handleInput(data: string): void;
    scrollBy(lines: number): void;
    invalidate(): void;
    dispose(): void;
    hasVisibleMotion(): boolean;
    private renderCompact;
    private renderDirectory;
    private directoryTitle;
    private directoryFooterLines;
    private setVisibleMotion;
    private renderAgent;
    /** Per-message Pi-native component reuse: unchanged messages keep their components and cached lines. */
    private nativeGroupCache;
    private nativeConversationRef?;
    private nativeFlags;
    private nativeResults;
    /** Kept as the single external entry point; all invalidation is reference/flag-driven. */
    private rebuildNativeComponents;
    private syncNativeGroups;
    private buildNativeGroup;
    private ensureNativeLines;
    private nativeLines;
    private conversationLineTotal;
    private handleDirectory;
    private handlePicker;
    private toggleDirectoryView;
    private handleSearch;
    private filteredDirectoryAgents;
    private visibleSelectedAgent;
    private selectedAgent;
    private matches;
    private conversationScrollMaximum;
    private clampScrollOffsets;
    private reconcileProjection;
    private move;
    private clampFactSheetOffset;
    private scrollFactSheet;
    private openConversation;
    openAgent(agentId: string): void;
    private applyConversationUpdate;
    private activateSelected;
    private returnToDirectory;
    private scrollConversation;
    private submitEditor;
    private clearOrInterrupt;
    private runAction;
    private run;
    private setStatus;
    private safeRender;
}
export {};
