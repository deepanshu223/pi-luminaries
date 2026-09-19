import type { ExtensionContext, ExtensionUIContext, KeybindingsManager } from '@earendil-works/pi-coding-agent';
import {
  type LuminariesActionResult,
  LuminariesCommandCenterComponent,
  renderAmbientWidget,
  type LuminariesNativeConversationModule,
  type LuminariesNativeConversationUi,
  type LuminariesTheme,
} from './command-center-view.ts';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type { LuminariesCommandCenterAgent, LuminariesCommandCenterProjection } from './command-center-projection.ts';
import { orderCommandCenterDirectory } from './command-center-projection.ts';
import type { LuminariesConversationReset, LuminariesConversationUpdate } from './agent-conversations.ts';
import type { LuminariesToolDefinition, LuminariesToolName, LuminariesToolResult } from './luminaries-tools.ts';
import { messageGroupReceipt } from './luminaries-tools.ts';
import type { ModelDescriptor } from './spawn-configuration.ts';
import type { ManagedExtensionSource } from './root-configuration.ts';
import { HOST_TERMINAL_WIDTH, type LuminariesTerminalWidth } from './terminal-width.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { basename, resolve } from 'node:path';
import { sanitizeDisplayText, splitWhitespace } from './display-sanitizer.ts';
import { isRecord } from './scheduler-state.ts';

const TOOL = LUMINARIES_IDENTITY.tools;
const PRODUCT = LUMINARIES_IDENTITY.label;
const DEFAULT_TERMINAL_ROWS = 34;
const MOTION_FRAME_COUNT = 4;
const MOTION_INTERVAL_MS = 350;
const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE_TRACKING = '\x1b[?1006l\x1b[?1000l';

type WorkspaceMouse = {
  setEnabled(enabled: boolean, passWheelToFocus?: boolean): void;
  dispose(): void;
};

function disposeComponent(component: Component | undefined): void {
  if (component && 'dispose' in component && typeof component.dispose === 'function') component.dispose();
}

function mouseWheelDirection(data: string): -1 | 1 | undefined {
  if (data.length < 8 || data.length > 64 || !data.startsWith('\x1b[<')) return undefined;
  const end = data.charCodeAt(data.length - 1);
  if (end !== 77 && end !== 109) return undefined;
  let button = 0;
  let separators = 0;
  let digits = 0;
  for (let index = 3; index < data.length - 1; index++) {
    const code = data.charCodeAt(index);
    if (code === 59) {
      if (!digits) return undefined;
      separators++;
      digits = 0;
      continue;
    }
    if (code < 48 || code > 57) return undefined;
    if (!separators) button = button * 10 + code - 48;
    digits++;
  }
  if (separators !== 2 || !digits || (button & 64) === 0) return undefined;
  const direction = button & 3;
  return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
}

function installWorkspaceMouse(tui: TUI, component: LuminariesCommandCenterComponent): WorkspaceMouse {
  let enabled = false;
  let passWheelToFocus = false;
  let disposed = false;
  // Fullscreen Pi owns mouse reporting and defers wheel input to its focused overlay.
  const controlsTerminalMouse = tui.mode !== 'fullscreen';
  const removeInputListener = tui.addInputListener((data) => {
    if (!enabled) return undefined;
    const direction = mouseWheelDirection(data);
    if (!direction) return undefined;
    if (passWheelToFocus) return undefined;
    component.scrollBy(direction);
    tui.requestRender();
    return { consume: true };
  });
  return {
    setEnabled(value, passToFocus = false) {
      if (disposed) return;
      passWheelToFocus = value && passToFocus;
      if (enabled === value) return;
      enabled = value;
      if (controlsTerminalMouse) tui.terminal.write(value ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING);
    },
    dispose() {
      if (disposed) return;
      if (enabled && controlsTerminalMouse) tui.terminal.write(DISABLE_MOUSE_TRACKING);
      enabled = false;
      disposed = true;
      removeInputListener();
    },
  };
}

export { projectCommandCenter } from './command-center-projection.ts';
export type {
  LuminariesCommandCenterAgent,
  LuminariesCommandCenterProjection,
  LuminariesHumanState,
  LuminariesPiMessage,
} from './command-center-projection.ts';
export { LuminariesCommandCenterComponent, renderAmbientWidget } from './command-center-view.ts';
export type {
  LuminariesCommandCenterActions,
  LuminariesComponent,
  LuminariesNativeConversationUi,
  LuminariesTheme,
} from './command-center-view.ts';
export type { LuminariesConversationSplice } from './agent-conversations.ts';
export type { LuminariesConversationReset, LuminariesConversationUpdate };
export type { LuminariesTerminalWidth } from './terminal-width.ts';

type LuminariesExtensionUi = Pick<ExtensionUIContext, 'setWidget'> &
  Partial<Pick<ExtensionUIContext, 'custom' | 'notify' | 'select'>>;

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
  operatorInput(
    agentId: string,
    message: string,
    mode: 'auto' | 'follow_up',
    operationId?: string,
  ): Promise<'woken' | 'steered' | 'follow_up_queued'>;
  operatorInterrupt(agentId: string, operationId?: string): Promise<'interrupted' | 'already_finished'>;
  operatorSetCapacity(capacity: number, operationId?: string): Promise<void>;
  operatorSetDepth(depth: number, operationId?: string): Promise<void>;
  operatorParkAll(mode: 'safe' | 'now', operationId?: string): Promise<void>;
  operatorDetachSession(
    agentId: string,
    operationId?: string,
  ): Promise<
    | {
        sourceAgentId: string;
        sourceLifecycle: 'closed';
        sessionId: string;
        sessionFile: string;
        sessionName: string;
        command: string;
      }
    | { status: 'not_ready'; message: string }
  >;
  operatorSessions(): Promise<
    readonly {
      sessionFile: string;
      sessionId: string;
      cwd: string;
      name?: string;
      modifiedAtMs: number;
      messageCount: number;
      firstMessage: string;
    }[]
  >;
  operatorInspectSessionReference(reference: string): Promise<{
    sessionFile: string;
    sessionId: string;
    cwd: string;
    name?: string;
  }>;
  operatorAdoptSession(
    sessionFile: string,
    options?: { name?: string; assignment?: string; expertise?: string[] },
    operationId?: string,
  ): Promise<{ sourceSessionFile: string; agentId: string; handle: string; sessionId: string }>;
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
  operatorSelectableExtensions(): readonly { specifier: string; source: string }[];
  operatorExtensionSources(): readonly ManagedExtensionSource[];
  operatorApproveExtension(
    specifier: string,
    scope: ManagedExtensionSource['scope'],
    install: boolean,
    operationId?: string,
  ): Promise<void>;
}

/** Session-bound owner of the active-only widget, shared motion clock, and foreground workspace. */
export class LuminariesCommandCenterController {
  private readonly loadPiConversation: () => Promise<LuminariesNativeConversationModule>;
  private readonly luminariesToolDefinitions?: ReadonlyMap<string, LuminariesToolDefinition>;
  private context?: LuminariesUiContext;
  private manager?: LuminariesCommandCenterHost;
  private unsubscribe?: () => void;
  private timer?: NodeJS.Timeout;
  private phase = 0;
  private motionEnabled = true;
  private widgetRender?: () => void;
  private workspaceRender?: () => void;
  private widgetRegistered = false;
  private workspaceOpen = false;
  private openPromise?: Promise<void>;
  private workspaceDone?: () => void;
  private workspaceComponent?: LuminariesCommandCenterComponent;
  private workspaceDialogClose?: () => void;
  private workspaceMouse?: WorkspaceMouse;
  private workspaceTui?: TUI;
  private workspaceKeybindings?: KeybindingsManager;
  private nativeUi?: LuminariesNativeConversationModule;
  private terminalWidth: LuminariesTerminalWidth = HOST_TERMINAL_WIDTH;
  private projection?: LuminariesCommandCenterProjection;
  private closedHistory?: {
    revision: number;
    agents: readonly LuminariesCommandCenterAgent[];
    archivedCount: number;
  };
  private closedHistoryRefresh?: Promise<void>;
  private closedHistoryRefreshRequested = false;
  private uiViewGeneration = 0;
  private renderQueued = false;
  private pendingWorkspaceInvalidate = false;
  private timerIntervalMs?: number;

  constructor(
    loadPiConversation: () => Promise<LuminariesNativeConversationModule> = async () => {
      const [pi, tui] = await Promise.all([
        import('@earendil-works/pi-coding-agent'),
        import('@earendil-works/pi-tui'),
      ]);
      return { ...pi, Spacer: tui.Spacer, Text: tui.Text };
    },
    luminariesToolDefinitions?: ReadonlyMap<string, LuminariesToolDefinition>,
  ) {
    this.loadPiConversation = loadPiConversation;
    this.luminariesToolDefinitions = luminariesToolDefinitions;
  }

  attach(context: LuminariesUiContext, manager: LuminariesCommandCenterHost): void {
    if (this.context?.ui === context.ui && this.manager === manager) {
      this.context = context;
      return;
    }
    this.dispose();
    if (context.mode !== 'tui' || !context.ui) return;
    const generation = this.uiViewGeneration;
    this.context = context;
    this.manager = manager;
    this.projection = this.withClosedHistory(manager.commandCenterProjection());
    this.unsubscribe = manager.onCommandCenterChange((projection) => {
      if (!this.isCurrent(manager, generation)) return;
      this.projection = this.withClosedHistory(projection);
      // Coalesce workspace invalidation to at most one frame per projection burst.
      if (this.workspaceOpen && !this.pendingWorkspaceInvalidate) {
        this.pendingWorkspaceInvalidate = true;
        queueMicrotask(() => {
          this.pendingWorkspaceInvalidate = false;
          if (!this.isCurrent(manager, generation) || !this.workspaceComponent) return;
          this.workspaceComponent.invalidate();
        });
      }
      this.refresh(generation);
      if (this.workspaceOpen && projection.historyRevision !== this.closedHistory?.revision)
        void this.refreshClosedHistory(manager, generation).catch((error) =>
          this.context?.ui?.notify?.(error instanceof Error ? error.message : String(error), 'warning'),
        );
    });
    this.refresh(generation);
  }

  async open(context?: LuminariesUiContext, initialAgentId?: string): Promise<void> {
    if (this.openPromise) return this.openPromise;
    if (context?.mode === 'tui' && context.ui) this.context = context;
    const ui = this.context?.ui;
    const manager = this.manager;
    if (!ui?.custom || !manager) {
      ui?.notify?.(`${PRODUCT} command center requires interactive TUI mode.`, 'warning');
      return;
    }
    const generation = this.uiViewGeneration;
    const initialProjection = this.projection;
    if (!initialProjection) throw new Error(`${PRODUCT} command-center projection is unavailable`);
    if (!this.nativeUi) ui.notify?.(`Opening ${PRODUCT}…`, 'info');
    this.workspaceOpen = true;
    this.refresh(generation);
    const openPromise = Promise.all([
      this.loadPiConversation(),
      this.refreshClosedHistory(manager, generation)
        .then(() => this.closedHistory)
        .catch((error) => {
          ui.notify?.(error instanceof Error ? error.message : String(error), 'warning');
          return undefined;
        }),
    ])
      .then(([pi, closedHistory]) => {
        if (!this.isCurrent(manager, generation) || this.context?.ui !== ui || !this.workspaceOpen) return undefined;
        if (closedHistory) this.closedHistory = closedHistory;
        this.nativeUi = pi;
        this.projection = this.withClosedHistory(manager.commandCenterProjection());
        if (initialAgentId && !this.projection.directory.some((agent) => agent.agentId === initialAgentId))
          throw new Error('The requested collaborator could not be opened because retained history is unavailable');
        return ui.custom?.<void>(
          (tui, theme, keybindings, done) => {
            if (!this.isCurrent(manager, generation) || !this.workspaceOpen) {
              queueMicrotask(() => done());
              return {
                focused: false,
                render: () => [],
                handleInput: () => undefined,
                invalidate: () => undefined,
              };
            }
            let component: LuminariesCommandCenterComponent | undefined;
            let mouse: WorkspaceMouse | undefined;
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              this.workspaceDialogClose?.();
              this.workspaceDialogClose = undefined;
              mouse?.dispose();
              if (this.workspaceMouse === mouse) this.workspaceMouse = undefined;
              if (this.workspaceComponent === component) {
                this.workspaceComponent = undefined;
                this.workspaceDone = undefined;
                this.workspaceTui = undefined;
                this.workspaceKeybindings = undefined;
              }
              component?.dispose();
              done();
            };
            component = new LuminariesCommandCenterComponent(
              () => this.projection ?? initialProjection,
              () => (this.motionEnabled ? this.phase : 0),
              theme,
              {
                subscribe: (agentId, listener) => manager.onAgentConversationChange(agentId, listener),
                readOnlyReason: () => manager.readOnlyReason?.(),
                send: (agentId, message, mode) => manager.operatorInput(agentId, message, mode),
                interrupt: (agentId) => manager.operatorInterrupt(agentId),
                spawn: () => this.spawnFromCommandCenter(manager, generation),
                multicast: (recipientIds) => this.multicastFromCommandCenter(manager, generation, recipientIds),
                palette: (agentId) => this.openActionPalette(manager, agentId, generation),
                motionChanged: () => this.syncTimer(generation),
              },
              () => this.queueRender(generation),
              finish,
              () => Math.max(1, tui.terminal.rows || DEFAULT_TERMINAL_ROWS),
              this.terminalWidth,
              {
                tui,
                keybindings,
                markdownTheme: pi.getMarkdownTheme(),
                selectListTheme: pi.getSelectListTheme(),
                UserMessageComponent: pi.UserMessageComponent,
                AssistantMessageComponent: pi.AssistantMessageComponent,
                ToolExecutionComponent: pi.ToolExecutionComponent,
                CustomMessageComponent: pi.CustomMessageComponent,
                BranchSummaryMessageComponent: pi.BranchSummaryMessageComponent,
                CompactionSummaryMessageComponent: pi.CompactionSummaryMessageComponent,
                BashExecutionComponent: pi.BashExecutionComponent,
                parseSkillBlock: pi.parseSkillBlock,
                SkillInvocationMessageComponent: pi.SkillInvocationMessageComponent,
                Spacer: pi.Spacer,
                Text: pi.Text,
                CustomEditor: pi.CustomEditor,
                ExtensionEditorComponent: pi.ExtensionEditorComponent,
                ExtensionInputComponent: pi.ExtensionInputComponent,
                ExtensionSelectorComponent: pi.ExtensionSelectorComponent,
                ...(this.luminariesToolDefinitions ? { toolDefinitions: this.luminariesToolDefinitions } : {}),
              } satisfies LuminariesNativeConversationUi,
              {
                initialAgentId,
                rootEnter: this.context?.parentConversation === true ? 'return' : 'conversation',
              },
            );
            mouse = installWorkspaceMouse(tui, component);
            this.workspaceComponent = component;
            this.workspaceDone = finish;
            this.workspaceMouse = mouse;
            this.workspaceTui = tui;
            this.workspaceKeybindings = keybindings;
            this.workspaceRender = () => tui.requestRender();
            this.syncTimer(generation);
            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              width: '100%',
              maxHeight: '100%',
              row: 0,
              col: 0,
              margin: 0,
            },
            onHandle: (handle) => {
              if (!this.isCurrent(manager, generation) || !this.workspaceOpen || !this.workspaceComponent) {
                handle.hide();
                this.workspaceMouse?.dispose();
                return;
              }
              handle.focus();
              this.workspaceMouse?.setEnabled(true);
            },
          },
        );
      })
      .then(() => undefined)
      .finally(() => {
        if (this.uiViewGeneration !== generation || this.openPromise !== openPromise) return;
        this.workspaceDone?.();
        this.workspaceDialogClose?.();
        this.workspaceDialogClose = undefined;
        this.workspaceMouse?.dispose();
        this.workspaceMouse = undefined;
        this.workspaceComponent?.dispose?.();
        this.workspaceComponent = undefined;
        this.workspaceDone = undefined;
        this.workspaceRender = undefined;
        this.workspaceOpen = false;
        this.openPromise = undefined;
        this.refresh(generation);
      });
    this.openPromise = openPromise;
    return openPromise;
  }

  dispose(): void {
    this.uiViewGeneration++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.timerIntervalMs = undefined;
    this.workspaceDialogClose?.();
    this.workspaceDialogClose = undefined;
    const finish = this.workspaceDone;
    this.workspaceDone = undefined;
    if (finish) finish();
    else this.workspaceComponent?.dispose?.();
    this.workspaceMouse?.dispose();
    this.workspaceMouse = undefined;
    this.workspaceComponent = undefined;
    this.workspaceTui = undefined;
    this.workspaceKeybindings = undefined;
    this.nativeUi = undefined;
    this.clearWidget();
    this.context = undefined;
    this.manager = undefined;
    this.projection = undefined;
    this.closedHistory = undefined;
    this.closedHistoryRefresh = undefined;
    this.closedHistoryRefreshRequested = false;
    this.workspaceRender = undefined;
    this.workspaceOpen = false;
    this.openPromise = undefined;
    this.terminalWidth = HOST_TERMINAL_WIDTH;
    this.renderQueued = false;
  }

  private dialogUi(
    manager: LuminariesCommandCenterHost,
    generation: number,
  ): NonNullable<LuminariesUiContext['ui']> | undefined {
    return this.isCurrent(manager, generation) ? this.context?.ui : undefined;
  }

  private async dialogInput(
    manager: LuminariesCommandCenterHost,
    generation: number,
    title: string,
    guidance?: string,
  ): Promise<string | undefined> {
    return this.workspaceDialog(
      manager,
      generation,
      (pi, tui, _keybindings, done) =>
        new pi.ExtensionInputComponent(
          guidance ? `${title}\n${guidance}` : title,
          undefined,
          done,
          () => done(undefined),
          { tui },
        ),
    );
  }

  private async dialogEditor(
    manager: LuminariesCommandCenterHost,
    generation: number,
    title: string,
    guidance: string,
    prefill?: string,
  ): Promise<string | undefined> {
    return this.workspaceDialog(
      manager,
      generation,
      (pi, tui, keybindings, done) =>
        new pi.ExtensionEditorComponent(tui, keybindings, `${title}\n${guidance}`, prefill, done, () =>
          done(undefined),
        ),
    );
  }

  private async dialogSelect(
    manager: LuminariesCommandCenterHost,
    generation: number,
    title: string,
    options: string[],
  ): Promise<string | undefined> {
    return this.workspaceDialog(
      manager,
      generation,
      (pi, tui, _keybindings, done) =>
        new pi.ExtensionSelectorComponent(title, options, done, () => done(undefined), { tui }),
    );
  }

  private async dialogSessionSelect(
    manager: LuminariesCommandCenterHost,
    generation: number,
    title: string,
    options: string[],
  ): Promise<string | undefined> {
    const { SelectList, Text } = await import('@earendil-works/pi-tui');
    if (!this.isCurrent(manager, generation)) return undefined;
    return this.workspaceDialog(
      manager,
      generation,
      (pi, tui, _keybindings, done) => {
        const items = options.map((value) => ({ value, label: value }));
        const titleText = new Text(title, 0, 0);
        const footer = new Text('↑↓ or wheel navigate · Enter select · Esc cancel', 0, 0);
        let selectedValue = items[0]?.value;
        let viewportSize = 0;
        const createList = (maxVisible: number) => {
          const list = new SelectList(items, maxVisible, pi.getSelectListTheme());
          const selectedIndex = items.findIndex((item) => item.value === selectedValue);
          list.setSelectedIndex(selectedIndex < 0 ? 0 : selectedIndex);
          list.onSelectionChange = (item) => {
            selectedValue = item.value;
          };
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(undefined);
          return list;
        };
        let list = createList(1);
        const scrollBy = (direction: -1 | 1) => {
          const selectedIndex = items.findIndex((item) => item.value === list.getSelectedItem()?.value);
          list.setSelectedIndex(selectedIndex + direction);
          selectedValue = list.getSelectedItem()?.value ?? selectedValue;
          tui.requestRender();
        };
        return {
          render: (width: number) => {
            const overlayRows = Math.max(1, Math.min(Math.floor(tui.terminal.rows * 0.8), tui.terminal.rows - 2));
            const minimumListRows = Math.min(overlayRows, items.length > 1 ? 2 : 1);
            const footerLines = footer.render(width).slice(0, Math.max(0, overlayRows - minimumListRows - 1));
            const titleLines = titleText
              .render(width)
              .slice(0, Math.max(0, overlayRows - minimumListRows - footerLines.length));
            const availableRows = Math.max(1, overlayRows - titleLines.length - footerLines.length);
            const nextViewport = Math.max(
              1,
              Math.min(items.length, availableRows - (items.length > availableRows ? 1 : 0)),
            );
            if (nextViewport !== viewportSize) {
              viewportSize = nextViewport;
              list = createList(viewportSize);
            }
            return [...titleLines, ...list.render(width).slice(0, availableRows), ...footerLines];
          },
          handleInput: (data: string) => {
            const direction = mouseWheelDirection(data);
            if (direction) scrollBy(direction);
            else list.handleInput(data);
          },
          invalidate: () => {
            titleText.invalidate();
            list.invalidate();
            footer.invalidate();
          },
        };
      },
      true,
    );
  }

  private async dialogConfirm(
    manager: LuminariesCommandCenterHost,
    generation: number,
    title: string,
    message: string,
  ): Promise<boolean | undefined> {
    const result = await this.dialogSelect(manager, generation, `${title}\n${message}`, ['Yes', 'No']);
    return result === undefined ? undefined : result === 'Yes';
  }

  private async workspaceDialog<T>(
    manager: LuminariesCommandCenterHost,
    generation: number,
    create: (
      pi: LuminariesNativeConversationModule,
      tui: TUI,
      keybindings: KeybindingsManager,
      done: (value: T | undefined) => void,
    ) => Component,
    passWheelToDialog = false,
  ): Promise<T | undefined> {
    const pi = this.nativeUi;
    const tui = this.workspaceTui;
    const keybindings = this.workspaceKeybindings;
    if (!pi || !tui || !keybindings) return undefined;
    this.workspaceDialogClose?.();
    this.workspaceMouse?.setEnabled(passWheelToDialog, passWheelToDialog);
    return new Promise<T | undefined>((resolvePromise, rejectPromise) => {
      let finished = false;
      let component: Component | undefined;
      let handle: ReturnType<TUI['showOverlay']> | undefined;
      const finish = (value: T | undefined) => {
        if (finished) return;
        finished = true;
        if (this.workspaceDialogClose === cancel) this.workspaceDialogClose = undefined;
        handle?.hide();
        disposeComponent(component);
        if (this.isCurrent(manager, generation) && this.workspaceOpen) this.workspaceMouse?.setEnabled(true);
        resolvePromise(this.isCurrent(manager, generation) ? value : undefined);
      };
      const cancel = () => finish(undefined);
      this.workspaceDialogClose = cancel;
      try {
        component = create(pi, tui, keybindings, finish);
        handle = tui.showOverlay(component, { width: '80%', maxHeight: '80%', anchor: 'center', margin: 1 });
        handle.focus();
      } catch (error) {
        finished = true;
        if (this.workspaceDialogClose === cancel) this.workspaceDialogClose = undefined;
        handle?.hide();
        disposeComponent(component);
        if (this.isCurrent(manager, generation) && this.workspaceOpen) this.workspaceMouse?.setEnabled(true);
        rejectPromise(error);
      }
    });
  }

  private async dialogNumber(
    manager: LuminariesCommandCenterHost,
    generation: number,
    title: string,
    guidance: string,
  ): Promise<number | undefined> {
    const value = await this.dialogInput(manager, generation, title, guidance);
    if (value === undefined) return undefined;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1) throw new Error('Enter a positive whole number.');
    return result;
  }

  private async spawnFromCommandCenter(
    manager: LuminariesCommandCenterHost,
    generation: number,
  ): Promise<LuminariesActionResult | undefined> {
    const ui = this.dialogUi(manager, generation);
    if (!ui?.custom) throw new Error(`Interactive ${PRODUCT} dialogs are unavailable`);
    const assignment = (
      await this.dialogEditor(
        manager,
        generation,
        'New luminary · First assignment',
        'Describe the complete first task. Enter submits; Esc cancels.',
      )
    )?.trim();
    if (!assignment) return undefined;
    const ownershipBoundary = (
      await this.dialogEditor(
        manager,
        generation,
        'Scope of work',
        'Describe the files, area, or decision this expert is responsible for.',
      )
    )?.trim();
    if (!ownershipBoundary) return undefined;
    const projection = this.projection;
    if (!projection) return undefined;
    const root = projection.agents.find((agent) => agent.agentId === projection.rootId);
    const launch = await this.dialogSelect(
      manager,
      generation,
      [
        'New luminary',
        `Name: automatic (${projection.configuration.namePoolSource})`,
        `Model: ${root?.model ?? 'parent model'}`,
        `Thinking: ${root?.thinking ?? 'parent thinking'}`,
        'Context: fresh',
        `Project: ${root?.cwd ?? 'current project'}`,
      ].join('\n'),
      ['Create with these settings', 'Customize', 'Cancel'],
    );
    if (!launch || launch === 'Cancel') return undefined;
    const customize = launch === 'Customize';
    let name: string | undefined;
    let context: 'fresh' | 'recent' | 'fork' | 'custom' = 'fresh';
    let systemPrompt: string | undefined;
    let cwd: string | undefined;
    let model = 'Use parent model';
    let thinking = 'Use parent thinking';
    let advanced = false;
    if (customize) {
      const nameInput = await this.dialogInput(
        manager,
        generation,
        'Display name',
        'Optional. Leave empty to choose a star name automatically.',
      );
      if (nameInput === undefined) return undefined;
      name = nameInput.trim() || undefined;
      const launchChoice = await this.dialogSelect(manager, generation, 'Launch context · current fresh', [
        'Fresh · assignment only',
        'Recent · newest compatible parent context',
        'Fork · complete current parent branch',
        'Custom · isolated startup',
      ]);
      if (!launchChoice) return undefined;
      context = launchChoice.startsWith('Recent')
        ? 'recent'
        : launchChoice.startsWith('Fork')
          ? 'fork'
          : launchChoice.startsWith('Custom')
            ? 'custom'
            : 'fresh';
      if ((context === 'recent' || context === 'fork') && root?.state === 'running')
        return {
          tone: 'muted',
          persistent: true,
          text: 'Root is working. Recent and Fork are available when its current turn finishes.',
        };
      if (context === 'custom') {
        const promptInput = await this.dialogEditor(
          manager,
          generation,
          'Custom system prompt',
          `Optional. Leave empty to use the ${PRODUCT} clean-room kernel.`,
        );
        if (promptInput === undefined) return undefined;
        systemPrompt = promptInput.trim() || undefined;
      }
      const cwdChoice =
        (await this.dialogSelect(manager, generation, `Working directory · current ${root?.cwd ?? 'project'}`, [
          `Use parent directory · ${root?.cwd ?? 'current'}`,
          'Another authorized directory',
        ])) ?? '';
      if (!cwdChoice) return undefined;
      cwd = cwdChoice.startsWith('Another')
        ? (
            await this.dialogInput(
              manager,
              generation,
              'Working directory path',
              `Enter an authorized existing directory. Current: ${root?.cwd ?? 'project directory'}`,
            )
          )?.trim()
        : undefined;
      if (cwdChoice.startsWith('Another') && !cwd) return undefined;
      const parentModel = root?.model ?? 'Pi default';
      model =
        (await this.dialogSelect(manager, generation, `Model · current ${parentModel}`, [
          `Use parent model · ${parentModel}`,
          ...manager.operatorModels().map((candidate) => `${candidate.provider}/${candidate.id}`),
        ])) ?? '';
      if (!model) return undefined;
      const parentThinking = root?.thinking ?? 'Pi default';
      thinking =
        (await this.dialogSelect(manager, generation, `Thinking · current ${parentThinking}`, [
          `Use parent thinking · ${parentThinking}`,
          ...manager.operatorThinkingLevels(),
        ])) ?? '';
      if (!thinking) return undefined;
      const advancedChoice = await this.dialogConfirm(
        manager,
        generation,
        'Advanced launch options',
        context === 'custom'
          ? 'Select allowed extensions, reattach startup resources, or grant rare authority?'
          : 'Select allowed extensions or grant rare authority?',
      );
      if (advancedChoice === undefined) return undefined;
      advanced = advancedChoice;
    }
    const commaList = (value: string): string[] | undefined => {
      const values = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return values.length ? [...new Set(values)] : undefined;
    };
    const extensionChoices = manager.operatorSelectableExtensions();
    const extensions: string[] = [];
    while (advanced && extensions.length < extensionChoices.length) {
      const remaining = extensionChoices.filter((entry) => !extensions.includes(entry.specifier));
      const choices = [...remaining.map((entry) => `${entry.specifier} · ${entry.source}`), 'Done'];
      const choice = await this.dialogSelect(manager, generation, 'Child extensions', choices);
      if (!choice) return undefined;
      if (choice === 'Done') break;
      const selected = remaining.find((entry) => choice === `${entry.specifier} · ${entry.source}`);
      if (!selected) throw new Error('The selected extension is no longer available');
      extensions.push(selected.specifier);
    }
    let skills: string[] | undefined;
    let promptTemplates: string[] | undefined;
    let themes: string[] | undefined;
    if (advanced && context === 'custom') {
      const guidance = 'Optional. Enter comma-separated authorized paths, or leave empty. Esc cancels creation.';
      const skillsInput = await this.dialogInput(manager, generation, 'Skills', guidance);
      if (skillsInput === undefined) return undefined;
      skills = commaList(skillsInput);
      const templatesInput = await this.dialogInput(manager, generation, 'Prompt templates', guidance);
      if (templatesInput === undefined) return undefined;
      promptTemplates = commaList(templatesInput);
      const themesInput = await this.dialogInput(manager, generation, 'Themes', guidance);
      if (themesInput === undefined) return undefined;
      themes = commaList(themesInput);
    }
    const peerInterrupt = advanced
      ? await this.dialogSelect(manager, generation, 'Peer interruption permission', [
          'Do not allow',
          'Allow interrupting another luminary',
        ])
      : undefined;
    if (advanced && !peerInterrupt) return undefined;
    if (!this.isCurrent(manager, generation)) return undefined;
    const result = await manager.operatorExecute(TOOL.spawn, {
      ...(name ? { name } : {}),
      assignment,
      ownershipBoundary,
      context,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(cwd ? { cwd } : {}),
      ...(model.startsWith('Use parent model') ? {} : { model }),
      ...(thinking.startsWith('Use parent thinking') ? {} : { thinking }),
      ...(extensions.length ? { extensions } : {}),
      ...(skills ? { skills } : {}),
      ...(promptTemplates ? { promptTemplates } : {}),
      ...(themes ? { themes } : {}),
      ...(peerInterrupt === 'Allow interrupting another luminary' ? { grants: { peerInterrupt: true } } : {}),
    });
    if (result.details.status === 'not_ready')
      return {
        tone: 'muted',
        persistent: true,
        text: 'Root is working. Recent and Fork are available when its current turn finishes.',
      };
    const receipt = result.details.agent;
    const receiptHandle =
      typeof receipt === 'object' && receipt !== null && !Array.isArray(receipt)
        ? Reflect.get(receipt, 'humanHandle')
        : undefined;
    const handle = typeof receiptHandle === 'string' ? receiptHandle : undefined;
    const startupState = result.details.startupState;
    const state = typeof startupState === 'string' ? startupState.split('_').join(' ') : 'starting';
    const receiptStatus =
      typeof receipt === 'object' && receipt !== null && !Array.isArray(receipt)
        ? Reflect.get(receipt, 'status')
        : undefined;
    if (!handle) return `A new luminary joined your constellation.`;
    if (receiptStatus === 'already_known') return `${handle} already exists.`;
    if (state === 'needs attention' || state === 'failed')
      return `${handle} joined the constellation, but the first turn needs review. Open it to see what happened.`;
    return state === 'settled'
      ? `${handle} joined the constellation. The first turn completed.`
      : `${handle} joined the constellation. Starting the first turn.`;
  }

  private async multicastFromCommandCenter(
    manager: LuminariesCommandCenterHost,
    generation: number,
    recipientIds: readonly string[],
  ): Promise<LuminariesActionResult | undefined> {
    const ui = this.dialogUi(manager, generation);
    if (!ui?.custom) throw new Error(`Interactive ${PRODUCT} dialogs are unavailable`);
    const projection = this.projection;
    if (!projection) return undefined;
    const candidates = new Set(
      projection.agents
        .filter((agent) => agent.agentId !== projection.rootId && agent.lifecycle === 'open')
        .map((agent) => agent.agentId),
    );
    if (!recipientIds.length || new Set(recipientIds).size !== recipientIds.length)
      throw new Error('Multicast requires at least one distinct open collaborator');
    if (recipientIds.some((agentId) => !candidates.has(agentId)))
      throw new Error('A selected multicast collaborator is no longer open');
    const message = (
      await this.dialogEditor(
        manager,
        generation,
        'Message several luminaries',
        'Enter the message each selected luminary should receive.',
      )
    )?.trim();
    if (!message) return undefined;
    const delivery = await this.dialogSelect(manager, generation, 'When should they receive it?', [
      'Send now · wake or guide the current turn',
      'Send after current work',
      'Leave a notification · no new turn',
    ]);
    if (!delivery) return undefined;
    const mode = delivery.startsWith('Send after')
      ? 'follow_up'
      : delivery.startsWith('Leave a notification')
        ? 'notify_only'
        : 'default';
    if (!this.isCurrent(manager, generation)) return undefined;
    const result = await manager.operatorExecute(TOOL.message, {
      action: 'multicast',
      recipientIds,
      message,
      mode,
    });
    const receipt = messageGroupReceipt(result.details);
    if (receipt.problems.length)
      return {
        tone: 'error',
        persistent: true,
        text: [receipt.summary, ...receipt.problems].join('\n'),
      };
    if (mode === 'notify_only')
      return `${recipientIds.length} notification${recipientIds.length === 1 ? '' : 's'} recorded. No model turns started.`;
    if (mode === 'follow_up')
      return `${recipientIds.length} follow-up${recipientIds.length === 1 ? '' : 's'} accepted for later turns.`;
    return `${recipientIds.length} message${recipientIds.length === 1 ? '' : 's'} accepted for delivery.`;
  }

  private async messageFromCommandCenter(
    manager: LuminariesCommandCenterHost,
    generation: number,
    agent: LuminariesCommandCenterAgent,
  ): Promise<string | undefined> {
    const message = (
      await this.dialogEditor(
        manager,
        generation,
        `Message ${agent.handle}`,
        'Send now: wake a ready or parked luminary, or guide its current turn.',
      )
    )?.trim();
    if (!message || !this.isCurrent(manager, generation)) return undefined;
    const disposition = await manager.operatorInput(agent.agentId, message, 'auto');
    return disposition === 'steered'
      ? `Message for ${agent.handle} was accepted for the active turn.`
      : `Message for ${agent.handle} was accepted to start the next turn.`;
  }

  private async openActionPalette(
    manager: LuminariesCommandCenterHost,
    agentId: string,
    generation: number,
  ): Promise<LuminariesActionResult | undefined> {
    const ui = this.dialogUi(manager, generation);
    if (!ui?.custom) throw new Error(`Interactive ${PRODUCT} dialogs are unavailable`);
    const projection = this.projection;
    if (!projection) return undefined;
    const agent = [...projection.agents, ...projection.closedAgents].find((candidate) => candidate.agentId === agentId);
    if (!agent) throw new Error('The selected collaborator is no longer available');
    if (agent.lifecycle === 'closed') {
      const byId = new Map(projection.directory.map((candidate) => [candidate.agentId, candidate]));
      let resumeSlots = 1;
      let parent = agent.parentId ? byId.get(agent.parentId) : undefined;
      while (agent.archived && parent?.lifecycle === 'closed' && parent.archived) {
        resumeSlots++;
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      const parentAvailable = parent?.lifecycle === 'open';
      const requiredCapacity = projection.capacity.limit + Math.max(0, resumeSlots - projection.capacity.available);
      const resumeAction = !parentAvailable
        ? 'Resume unavailable · resume its parent first'
        : projection.capacity.available >= resumeSlots
          ? 'Resume collaborator'
          : `Increase capacity to ${requiredCapacity} and resume`;
      const choices = [
        agent.archived ? 'Unarchive subtree' : 'Archive conversation',
        'Continue in standalone Pi',
        resumeAction,
        'Cancel',
      ];
      const action = await this.dialogSelect(manager, generation, `${agent.handle} · Conversation kept`, choices);
      if (!action || action === 'Cancel' || action.startsWith('Resume unavailable')) return undefined;
      if (!this.isCurrent(manager, generation)) return undefined;
      if (action === 'Continue in standalone Pi') return this.detachSession(manager, generation, agent);
      if (action === 'Archive conversation') {
        const confirmed = await this.dialogConfirm(
          manager,
          generation,
          'Archive closed conversation',
          `Archive ${agent.handle} and its already-closed descendants?`,
        );
        if (!confirmed || !this.isCurrent(manager, generation)) return undefined;
        await manager.operatorSetArchived(agentId, true);
        await this.refreshClosedHistory(manager, generation);
        return `Archived ${agent.handle} and its closed subtree.`;
      }
      if (action === 'Unarchive subtree') {
        await manager.operatorSetArchived(agentId, false);
        await this.refreshClosedHistory(manager, generation);
        return `Restored ${agent.handle} and its closed subtree to the directory.`;
      }
      if (action.startsWith('Increase capacity')) {
        const confirmed = await this.dialogConfirm(
          manager,
          generation,
          'Increase collaborator capacity',
          `Increase capacity from ${projection.capacity.limit} to ${requiredCapacity} and resume ${agent.handle}?`,
        );
        if (!confirmed || !this.isCurrent(manager, generation)) return undefined;
        await manager.operatorSetCapacity(requiredCapacity);
        try {
          await manager.operatorResume(agentId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Capacity increased to ${requiredCapacity}, but ${agent.handle} was not resumed: ${detail}`, {
            cause: error,
          });
        }
        await this.refreshClosedHistory(manager, generation);
        return `Increased capacity to ${requiredCapacity} and resumed ${agent.handle}.`;
      }
      await manager.operatorResume(agentId);
      await this.refreshClosedHistory(manager, generation);
      return `Resumed ${agent.handle}.`;
    }
    const root = agent.agentId === projection.rootId;
    const byId = new Map(projection.agents.map((candidate) => [candidate.agentId, candidate]));
    const descendants = projection.agents.filter((candidate) => {
      let parentId = candidate.parentId;
      while (parentId) {
        if (parentId === agent.agentId) return true;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return false;
    });
    const motionAction = this.motionEnabled ? 'Reduce motion' : 'Enable motion';
    const closeAction = descendants.length ? 'Close owned subtree' : 'Close';
    const choices = root
      ? [
          'Root settings',
          'Set collaborator capacity',
          'Set nesting depth',
          'Open another terminal',
          'Bring in a Pi session',
          'Park all collaborators',
          motionAction,
          'Cancel',
        ]
      : [
          ...(agent.attention ? (agent.canContinueWithMessage ? ['Continue with a message'] : []) : ['Message']),
          'Edit expert card',
          'Change model',
          'Change thinking',
          'Extensions',
          'Permissions',
          'Continue in standalone Pi',
          closeAction,
          'Cancel',
        ];
    const attentionReason = agent.health.observations[0]?.message ?? agent.health.summary;
    let action = await this.dialogSelect(
      manager,
      generation,
      root
        ? agent.attention
          ? `Root · ${attentionReason}`
          : 'Root settings and controls'
        : agent.attention
          ? `${agent.handle} · ${attentionReason}`
          : `${agent.handle} actions`,
      choices,
    );
    if (!action || action === 'Cancel') return undefined;
    if (action === 'Message' || action === 'Continue with a message')
      return this.messageFromCommandCenter(manager, generation, agent);
    if (action === 'Root settings') {
      const configuration = projection.configuration;
      const capacityChoice = `Change capacity · up to ${configuration.maxOpenAgents} luminaries`;
      const depthChoice = `Change nesting depth · ${configuration.maxDepth}`;
      const extensionChoice = `Extension availability · ${configuration.agentExtensions.length} rules`;
      const selected = await this.dialogSelect(
        manager,
        generation,
        'Root settings · limits apply to this constellation',
        [
          capacityChoice,
          depthChoice,
          extensionChoice,
          `Automatic names · ${configuration.namePoolSource}`,
          ...configuration.agentExtensions.map((entry) => `${entry.specifier} · ${entry.state} · ${entry.source}`),
          `Waves grant · ${configuration.serviceGrant.join(', ') || 'none'} · ${configuration.sources.serviceGrant}`,
          'Back',
        ],
      );
      if (selected === capacityChoice) action = 'Set collaborator capacity';
      else if (selected === depthChoice) action = 'Set nesting depth';
      else if (selected === extensionChoice) action = 'Manage extension availability';
      else return undefined;
    }
    if (action === 'Edit expert card') {
      const field = await this.dialogSelect(manager, generation, `${agent.handle} card field`, [
        'Display name',
        'Role',
        'Focus',
        'Assignment',
        'Scope of work',
        'Expertise',
        'Published outputs',
      ]);
      if (!field) return undefined;
      const current =
        field === 'Display name'
          ? agent.name
          : field === 'Role'
            ? (agent.role ?? '')
            : field === 'Focus'
              ? (agent.focus ?? '')
              : field === 'Assignment'
                ? agent.assignment
                : field === 'Scope of work'
                  ? agent.ownershipBoundary
                  : field === 'Expertise'
                    ? agent.expertise.join(', ')
                    : agent.artifacts.join(', ');
      const optional = field === 'Role' || field === 'Focus' || field === 'Expertise' || field === 'Published outputs';
      const edit = optional
        ? await this.dialogSelect(manager, generation, `${agent.handle} · ${field}`, [
            'Set value',
            'Clear field',
            'Cancel',
          ])
        : 'Set value';
      if (!edit || edit === 'Cancel') return undefined;
      let patch: Record<string, unknown>;
      if (edit === 'Clear field') {
        patch =
          field === 'Role'
            ? { role: null }
            : field === 'Focus'
              ? { focus: null }
              : field === 'Expertise'
                ? { expertise: null }
                : { publishedRefs: null };
      } else {
        const multiline = field === 'Focus' || field === 'Assignment' || field === 'Scope of work';
        const raw = multiline
          ? await this.dialogEditor(
              manager,
              generation,
              `${agent.handle} · ${field}`,
              field === 'Scope of work'
                ? 'Describe the files, area, or decision this expert is responsible for.'
                : 'Edit the current text. Enter submits; Esc cancels.',
              current,
            )
          : await this.dialogInput(
              manager,
              generation,
              `${agent.handle} · ${field}`,
              current ? `Current: ${current}` : 'Enter the new value.',
            );
        if (raw === undefined) return undefined;
        const value = raw.trim();
        if (!value && field !== 'Expertise' && field !== 'Published outputs') return undefined;
        patch =
          field === 'Display name'
            ? { displayName: value }
            : field === 'Role'
              ? { role: value }
              : field === 'Focus'
                ? { focus: value }
                : field === 'Assignment'
                  ? { assignment: value }
                  : field === 'Scope of work'
                    ? { ownershipBoundary: value }
                    : field === 'Expertise'
                      ? {
                          expertise: value
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean),
                        }
                      : {
                          publishedRefs: value
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean),
                        };
      }
      if (!this.isCurrent(manager, generation)) return undefined;
      const result = await manager.operatorExecute(TOOL.directory, { action: 'update', agentId, patch });
      return Array.isArray(result.details.clearedFields)
        ? `Cleared ${field.toLowerCase()} for ${agent.handle}.`
        : `Updated ${agent.handle}.`;
    }
    if (action === 'Set collaborator capacity') {
      const capacity = await this.dialogNumber(
        manager,
        generation,
        `Collaborator capacity · current ${projection.configuration.maxOpenAgents}, open ${projection.capacity.used}`,
        `Enter a positive whole number of at least ${projection.capacity.used}.`,
      );
      if (capacity === undefined || !this.isCurrent(manager, generation)) return undefined;
      await manager.operatorSetCapacity(capacity);
      return `Collaborator capacity is now ${capacity}.`;
    }
    if (action === 'Set nesting depth') {
      const depth = await this.dialogNumber(
        manager,
        generation,
        `Nesting depth · current ${projection.configuration.maxDepth}`,
        'Root is level 0, its luminaries are level 1, their subagents are level 2. Enter the deepest level to allow. Existing narrower permissions remain.',
      );
      if (depth === undefined || !this.isCurrent(manager, generation)) return undefined;
      await manager.operatorSetDepth(depth);
      return `Nesting depth is now ${depth}. The same constellation and conversations are retained.`;
    }
    if (action === 'Manage extension availability') return this.approveExtensionSource(manager, generation);
    if (action === 'Open another terminal') {
      return {
        tone: 'success',
        persistent: true,
        text: `Open this constellation:\n${manager.attachmentInvocation()}\nOpen one luminary:\npi --${LUMINARIES_IDENTITY.flags.luminary} <shortId>`,
      };
    }
    if (action === 'Bring in a Pi session') {
      const sessions = await manager.operatorSessions();
      if (!this.isCurrent(manager, generation)) return undefined;
      const shortCounts = new Map<string, number>();
      for (const session of sessions) {
        const shortId = session.sessionId.slice(-8);
        shortCounts.set(shortId, (shortCounts.get(shortId) ?? 0) + 1);
      }
      const choiceFor = (session: (typeof sessions)[number]) => {
        const preview = splitWhitespace(sanitizeDisplayText(session.firstMessage, [])).join(' ').slice(0, 80);
        const label = session.name || preview || 'Untitled session';
        const shortId = session.sessionId.slice(-8);
        const identity = shortCounts.get(shortId) === 1 ? shortId : session.sessionId;
        return `${label} · ${identity}`;
      };
      const rootCwd = projection.agents.find((candidate) => candidate.agentId === projection.rootId)?.cwd;
      const pathKey = (value: string) =>
        process.platform === 'win32' ? resolve(value).toLocaleLowerCase() : resolve(value);
      const canonicalRootCwd = rootCwd ? pathKey(rootCwd) : undefined;
      const sameProject = sessions.filter((session) => canonicalRootCwd && pathKey(session.cwd) === canonicalRootCwd);
      const otherProjects = sessions.filter((session) => !sameProject.includes(session));
      const sameChoices = sameProject.map(choiceFor);
      const selected = await this.dialogSessionSelect(
        manager,
        generation,
        `Bring a Pi session into ${rootCwd ?? 'this constellation'}\nCopies its active conversation; the source stays standalone.`,
        [
          ...sameChoices,
          ...(otherProjects.length ? [`Other projects · ${otherProjects.length}`] : []),
          'Enter a session ID or file path',
          'Cancel',
        ],
      );
      if (!selected || selected === 'Cancel' || !this.isCurrent(manager, generation)) return undefined;
      let selectedSession = sameProject[sameChoices.indexOf(selected)];
      if (selected.startsWith('Other projects')) {
        const otherChoices = otherProjects.map(
          (session) => `${basename(session.cwd) || session.cwd} · ${choiceFor(session)}`,
        );
        const other = await this.dialogSessionSelect(manager, generation, 'Other projects', [...otherChoices, 'Back']);
        if (!other || other === 'Back' || !this.isCurrent(manager, generation)) return undefined;
        selectedSession = otherProjects[otherChoices.indexOf(other)];
      }
      const reference =
        selectedSession?.sessionFile ??
        (
          await this.dialogInput(
            manager,
            generation,
            'Pi session',
            'Enter the exact Pi session ID or session-file path.',
          )
        )?.trim();
      if (!reference || !this.isCurrent(manager, generation)) return undefined;
      const source = await manager.operatorInspectSessionReference(reference);
      if (!this.isCurrent(manager, generation)) return undefined;
      const nameInput = await this.dialogInput(
        manager,
        generation,
        'Luminary name',
        `Optional. Current session name: ${source.name ?? selectedSession?.name ?? 'none'}`,
      );
      if (nameInput === undefined || !this.isCurrent(manager, generation)) return undefined;
      const assignment = (
        await this.dialogEditor(
          manager,
          generation,
          'Luminary assignment',
          'Describe what this expert should continue working on in the destination constellation.',
        )
      )?.trim();
      if (!assignment || !this.isCurrent(manager, generation)) return undefined;
      const expertiseInput = await this.dialogInput(
        manager,
        generation,
        'Expertise',
        'Optional. Enter concise areas separated by commas.',
      );
      if (expertiseInput === undefined || !this.isCurrent(manager, generation)) return undefined;
      const adopted = await manager.operatorAdoptSession(source.sessionFile, {
        ...(nameInput.trim() ? { name: nameInput.trim() } : {}),
        assignment,
        ...(expertiseInput.trim()
          ? {
              expertise: expertiseInput
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            }
          : {}),
      });
      return {
        tone: 'success',
        persistent: true,
        text: `Brought in ${adopted.handle}. The standalone source remains unchanged: ${adopted.sourceSessionFile}`,
      };
    }
    if (action === 'Continue in standalone Pi') {
      return this.detachSession(manager, generation, agent);
    }
    if (action === 'Park all collaborators') {
      const mode = await this.dialogSelect(manager, generation, 'Park all collaborators', [
        'At next safe boundary',
        'Now',
        'Cancel',
      ]);
      if (!mode || mode === 'Cancel' || !this.isCurrent(manager, generation)) return undefined;
      await manager.operatorParkAll(mode === 'Now' ? 'now' : 'safe');
      return mode === 'Now'
        ? 'Collaborators are being parked now.'
        : 'Collaborators will park at their next safe boundary.';
    }
    if (action === motionAction) {
      this.motionEnabled = !this.motionEnabled;
      this.refresh(generation);
      return this.motionEnabled ? 'Motion enabled.' : 'Motion reduced.';
    }
    if (action === 'Change model' || action === 'Change thinking') {
      const changingModel = action === 'Change model';
      if (agent.parentId !== null && (agent.humanState === 'working' || agent.humanState === 'starting'))
        return {
          tone: 'muted',
          persistent: true,
          text: `${agent.handle} is working. Model and thinking changes are available when it is Ready or Parked.`,
        };
      const value = await this.dialogSelect(
        manager,
        generation,
        changingModel
          ? `${agent.handle} model · current ${agent.model ?? 'Pi default'}`
          : `${agent.handle} thinking · current ${agent.thinking ?? 'Pi default'}`,
        changingModel
          ? manager.operatorModels().map((candidate) => `${candidate.provider}/${candidate.id}`)
          : [...manager.operatorThinkingLevels()],
      );
      if (!value) return undefined;
      if (!this.isCurrent(manager, generation)) return undefined;
      const current = this.projection?.agents.find((candidate) => candidate.agentId === agentId);
      if (current?.parentId !== null && (current?.humanState === 'working' || current?.humanState === 'starting'))
        return {
          tone: 'muted',
          persistent: true,
          text: `${current.handle} is working. Model and thinking changes are available when it is Ready or Parked.`,
        };
      const result = await manager.operatorExecute(
        TOOL.control,
        changingModel
          ? { action: 'set_model', agentId, model: value }
          : { action: 'set_thinking', agentId, thinking: value },
      );
      if (result.details.status === 'not_ready')
        return {
          tone: 'muted',
          persistent: true,
          text: `${agent.handle} is working. Model and thinking changes are available when it is Ready or Parked.`,
        };
      if (result.details.status !== 'applied') {
        const reason = typeof result.details.error === 'string' ? ` ${result.details.error}` : '';
        return {
          tone: 'error',
          persistent: true,
          text: `${agent.handle} · ${changingModel ? 'model' : 'thinking'} change ${result.details.status === 'refused' ? 'refused' : 'could not be confirmed'}.${reason}`,
        };
      }
      const effective = result.details.effectiveConfiguration;
      const effectiveModel = isRecord(effective) ? effective.model : undefined;
      const effectiveThinking = isRecord(effective) ? effective.thinking : undefined;
      return `${agent.handle} now uses ${typeof effectiveModel === 'string' ? effectiveModel : 'Pi default model'} · thinking ${typeof effectiveThinking === 'string' ? effectiveThinking : 'Pi default'}.`;
    }
    if (action === 'Extensions') return this.changeExtensions(manager, generation, agent);
    if (action === 'Permissions') {
      const grant = await this.dialogSelect(
        manager,
        generation,
        [
          `${agent.handle} permissions`,
          `Spawn subagents: ${agent.canSpawn ? 'allowed' : 'not allowed'}`,
          `Interrupt other luminaries: ${agent.canPeerInterrupt ? 'allowed' : 'not allowed'}`,
        ].join('\n'),
        [
          agent.canSpawn ? 'Disable subagent spawning' : 'Allow subagent spawning',
          agent.canPeerInterrupt ? 'Disable interrupting other luminaries' : 'Allow interrupting other luminaries',
          'Cancel',
        ],
      );
      if (!grant || grant === 'Cancel') return undefined;
      if (grant === 'Allow subagent spawning') {
        if (!this.isCurrent(manager, generation)) return undefined;
        await manager.operatorExecute(TOOL.control, {
          action: 'set_grants',
          agentId,
          grants: { spawn: true },
        });
      } else {
        if (!this.isCurrent(manager, generation)) return undefined;
        await manager.operatorExecute(TOOL.control, {
          action: 'set_grants',
          agentId,
          grants:
            grant === 'Disable subagent spawning'
              ? { spawn: false }
              : { peerInterrupt: grant === 'Allow interrupting other luminaries' },
        });
      }
      return `Changed ${agent.handle}'s permissions.`;
    }
    if (action === 'Close' || action === 'Close owned subtree') {
      const subtree = action === 'Close owned subtree';
      const confirmed = await this.dialogConfirm(
        manager,
        generation,
        action,
        subtree
          ? `Close ${agent.handle} and ${descendants.length} open descendant${descendants.length === 1 ? '' : 's'}? Their conversations will be kept.`
          : `Close ${agent.handle}? Conversation kept for later resume.`,
      );
      if (!confirmed || !this.isCurrent(manager, generation)) return undefined;
      await manager.operatorExecute(TOOL.control, {
        action: subtree ? 'close_subtree' : 'close',
        agentId,
      });
      await this.refreshClosedHistory(manager, generation);
      return `Closed ${agent.handle}${subtree ? ' and its owned subtree' : ''}.`;
    }
    return undefined;
  }

  private async approveExtensionSource(
    manager: LuminariesCommandCenterHost,
    generation: number,
  ): Promise<LuminariesActionResult | undefined> {
    const sources = manager.operatorExtensionSources();
    const labels = sources.map(
      (source) => `${source.specifier} · ${source.scope === 'project' ? 'this project' : 'user'}`,
    );
    const selected = await this.dialogSelect(manager, generation, 'Approve an extension for this constellation', [
      ...labels,
      'Enter another Pi extension source',
      'Cancel',
    ]);
    if (!selected || selected === 'Cancel') return undefined;
    let source = sources[labels.indexOf(selected)];
    let install = false;
    if (selected === 'Enter another Pi extension source') {
      const specifier = (
        await this.dialogInput(
          manager,
          generation,
          'Pi extension source',
          'Use the same local, npm:, git:, or GitHub source accepted by pi install.',
        )
      )?.trim();
      if (!specifier) return undefined;
      const scope = await this.dialogSelect(manager, generation, 'Where should Pi keep this source?', [
        'This project',
        'Your Pi profile',
        'Cancel',
      ]);
      if (!scope || scope === 'Cancel') return undefined;
      source = { specifier, scope: scope === 'This project' ? 'project' : 'user' };
      install = true;
    }
    if (!source || !this.isCurrent(manager, generation)) return undefined;
    const confirmed = await this.dialogConfirm(
      manager,
      generation,
      `Approve ${source.specifier}?`,
      'This makes the extension available for explicit expert selection. It does not load it into every expert.',
    );
    if (confirmed !== true || !this.isCurrent(manager, generation)) return undefined;
    await manager.operatorApproveExtension(source.specifier, source.scope, install);
    return {
      tone: 'success',
      persistent: true,
      text: `${source.specifier} is now available for expert selection. No expert was restarted or changed.`,
    };
  }

  private async changeExtensions(
    manager: LuminariesCommandCenterHost,
    generation: number,
    agent: LuminariesCommandCenterAgent,
  ): Promise<LuminariesActionResult | undefined> {
    if (agent.extensionChangePending)
      return { tone: 'muted', persistent: true, text: `${agent.handle} already has an extension change pending.` };
    const available = manager.operatorSelectableExtensions();
    if (!available.length)
      return {
        tone: 'muted',
        persistent: true,
        text: 'No optional extensions are approved. Select Root → actions → Root settings → Extension availability.',
      };
    const selected = new Set(agent.selectedExtensions);
    for (;;) {
      const labels = available.map(
        (extension) => `${selected.has(extension.specifier) ? '✓' : ' '} ${extension.specifier} · ${extension.source}`,
      );
      const choice = await this.dialogSelect(
        manager,
        generation,
        [
          `${agent.handle} extensions`,
          `Always loaded: ${agent.alwaysExtensions.join(', ') || 'none'}`,
          'A resident expert finishes its current turn and parks before this selection changes.',
        ].join('\n'),
        [...labels, 'Apply selection', 'Cancel'],
      );
      if (!choice || choice === 'Cancel') return undefined;
      if (choice === 'Apply selection') break;
      const extension = available[labels.indexOf(choice)];
      if (!extension) throw new Error('The selected extension is no longer available');
      if (selected.has(extension.specifier)) selected.delete(extension.specifier);
      else selected.add(extension.specifier);
    }
    if (!this.isCurrent(manager, generation)) return undefined;
    const result = await manager.operatorExecute(TOOL.control, {
      action: 'set_extensions',
      agentId: agent.agentId,
      extensions: [...selected],
    });
    const status = result.details.status;
    if (status === 'pending')
      return {
        tone: 'success',
        persistent: true,
        text: `${agent.handle} will finish its current turn and park. The saved extension selection loads on the next message.`,
      };
    if (status === 'saved' || status === 'applied')
      return `${agent.handle}'s extension selection is saved and will load on the next message.`;
    const reason = typeof result.details.error === 'string' ? ` ${result.details.error}` : '';
    return {
      tone: 'error',
      persistent: true,
      text: `${agent.handle}'s extension selection ${status === 'refused' ? 'was refused' : 'could not be confirmed'}.${reason}`,
    };
  }

  private async detachSession(
    manager: LuminariesCommandCenterHost,
    generation: number,
    agent: LuminariesCommandCenterAgent,
  ): Promise<LuminariesActionResult | undefined> {
    const confirmed = await this.dialogConfirm(
      manager,
      generation,
      'Continue in standalone Pi',
      `${agent.handle} will close in this constellation and keep its history here. A separate ordinary Pi session will continue from the same conversation. Continue?`,
    );
    if (!confirmed || !this.isCurrent(manager, generation)) return undefined;
    const detached = await manager.operatorDetachSession(agent.agentId);
    if ('status' in detached) return { tone: 'muted', persistent: true, text: detached.message };
    const root = this.projection?.agents.find((candidate) => candidate.parentId === null);
    const directory = root && resolve(root.cwd) !== resolve(agent.cwd) ? `From ${agent.cwd}:\n` : '';
    const receipt = `Standalone Pi session created.\n${agent.handle} is closed in this constellation.\nOpen ${detached.sessionName}:\n${directory}${detached.command}\nOr run pi --resume and choose "${detached.sessionName}".`;
    return { tone: 'success', persistent: true, text: receipt };
  }

  private refresh(generation: number): void {
    if (generation !== this.uiViewGeneration) return;
    const projection = this.projection;
    if (!projection) return;
    if (!this.workspaceOpen && projection.visible) this.ensureWidget(generation);
    else this.clearWidget();
    this.syncTimer(generation);
    this.queueRender(generation);
  }

  private syncTimer(generation: number): void {
    if (generation !== this.uiViewGeneration) return;
    const projection = this.projection;
    if (!projection) return;
    const visible = projection.visible || this.workspaceOpen;
    const visibleMotion = this.workspaceOpen
      ? this.workspaceComponent?.hasVisibleMotion() === true
      : projection.counts.working > 0;
    const timerIntervalMs = visible && this.motionEnabled && visibleMotion ? MOTION_INTERVAL_MS : undefined;
    if (timerIntervalMs !== this.timerIntervalMs) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.timerIntervalMs = timerIntervalMs;
    }
    if (timerIntervalMs && !this.timer) {
      this.timer = setInterval(() => {
        if (generation !== this.uiViewGeneration) return;
        const stillVisible = this.workspaceOpen
          ? this.workspaceComponent?.hasVisibleMotion() === true
          : (this.projection?.counts.working ?? 0) > 0;
        if (!this.motionEnabled || !stillVisible) {
          this.syncTimer(generation);
          return;
        }
        this.phase = (this.phase + 1) % MOTION_FRAME_COUNT;
        this.queueRender(generation);
      }, timerIntervalMs);
      this.timer.unref?.();
    }
    if (!this.motionEnabled || !visibleMotion) this.phase = 0;
  }

  private withClosedHistory(projection: LuminariesCommandCenterProjection): LuminariesCommandCenterProjection {
    if (!this.closedHistory) return projection;
    const openIds = new Set(projection.agents.map((agent) => agent.agentId));
    const currentClosedIds = new Set(projection.closedAgents.map((agent) => agent.agentId));
    const history = this.closedHistory.agents.filter(
      (agent) => !openIds.has(agent.agentId) && !currentClosedIds.has(agent.agentId),
    );
    const directory = orderCommandCenterDirectory([...projection.directory, ...history], projection.rootId);
    return {
      ...projection,
      closedAgents: directory.filter((agent) => agent.lifecycle === 'closed'),
      directory,
      archivedCount: this.closedHistory.archivedCount,
      historyRevision: Math.max(projection.historyRevision, this.closedHistory.revision),
    };
  }

  private refreshClosedHistory(manager: LuminariesCommandCenterHost, generation: number): Promise<void> {
    if (this.closedHistoryRefresh) {
      this.closedHistoryRefreshRequested = true;
      return this.closedHistoryRefresh;
    }
    this.closedHistoryRefreshRequested = false;
    let succeeded = false;
    const refresh = manager.operatorClosedHistory().then((history) => {
      succeeded = true;
      if (!this.isCurrent(manager, generation)) return;
      this.closedHistory = history;
      this.projection = this.withClosedHistory(manager.commandCenterProjection());
      this.workspaceComponent?.invalidate();
      this.refresh(generation);
    });
    this.closedHistoryRefresh = refresh;
    void refresh
      .finally(() => {
        if (this.closedHistoryRefresh !== refresh) return;
        this.closedHistoryRefresh = undefined;
        if (
          succeeded &&
          this.closedHistoryRefreshRequested &&
          this.isCurrent(manager, generation) &&
          this.workspaceOpen &&
          (this.projection?.historyRevision ?? 0) > (this.closedHistory?.revision ?? 0)
        )
          void this.refreshClosedHistory(manager, generation).catch((error) =>
            this.context?.ui?.notify?.(error instanceof Error ? error.message : String(error), 'warning'),
          );
      })
      .catch(() => undefined);
    return refresh;
  }

  private ensureWidget(generation: number): void {
    const ui = this.context?.ui;
    if (!ui || this.widgetRegistered) return;
    this.widgetRegistered = true;
    ui.setWidget(
      LUMINARIES_IDENTITY.namespace.uiSlot,
      (tui: { requestRender(): void }, theme: LuminariesTheme) => {
        this.widgetRender = () => tui.requestRender();
        return {
          render: (width: number) => {
            const projection = generation === this.uiViewGeneration ? this.projection : undefined;
            return projection
              ? renderAmbientWidget(projection, width, this.motionEnabled ? this.phase : 0, theme, this.terminalWidth)
              : [];
          },
          invalidate: () => this.queueRender(generation),
          dispose: () => {
            this.widgetRender = undefined;
          },
        };
      },
      { placement: 'aboveEditor' },
    );
  }

  private clearWidget(): void {
    if (!this.widgetRegistered) return;
    this.widgetRegistered = false;
    this.widgetRender = undefined;
    this.context?.ui?.setWidget(LUMINARIES_IDENTITY.namespace.uiSlot, undefined);
  }

  private isCurrent(manager: LuminariesCommandCenterHost, generation: number): boolean {
    return this.manager === manager && this.uiViewGeneration === generation;
  }

  private queueRender(generation: number): void {
    if (generation !== this.uiViewGeneration || this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      if (generation !== this.uiViewGeneration) return;
      this.renderQueued = false;
      this.widgetRender?.();
      this.workspaceRender?.();
    });
  }
}
