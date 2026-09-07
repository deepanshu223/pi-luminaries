import { truncateTail } from '@earendil-works/pi-coding-agent';
import type {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomEditor,
  CustomMessageComponent,
  ExtensionEditorComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  getMarkdownTheme,
  getSelectListTheme,
  KeybindingsManager,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from '@earendil-works/pi-coding-agent';
import {
  decodeKittyPrintable,
  type Component,
  type MarkdownTheme,
  type SelectListTheme,
  type Spacer,
  type Text,
  type TUI,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
  agentCard,
  agentTone,
  availabilityLabel,
  hasMotionFrame,
  hasRunningTurn,
  motionGlyph,
} from './command-center-card.ts';
import type {
  LuminariesCommandCenterAgent,
  LuminariesCommandCenterProjection,
  LuminariesPiMessage,
} from './command-center-projection.ts';
import { orderCommandCenterDirectory } from './command-center-projection.ts';
import type { LuminariesConversationUpdate } from './agent-conversations.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import { renderLuminariesProtocolMessage } from './luminaries-tools.ts';
import { isAsciiControlCharacter, sanitizeDisplayText, splitWhitespace } from './display-sanitizer.ts';
import { boundTerminalLines, HOST_TERMINAL_WIDTH, type LuminariesTerminalWidth } from './terminal-width.ts';

const DEFAULT_TERMINAL_ROWS = 34;
const STATUS_TTL_MS = 4_000;
const PRODUCT = LUMINARIES_IDENTITY.label;

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
type NativeToolResult = Parameters<InstanceType<typeof ToolExecutionComponent>['updateResult']>[0];
type NativeAssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type NativeCustomMessage = ConstructorParameters<typeof CustomMessageComponent>[0];
type NativeBranchSummaryMessage = ConstructorParameters<typeof BranchSummaryMessageComponent>[0];
type NativeCompactionSummaryMessage = ConstructorParameters<typeof CompactionSummaryMessageComponent>[0];
type LuminariesNativeEditor = InstanceType<typeof CustomEditor>;

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

function visibleWidth(value: string, terminalWidth: LuminariesTerminalWidth): number {
  return terminalWidth.visibleWidth(value);
}

function truncate(value: string, width: number, terminalWidth: LuminariesTerminalWidth, ellipsis = '…'): string {
  return terminalWidth.truncateToWidth(value, Math.max(0, width), ellipsis);
}

export function friendlyError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return sanitizeDisplayText(message, []);
}

function separator(width: number, theme: LuminariesTheme, terminalWidth: LuminariesTerminalWidth): string {
  return theme.fg('borderMuted', truncate('─'.repeat(Math.max(1, width)), width, terminalWidth, ''));
}

function collaboratorCount(projection: LuminariesCommandCenterProjection): number {
  return projection.agents.filter((agent) => agent.agentId !== projection.rootId).length;
}

type DirectoryView = 'current' | 'archived';

function directoryAgents(
  projection: LuminariesCommandCenterProjection,
  directoryView: DirectoryView,
): readonly LuminariesCommandCenterAgent[] {
  return orderCommandCenterDirectory(
    projection.directory.filter((agent) =>
      directoryView === 'archived' ? agent.archived : agent.agentId === projection.rootId || !agent.archived,
    ),
    projection.rootId,
  );
}

function workspaceSummary(projection: LuminariesCommandCenterProjection, directoryView: DirectoryView): string {
  if (directoryView === 'archived')
    return projection.archivedCount ? `${projection.archivedCount} archived` : 'No archived collaborators';
  const luminaries = collaboratorCount(projection);
  if (!luminaries) {
    const retained = projection.closedAgents.filter((agent) => !agent.archived).length;
    return retained
      ? `${retained} retained luminar${retained === 1 ? 'y' : 'ies'} · none open`
      : 'Your constellation starts with one expert';
  }
  const parts = [
    `${luminaries} luminar${luminaries === 1 ? 'y' : 'ies'}`,
    projection.counts.attention ? `✕${projection.counts.attention}` : undefined,
    projection.counts.working ? `${projection.counts.working} working` : undefined,
    projection.counts.waiting ? `${projection.counts.waiting} waiting` : undefined,
    projection.counts.idle ? `${projection.counts.idle} idle` : undefined,
  ].filter((value): value is string => !!value);
  parts.push(`${projection.capacity.available} slots`);
  return parts.join(' · ');
}

function emptyConstellationMessage(projection: LuminariesCommandCenterProjection): string {
  const retained = projection.closedAgents.filter((agent) => !agent.archived).length;
  return retained
    ? `${retained} retained luminar${retained === 1 ? 'y' : 'ies'} · v history · n new luminary`
    : 'No luminaries yet. Press n to create, or use Root actions to bring in a Pi session.';
}

function commandHints(
  projection: LuminariesCommandCenterProjection,
  selected: LuminariesCommandCenterAgent | undefined,
  directoryView: DirectoryView,
  rootEnter: 'return' | 'manage' | 'conversation',
  readOnly: boolean,
): readonly string[] {
  const root = selected?.agentId === projection.rootId;
  const openCollaborators = collaboratorCount(projection);
  const currentRows = directoryAgents(projection, 'current').filter((agent) => agent.agentId !== projection.rootId);
  if (directoryView === 'archived')
    return [
      'Esc return',
      selected ? 'Enter history' : undefined,
      !readOnly && selected ? 'a actions' : undefined,
      selected ? 'i details' : undefined,
      'v current',
    ].filter((value): value is string => !!value);
  if (!currentRows.length)
    return [
      !readOnly && projection.capacity.available > 0 ? 'n bring in luminary' : undefined,
      !readOnly && root ? 'a actions' : undefined,
      'v archived',
      rootEnter === 'return' ? 'Esc return to Pi' : 'Esc return',
    ].filter((value): value is string => !!value);
  return [
    'Esc return',
    !selected
      ? undefined
      : root
        ? rootEnter === 'return'
          ? 'Enter Pi'
          : rootEnter === 'conversation'
            ? 'Enter open'
            : 'Enter root actions'
        : 'Enter open',
    !readOnly && selected ? 'a actions' : undefined,
    selected ? 'i details' : undefined,
    '/ find',
    !readOnly && projection.capacity.available > 0 ? 'n new' : undefined,
    !readOnly && openCollaborators >= 2 ? 'b message several' : undefined,
  ].filter((value): value is string => !!value);
}

function searchHint(
  query: string,
  matchCount: number,
  selected: LuminariesCommandCenterAgent | undefined,
  rootId: string,
  rootEnter: 'return' | 'manage' | 'conversation',
): string {
  const action = selected
    ? selected.agentId === rootId
      ? rootEnter === 'return'
        ? ' · Enter return to Pi'
        : rootEnter === 'conversation'
          ? ' · Enter open root conversation'
          : ' · Enter root actions'
      : ' · Enter open conversation'
    : '';
  return `Find: ${query || '…'} · ${matchCount} match${matchCount === 1 ? '' : 'es'}${action} · Esc cancel`;
}

function agentStatus(
  agent: LuminariesCommandCenterAgent,
  phase: number,
  includeActivity: boolean,
  directoryView?: DirectoryView,
): string {
  if (agent.attention)
    return `✕ Needs you${
      includeActivity && agent.health.observations[0]?.message
        ? ` · ${singleLine(agent.health.observations[0].message)}`
        : ''
    }`;
  const frame = motionGlyph(agent, phase);
  const posture = `${frame ? `${frame} ` : ''}${availabilityLabel(agent)}`;
  const activity =
    directoryView === 'archived' && agent.archived
      ? 'archived'
      : includeActivity && agent.humanState === 'waiting' && agent.dependency?.startsWith('Waiting on ')
        ? `for ${agent.dependency.slice('Waiting on '.length)}`
        : includeActivity
          ? singleLine(agent.activity)
          : '';
  return activity ? `${posture} · ${activity}` : posture;
}

function singleLine(value: string): string {
  return splitWhitespace(value).join(' ');
}

export function renderAmbientWidget(
  projection: LuminariesCommandCenterProjection,
  width: number,
  phase: number,
  theme: LuminariesTheme,
  terminalWidth: LuminariesTerminalWidth = HOST_TERMINAL_WIDTH,
): string[] {
  if (!projection.visible || width < 18) return [];
  const summary = [
    projection.counts.attention ? `${projection.counts.attention} need attention` : undefined,
    projection.counts.working ? `${projection.counts.working} working` : undefined,
    projection.counts.waiting ? `${projection.counts.waiting} waiting` : undefined,
  ].filter((value): value is string => !!value);
  if (!summary.length) summary.push('Active work');
  const hint = width >= 56 ? ' · Alt+L manage' : ` · /${LUMINARIES_IDENTITY.command}`;
  const header = truncate(`${PRODUCT} · ${summary.join(' · ')}${hint}`, width, terminalWidth);
  const lines = [theme.fg('accent', theme.bold(header))];
  for (const row of projection.ambient) {
    const identity = `${row.prefix}${row.name}`;
    const status = agentStatus(row.agent, phase, false);
    lines.push(theme.fg(agentTone(row.agent), rightAligned(identity, status, width, terminalWidth)));
  }
  return boundTerminalLines(lines, width, terminalWidth);
}

function rightAligned(left: string, right: string, width: number, terminalWidth: LuminariesTerminalWidth): string {
  const safeWidth = Math.max(1, width);
  const gapWidth = visibleWidth(' ', terminalWidth);
  const reservedLeft = Math.min(visibleWidth(left, terminalWidth), Math.max(10, Math.floor(safeWidth * 0.4)));
  const boundedRight = truncate(right, Math.max(0, safeWidth - gapWidth - reservedLeft), terminalWidth);
  const rightWidth = visibleWidth(boundedRight, terminalWidth);
  const leftWidth = Math.max(0, safeWidth - rightWidth - gapWidth);
  const clippedLeft = truncate(left, leftWidth, terminalWidth);
  const padding = Math.max(0, safeWidth - visibleWidth(clippedLeft, terminalWidth) - rightWidth);
  return truncate(`${clippedLeft}${' '.repeat(padding)}${boundedRight}`, safeWidth, terminalWidth, '');
}

function directoryLine(
  agent: LuminariesCommandCenterAgent,
  selected: boolean,
  width: number,
  phase: number,
  theme: LuminariesTheme,
  terminalWidth: LuminariesTerminalWidth,
  directoryView: DirectoryView,
  pickerMarks?: ReadonlySet<string>,
): string {
  const marker = selected ? '›' : ' ';
  const recipient = pickerMarks
    ? agent.parentId !== null && agent.lifecycle === 'open'
      ? pickerMarks.has(agent.agentId)
        ? '[✓] '
        : '[ ] '
      : '    '
    : '';
  const prefix = `${marker} ${agent.treePrefix}${recipient}`;
  const status = agentStatus(agent, phase, false, directoryView);
  const statusWidth = visibleWidth(status, terminalWidth);
  const leftWidth = Math.max(1, width - statusWidth - 1);
  const suffix = agent.parentId === null ? '' : ` · ${agent.shortId}`;
  const prefixWidth = Math.max(1, leftWidth - visibleWidth(suffix, terminalWidth));
  const left = `${truncate(`${prefix}${agent.name}`, prefixWidth, terminalWidth)}${suffix}`;
  const padding = ' '.repeat(Math.max(1, width - visibleWidth(left, terminalWidth) - statusWidth));
  const plain = truncate(`${left}${padding}${status}`, width, terminalWidth, '');
  const colored = theme.fg(
    agent.attention ? 'error' : selected ? 'accent' : agentTone(agent),
    selected ? theme.bold(plain) : plain,
  );
  return colored;
}

function directoryWindow(
  agents: readonly LuminariesCommandCenterAgent[],
  selectedId: string,
  height: number,
): readonly LuminariesCommandCenterAgent[] {
  const selected = Math.max(
    0,
    agents.findIndex((agent) => agent.agentId === selectedId),
  );
  const safeHeight = Math.max(1, height);
  const start = Math.max(0, Math.min(selected - safeHeight + 1, agents.length - safeHeight));
  return agents.slice(start, start + safeHeight);
}

function factSheetLines(
  agent: LuminariesCommandCenterAgent,
  width: number,
  height: number,
  theme: LuminariesTheme,
  terminalWidth: LuminariesTerminalWidth,
  complete = false,
  offset = 0,
): string[] {
  const card = agentCard(agent, complete);
  const lines = [
    theme.fg(card.tone, theme.bold(rightAligned(card.name, card.state, width, terminalWidth))),
    theme.fg('dim', truncate(card.breadcrumb, width, terminalWidth)),
  ];
  const valueWidth = Math.max(1, width - 2);
  const wrapped = card.fields.map((field) =>
    field.value.split('\n').flatMap((value) => {
      const wrapped = wrapTextWithAnsi(value, valueWidth);
      if (!complete && field.label === 'Recent activity' && wrapped.length > 2)
        return [wrapped[0], truncate(`${wrapped[1]}…`, valueWidth, terminalWidth)];
      return wrapped;
    }),
  );
  if (complete) {
    for (let fieldIndex = 0; fieldIndex < card.fields.length; fieldIndex++) {
      const field = card.fields[fieldIndex];
      if (!field) continue;
      const values = wrapped[fieldIndex] ?? [''];
      lines.push(theme.fg('muted', field.label));
      for (const value of values) lines.push(`${theme.fg('muted', '  ')}${theme.fg('text', value)}`);
    }
    return lines.slice(offset, offset + height);
  }
  const visibleFieldCount = Math.min(card.fields.length, Math.floor(Math.max(0, height - lines.length) / 2));
  const visibleFields = card.fields.slice(0, visibleFieldCount);
  const allocations = visibleFields.map(() => 1);
  let remaining = Math.max(0, height - lines.length - visibleFields.length * 2);
  while (remaining > 0 && visibleFields.some((_, index) => (allocations[index] ?? 0) < (wrapped[index]?.length ?? 0))) {
    for (let index = 0; index < visibleFields.length && remaining > 0; index++) {
      const allocation = allocations[index] ?? 0;
      if (allocation >= (wrapped[index]?.length ?? 0)) continue;
      allocations[index] = allocation + 1;
      remaining--;
    }
  }
  for (let fieldIndex = 0; fieldIndex < visibleFields.length; fieldIndex++) {
    const field = visibleFields[fieldIndex];
    if (!field) continue;
    const values = wrapped[fieldIndex] ?? [''];
    const allocation = allocations[fieldIndex] ?? 1;
    lines.push(theme.fg('muted', field.label));
    for (let lineIndex = 0; lineIndex < allocation; lineIndex++) {
      let value = values[lineIndex] ?? '';
      if (lineIndex === allocation - 1 && allocation < values.length)
        value = truncate(`${value}…`, valueWidth, terminalWidth);
      lines.push(`${theme.fg('muted', '  ')}${theme.fg('text', value)}`);
    }
  }
  return lines.slice(0, height);
}

function factSheetLineCount(
  agent: LuminariesCommandCenterAgent,
  width: number,
  theme: LuminariesTheme,
  terminalWidth: LuminariesTerminalWidth,
): number {
  return factSheetLines(agent, width, Number.MAX_SAFE_INTEGER, theme, terminalWidth, true).length;
}

function conversationHeaderLines(
  agent: LuminariesCommandCenterAgent,
  width: number,
  theme: LuminariesTheme,
  terminalWidth: LuminariesTerminalWidth,
): string[] {
  const identity = agent.role ? `${agent.handle} · ${agent.role}` : agent.handle;
  const facts = [agent.model, agent.thinking, agent.contextMode].filter(Boolean).join(' · ');
  const label = identity;
  const state = availabilityLabel(agent);
  const current = agent.activity ? `${state} · ${singleLine(agent.activity)}` : state;
  const wake = state === 'Parked' ? ' · message to wake' : '';
  const status = `${current}${wake}${agent.attention ? ' · Needs you' : ''} · Esc directory`;
  return [
    theme.fg(agentTone(agent), theme.bold(rightAligned(label, status, width, terminalWidth))),
    theme.fg('dim', truncate(`${agent.breadcrumb.join(' › ')}${facts ? ` · ${facts}` : ''}`, width, terminalWidth)),
  ];
}

function messageText(message: LuminariesPiMessage): string | undefined {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts = message.content
    .filter(
      (part): part is Record<string, unknown> =>
        typeof part === 'object' && part !== null && !Array.isArray(part) && part.type === 'text',
    )
    .map((part) => part.text)
    .filter((value): value is string => typeof value === 'string');
  return parts.length ? parts.join('') : undefined;
}

function messageParts(message: LuminariesPiMessage): readonly Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.filter(
        (part): part is Record<string, unknown> => typeof part === 'object' && part !== null && !Array.isArray(part),
      )
    : [];
}

function isNativeAssistantMessage(
  message: LuminariesPiMessage,
): message is LuminariesPiMessage & NativeAssistantMessage {
  return message.role === 'assistant';
}

function isNativeCustomMessage(message: LuminariesPiMessage): message is LuminariesPiMessage & NativeCustomMessage {
  return message.role === 'custom';
}

function isNativeBranchSummaryMessage(
  message: LuminariesPiMessage,
): message is LuminariesPiMessage & NativeBranchSummaryMessage {
  return message.role === 'branchSummary';
}

function isNativeCompactionSummaryMessage(
  message: LuminariesPiMessage,
): message is LuminariesPiMessage & NativeCompactionSummaryMessage {
  return message.role === 'compactionSummary';
}

function toolResult(message: LuminariesPiMessage): NativeToolResult | undefined {
  if (message.role !== 'toolResult' || !Array.isArray(message.content)) return undefined;
  const content: NativeToolResult['content'] = [];
  for (const part of message.content) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
    else if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')
      content.push({ type: 'image', data: part.data, mimeType: part.mimeType });
  }
  return {
    content,
    ...(message.details !== undefined ? { details: message.details } : {}),
    isError: message.isError === true,
  };
}

function unfinishedToolResult(message: LuminariesPiMessage): NativeToolResult | undefined {
  if (message.stopReason !== 'aborted' && message.stopReason !== 'error') return undefined;
  const text =
    typeof message.errorMessage === 'string'
      ? message.errorMessage
      : message.stopReason === 'aborted'
        ? 'Operation aborted'
        : 'Error';
  return { content: [{ type: 'text', text }], isError: true };
}
function historicalTruncation(output: string) {
  const truncation = truncateTail(output);
  truncation.truncated = true;
  return truncation;
}

interface NativeMessageGroup {
  message: LuminariesPiMessage;
  components: Component[];
  toolCallIds: string[];
  hasPriorContent: boolean;
  lines?: string[];
  width?: number;
}

export class LuminariesCommandCenterComponent implements LuminariesComponent {
  focused = true;
  private view: 'directory' | 'agent' = 'directory';
  private directoryView: DirectoryView = 'current';
  private selectedId: string;
  private readonly selectedByView: Partial<Record<DirectoryView, string>> = {};
  private searchQuery?: string;
  private searchRestoreId?: string;
  private factSheetOpen = false;
  private factSheetOffset = 0;
  private pickerMarks?: Set<string>;
  private status?: LuminariesActionStatus;
  private statusTimer?: NodeJS.Timeout;
  private busy = false;
  private conversationTailOffset = 0;
  private visibleMotion = false;
  private disposed = false;
  private toolsExpanded = false;
  private thinkingHidden = false;
  private conversation: readonly LuminariesPiMessage[] = [];
  private conversationEpoch?: string;
  private conversationIncarnation?: number;
  private conversationRevision = 0;
  private conversationHydrated = false;
  private conversationUnsubscribe?: () => void;
  private nativeAgentId?: string;
  /** One component group per conversation message; unchanged messages reuse their Pi-native components. */
  private nativeGroups: NativeMessageGroup[] = [];
  private nativeGroupWidth = 0;
  private nativeLineTotal?: number;
  private directoryRenderWidth?: number;
  private readonly editor?: LuminariesNativeEditor;
  private editorAgentId?: string;
  private readonly getProjection: () => LuminariesCommandCenterProjection;
  private readonly getPhase: () => number;
  private readonly theme: LuminariesTheme;
  private readonly actions: LuminariesCommandCenterActions;
  private readonly requestRender: () => void;
  private readonly done: () => void;
  private readonly getTerminalRows: () => number;
  private readonly terminalWidth: LuminariesTerminalWidth;
  private readonly nativeUi?: LuminariesNativeConversationUi;
  private readonly rootEnter: 'return' | 'manage' | 'conversation';

  constructor(
    getProjection: () => LuminariesCommandCenterProjection,
    getPhase: () => number,
    theme: LuminariesTheme,
    actions: LuminariesCommandCenterActions,
    requestRender: () => void,
    done: () => void,
    getTerminalRows: () => number = () => DEFAULT_TERMINAL_ROWS,
    terminalWidth: LuminariesTerminalWidth = HOST_TERMINAL_WIDTH,
    nativeUi?: LuminariesNativeConversationUi,
    options: { initialAgentId?: string; rootEnter?: 'return' | 'manage' | 'conversation' } = {},
  ) {
    this.getProjection = getProjection;
    this.getPhase = getPhase;
    this.theme = theme;
    this.actions = actions;
    this.requestRender = requestRender;
    this.done = done;
    this.getTerminalRows = getTerminalRows;
    this.terminalWidth = terminalWidth;
    this.nativeUi = nativeUi;
    this.rootEnter = options.rootEnter ?? 'return';
    const projection = getProjection();
    const initialAgent = options.initialAgentId
      ? projection.directory.find((agent) => agent.agentId === options.initialAgentId)
      : undefined;
    if (initialAgent?.archived) this.directoryView = 'archived';
    const initialAgents = directoryAgents(projection, this.directoryView);
    const fallbackId =
      initialAgents.find((agent) => agent.attention)?.agentId ??
      initialAgents.find((agent) => agent.agentId !== projection.rootId && agent.active)?.agentId ??
      projection.agents.find((agent) => agent.agentId !== projection.rootId)?.agentId ??
      projection.rootId;
    this.selectedId = initialAgent ? initialAgent.agentId : fallbackId;
    this.selectedByView[this.directoryView] = this.selectedId;
    if (options.initialAgentId && this.selectedId !== projection.rootId) this.view = 'agent';
    if (nativeUi) {
      this.editor = new nativeUi.CustomEditor(
        nativeUi.tui,
        {
          borderColor: (text) => theme.fg('accent', text),
          selectList: nativeUi.selectListTheme,
        },
        nativeUi.keybindings,
        { paddingX: 0 },
      );
      this.editor.onSubmit = (text) => this.submitEditor(text, 'auto');
      this.editor.onEscape = () => this.returnToDirectory();
      this.editor.onAction('app.message.followUp', () => this.submitEditor(this.editor?.getText() ?? '', 'follow_up'));
      this.editor.onAction('app.clear', () => this.clearOrInterrupt());
      this.editor.onAction('app.tools.expand', () => {
        this.toolsExpanded = !this.toolsExpanded;
        this.rebuildNativeComponents(this.selectedAgent(this.getProjection()));
        this.safeRender();
      });
      this.editor.onAction('app.thinking.toggle', () => {
        this.thinkingHidden = !this.thinkingHidden;
        this.rebuildNativeComponents(this.selectedAgent(this.getProjection()));
        this.safeRender();
      });
    }
    if (this.view === 'agent') this.openConversation(this.selectedAgent(projection));
    this.clampScrollOffsets(projection);
  }

  render(width: number): string[] {
    const projection = this.getProjection();
    const selected = this.selectedAgent(projection);
    const safeWidth = Math.max(1, width);
    if (safeWidth < 28)
      return boundTerminalLines(
        [truncate(`${PRODUCT} needs 28 columns.`, safeWidth, this.terminalWidth)],
        safeWidth,
        this.terminalWidth,
      );
    const rows = Math.max(1, this.getTerminalRows());
    if (this.view === 'directory') {
      if (this.factSheetOpen && this.directoryRenderWidth !== undefined && this.directoryRenderWidth !== safeWidth)
        this.factSheetOffset = 0;
      this.directoryRenderWidth = safeWidth;
    }
    if (this.view === 'agent') {
      this.setVisibleMotion(hasMotionFrame(selected));
      return this.renderAgent(selected, safeWidth, rows);
    }
    const lines =
      rows < 10
        ? this.renderCompact(projection, safeWidth, rows)
        : this.renderDirectory(projection, selected, safeWidth, rows);
    return boundTerminalLines(lines, safeWidth, this.terminalWidth);
  }

  handleInput(data: string): void {
    data = decodeKittyPrintable(data) ?? data;
    if (this.status && !this.busy) {
      if (!this.status.persistent) this.setStatus(undefined);
      else if (this.matches(data, 'tui.select.cancel')) {
        this.setStatus(undefined);
        this.safeRender();
        return;
      }
    }
    const projection = this.getProjection();
    this.reconcileProjection(projection);
    this.clampScrollOffsets(projection);
    const selected = this.selectedAgent(projection);
    if (this.view === 'agent') {
      if (selected.lifecycle === 'closed' || this.actions.readOnlyReason?.()) {
        if (this.matches(data, 'tui.select.cancel')) this.returnToDirectory();
        else if (this.matches(data, 'tui.select.pageUp')) this.scrollConversation(8);
        else if (this.matches(data, 'tui.select.pageDown')) this.scrollConversation(-8);
        return;
      }
      if (!this.editor) {
        if (this.matches(data, 'tui.select.cancel')) this.returnToDirectory();
        return;
      }
      this.editor.focused = this.focused;
      this.editor.handleInput(data);
      this.clampScrollOffsets(this.getProjection());
      return;
    }
    if (this.factSheetOpen) {
      if (data === 'i' || this.matches(data, 'tui.select.cancel')) {
        this.factSheetOpen = false;
        this.factSheetOffset = 0;
      } else if (this.matches(data, 'tui.select.up')) this.scrollFactSheet(-1, selected);
      else if (this.matches(data, 'tui.select.down')) this.scrollFactSheet(1, selected);
      else if (this.matches(data, 'tui.select.pageUp')) this.scrollFactSheet(-8, selected);
      else if (this.matches(data, 'tui.select.pageDown')) this.scrollFactSheet(8, selected);
      this.safeRender();
      return;
    }
    if (this.pickerMarks) {
      this.handlePicker(data, projection, selected);
      this.safeRender();
      return;
    }
    if (this.searchQuery !== undefined) {
      this.handleSearch(data, projection);
      return;
    }
    if (this.matches(data, 'tui.select.cancel')) {
      this.disposed = true;
      this.done();
      this.safeRender();
      return;
    }
    this.handleDirectory(data, projection);
    this.safeRender();
  }

  scrollBy(lines: number): void {
    const projection = this.getProjection();
    this.reconcileProjection(projection);
    if (this.view === 'agent') {
      this.rebuildNativeComponents(this.selectedAgent(projection));
      this.clampScrollOffsets(projection);
      this.scrollConversation(-lines);
    } else {
      this.clampScrollOffsets(projection);
      if (this.factSheetOpen) this.scrollFactSheet(lines, this.selectedAgent(projection));
      else this.move(lines, projection);
      this.safeRender();
    }
  }

  invalidate(): void {
    const projection = this.getProjection();
    this.reconcileProjection(projection);
    if (this.view === 'agent') {
      const selected = this.selectedAgent(projection);
      this.setVisibleMotion(hasMotionFrame(selected));
      this.rebuildNativeComponents(selected);
    }
    this.clampScrollOffsets(projection);
    this.safeRender();
  }

  dispose(): void {
    this.disposed = true;
    this.focused = false;
    this.conversationUnsubscribe?.();
    this.conversationUnsubscribe = undefined;
    if (this.statusTimer) clearTimeout(this.statusTimer);
  }

  hasVisibleMotion(): boolean {
    return this.visibleMotion;
  }

  private renderCompact(projection: LuminariesCommandCenterProjection, width: number, terminalRows: number): string[] {
    const visibleAgents = this.filteredDirectoryAgents(projection);
    const visibleSelected = this.visibleSelectedAgent(projection);
    const readOnlyReason = this.actions.readOnlyReason?.();
    const footer = this.directoryFooterLines(
      projection,
      visibleSelected,
      visibleAgents.length,
      readOnlyReason !== undefined,
      width,
    );
    const bodyHeight = Math.max(0, terminalRows - 1 - footer.length);
    let body: string[];
    if (this.factSheetOpen && visibleSelected) {
      this.clampFactSheetOffset(visibleSelected, width, bodyHeight);
      body = factSheetLines(
        visibleSelected,
        width,
        bodyHeight,
        this.theme,
        this.terminalWidth,
        true,
        this.factSheetOffset,
      );
    } else if (visibleSelected)
      body = [
        directoryLine(
          visibleSelected,
          true,
          width,
          this.getPhase(),
          this.theme,
          this.terminalWidth,
          this.directoryView,
          this.pickerMarks,
        ),
      ];
    else
      body = [
        this.theme.fg(
          'muted',
          truncate(
            this.searchQuery === undefined
              ? this.directoryView === 'archived'
                ? 'No archived collaborators.'
                : emptyConstellationMessage(projection)
              : 'No matching collaborators.',
            width,
            this.terminalWidth,
          ),
        ),
      ];
    this.setVisibleMotion(!this.factSheetOpen && !!visibleSelected && hasMotionFrame(visibleSelected));
    const lines = [
      this.directoryTitle(projection, width, readOnlyReason),
      ...body,
      ...footer.map((line) =>
        this.theme.fg(this.status?.tone ?? (this.searchQuery !== undefined ? 'accent' : 'dim'), line),
      ),
    ];
    return lines.slice(0, terminalRows);
  }

  private renderDirectory(
    projection: LuminariesCommandCenterProjection,
    selected: LuminariesCommandCenterAgent,
    width: number,
    terminalRows: number,
  ): string[] {
    const visibleAgents = this.filteredDirectoryAgents(projection);
    const visibleSelected = this.visibleSelectedAgent(projection);
    const readOnlyReason = this.actions.readOnlyReason?.();
    const footer = this.directoryFooterLines(
      projection,
      visibleSelected,
      visibleAgents.length,
      readOnlyReason !== undefined,
      width,
    );
    const bodyHeight = Math.max(1, terminalRows - 3 - footer.length);
    const lines = [
      this.directoryTitle(projection, width, readOnlyReason),
      separator(width, this.theme, this.terminalWidth),
    ];
    let window: readonly LuminariesCommandCenterAgent[] = [];
    if (this.factSheetOpen && visibleSelected) {
      this.clampFactSheetOffset(visibleSelected, width, bodyHeight);
      lines.push(
        ...factSheetLines(
          visibleSelected,
          width,
          bodyHeight,
          this.theme,
          this.terminalWidth,
          true,
          this.factSheetOffset,
        ),
      );
    } else if (!visibleAgents.length) {
      lines.push(
        this.theme.fg(
          'muted',
          truncate(
            this.searchQuery === undefined
              ? this.directoryView === 'archived'
                ? 'No archived collaborators.'
                : emptyConstellationMessage(projection)
              : 'No matching collaborators.',
            width,
            this.terminalWidth,
          ),
        ),
      );
    } else {
      const wideInspector =
        width >= 86 &&
        visibleSelected &&
        !this.pickerMarks &&
        (collaboratorCount(projection) > 0 || visibleSelected.attention);
      const directoryWidth = wideInspector ? Math.max(32, Math.min(48, Math.floor(width * 0.42))) : width;
      window = directoryWindow(visibleAgents, selected.agentId, bodyHeight);
      const directoryLines = window.map((agent) =>
        directoryLine(
          agent,
          agent.agentId === selected.agentId,
          directoryWidth,
          this.getPhase(),
          this.theme,
          this.terminalWidth,
          this.directoryView,
          this.pickerMarks,
        ),
      );
      if (wideInspector) {
        const divider = this.theme.fg('borderMuted', ' | ');
        const inspectorWidth = Math.max(1, width - directoryWidth - 3);
        const inspector = factSheetLines(visibleSelected, inspectorWidth, bodyHeight, this.theme, this.terminalWidth);
        for (let index = 0; index < Math.max(directoryLines.length, inspector.length); index++) {
          const left = truncate(directoryLines[index] ?? '', directoryWidth, this.terminalWidth, '');
          const padding = ' '.repeat(Math.max(0, directoryWidth - visibleWidth(left, this.terminalWidth)));
          lines.push(`${left}${padding}${divider}${inspector[index] ?? ''}`);
        }
      } else lines.push(...directoryLines);
      if (visibleAgents.length === 1 && visibleAgents[0]?.agentId === projection.rootId) {
        lines.push('');
        lines.push(this.theme.fg('muted', truncate(emptyConstellationMessage(projection), width, this.terminalWidth)));
      }
    }
    this.setVisibleMotion(!this.factSheetOpen && window.some(hasMotionFrame));
    while (lines.length < terminalRows - 1 - footer.length) lines.push('');
    lines.push(separator(width, this.theme, this.terminalWidth));
    lines.push(
      ...footer.map((line) =>
        this.theme.fg(
          this.status?.tone ?? (this.searchQuery !== undefined || this.pickerMarks ? 'accent' : 'dim'),
          line,
        ),
      ),
    );
    return lines;
  }

  private directoryTitle(
    projection: LuminariesCommandCenterProjection,
    width: number,
    readOnlyReason: string | undefined,
  ): string {
    const current =
      this.directoryView === 'current'
        ? this.theme.fg('accent', this.theme.bold('[Current]'))
        : this.theme.fg('dim', 'Current');
    const archived =
      this.directoryView === 'archived'
        ? this.theme.fg('accent', this.theme.bold('[Archived]'))
        : this.theme.fg('dim', 'Archived');
    const views = `${current} ${archived}`;
    const summary = readOnlyReason ?? workspaceSummary(projection, this.directoryView);
    const title = width < 100 ? 'Constellation' : `${LUMINARIES_IDENTITY.label} · Constellation`;
    const product = this.theme.fg('accent', this.theme.bold(title));
    const left = width < 40 ? views : `${product}   ${views}`;
    return visibleWidth(`${left} ${summary}`, this.terminalWidth) <= width
      ? rightAligned(left, summary, width, this.terminalWidth)
      : truncate(left, width, this.terminalWidth);
  }

  private directoryFooterLines(
    projection: LuminariesCommandCenterProjection,
    selected: LuminariesCommandCenterAgent | undefined,
    matchCount: number,
    readOnly: boolean,
    width: number,
  ): string[] {
    const value = this.factSheetOpen
      ? 'Esc close details · ↑↓ scroll · PgUp/PgDn'
      : this.status
        ? this.status.text
        : this.pickerMarks
          ? `Recipients · ${this.pickerMarks.size} marked · Space/t mark · a all-or-none · Enter compose · Esc cancel`
          : this.searchQuery !== undefined
            ? searchHint(this.searchQuery, matchCount, selected, projection.rootId, this.rootEnter)
            : commandHints(projection, selected, this.directoryView, this.rootEnter, readOnly).join(' · ');
    return this.status?.persistent
      ? [...wrapTextWithAnsi(value, Math.max(1, width)), 'Esc dismiss']
      : [truncate(value, Math.max(1, width), this.terminalWidth)];
  }

  private setVisibleMotion(visible: boolean): void {
    if (this.visibleMotion === visible) return;
    this.visibleMotion = visible;
    this.actions.motionChanged?.();
  }

  private renderAgent(selected: LuminariesCommandCenterAgent, width: number, terminalRows: number): string[] {
    const header = conversationHeaderLines(selected, width, this.theme, this.terminalWidth);
    if (terminalRows <= header.length) return header.slice(0, terminalRows);
    if (!this.nativeUi)
      return [
        ...header,
        ...Array.from({ length: terminalRows - header.length - 1 }, () => ''),
        this.theme.fg(
          'error',
          truncate('Pi native conversation components are unavailable.', width, this.terminalWidth),
        ),
      ];

    this.syncNativeGroups(selected);
    this.ensureNativeLines(width);
    const lineCount = this.nativeLineTotal ?? 0;
    const readOnlyReason = this.actions.readOnlyReason?.();
    const statusLines = readOnlyReason
      ? [this.theme.fg('warning', truncate(readOnlyReason, width, this.terminalWidth))]
      : this.status
        ? [this.theme.fg(this.status.tone, truncate(this.status.text, width, this.terminalWidth))]
        : !this.conversationHydrated
          ? [this.theme.fg('muted', truncate('Loading conversation history…', width, this.terminalWidth))]
          : [];
    let editorLines: string[] = [];
    if (!readOnlyReason && selected.lifecycle !== 'closed' && this.editor) {
      this.editor.focused = this.focused;
      editorLines = this.editor.render(width);
    }
    const maximumEditorHeight = Math.max(0, terminalRows - header.length - statusLines.length);
    if (editorLines.length > maximumEditorHeight) editorLines = editorLines.slice(-maximumEditorHeight);
    const conversationHeight = Math.max(0, terminalRows - header.length - statusLines.length - editorLines.length);
    const maximumOffset = Math.max(0, lineCount - conversationHeight);
    const tailOffset = Math.min(this.conversationTailOffset, maximumOffset);
    const end = Math.max(0, lineCount - tailOffset);
    const start = Math.max(0, end - conversationHeight);
    const visibleConversation = this.nativeLines(start, end);
    const padding = Array.from({ length: conversationHeight - visibleConversation.length }, () => '');
    return [...header, ...padding, ...visibleConversation, ...statusLines, ...editorLines];
  }

  /** Per-message Pi-native component reuse: unchanged messages keep their components and cached lines. */
  private nativeGroupCache = new WeakMap<LuminariesPiMessage, NativeMessageGroup>();
  private nativeConversationRef?: readonly LuminariesPiMessage[];
  private nativeFlags = { toolsExpanded: false, thinkingHidden: false };
  private nativeResults = new Map<string, LuminariesPiMessage>();

  /** Kept as the single external entry point; all invalidation is reference/flag-driven. */
  private rebuildNativeComponents(agent: LuminariesCommandCenterAgent): void {
    this.syncNativeGroups(agent);
  }

  private syncNativeGroups(agent: LuminariesCommandCenterAgent): void {
    if (!this.nativeUi) return;
    const flagsChanged =
      this.nativeFlags.toolsExpanded !== this.toolsExpanded || this.nativeFlags.thinkingHidden !== this.thinkingHidden;
    const agentSwitched = this.nativeAgentId !== agent.agentId;
    const conversationChanged = this.nativeConversationRef !== this.conversation;
    if (!agentSwitched && !conversationChanged && !flagsChanged) return;
    const priorTotal =
      !agentSwitched && !flagsChanged && this.conversationTailOffset > 0 ? this.conversationLineTotal() : undefined;
    if (agentSwitched || flagsChanged) this.nativeGroupCache = new WeakMap();
    const priorGroups = agentSwitched || flagsChanged ? [] : this.nativeGroups;
    const priorResults = new Map<string, LuminariesPiMessage>();
    for (const group of priorGroups)
      if (group.message.role === 'toolResult' && typeof group.message.toolCallId === 'string')
        priorResults.set(group.message.toolCallId, group.message);

    const results = new Map<string, LuminariesPiMessage>();
    for (const message of this.conversation)
      if (message.role === 'toolResult' && typeof message.toolCallId === 'string')
        results.set(message.toolCallId, message);
    const changedResultIds = new Set<string>();
    for (const [id, message] of priorResults) if (results.get(id) !== message) changedResultIds.add(id);
    for (const [id, message] of results) if (priorResults.get(id) !== message) changedResultIds.add(id);
    this.nativeResults = results;

    const groups: NativeMessageGroup[] = [];
    let hasPriorContent = false;
    for (const message of this.conversation) {
      let group = this.nativeGroupCache.get(message);
      if (group?.hasPriorContent !== hasPriorContent || group?.toolCallIds.some((id) => changedResultIds.has(id)))
        group = undefined;
      if (!group) {
        group = this.buildNativeGroup(message, hasPriorContent, agent);
        this.nativeGroupCache.set(message, group);
      }
      if (group.components.length) hasPriorContent = true;
      groups.push(group);
    }
    this.nativeFlags = { toolsExpanded: this.toolsExpanded, thinkingHidden: this.thinkingHidden };
    this.nativeAgentId = agent.agentId;
    this.nativeConversationRef = this.conversation;
    this.nativeGroups = groups;
    this.nativeLineTotal = undefined;
    if (priorTotal !== undefined)
      this.conversationTailOffset = Math.max(
        0,
        this.conversationTailOffset + this.conversationLineTotal() - priorTotal,
      );
  }

  private buildNativeGroup(
    message: LuminariesPiMessage,
    hasPriorContent: boolean,
    agent: LuminariesCommandCenterAgent,
  ): NativeMessageGroup {
    const ui = this.nativeUi;
    if (!ui) return { message, components: [], toolCallIds: [], hasPriorContent, lines: [] };
    const components: Component[] = [];
    const toolCallIds: string[] = [];
    if (message.role === 'user') {
      const text = messageText(message);
      if (text) {
        if (hasPriorContent) components.push(new ui.Spacer(1));
        if (typeof message.attribution === 'string')
          components.push(new ui.Text(this.theme.fg('dim', message.attribution)));
        const skillBlock = ui.parseSkillBlock(text);
        if (skillBlock) {
          const skill = new ui.SkillInvocationMessageComponent(skillBlock, ui.markdownTheme);
          skill.setExpanded(this.toolsExpanded);
          components.push(skill);
          if (skillBlock.userMessage) {
            components.push(new ui.Spacer(1));
            components.push(new ui.UserMessageComponent(skillBlock.userMessage, ui.markdownTheme));
          }
        } else components.push(new ui.UserMessageComponent(text, ui.markdownTheme));
      }
      return { message, components, toolCallIds, hasPriorContent };
    }
    if (isNativeAssistantMessage(message)) {
      const assistant = new ui.AssistantMessageComponent(message, this.thinkingHidden, ui.markdownTheme);
      assistant.setHideThinkingBlock(this.thinkingHidden);
      components.push(assistant);
      for (const part of messageParts(message)) {
        if (part.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string') continue;
        const tool = new ui.ToolExecutionComponent(
          part.name,
          part.id,
          part.arguments ?? {},
          undefined,
          ui.toolDefinitions?.get(part.name),
          ui.tui,
          agent.cwd,
        );
        const resultMessage = this.nativeResults.get(part.id);
        const result = resultMessage ? toolResult(resultMessage) : unfinishedToolResult(message);
        if (result) tool.updateResult(result, resultMessage?.isPartial === true);
        tool.setExpanded(this.toolsExpanded);
        components.push(tool);
        toolCallIds.push(part.id);
      }
      return { message, components, toolCallIds, hasPriorContent };
    }
    if (isNativeCustomMessage(message) && message.display) {
      const custom = new ui.CustomMessageComponent(
        message,
        message.customType === LUMINARIES_IDENTITY.namespace.protocolMessageType
          ? renderLuminariesProtocolMessage
          : undefined,
        ui.markdownTheme,
      );
      custom.setExpanded(this.toolsExpanded);
      components.push(custom);
      return { message, components, toolCallIds, hasPriorContent };
    }
    if (isNativeBranchSummaryMessage(message)) {
      components.push(new ui.Spacer(1));
      const summary = new ui.BranchSummaryMessageComponent(message, ui.markdownTheme);
      summary.setExpanded(this.toolsExpanded);
      components.push(summary);
      return { message, components, toolCallIds, hasPriorContent };
    }
    if (isNativeCompactionSummaryMessage(message)) {
      components.push(new ui.Spacer(1));
      const summary = new ui.CompactionSummaryMessageComponent(message, ui.markdownTheme);
      summary.setExpanded(this.toolsExpanded);
      components.push(summary);
      return { message, components, toolCallIds, hasPriorContent };
    }
    if (message.role === 'bashExecution' && typeof message.command === 'string') {
      const bash = new ui.BashExecutionComponent(message.command, ui.tui, message.excludeFromContext === true);
      if (typeof message.output === 'string' && message.output) bash.appendOutput(message.output);
      bash.setComplete(
        typeof message.exitCode === 'number' ? message.exitCode : undefined,
        message.cancelled === true,
        message.truncated === true
          ? historicalTruncation(typeof message.output === 'string' ? message.output : '')
          : undefined,
        typeof message.fullOutputPath === 'string' ? message.fullOutputPath : undefined,
      );
      bash.setExpanded(this.toolsExpanded);
      components.push(bash);
    }
    return { message, components, toolCallIds, hasPriorContent };
  }

  private ensureNativeLines(width: number): void {
    if (width === this.nativeGroupWidth && this.nativeLineTotal !== undefined) return;
    this.nativeGroupWidth = width;
    let total = 0;
    for (const group of this.nativeGroups) {
      if (group.width !== width) {
        group.lines = group.components.flatMap((component) => component.render(width));
        group.width = width;
      }
      total += group.lines?.length ?? 0;
    }
    this.nativeLineTotal = total;
  }

  private nativeLines(start: number, end: number): string[] {
    const lines: string[] = [];
    let offset = 0;
    for (const group of this.nativeGroups) {
      const groupLines = group.lines ?? [];
      const groupEnd = offset + groupLines.length;
      if (groupEnd > start && offset < end)
        lines.push(...groupLines.slice(Math.max(0, start - offset), Math.min(groupLines.length, end - offset)));
      offset = groupEnd;
      if (offset >= end) break;
    }
    return lines;
  }

  private conversationLineTotal(): number {
    const width = Math.max(1, Math.floor(this.nativeUi?.tui.terminal?.columns ?? this.nativeGroupWidth));
    if (!width) return 0;
    this.ensureNativeLines(width);
    return this.nativeLineTotal ?? 0;
  }

  private handleDirectory(data: string, projection: LuminariesCommandCenterProjection): void {
    const visibleSelected = this.visibleSelectedAgent(projection);
    if (this.matches(data, 'tui.select.up')) this.move(-1, projection);
    else if (this.matches(data, 'tui.select.down')) this.move(1, projection);
    else if (this.matches(data, 'tui.select.pageUp')) this.move(-8, projection);
    else if (this.matches(data, 'tui.select.pageDown')) this.move(8, projection);
    else if (this.actions.readOnlyReason?.() && (data === 'n' || data === 'b' || data === 'a')) {
      this.setStatus({ tone: 'warning', text: this.actions.readOnlyReason?.() ?? 'This view is read-only.' }, false);
    } else if (data === 'v') this.toggleDirectoryView(projection);
    else if (data === 'i' && visibleSelected) {
      this.setStatus(undefined);
      this.factSheetOpen = true;
      this.factSheetOffset = 0;
    } else if (data === '/') {
      this.setStatus(undefined);
      this.searchRestoreId = this.selectedId;
      this.searchQuery = '';
    } else if (
      data === 'n' &&
      this.directoryView === 'current' &&
      projection.capacity.available > 0 &&
      this.actions.spawn
    )
      this.runAction(() => this.actions.spawn?.());
    else if (
      data === 'b' &&
      this.directoryView === 'current' &&
      collaboratorCount(projection) >= 2 &&
      this.actions.multicast
    ) {
      this.pickerMarks = new Set();
      this.setStatus(undefined);
    } else if (data === 'a' && visibleSelected && this.actions.palette)
      this.runAction(() => this.actions.palette?.(visibleSelected.agentId));
    else if (this.matches(data, 'tui.select.confirm') && visibleSelected)
      this.activateSelected(visibleSelected, projection);
  }

  private handlePicker(
    data: string,
    projection: LuminariesCommandCenterProjection,
    selected: LuminariesCommandCenterAgent,
  ): void {
    const marks = this.pickerMarks;
    if (!marks) return;
    if (this.matches(data, 'tui.select.cancel')) {
      this.pickerMarks = undefined;
      this.setStatus(undefined);
      return;
    }
    if (this.matches(data, 'tui.select.up')) this.move(-1, projection);
    else if (this.matches(data, 'tui.select.down')) this.move(1, projection);
    else if (this.matches(data, 'tui.select.pageUp')) this.move(-8, projection);
    else if (this.matches(data, 'tui.select.pageDown')) this.move(8, projection);
    else if (data === 'a') {
      const agents = this.filteredDirectoryAgents(projection);
      const terminalRows = Math.max(1, this.getTerminalRows());
      const visible =
        terminalRows < 10
          ? [this.visibleSelectedAgent(projection)].filter(
              (agent): agent is LuminariesCommandCenterAgent => agent !== undefined,
            )
          : directoryWindow(agents, this.selectedId, Math.max(1, terminalRows - 4));
      const recipients = visible.filter((agent) => agent.parentId !== null && agent.lifecycle === 'open');
      const remove = recipients.length > 0 && recipients.every((agent) => marks.has(agent.agentId));
      for (const agent of recipients) {
        if (remove) marks.delete(agent.agentId);
        else marks.add(agent.agentId);
      }
    } else if (data === ' ' || data === 't') {
      if (selected.parentId === null || selected.lifecycle !== 'open') return;
      if (marks.has(selected.agentId)) marks.delete(selected.agentId);
      else marks.add(selected.agentId);
    } else if (this.matches(data, 'tui.select.confirm')) {
      if (!marks.size) {
        this.setStatus({ tone: 'muted', text: 'Recipients · 0 marked · Mark an open collaborator first.' });
        return;
      }
      const recipientIds = [...marks];
      this.pickerMarks = undefined;
      this.runAction(() => this.actions.multicast?.(recipientIds));
    }
  }

  private toggleDirectoryView(projection: LuminariesCommandCenterProjection): void {
    this.selectedByView[this.directoryView] = this.selectedId;
    this.directoryView = this.directoryView === 'current' ? 'archived' : 'current';
    const agents = directoryAgents(projection, this.directoryView);
    const remembered = this.selectedByView[this.directoryView];
    const selected =
      agents.find((agent) => agent.agentId === remembered) ??
      agents.find((agent) => agent.attention) ??
      agents.find((agent) => agent.active) ??
      agents[0];
    this.selectedId = selected?.agentId ?? projection.rootId;
    this.selectedByView[this.directoryView] = this.selectedId;
    this.searchQuery = undefined;
    this.searchRestoreId = undefined;
    this.factSheetOpen = false;
    this.factSheetOffset = 0;
    this.pickerMarks = undefined;
    this.setStatus(undefined);
  }

  private handleSearch(data: string, projection: LuminariesCommandCenterProjection): void {
    if (this.matches(data, 'tui.select.cancel')) {
      this.searchQuery = undefined;
      if (
        this.searchRestoreId &&
        directoryAgents(projection, this.directoryView).some((agent) => agent.agentId === this.searchRestoreId)
      )
        this.selectedId = this.searchRestoreId;
      this.searchRestoreId = undefined;
    } else if (this.matches(data, 'tui.select.confirm')) {
      const selected = this.visibleSelectedAgent(projection);
      if (!selected) {
        this.safeRender();
        return;
      }
      this.searchQuery = undefined;
      this.searchRestoreId = undefined;
      this.activateSelected(selected, projection);
    } else if (this.matches(data, 'tui.select.up')) {
      this.move(-1, projection);
    } else if (this.matches(data, 'tui.select.down')) {
      this.move(1, projection);
    } else if (this.matches(data, 'tui.editor.deleteCharBackward')) {
      this.searchQuery = [...(this.searchQuery ?? '')].slice(0, -1).join('');
    } else if (!isAsciiControlCharacter(data) && Buffer.byteLength((this.searchQuery ?? '') + data) <= 512) {
      this.searchQuery = (this.searchQuery ?? '') + data;
    }
    const first = this.filteredDirectoryAgents(projection)[0];
    if (first && !this.filteredDirectoryAgents(projection).some((agent) => agent.agentId === this.selectedId)) {
      this.selectedId = first.agentId;
      this.selectedByView[this.directoryView] = first.agentId;
    }
    this.safeRender();
  }

  private filteredDirectoryAgents(
    projection: LuminariesCommandCenterProjection,
  ): readonly LuminariesCommandCenterAgent[] {
    const agents = directoryAgents(projection, this.directoryView);
    const query = this.searchQuery?.trim().toLocaleLowerCase();
    if (!query) return agents;
    return agents.filter((agent) =>
      [
        agent.name,
        agent.handle,
        agent.shortId,
        agent.agentId,
        agent.role,
        agent.focus,
        agent.assignment,
        ...agent.expertise,
        ...agent.artifacts,
        availabilityLabel(agent),
        agent.activity,
        agent.attention ? 'needs you' : undefined,
        agent.attention ? agent.health.summary : undefined,
        agent.archived ? 'archived' : undefined,
      ]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }

  private visibleSelectedAgent(
    projection: LuminariesCommandCenterProjection,
  ): LuminariesCommandCenterAgent | undefined {
    const visible = this.filteredDirectoryAgents(projection);
    return visible.find((agent) => agent.agentId === this.selectedId) ?? visible[0];
  }

  private selectedAgent(projection: LuminariesCommandCenterProjection): LuminariesCommandCenterAgent {
    const all = projection.directory;
    const visible = this.view === 'directory' ? this.filteredDirectoryAgents(projection) : all;
    const selected =
      visible.find((agent) => agent.agentId === this.selectedId) ??
      visible[0] ??
      all.find((agent) => agent.agentId === this.selectedId) ??
      all[0];
    if (!selected) throw new Error(`${PRODUCT} command center has no root collaborator`);
    return selected;
  }

  private matches(data: string, action: Parameters<KeybindingsManager['matches']>[1]): boolean {
    return this.nativeUi?.keybindings.matches(data, action) === true;
  }

  private conversationScrollMaximum(agent: LuminariesCommandCenterAgent): number {
    if (!this.nativeUi) return 0;
    const width = Math.max(1, this.nativeUi.tui.terminal?.columns ?? 1);
    const terminalRows = Math.max(1, this.getTerminalRows());
    const headerHeight = conversationHeaderLines(agent, width, this.theme, this.terminalWidth).length;
    const statusHeight = this.status ? 1 : 0;
    let editorHeight = agent.lifecycle !== 'closed' && this.editor ? this.editor.render(width).length : 0;
    editorHeight = Math.min(editorHeight, Math.max(0, terminalRows - headerHeight - statusHeight));
    const conversationHeight = Math.max(0, terminalRows - headerHeight - statusHeight - editorHeight);
    const lineCount = this.conversationLineTotal();
    return Math.max(0, lineCount - conversationHeight);
  }

  private clampScrollOffsets(projection: LuminariesCommandCenterProjection): void {
    if (this.view === 'agent') {
      this.conversationTailOffset = Math.min(
        this.conversationTailOffset,
        this.conversationScrollMaximum(this.selectedAgent(projection)),
      );
    }
  }

  private reconcileProjection(projection: LuminariesCommandCenterProjection): void {
    if (this.view === 'agent' && !projection.directory.some((agent) => agent.agentId === this.selectedId))
      this.returnToDirectory(true);
    const selected = this.selectedAgent(projection);
    if (selected.agentId !== this.selectedId) {
      this.selectedId = selected.agentId;
      this.selectedByView[this.directoryView] = selected.agentId;
      this.conversationTailOffset = 0;
      this.factSheetOpen = false;
      this.factSheetOffset = 0;
    }
  }

  private move(delta: number, projection: LuminariesCommandCenterProjection): void {
    const agents = this.filteredDirectoryAgents(projection);
    if (!agents.length) return;
    const index = Math.max(
      0,
      agents.findIndex((agent) => agent.agentId === this.selectedId),
    );
    const next = Math.max(0, Math.min(agents.length - 1, index + delta));
    this.selectedId = agents[next]?.agentId ?? this.selectedId;
    this.selectedByView[this.directoryView] = this.selectedId;
    this.setStatus(undefined);
  }

  private clampFactSheetOffset(agent: LuminariesCommandCenterAgent, width: number, height: number): void {
    const maximum = Math.max(0, factSheetLineCount(agent, width, this.theme, this.terminalWidth) - height);
    this.factSheetOffset = Math.min(this.factSheetOffset, maximum);
  }

  private scrollFactSheet(delta: number, agent: LuminariesCommandCenterAgent): void {
    const width = Math.max(1, this.nativeUi?.tui.terminal.columns ?? this.directoryRenderWidth ?? 80);
    const rows = Math.max(1, this.getTerminalRows());
    const height = Math.max(1, rows - 4);
    const maximum = Math.max(0, factSheetLineCount(agent, width, this.theme, this.terminalWidth) - height);
    this.factSheetOffset = Math.max(0, Math.min(maximum, this.factSheetOffset + delta));
  }

  private openConversation(agent: LuminariesCommandCenterAgent): void {
    if (this.editorAgentId !== agent.agentId) this.editor?.setText('');
    this.editorAgentId = agent.agentId;
    this.conversationUnsubscribe?.();
    this.conversationUnsubscribe = undefined;
    this.selectedId = agent.agentId;
    this.selectedByView[this.directoryView] = agent.agentId;
    this.view = 'agent';
    this.factSheetOpen = false;
    this.pickerMarks = undefined;
    this.conversationTailOffset = 0;
    this.conversation = [];
    this.conversationEpoch = undefined;
    this.conversationIncarnation = undefined;
    this.conversationRevision = 0;
    this.conversationHydrated = false;
    this.setStatus(
      this.actions.subscribe ? { tone: 'muted', text: `Opening conversation for ${agent.handle}…` } : undefined,
      false,
    );
    this.rebuildNativeComponents(agent);
    if (!this.actions.subscribe) return;
    try {
      this.conversationUnsubscribe = this.actions.subscribe(agent.agentId, (update) =>
        this.applyConversationUpdate(agent, update),
      );
    } catch (error) {
      this.setStatus(
        {
          tone: 'error',
          text: `Could not open the conversation for ${agent.handle}: ${friendlyError(error)}. Return to the directory and try again.`,
        },
        false,
      );
    }
  }

  openAgent(agentId: string): void {
    const agent = this.getProjection().directory.find((candidate) => candidate.agentId === agentId);
    if (!agent) throw new Error('The selected collaborator is no longer available');
    this.directoryView = agent.archived ? 'archived' : 'current';
    this.openConversation(agent);
    this.safeRender();
  }

  private applyConversationUpdate(agent: LuminariesCommandCenterAgent, update: LuminariesConversationUpdate): void {
    if (this.disposed || this.view !== 'agent' || this.selectedId !== agent.agentId || update.agentId !== agent.agentId)
      return;
    if (update.type === 'reset') {
      if (this.conversationEpoch === update.epoch && update.revision < this.conversationRevision) return;
      this.conversationEpoch = update.epoch;
      this.conversationIncarnation = update.incarnation;
      this.conversationRevision = update.revision;
      this.conversationHydrated = update.hydrated;
      this.conversation = [...update.messages];
      if (update.error)
        this.setStatus(
          {
            tone: 'error',
            text: `Could not open the conversation for ${agent.handle}: ${friendlyError(update.error)}. Return to the directory and try again.`,
          },
          false,
        );
      else if (update.hydrated && this.status?.tone === 'muted' && this.status.text.startsWith('Opening conversation '))
        this.setStatus(undefined);
    } else {
      if (
        update.epoch !== this.conversationEpoch ||
        update.incarnation !== this.conversationIncarnation ||
        update.baseRevision !== this.conversationRevision ||
        update.start > this.conversation.length ||
        update.deleteCount > this.conversation.length - update.start
      )
        return;
      const messages = [...this.conversation];
      messages.splice(update.start, update.deleteCount, ...update.messages);
      this.conversation = messages;
      this.conversationRevision = update.revision;
      this.conversationHydrated = true;
    }
    this.rebuildNativeComponents(this.selectedAgent(this.getProjection()));
    this.clampScrollOffsets(this.getProjection());
    this.safeRender();
  }

  private activateSelected(agent: LuminariesCommandCenterAgent, projection: LuminariesCommandCenterProjection): void {
    if (agent.agentId !== projection.rootId) {
      this.openConversation(agent);
      return;
    }
    if (this.rootEnter === 'return') {
      this.disposed = true;
      this.done();
      return;
    }
    if (this.rootEnter === 'conversation') {
      this.openConversation(agent);
      return;
    }
    if (this.actions.palette) this.runAction(() => this.actions.palette?.(agent.agentId));
  }

  private returnToDirectory(preserveReceipt = false): void {
    this.conversationUnsubscribe?.();
    this.conversationUnsubscribe = undefined;
    this.view = 'directory';
    this.conversation = [];
    this.conversationHydrated = false;
    this.nativeGroups = [];
    this.nativeGroupWidth = 0;
    this.nativeLineTotal = undefined;
    if (!preserveReceipt || !this.status?.persistent) this.setStatus(undefined);
    this.safeRender();
  }

  private scrollConversation(delta: number): void {
    const projection = this.getProjection();
    const selected = this.selectedAgent(projection);
    this.conversationTailOffset = Math.min(
      this.conversationScrollMaximum(selected),
      Math.max(0, this.conversationTailOffset + delta),
    );
    this.safeRender();
  }

  private submitEditor(value: string, requestedMode: 'auto' | 'follow_up'): void {
    if (this.busy) return;
    const projection = this.getProjection();
    this.reconcileProjection(projection);
    const agent = this.selectedAgent(projection);
    if (this.editorAgentId !== agent.agentId) {
      this.editor?.setText('');
      this.editorAgentId = agent.agentId;
      return;
    }
    const message = value.trim();
    if (!message) {
      this.setStatus({ tone: 'warning', text: 'Type a message first.' });
      this.safeRender();
      return;
    }
    if (message === `/${LUMINARIES_IDENTITY.command}`) {
      this.editor?.setText('');
      this.returnToDirectory();
      return;
    }
    if (agent.lifecycle === 'closed') {
      this.setStatus({ tone: 'muted', text: `${agent.handle} · Conversation kept. Use Resume collaborator first.` });
      this.safeRender();
      return;
    }
    this.run(
      () => this.actions.send(agent.agentId, message, requestedMode),
      (disposition) => {
        if (this.editor?.getText() === value) this.editor.setText('');
        this.conversationTailOffset = 0;
        return disposition === 'follow_up_queued'
          ? `Follow-up for ${agent.handle} was accepted for the next turn.`
          : disposition === 'steered'
            ? `Message for ${agent.handle} was accepted for the active turn.`
            : `Message for ${agent.handle} was accepted to start the next turn.`;
      },
    );
  }

  private clearOrInterrupt(): void {
    if (!this.editor) return;
    if (this.editor.getText()) {
      this.editor.setText('');
      this.safeRender();
      return;
    }
    const agent = this.selectedAgent(this.getProjection());
    if (!hasRunningTurn(agent)) {
      this.setStatus({ tone: 'muted', text: `${agent.handle} has no active turn to interrupt.` });
      this.safeRender();
      return;
    }
    this.runAction(async () => {
      const outcome = await this.actions.interrupt(agent.agentId);
      return outcome === 'already_finished'
        ? { tone: 'muted', persistent: true, text: `${agent.handle} already finished. Nothing was interrupted.` }
        : `Interrupted ${agent.handle}'s active turn.`;
    });
  }

  private runAction(operation: () => Promise<LuminariesActionResult | undefined> | undefined): void {
    if (this.busy) return;
    this.busy = true;
    this.focused = false;
    this.setStatus({ tone: 'muted', text: 'Opening actions…' }, false);
    this.safeRender();
    void Promise.resolve()
      .then(operation)
      .then(
        (result) => {
          if (this.disposed) return;
          this.busy = false;
          this.focused = true;
          const status = typeof result === 'string' ? { tone: 'success', text: result } : result;
          this.setStatus(status, status?.persistent !== true);
          this.safeRender();
        },
        (error: unknown) => {
          if (this.disposed) return;
          this.busy = false;
          this.focused = true;
          // Errors persist until dismissed or superseded; the 4s TTL is for transient status.
          this.setStatus({ tone: 'error', text: friendlyError(error) }, false);
          this.safeRender();
        },
      );
  }

  private run<T>(operation: () => Promise<T>, success: (value: T) => string): void {
    if (this.busy) return;
    this.busy = true;
    this.setStatus({ tone: 'muted', text: 'Submitting message…' }, false);
    this.safeRender();
    void operation().then(
      (value) => {
        if (this.disposed) return;
        this.busy = false;
        this.setStatus({ tone: 'success', text: success(value) });
        this.safeRender();
      },
      (error: unknown) => {
        if (this.disposed) return;
        this.busy = false;
        // Errors persist until dismissed or superseded; the 4s TTL is for transient status.
        this.setStatus({ tone: 'error', text: friendlyError(error) }, false);
        this.safeRender();
      },
    );
  }

  private setStatus(status: LuminariesActionStatus | undefined, transient = true): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    this.status = status;
    this.clampScrollOffsets(this.getProjection());
    if (!status || !transient) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.status = undefined;
      this.clampScrollOffsets(this.getProjection());
      this.safeRender();
    }, STATUS_TTL_MS);
    this.statusTimer.unref?.();
  }

  private safeRender(): void {
    if (!this.disposed) this.requestRender();
  }
}
