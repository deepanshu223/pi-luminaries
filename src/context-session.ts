import { isRecord } from './scheduler-state.ts';
import type { ContextMode, EffectiveSpawnConfiguration } from './spawn-configuration.ts';
import { estimatePiSessionMessages } from './pi-session-host.ts';

const DEFAULT_RECENT_TOKENS = 16_000;

export interface ParentContextSnapshot {
  messages: readonly unknown[];
  sourceSessionFile?: string;
  selectedToolCallId: string;
}

export interface ContextTransferReceipt {
  mode: ContextMode;
  requestedTokens?: number;
  effectiveTokens: number;
  estimatedTokens: number;
  transferredMessages: number;
  omittedMessages: number;
  targetContextWindow?: number;
  warning?: string;
}

export interface ContextLaunchPlan {
  receipt: ContextTransferReceipt;
  messages: readonly unknown[];
  parentSession?: string;
  noContextFiles: boolean;
  systemPrompt?: string;
}

function groups(messages: readonly unknown[]): readonly (readonly unknown[])[] {
  const result: unknown[][] = [];
  let current: unknown[] = [];
  for (const message of messages) {
    const role = isRecord(message) && typeof message.role === 'string' ? message.role : undefined;
    if (role === 'user' && current.length) {
      result.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) result.push(current);
  return result;
}

function selectRecent(messages: readonly unknown[], budget: number): readonly unknown[] {
  const messageGroups = groups(messages);
  const selected: (readonly unknown[])[] = [];
  let used = 0;
  for (let index = messageGroups.length - 1; index >= 0; index--) {
    const group = messageGroups[index];
    if (!group) continue;
    const cost = estimatePiSessionMessages(group);
    if (selected.length === 0 && cost > budget)
      throw new Error(
        `The newest protocol-valid context group needs about ${cost} tokens but only ${budget} are available`,
      );
    if (used + cost > budget) break;
    selected.unshift(group);
    used += cost;
  }
  return selected.flatMap((group) => group.map((message) => structuredClone(message)));
}

function availableTransferTokens(contextWindow: number, additionalOverheadTokens: number): number {
  if (additionalOverheadTokens >= contextWindow)
    throw new Error(
      `Startup context needs about ${additionalOverheadTokens} tokens but the selected model's context window is ${contextWindow}; shorten the assignment or choose a larger-context model`,
    );
  // Pi fits output to the remaining context; the model's maximum output is not a mandatory reserve.
  return contextWindow - additionalOverheadTokens;
}

function sourceModel(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'assistant') continue;
    if (typeof message.provider === 'string' && typeof message.model === 'string')
      return `${message.provider}/${message.model}`;
  }
  return undefined;
}

function warnings(...values: Array<string | undefined>): string | undefined {
  const present = values.filter((value): value is string => value !== undefined);
  return present.length ? present.join(' ') : undefined;
}

export function planContextLaunch(
  configuration: EffectiveSpawnConfiguration,
  snapshot: ParentContextSnapshot | undefined,
  additionalOverheadTokens = 0,
): ContextLaunchPlan {
  if (!Number.isSafeInteger(additionalOverheadTokens) || additionalOverheadTokens < 0)
    throw new Error('Context preflight overhead is invalid');
  if (configuration.context === 'fresh') {
    return {
      receipt: {
        mode: 'fresh',
        effectiveTokens: 0,
        estimatedTokens: 0,
        transferredMessages: 0,
        omittedMessages: 0,
        ...(configuration.contextWindow ? { targetContextWindow: configuration.contextWindow } : {}),
      },
      messages: [],
      noContextFiles: false,
    };
  }
  if (configuration.context === 'custom') {
    return {
      receipt: {
        mode: 'custom',
        effectiveTokens: 0,
        estimatedTokens: 0,
        transferredMessages: 0,
        omittedMessages: 0,
        ...(configuration.contextWindow ? { targetContextWindow: configuration.contextWindow } : {}),
      },
      messages: [],
      noContextFiles: true,
      systemPrompt:
        configuration.systemPrompt ?? 'You are operating in an isolated Pi context. Follow the user message.',
    };
  }
  if (!snapshot) throw new Error(`${configuration.context} context requires an exact parent spawn-call snapshot`);
  if (!configuration.contextWindow)
    throw new Error(`${configuration.context} context requires a declared target-model context window`);
  const safeTokens = availableTransferTokens(configuration.contextWindow, additionalOverheadTokens);
  const allMessages = snapshot.messages.map((message) => structuredClone(message));
  if (configuration.context === 'fork') {
    const cost = estimatePiSessionMessages(allMessages);
    if (cost > safeTokens)
      throw new Error(
        `Fork context needs about ${cost} tokens but the selected model has an estimated ${safeTokens} available; compact the parent and retry, or choose recent, fresh, custom, or a larger-context model`,
      );
    const parentModel = sourceModel(allMessages);
    const warning = warnings(
      cost > configuration.contextWindow / 2 ? 'Fork transfer exceeds 50% of the target context window.' : undefined,
      configuration.modelKey && parentModel && parentModel !== configuration.modelKey
        ? `Cross-model fork from ${parentModel} to ${configuration.modelKey} relies on Pi compatibility transformation; incompatible reasoning, tool IDs, or media may be normalized.`
        : undefined,
    );
    return {
      receipt: {
        mode: 'fork',
        effectiveTokens: cost,
        estimatedTokens: cost,
        transferredMessages: allMessages.length,
        omittedMessages: 0,
        targetContextWindow: configuration.contextWindow,
        ...(warning ? { warning } : {}),
      },
      messages: allMessages,
      ...(snapshot.sourceSessionFile ? { parentSession: snapshot.sourceSessionFile } : {}),
      noContextFiles: false,
    };
  }

  const requested = configuration.recentTokens ?? DEFAULT_RECENT_TOKENS;
  if (configuration.recentTokens !== undefined && requested > safeTokens)
    throw new Error(
      `Explicit recentTokens ${requested} exceeds the estimated available context ${safeTokens}; retry with that value or lower`,
    );
  const effective = Math.min(requested, safeTokens);
  if (effective < 1) throw new Error('The selected model has no estimated room for recent context');
  const selected = selectRecent(allMessages, effective);
  const cost = estimatePiSessionMessages(selected);
  const warning = warnings(
    configuration.recentTokens === undefined && effective < requested
      ? `Default recent budget reduced from ${requested} to ${effective} tokens for the target model.`
      : configuration.contextWindow && cost > configuration.contextWindow / 2
        ? 'Recent transfer exceeds 50% of the target context window.'
        : undefined,
  );
  return {
    receipt: {
      mode: 'recent',
      requestedTokens: requested,
      effectiveTokens: effective,
      estimatedTokens: cost,
      transferredMessages: selected.length,
      omittedMessages: allMessages.length - selected.length,
      targetContextWindow: configuration.contextWindow,
      ...(warning ? { warning } : {}),
    },
    messages: selected,
    ...(snapshot.sourceSessionFile ? { parentSession: snapshot.sourceSessionFile } : {}),
    noContextFiles: false,
  };
}
