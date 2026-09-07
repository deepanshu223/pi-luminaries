import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme, keyHint } from '@earendil-works/pi-coding-agent';
import {
  THINKING_LEVELS,
  normalizeCapabilityRequest,
  type CapabilityRequest,
  type ThinkingLevel,
} from './capability-policy.ts';
import { FORK_BOUNDARY_TEXT, RECENT_BOUNDARY_TEXT } from './context-transfer.ts';
import { hasUnsafeHumanFacingControl } from './identifiers.ts';
import { humanFacingProse, isLuminariesId, isRecord, sha256 } from './scheduler-state.ts';
import { type ContextMode, type SpawnConfigurationInput } from './spawn-configuration.ts';
import { LUMINARIES_IDENTITY, type LuminariesToolName } from './product-identity.ts';
import { Markdown, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { sanitizeDisplayText } from './display-sanitizer.ts';

export type { LuminariesToolName } from './product-identity.ts';

const TOOL = LUMINARIES_IDENTITY.tools;
const PRODUCT = LUMINARIES_IDENTITY.label;
const MAX_TOOL_CALL_ID = 128;
const CONTEXT_MODES = ['fresh', 'recent', 'fork', 'custom'] as const;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface LuminariesToolResult {
  content: [{ type: 'text'; text: string }];
  details: Record<string, unknown>;
  terminate?: boolean;
}
export interface LuminariesReceipt {
  message: string;
  details: Record<string, unknown>;
  terminate?: boolean;
}
export interface LuminariesToolHost {
  execute(
    command: LuminariesToolCommand,
    signal: AbortSignal | undefined,
    toolCallId?: string,
  ): Promise<LuminariesReceipt>;
}
export type LuminariesToolHostResolver = (
  context: ExtensionContext,
) => Promise<LuminariesToolHost> | LuminariesToolHost;

export interface LuminariesSpawnRequest extends SpawnConfigurationInput {
  requestId: string;
  name?: string;
  assignment: string;
  ownershipBoundary: string;
  expertCard?: {
    role?: string;
    focus?: string;
    expertise?: string[];
    publishedRefs?: string[];
  };
  context?: ContextMode;
  thinking?: ThinkingLevel;
}
export interface LuminariesDirectoryRequest {
  requestId: string;
  action: 'list' | 'inspect' | 'update';
  agentId?: string;
  patch?: Record<string, unknown>;
  includeClosed?: boolean;
  view?: 'summary' | 'card' | 'capabilities' | 'coordination' | 'diagnostics' | 'transcript';
  cursor?: string;
  limit?: number;
}
export interface LuminariesMessageRequest {
  requestId: string;
  action: 'send' | 'multicast' | 'request' | 'request_many' | 'reply' | 'cancel';
  recipientId?: string;
  recipientIds?: string[];
  message?: string;
  mode?: 'default' | 'follow_up' | 'notify_only';
  correlationId?: string;
  deadlineMs?: number;
}
export interface LuminariesControlRequest {
  requestId: string;
  action:
    | 'steer'
    | 'follow_up'
    | 'interrupt'
    | 'close'
    | 'close_subtree'
    | 'resume'
    | 'set_model'
    | 'set_thinking'
    | 'set_extensions'
    | 'set_grants';
  agentId?: string;
  message?: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensions?: string[];
  grants?: CapabilityRequest;
}
export interface LuminariesAwaitRequest {
  requestId: string;
  action: 'wait' | 'cancel';
  watchId?: string;
  requestIds?: string[];
  agentIds?: string[];
  eventKinds?: Array<'message' | 'request' | 'reply' | 'cancel' | 'resolution' | 'system'>;
  owned?: boolean;
}
export type LuminariesToolRequest =
  | LuminariesSpawnRequest
  | LuminariesDirectoryRequest
  | LuminariesMessageRequest
  | LuminariesControlRequest
  | LuminariesAwaitRequest;
export type LuminariesToolCommand =
  | { toolName: typeof TOOL.spawn; input: LuminariesSpawnRequest }
  | { toolName: typeof TOOL.directory; input: LuminariesDirectoryRequest }
  | { toolName: typeof TOOL.message; input: LuminariesMessageRequest }
  | { toolName: typeof TOOL.control; input: LuminariesControlRequest }
  | { toolName: typeof TOOL.await; input: LuminariesAwaitRequest };

interface JsonSchema {
  type: 'object';
  additionalProperties?: false;
  properties?: Record<string, unknown>;
  required?: readonly string[];
  minProperties?: number;
}
export interface LuminariesToolDefinition {
  name: LuminariesToolName;
  label: string;
  description: string;
  parameters: JsonSchema;
  executionMode: 'parallel';
  renderShell: 'self';
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ExtensionContext,
  ): Promise<LuminariesToolResult>;
  renderCall(args: unknown, theme: LuminariesRenderTheme): LuminariesRenderComponent;
  renderResult(
    result: { content?: readonly unknown[]; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: LuminariesRenderTheme,
    context: { args?: unknown; isError: boolean },
  ): LuminariesRenderComponent;
}

interface LuminariesRenderTheme {
  fg(color: string, text: string): string;
}
interface LuminariesRenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

function renderLines(
  lines: readonly string[],
  theme: LuminariesRenderTheme,
  tone: string,
  wrap = false,
): LuminariesRenderComponent {
  return {
    render: (width) =>
      lines.flatMap((line) =>
        (wrap ? wrapTextWithAnsi(line, Math.max(1, width)) : [truncateToWidth(line, Math.max(1, width), '…')]).map(
          (part) => theme.fg(tone, part),
        ),
      ),
    invalidate: () => undefined,
  };
}

function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function renderedIdentity(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.humanHandle === 'string') return value.humanHandle;
  const displayName = typeof value.displayName === 'string' ? value.displayName : undefined;
  const shortId = typeof value.shortId === 'string' ? value.shortId : undefined;
  return displayName && shortId ? `${displayName} · ${shortId}` : undefined;
}

function isGeneratedReference(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix) || value.length !== prefix.length + 40) return false;
  for (let index = prefix.length; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 48 || code > 57) && (code < 97 || code > 102)) return false;
  }
  return true;
}

function renderedReference(value: string | undefined): string | undefined {
  if (!value || hasUnsafeHumanFacingControl(value)) return undefined;
  if (isGeneratedReference(value, `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}root-`)) return 'Root';
  if (isGeneratedReference(value, `${LUMINARIES_IDENTITY.namespace.publicIdPrefix}agent-`)) return 'luminary';
  return value;
}

function callLabel(name: LuminariesToolName, args: unknown): string {
  const action = recordString(args, 'action');
  const reference = renderedReference(recordString(args, 'recipientId') ?? recordString(args, 'agentId'));
  const target = reference ? ` · ${reference}` : '';
  if (name === TOOL.spawn) return `Start ${recordString(args, 'name') ?? 'a luminary'}`;
  if (name === TOOL.directory)
    return action === 'list'
      ? 'List luminaries'
      : action === 'update'
        ? `Update expert card${target}`
        : `Inspect luminary${target}`;
  if (name === TOOL.message) {
    if (action === 'multicast' || action === 'request_many') return 'Message several luminaries';
    if (action === 'request') return `Request work${target}`;
    if (action === 'reply') return 'Reply to a luminary';
    if (action === 'cancel') return 'Cancel a request';
    return `Message${target}`;
  }
  if (name === TOOL.control) {
    const labels: Record<string, string> = {
      steer: 'Redirect the active turn',
      follow_up: 'Queue a follow-up',
      interrupt: 'Interrupt the active turn',
      close: 'Close a luminary',
      close_subtree: 'Close an owned subtree',
      resume: 'Resume luminary',
      set_model: 'Change model',
      set_thinking: 'Change thinking',
      set_extensions: 'Change extensions',
      set_grants: 'Change descendant grants',
    };
    return `${(action && labels[action]) ?? 'Manage a luminary'}${target}`;
  }
  return action === 'cancel' ? 'Cancel a wait' : 'Wait for collaborators';
}

function forkBoundaryLabel(result: { content?: readonly unknown[] }): string | undefined {
  if (!Array.isArray(result.content) || result.content.length !== 1 || !isRecord(result.content[0])) return undefined;
  const part = result.content[0];
  if (part.type !== 'text' || typeof part.text !== 'string') return undefined;
  if (part.text === FORK_BOUNDARY_TEXT.selected) return 'Fork boundary · this collaborator begins here';
  if (part.text === FORK_BOUNDARY_TEXT.unresolved)
    return 'Fork boundary · earlier parallel work was not carried into this collaborator';
  if (part.text === RECENT_BOUNDARY_TEXT.selected) return 'Recent boundary · this collaborator begins here';
  if (part.text === RECENT_BOUNDARY_TEXT.unresolved)
    return 'Recent boundary · earlier parallel work was not carried into this collaborator';
  return undefined;
}

function outcomeValues(details: unknown): string[] {
  if (!isRecord(details)) return [];
  const values: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value && !values.includes(value)) values.push(value);
  };
  add(details.status);
  add(details.requestStatus);
  add(details.outcomeCode);
  add(details.startupState);
  if (isRecord(details.agent)) add(details.agent.status);
  for (const leg of groupLegs(details)) {
    add(legOutcome(leg));
    add(leg.outcomeCode);
  }
  return values;
}

function displayOutcome(value: string, name: LuminariesToolName): string {
  if (value === 'settled' || value === 'consumed') return name === TOOL.message ? 'delivered' : 'complete';
  if (value === 'aborted' || value === 'interrupted') return 'interrupted';
  if (value === 'admitted') return 'accepted';
  if (value === 'already_known') return 'already open';
  return value.split('_').join(' ');
}

function resultText(result: { content?: readonly unknown[] }): string | undefined {
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === 'text')
    .map((part) => part.text)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  return text || undefined;
}

function argumentMessage(args: unknown): string | undefined {
  const message = recordString(args, 'message');
  return message ? sanitizeDisplayText(message, []) : undefined;
}

function withOutcomes(label: string, values: readonly string[], name: LuminariesToolName): string {
  const outcomes = values
    .map((value) => displayOutcome(value, name))
    .filter((value, index, all) => all.indexOf(value) === index);
  return outcomes.length ? `${label} · ${outcomes.slice(0, 3).join(' · ')}` : label;
}

function groupLegs(details: unknown): Record<string, unknown>[] {
  return isRecord(details) && Array.isArray(details.legs) ? details.legs.filter(isRecord) : [];
}

function legOutcome(leg: Record<string, unknown>): string {
  return recordString(leg, 'requestStatus') ?? recordString(leg, 'status') ?? 'unknown';
}

function unsuccessfulOutcome(status: string): boolean {
  return ['refused', 'failed', 'indeterminate', 'delivery_failed', 'delivery_indeterminate', 'timed_out'].includes(
    status,
  );
}

function unsuccessfulLeg(leg: Record<string, unknown>): boolean {
  const status = legOutcome(leg);
  return unsuccessfulOutcome(status) || ['cancelled', 'interrupted', 'aborted', 'unknown'].includes(status);
}

export function messageGroupReceipt(details: unknown): { summary: string; problems: string[] } {
  const legs = groupLegs(details);
  const counts = new Map<string, number>();
  for (const leg of legs) {
    const status = displayOutcome(legOutcome(leg), TOOL.message);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const problems = legs.filter(unsuccessfulLeg).map((leg) => {
    const status = legOutcome(leg);
    const identity = renderedIdentity(leg.recipient) ?? 'Luminary';
    const code = recordString(leg, 'outcomeCode');
    const reason = recordString(leg, 'error') ?? (code ? displayOutcome(code, TOOL.message) : undefined);
    return `${identity} · ${displayOutcome(status, TOOL.message)}${reason ? ` · ${sanitizeDisplayText(reason, [])}` : ''}`;
  });
  return { summary: [...counts].map(([status, count]) => `${count} ${status}`).join(' · '), problems };
}

function resultTone(details: unknown, isError: boolean): 'error' | 'success' {
  return isError || outcomeValues(details).some(unsuccessfulOutcome) || groupLegs(details).some(unsuccessfulLeg)
    ? 'error'
    : 'success';
}

function resultLabel(name: LuminariesToolName, details: unknown, args: unknown, isError: boolean): string {
  const action = recordString(details, 'action') ?? recordString(args, 'action');
  const outcomes = outcomeValues(details);
  if (isError) {
    const failureOutcomes = outcomes.filter(
      (value) =>
        !['queued', 'pending', 'settled', 'consumed', 'admitted', 'applied', 'starting', 'running', 'active'].includes(
          value,
        ),
    );
    return withOutcomes(`${callLabel(name, args)} failed`, failureOutcomes, name);
  }
  const identity =
    renderedIdentity(isRecord(details) ? details.recipient : undefined) ??
    renderedIdentity(isRecord(details) ? details.target : undefined) ??
    renderedIdentity(isRecord(details) ? details.agent : undefined);
  if (name === TOOL.spawn) return withOutcomes(identity ? `Start ${identity}` : callLabel(name, args), outcomes, name);
  if (name === TOOL.directory) {
    if (action === 'list' && isRecord(details) && Array.isArray(details.entries))
      return `Directory · ${details.entries.length} rows`;
    if (action === 'update')
      return withOutcomes(identity ? `Update ${identity}` : 'Update expert card', outcomes, name);
    return withOutcomes(identity ? `Inspect ${identity}` : 'Collaborator details', outcomes, name);
  }
  if (name === TOOL.message) {
    if (action === 'multicast' || action === 'request_many') {
      const count = isRecord(details) && Array.isArray(details.legs) ? details.legs.length : 0;
      const summary = messageGroupReceipt(details).summary;
      return `${action === 'request_many' ? 'Requests to' : 'Message to'} ${count} ${count === 1 ? 'luminary' : 'luminaries'}${summary ? ` · ${summary}` : ''}`;
    }
    const mode = recordString(details, 'mode') ?? recordString(args, 'mode');
    const label =
      action === 'request'
        ? identity
          ? `Request to ${identity}`
          : 'Work request'
        : action === 'reply'
          ? identity
            ? `Reply to ${identity}`
            : 'Reply'
          : action === 'cancel'
            ? 'Cancel request'
            : mode === 'notify_only'
              ? identity
                ? `Notify ${identity}`
                : 'Notification'
              : mode === 'follow_up'
                ? identity
                  ? `Follow-up to ${identity}`
                  : 'Follow-up'
                : identity
                  ? `Message to ${identity}`
                  : 'Message';
    return withOutcomes(label, outcomes, name);
  }
  if (name === TOOL.control) {
    const label = identity ? `${callLabel(name, { action })} · ${identity}` : callLabel(name, args ?? details);
    return withOutcomes(label, outcomes, name);
  }
  return withOutcomes('Wait for collaborators', outcomes, name);
}

function luminariesToolRenderer(
  name: LuminariesToolName,
): Pick<LuminariesToolDefinition, 'renderCall' | 'renderResult'> {
  return {
    renderCall: (args, theme) => renderLines([callLabel(name, args)], theme, 'muted'),
    renderResult: (result, options, theme, context) => {
      const label = forkBoundaryLabel(result) ?? resultLabel(name, result.details, context.args, context.isError);
      const detail = resultText(result);
      const message = argumentMessage(context.args);
      const lines = [options.isPartial ? `${label}…` : label];
      if (options.expanded && message) lines.push(`Message: ${message}`);
      const error = recordString(result.details, 'error');
      if (options.expanded) lines.push(...messageGroupReceipt(result.details).problems);
      if ((options.expanded || context.isError) && error) lines.push(sanitizeDisplayText(error, []));
      else if (context.isError && detail && detail !== label) lines.push(detail);
      return renderLines(
        lines,
        theme,
        resultTone(result.details, context.isError),
        options.expanded || context.isError,
      );
    },
  };
}

/** Pi owns the shared expansion state; collapsing a delivery never changes its model input. */
export function renderLuminariesProtocolMessage(
  message: { content?: unknown; details?: unknown },
  options: { expanded?: boolean; outputPad?: number },
  theme: LuminariesRenderTheme,
): LuminariesRenderComponent {
  const details = isRecord(message.details) ? message.details : undefined;
  if (details?.presentation === 'notice') {
    const lines = Array.isArray(details.lines)
      ? details.lines.filter((line): line is string => typeof line === 'string').slice(0, 16)
      : [];
    return renderLines(lines.length ? lines : [`${PRODUCT} activity`], theme, 'muted');
  }
  const presented =
    details?.presentation === 'message' && typeof details.content === 'string' ? details.content : undefined;
  const content =
    presented ?? (typeof message.content === 'string' && message.content.trim() ? message.content : undefined);
  if (!content) return renderLines([`${PRODUCT} activity`], theme, 'muted');
  const source = recordString(details, 'source');
  const heading = source ? `From ${sanitizeDisplayText(source, [])}` : 'Incoming message';
  const prefix = source ? `From ${source}:\n` : '';
  const body = prefix && content.startsWith(prefix) ? content.slice(prefix.length) : content;
  const markdown = new Markdown(body, 0, 0, getMarkdownTheme(), {
    color: (text) => theme.fg('customMessageText', text),
  });
  return {
    render: (width) => {
      const pad =
        typeof options?.outputPad === 'number' && Number.isFinite(options.outputPad)
          ? Math.max(0, Math.floor(options.outputPad))
          : 0;
      const available = Math.max(1, width - pad);
      const edge = available > 2 ? theme.fg('borderMuted', '│ ') : '';
      const lines = markdown.render(Math.max(1, available - (edge ? 2 : 0)));
      const collapsed = options.expanded !== true && lines.length > 3;
      return [
        theme.fg('customMessageLabel', truncateToWidth(heading, available)),
        ...(collapsed ? lines.slice(0, 3) : lines).map((line) => `${edge}${line}`),
        ...(collapsed ? [truncateToWidth(keyHint('app.tools.expand', 'expand message'), available)] : []),
      ];
    },
    invalidate: () => markdown.invalidate(),
  };
}

export function createLuminariesTools(resolveHost: LuminariesToolHostResolver): readonly LuminariesToolDefinition[] {
  return [
    definition(
      TOOL.spawn,
      `New luminary`,
      `Bring one persistent expert into the constellation when no open luminary fits. Put the complete first task in assignment and its durable scope in ownershipBoundary. Model uses provider/model; omit it to inherit. Omit cwd to use the parent's working directory. Context controls conversation transfer: fresh adds no parent conversation, recent adds a bounded suffix, fork transfers the exact current branch or refuses, and custom uses isolated startup context. Supply advanced cwd, resource, and grant fields only when intentionally configuring known values.`,
      spawnSchema(),
      (value, toolCallId) => normalizeSpawn(value, toolCallId),
      (input) => ({ toolName: TOOL.spawn, input }),
      resolveHost,
    ),
    definition(
      TOOL.directory,
      `Constellation directory`,
      `List, inspect, or update the same-root constellation. list {includeClosed?,cursor?,limit?}; inspect {agentId?,view?,cursor?,limit?}; update {agentId?,patch}. Luminary fields accept Root, a stable ID, or a current unique Name · shortId handle. List pages; summary does not. Public card, capabilities, coordination, diagnostics, and transcript views page; the last four require owner/self-descendant authority. Use nextCursor only on the same action and view; if it is stale, retry once without it. Omit agentId on update for self; use null to clear role/focus and [] to clear expertise/publishedRefs.`,
      directorySchema(),
      (value, toolCallId) => normalizeDirectory(value, toolCallId),
      (input) => ({ toolName: TOOL.directory, input }),
      resolveHost,
    ),
    definition(
      TOOL.message,
      `Message luminary`,
      `Send ordinary input to open collaborators. send {recipientId,message,mode?}; request {recipientId,message,mode?,deadlineMs?}; reply {correlationId,message} only; cancel {correlationId} only. A request already yields and its correlation identifies the reply target, so do not immediately await it and never add recipientId to reply. Default wakes idle recipients or steers busy ones; follow_up waits for a later turn; notify_only records without model work.`,
      messageSchema(),
      (value, toolCallId) => normalizeMessage(value, toolCallId),
      (input) => ({ toolName: TOOL.message, input }),
      resolveHost,
    ),
    definition(
      TOOL.control,
      `Control luminary`,
      `Ordinary communication uses ${TOOL.message}; steer, follow_up, and interrupt are owner controls for a running descendant turn. An interrupt message is replacement work for the next turn. close/close_subtree/resume {agentId}. Close keeps resumable history. set_extensions {agentId,extensions} selects current root-approved allow sources; [] removes optional sources, while always sources remain. A resident target finishes its turn and parks before the saved selection loads on its next message. set_grants {spawn:true} inherits the available depth ceiling unless maxDepth intentionally narrows it. Owning ancestors may change descendant grants within inherited ceilings; agents cannot widen their own authority or approve extension sources.`,
      controlSchema(),
      (value, toolCallId) => normalizeControl(value, toolCallId),
      (input) => ({ toolName: TOOL.control, input }),
      resolveHost,
    ),
    definition(
      TOOL.await,
      `Await collaborators`,
      `Pause for other still-open requestIds you created or activity from descendants you own. Do not watch Root, ancestors, siblings, or unrelated peers. Incoming messages and replies wake automatically. A turn's watch ends when activity matches, the turn is interrupted, or another turn starts; request correlations remain open until resolved. Reuse the exact watchId only while that watch is still pending. Otherwise inspect the activity or register a new watch with selectors. Cancel also requires the active watch's exact ID. Print/json parents cannot reactivate later.`,
      awaitSchema(),
      (value, toolCallId) => normalizeAwait(value, toolCallId),
      (input) => ({ toolName: TOOL.await, input }),
      resolveHost,
    ),
  ];
}

function definition<T extends LuminariesToolRequest>(
  name: LuminariesToolName,
  label: string,
  description: string,
  parameters: JsonSchema,
  normalize: (value: unknown, toolCallId: string) => T,
  command: (input: T) => LuminariesToolCommand,
  resolveHost: LuminariesToolHostResolver,
): LuminariesToolDefinition {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: 'parallel',
    renderShell: 'self',
    ...luminariesToolRenderer(name),
    async execute(toolCallId, params, signal, _onUpdate, context) {
      const normalized = normalize(params, toolCallId);
      const host = await resolveHost(context);
      return formatLuminariesToolResult(await host.execute(command(normalized), signal, toolCallId));
    },
  };
}

export function normalizeLuminariesToolCommand(
  name: LuminariesToolName,
  value: unknown,
  toolCallId: string,
): LuminariesToolCommand {
  if (name === TOOL.spawn) return { toolName: name, input: normalizeSpawn(value, toolCallId) };
  if (name === TOOL.directory) return { toolName: name, input: normalizeDirectory(value, toolCallId) };
  if (name === TOOL.message) return { toolName: name, input: normalizeMessage(value, toolCallId) };
  if (name === TOOL.control) return { toolName: name, input: normalizeControl(value, toolCallId) };
  return { toolName: name, input: normalizeAwait(value, toolCallId) };
}

function normalizeSpawn(value: unknown, toolCallId: string): LuminariesSpawnRequest {
  const object = objectValue(value, TOOL.spawn);
  exact(
    object,
    [
      'name',
      'assignment',
      'ownershipBoundary',
      'expertCard',
      'context',
      'recentTokens',
      'systemPrompt',
      'model',
      'thinking',
      'cwd',
      'extensions',
      'skills',
      'promptTemplates',
      'themes',
      'grants',
    ],
    TOOL.spawn,
  );
  const expertCard = object.expertCard === undefined ? undefined : normalizeExpertCard(object.expertCard);
  const context = object.context === undefined ? undefined : enumValue(object.context, CONTEXT_MODES, 'context mode');
  const recentTokens =
    object.recentTokens === undefined
      ? undefined
      : boundedInteger(object.recentTokens, 'recentTokens', 1, Number.MAX_SAFE_INTEGER);
  const systemPrompt =
    object.systemPrompt === undefined ? undefined : boundedString(object.systemPrompt, 'systemPrompt');
  const model = object.model === undefined ? undefined : boundedString(object.model, 'model');
  const thinking = object.thinking === undefined ? undefined : enumValue(object.thinking, THINKING_LEVELS, 'thinking');
  const cwd = object.cwd === undefined ? undefined : boundedString(object.cwd, 'cwd', 4096);
  const extensions = object.extensions === undefined ? undefined : stringList(object.extensions, 'extensions', 4096);
  const skills = object.skills === undefined ? undefined : stringList(object.skills, 'skills', 4096);
  const promptTemplates =
    object.promptTemplates === undefined ? undefined : stringList(object.promptTemplates, 'promptTemplates', 4096);
  const themes = object.themes === undefined ? undefined : stringList(object.themes, 'themes', 4096);
  const grants = object.grants === undefined ? undefined : normalizeCapabilityRequest(object.grants);
  if (grants?.tools !== undefined) throw new Error(`${TOOL.spawn} resolves tools automatically`);
  if (grants?.extensions !== undefined)
    throw new Error(`${TOOL.spawn} selects root-approved extensions through the extensions field`);
  return {
    requestId: normalizePiToolCallId(toolCallId),
    ...(object.name === undefined ? {} : { name: humanFacingString(object.name, 'name') }),
    assignment: humanFacingProse(object.assignment, 'assignment'),
    ownershipBoundary: humanFacingProse(object.ownershipBoundary, 'ownershipBoundary'),
    ...(expertCard ? { expertCard } : {}),
    ...(context ? { context } : {}),
    ...(recentTokens === undefined ? {} : { recentTokens }),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(cwd ? { cwd } : {}),
    ...(extensions ? { extensions } : {}),
    ...(skills ? { skills } : {}),
    ...(promptTemplates ? { promptTemplates } : {}),
    ...(themes ? { themes } : {}),
    ...(grants ? { grants } : {}),
  };
}
function normalizeDirectory(value: unknown, toolCallId: string): LuminariesDirectoryRequest {
  const object = objectValue(value, TOOL.directory);
  exact(object, ['action', 'agentId', 'patch', 'includeClosed', 'view', 'cursor', 'limit'], TOOL.directory);
  const action = enumValue(object.action, ['list', 'inspect', 'update'] as const, 'agents action');
  const agentId = object.agentId === undefined ? undefined : humanFacingString(object.agentId, 'agentId');
  if (action === 'update' && object.patch === undefined) throw new Error(`${TOOL.directory} update requires patch`);
  const includeClosed =
    object.includeClosed === undefined ? undefined : booleanValue(object.includeClosed, 'includeClosed');
  const view =
    object.view === undefined
      ? undefined
      : enumValue(
          object.view,
          ['summary', 'card', 'capabilities', 'coordination', 'diagnostics', 'transcript'] as const,
          'agent view',
        );
  const cursor = object.cursor === undefined ? undefined : boundedString(object.cursor, 'cursor', 4096);
  const limit =
    object.limit === undefined ? undefined : boundedInteger(object.limit, 'limit', 1, Number.MAX_SAFE_INTEGER);
  if (action === 'list' && (agentId !== undefined || object.patch !== undefined || view !== undefined))
    throw new Error(`${TOOL.directory} list accepts only includeClosed, cursor, and limit`);
  if (action === 'inspect' && (object.patch !== undefined || includeClosed !== undefined))
    throw new Error(`${TOOL.directory} inspect does not accept patch or includeClosed`);
  if (
    action === 'inspect' &&
    (cursor !== undefined || limit !== undefined) &&
    view !== 'capabilities' &&
    view !== 'card' &&
    view !== 'coordination' &&
    view !== 'diagnostics' &&
    view !== 'transcript'
  )
    throw new Error(
      `${TOOL.directory} paging is available only for card, capabilities, coordination, diagnostics, or transcript views`,
    );
  if (
    action === 'update' &&
    (includeClosed !== undefined || view !== undefined || cursor !== undefined || limit !== undefined)
  )
    throw new Error(`${TOOL.directory} update does not accept history fields`);
  const patch = object.patch === undefined ? undefined : normalizePatch(object.patch);
  return {
    requestId: normalizePiToolCallId(toolCallId),
    action,
    ...(agentId ? { agentId } : {}),
    ...(patch ? { patch } : {}),
    ...(includeClosed === undefined ? {} : { includeClosed }),
    ...(view ? { view } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
  };
}
function normalizeMessage(value: unknown, toolCallId: string): LuminariesMessageRequest {
  const object = objectValue(value, TOOL.message);
  exact(
    object,
    ['action', 'recipientId', 'recipientIds', 'message', 'mode', 'correlationId', 'deadlineMs'],
    TOOL.message,
  );
  const action = enumValue(
    object.action,
    ['send', 'multicast', 'request', 'request_many', 'reply', 'cancel'] as const,
    'message action',
  );
  const recipientId =
    object.recipientId === undefined ? undefined : humanFacingString(object.recipientId, 'recipientId');
  const recipientIds =
    object.recipientIds === undefined ? undefined : humanFacingStringList(object.recipientIds, 'recipientIds');
  const correlationId =
    object.correlationId === undefined ? undefined : identifier(object.correlationId, 'correlationId');
  const message = object.message === undefined ? undefined : boundedString(object.message, 'message');
  const mode =
    object.mode === undefined
      ? undefined
      : enumValue(object.mode, ['default', 'follow_up', 'notify_only'] as const, 'message mode');
  const deadlineMs =
    object.deadlineMs === undefined
      ? undefined
      : boundedInteger(object.deadlineMs, 'deadlineMs', 1_000, Number.MAX_SAFE_INTEGER);
  if (action === 'send') {
    if (!recipientId || message === undefined) throw new Error(`${TOOL.message} send requires recipientId and message`);
    if (recipientIds || correlationId !== undefined || deadlineMs !== undefined)
      throw new Error(`${TOOL.message} send accepts one recipient and no correlation or deadline`);
  } else if (action === 'multicast') {
    if (!recipientIds || message === undefined)
      throw new Error(`${TOOL.message} multicast requires recipientIds and message`);
    if (recipientId || correlationId !== undefined || deadlineMs !== undefined)
      throw new Error(`${TOOL.message} multicast does not accept recipientId, correlationId, or deadlineMs`);
  } else if (action === 'request' || action === 'request_many') {
    if (message === undefined) throw new Error(`${TOOL.message} ${action} requires message`);
    if (mode === 'notify_only' || correlationId !== undefined)
      throw new Error(`${TOOL.message} ${action} accepts only default/follow_up mode and no correlationId`);
    if (action === 'request' && (!recipientId || recipientIds))
      throw new Error(`${TOOL.message} request requires recipientId only`);
    if (action === 'request_many' && (!recipientIds || recipientId))
      throw new Error(`${TOOL.message} request_many requires recipientIds and no recipientId`);
  } else if (action === 'reply') {
    if (!correlationId || message === undefined)
      throw new Error(`${TOOL.message} reply requires correlationId and message`);
    if (recipientId || recipientIds || mode !== undefined || deadlineMs !== undefined)
      throw new Error(`${TOOL.message} reply does not accept recipients, mode, or deadlineMs`);
  } else if (
    !correlationId ||
    recipientId ||
    recipientIds ||
    message !== undefined ||
    mode !== undefined ||
    deadlineMs !== undefined
  ) {
    throw new Error(`${TOOL.message} cancel requires only correlationId`);
  }
  return {
    requestId: normalizePiToolCallId(toolCallId),
    action,
    ...(recipientId ? { recipientId } : {}),
    ...(recipientIds ? { recipientIds } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(mode ? { mode } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}
function normalizeControl(value: unknown, toolCallId: string): LuminariesControlRequest {
  const object = objectValue(value, TOOL.control);
  exact(object, ['action', 'agentId', 'message', 'model', 'thinking', 'extensions', 'grants'], TOOL.control);
  const action = enumValue(
    object.action,
    [
      'steer',
      'follow_up',
      'interrupt',
      'close',
      'close_subtree',
      'resume',
      'set_model',
      'set_thinking',
      'set_extensions',
      'set_grants',
    ] as const,
    'control action',
  );
  const agentId = object.agentId === undefined ? undefined : humanFacingString(object.agentId, 'agentId');
  const message = object.message === undefined ? undefined : boundedString(object.message, 'message');
  const model = object.model === undefined ? undefined : boundedString(object.model, 'model');
  const thinking = object.thinking === undefined ? undefined : enumValue(object.thinking, THINKING_LEVELS, 'thinking');
  const extensions =
    object.extensions === undefined ? undefined : humanFacingStringList(object.extensions, 'extensions');
  const grants = object.grants === undefined ? undefined : normalizeCapabilityRequest(object.grants);
  if (grants?.tools !== undefined || grants?.extensions !== undefined)
    throw new Error(`${TOOL.control} resolves tool and extension availability automatically`);
  const unrelated = (...values: unknown[]) => values.some((item) => item !== undefined);
  if (action === 'steer' || action === 'follow_up') {
    if (!agentId || message === undefined) throw new Error(`${TOOL.control} ${action} requires agentId and message`);
    if (unrelated(model, thinking, extensions, grants))
      throw new Error(`${TOOL.control} ${action} contains unrelated fields`);
  } else if (action === 'interrupt') {
    if (!agentId || unrelated(model, thinking, extensions, grants))
      throw new Error(`${TOOL.control} interrupt requires agentId and optional message only`);
  } else if (action === 'close' || action === 'close_subtree' || action === 'resume') {
    if (!agentId || unrelated(message, model, thinking, extensions, grants))
      throw new Error(`${TOOL.control} ${action} requires agentId only`);
  } else if (action === 'set_model') {
    if (!agentId || !model || unrelated(message, thinking, extensions, grants))
      throw new Error(`${TOOL.control} set_model requires agentId and model only`);
  } else if (action === 'set_thinking') {
    if (!agentId || !thinking || unrelated(message, model, extensions, grants))
      throw new Error(`${TOOL.control} set_thinking requires agentId and thinking only`);
  } else if (action === 'set_extensions') {
    if (!agentId || !extensions || unrelated(message, model, thinking, grants))
      throw new Error(`${TOOL.control} set_extensions requires agentId and extensions only`);
  } else if (action === 'set_grants') {
    if (!agentId || !grants || Object.keys(grants).length === 0 || unrelated(message, model, thinking, extensions))
      throw new Error(`${TOOL.control} set_grants requires agentId and grants only`);
  }
  return {
    requestId: normalizePiToolCallId(toolCallId),
    action,
    ...(agentId ? { agentId } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(extensions ? { extensions } : {}),
    ...(grants ? { grants } : {}),
  };
}
function normalizeAwait(value: unknown, toolCallId: string): LuminariesAwaitRequest {
  const object = objectValue(value, TOOL.await);
  exact(object, ['action', 'watchId', 'requestIds', 'agentIds', 'eventKinds', 'owned'], TOOL.await);
  const action = enumValue(object.action, ['wait', 'cancel'] as const, 'await action');
  const watchId = object.watchId === undefined ? undefined : identifier(object.watchId, 'watchId');
  const requestIds = object.requestIds === undefined ? undefined : identifierList(object.requestIds, 'requestIds');
  const agentIds = object.agentIds === undefined ? undefined : humanFacingStringList(object.agentIds, 'agentIds');
  const eventKinds =
    object.eventKinds === undefined
      ? undefined
      : enumList(
          object.eventKinds,
          ['message', 'request', 'reply', 'cancel', 'resolution', 'system'] as const,
          'eventKinds',
        );
  const owned = object.owned === undefined ? undefined : booleanValue(object.owned, 'owned');
  if (action === 'cancel') {
    if (!watchId || requestIds || agentIds || eventKinds || owned !== undefined)
      throw new Error(`${TOOL.await} cancel requires only watchId`);
  } else if (watchId && (requestIds || agentIds || eventKinds || owned !== undefined)) {
    throw new Error(`${TOOL.await} wait cannot reuse a watchId with new selectors`);
  } else if (!watchId && !requestIds && !agentIds && !eventKinds && owned === undefined) {
    throw new Error(`${TOOL.await} wait requires a selector`);
  }
  return {
    requestId: normalizePiToolCallId(toolCallId),
    action,
    ...(watchId ? { watchId } : {}),
    ...(requestIds ? { requestIds } : {}),
    ...(agentIds ? { agentIds } : {}),
    ...(eventKinds ? { eventKinds } : {}),
    ...(owned === undefined ? {} : { owned }),
  };
}

function normalizeExpertCard(value: unknown): NonNullable<LuminariesSpawnRequest['expertCard']> {
  const object = objectValue(value, 'expertCard');
  exact(object, ['role', 'focus', 'expertise', 'publishedRefs'], 'expertCard');
  const role = object.role === undefined ? undefined : humanFacingString(object.role, 'expertCard.role');
  const focus = object.focus === undefined ? undefined : humanFacingProse(object.focus, 'expertCard.focus');
  const expertise = object.expertise === undefined ? undefined : humanFacingStringList(object.expertise, 'expertise');
  const publishedRefs =
    object.publishedRefs === undefined ? undefined : humanFacingStringList(object.publishedRefs, 'publishedRefs');
  return {
    ...(role ? { role } : {}),
    ...(focus ? { focus } : {}),
    ...(expertise ? { expertise } : {}),
    ...(publishedRefs ? { publishedRefs } : {}),
  };
}
function normalizePatch(value: unknown): Record<string, unknown> {
  const object = objectValue(value, 'metadata patch');
  exact(
    object,
    ['displayName', 'assignment', 'ownershipBoundary', 'role', 'focus', 'expertise', 'publishedRefs'],
    'metadata patch',
  );
  const patch: Record<string, unknown> = {};
  if (Object.keys(object).length === 0) throw new Error('metadata patch is empty');
  if (object.displayName !== undefined) patch.displayName = humanFacingString(object.displayName, 'displayName');
  if (object.assignment !== undefined) patch.assignment = humanFacingProse(object.assignment, 'assignment');
  if (object.ownershipBoundary !== undefined)
    patch.ownershipBoundary = humanFacingProse(object.ownershipBoundary, 'ownershipBoundary');
  if (object.role !== undefined) patch.role = nullableHumanFacingString(object.role, 'role');
  if (object.focus !== undefined) patch.focus = object.focus === null ? null : humanFacingProse(object.focus, 'focus');
  if (object.expertise !== undefined)
    patch.expertise = object.expertise === null ? null : humanFacingStringList(object.expertise, 'expertise');
  if (object.publishedRefs !== undefined)
    patch.publishedRefs =
      object.publishedRefs === null ? null : humanFacingStringList(object.publishedRefs, 'publishedRefs');
  return patch;
}

function spawnSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['assignment', 'ownershipBoundary'],
    properties: {
      name: stringSchema(),
      assignment: stringSchema(),
      ownershipBoundary: stringSchema(),
      expertCard: expertCardSchema(),
      context: enumSchema(CONTEXT_MODES),
      recentTokens: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      systemPrompt: stringSchema(),
      model: stringSchema(),
      thinking: enumSchema(THINKING_LEVELS),
      cwd: stringSchema(4096),
      extensions: { type: 'array', items: stringSchema(4096) },
      skills: { type: 'array', items: stringSchema(4096) },
      promptTemplates: { type: 'array', items: stringSchema(4096) },
      themes: { type: 'array', items: stringSchema(4096) },
      grants: capabilityGrantSchema(),
    },
  };
}
function directorySchema(): JsonSchema {
  return actionSchema([
    {
      action: 'list',
      extra: {
        includeClosed: { type: 'boolean' },
        cursor: stringSchema(4096),
        limit: { type: 'integer', minimum: 1 },
      },
    },
    {
      action: 'inspect',
      extra: {
        agentId: stringSchema(),
        view: enumSchema(['summary', 'card', 'capabilities', 'coordination', 'diagnostics', 'transcript']),
        cursor: stringSchema(4096),
        limit: { type: 'integer', minimum: 1 },
      },
    },
    {
      action: 'update',
      extra: { agentId: stringSchema(), patch: patchSchema() },
    },
  ]);
}
function messageSchema(): JsonSchema {
  const recipients = { type: 'array', minItems: 1, items: stringSchema() };
  const deadline = { type: 'integer', minimum: 1_000, maximum: Number.MAX_SAFE_INTEGER };
  return actionSchema([
    {
      action: 'send',
      extra: {
        recipientId: stringSchema(),
        message: stringSchema(),
        mode: enumSchema(['default', 'follow_up', 'notify_only']),
      },
    },
    {
      action: 'multicast',
      extra: {
        recipientIds: recipients,
        message: stringSchema(),
        mode: enumSchema(['default', 'follow_up', 'notify_only']),
      },
    },
    {
      action: 'request',
      extra: {
        recipientId: stringSchema(),
        message: stringSchema(),
        mode: enumSchema(['default', 'follow_up']),
        deadlineMs: deadline,
      },
    },
    {
      action: 'request_many',
      extra: {
        recipientIds: recipients,
        message: stringSchema(),
        mode: enumSchema(['default', 'follow_up']),
        deadlineMs: deadline,
      },
    },
    {
      action: 'reply',
      extra: { correlationId: stringSchema(128), message: stringSchema() },
    },
    { action: 'cancel', extra: { correlationId: stringSchema(128) } },
  ]);
}
function controlSchema(): JsonSchema {
  return actionSchema([
    {
      action: 'steer',
      extra: { agentId: stringSchema(), message: stringSchema() },
    },
    {
      action: 'follow_up',
      extra: { agentId: stringSchema(), message: stringSchema() },
    },
    {
      action: 'interrupt',
      extra: { agentId: stringSchema(), message: stringSchema() },
    },
    { action: 'close', extra: { agentId: stringSchema() } },
    { action: 'close_subtree', extra: { agentId: stringSchema() } },
    { action: 'resume', extra: { agentId: stringSchema() } },
    {
      action: 'set_model',
      extra: { agentId: stringSchema(), model: stringSchema() },
    },
    {
      action: 'set_thinking',
      extra: { agentId: stringSchema(), thinking: enumSchema(THINKING_LEVELS) },
    },
    {
      action: 'set_extensions',
      extra: { agentId: stringSchema(), extensions: { type: 'array', items: stringSchema(4096) } },
    },
    {
      action: 'set_grants',
      extra: { agentId: stringSchema(), grants: capabilityGrantSchema() },
    },
  ]);
}
function awaitSchema(): JsonSchema {
  return actionSchema([
    {
      action: 'wait',
      extra: {
        watchId: stringSchema(128),
        requestIds: { type: 'array', items: stringSchema(128) },
        agentIds: { type: 'array', items: stringSchema() },
        eventKinds: {
          type: 'array',
          items: enumSchema(['message', 'request', 'reply', 'cancel', 'resolution', 'system']),
        },
        owned: { type: 'boolean' },
      },
    },
    { action: 'cancel', extra: { watchId: stringSchema(128) } },
  ]);
}
function capabilityGrantSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      spawn: { type: 'boolean' },
      peerInterrupt: { type: 'boolean' },
      maxDepth: { type: 'integer', minimum: 0 },
      models: { type: 'array', items: stringSchema() },
      thinking: { type: 'array', items: enumSchema(THINKING_LEVELS) },
      skills: { type: 'array', items: stringSchema(4096) },
      promptTemplates: { type: 'array', items: stringSchema(4096) },
      themes: { type: 'array', items: stringSchema(4096) },
      cwdRoots: { type: 'array', items: stringSchema(4096) },
    },
  };
}
function expertCardSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      role: stringSchema(),
      focus: stringSchema(),
      expertise: { type: 'array', items: stringSchema() },
      publishedRefs: { type: 'array', items: stringSchema() },
    },
  };
}
function patchSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      displayName: stringSchema(),
      assignment: stringSchema(),
      ownershipBoundary: stringSchema(),
      role: { anyOf: [stringSchema(), { type: 'null' }] },
      focus: { anyOf: [stringSchema(), { type: 'null' }] },
      expertise: { anyOf: [{ type: 'array', items: stringSchema() }, { type: 'null' }] },
      publishedRefs: { anyOf: [{ type: 'array', items: stringSchema() }, { type: 'null' }] },
    },
  };
}
function actionSchema(variants: readonly { action: string; extra?: Record<string, unknown> }[]): JsonSchema {
  const properties: Record<string, unknown> = {
    action: { type: 'string', enum: variants.map((variant) => variant.action) },
  };
  for (const variant of variants)
    for (const [name, property] of Object.entries(variant.extra ?? {})) {
      const current = properties[name];
      if (current === undefined) properties[name] = property;
      else if (isRecord(current) && isRecord(property) && Array.isArray(current.enum) && Array.isArray(property.enum))
        properties[name] = { ...current, enum: [...new Set([...current.enum, ...property.enum])] };
    }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties,
  };
}
function stringSchema(maximum?: number): Record<string, unknown> {
  return { type: 'string', minLength: 1, ...(maximum === undefined ? {} : { maxLength: maximum }) };
}
function enumSchema<T extends string>(values: readonly T[]): Record<string, unknown> {
  return { type: 'string', enum: values };
}
function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains a forbidden key`);
  return value;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field '${key}'`);
}
export function normalizePiToolCallId(toolCallId: string): string {
  if (typeof toolCallId !== 'string' || toolCallId.length < 1 || Buffer.byteLength(toolCallId) > 4 * 1024)
    throw new Error('toolCallId is outside its bound');
  if (
    isLuminariesId(toolCallId) &&
    toolCallId.length <= MAX_TOOL_CALL_ID &&
    Buffer.byteLength(toolCallId) <= MAX_TOOL_CALL_ID
  )
    return toolCallId;
  return `pi-tool-${sha256(toolCallId).slice(0, 56)}`;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isLuminariesId(value) || FORBIDDEN_KEYS.has(value))
    throw new Error(`${label} is invalid`);
  return value;
}
function boundedString(value: unknown, label: string, maximum?: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    (maximum !== undefined && (value.length > maximum || Buffer.byteLength(value) > maximum))
  )
    throw new Error(`${label} is outside its bound`);
  return value;
}
function humanFacingString(value: unknown, label: string, maximum?: number): string {
  const result = boundedString(value, label, maximum);
  if (hasUnsafeHumanFacingControl(result)) throw new Error(`${label} contains a presentation control`);
  return result;
}
function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}
function nullableHumanFacingString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return humanFacingString(value, label);
}
function stringList(value: unknown, label: string, maximumString: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const result = value.map((item) => boundedString(item, label, maximumString));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}
function humanFacingStringList(value: unknown, label: string, maximumString?: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const result = value.map((item) => humanFacingString(item, label, maximumString));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  if (result.some(hasUnsafeHumanFacingControl)) throw new Error(`${label} contains a presentation control`);
  return result;
}
function identifierList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const result = value.map((item) => identifier(item, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}
function enumList<T extends string>(value: unknown, values: readonly T[], label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const result = value.map((item) => enumValue(item, values, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}
function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label} is outside its bound`);
  return value;
}
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value === 'string') for (const candidate of values) if (candidate === value) return candidate;
  throw new Error(`${label} is invalid`);
}
export function formatLuminariesToolResult(receipt: LuminariesReceipt): LuminariesToolResult {
  const modelDetails = { ...receipt.details };
  delete modelDetails.requestId;
  delete modelDetails.duplicate;
  delete modelDetails.eventId;
  delete modelDetails.traceId;
  delete modelDetails.controlId;
  delete modelDetails.triggerEventId;
  delete modelDetails.durableSeq;
  if (Array.isArray(modelDetails.legs))
    modelDetails.legs = modelDetails.legs.map((value) => {
      if (!isRecord(value)) return value;
      const leg = { ...value };
      delete leg.eventId;
      delete leg.traceId;
      return leg;
    });
  return {
    content: [{ type: 'text', text: `${receipt.message}\n${JSON.stringify(modelDetails)}` }],
    details: receipt.details,
    ...(receipt.terminate ? { terminate: true } : {}),
  };
}
