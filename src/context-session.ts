import { isRecord } from './scheduler-state.ts';
import type { ContextMode, EffectiveSpawnConfiguration } from './spawn-configuration.ts';

const DEFAULT_RECENT_TOKENS = 16_000;

export type ContextTokenEstimator = (messages: readonly unknown[]) => number;

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

interface TokenCounter {
  usedFallback: boolean;
  estimate(messages: readonly unknown[]): number;
}

function tokenCounter(estimator: ContextTokenEstimator | undefined): TokenCounter {
  let usedFallback = estimator === undefined;
  return {
    get usedFallback() {
      return usedFallback;
    },
    estimate(messages) {
      if (estimator) {
        try {
          const value = estimator(messages);
          if (Number.isSafeInteger(value) && value >= 0) return Math.max(1, value);
        } catch {
          // Fall back to the documented bounded estimate when provider accounting is unavailable.
        }
        usedFallback = true;
      }
      return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4));
    },
  };
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

function selectRecent(messages: readonly unknown[], budget: number, counter: TokenCounter): readonly unknown[] {
  const messageGroups = groups(messages);
  const selected: (readonly unknown[])[] = [];
  let used = 0;
  for (let index = messageGroups.length - 1; index >= 0; index--) {
    const group = messageGroups[index];
    if (!group) continue;
    const cost = counter.estimate(group);
    if (selected.length === 0 && cost > budget)
      throw new Error(`The newest protocol-valid context group needs ${cost} tokens but only ${budget} are safe`);
    if (used + cost > budget) break;
    selected.unshift(group);
    used += cost;
  }
  return selected.flatMap((group) => group.map((message) => structuredClone(message)));
}

function safeTransferTokens(contextWindow: number, maxOutputTokens: number, additionalOverheadTokens: number): number {
  const available = contextWindow - maxOutputTokens;
  if (additionalOverheadTokens > available)
    throw new Error(
      `The selected model leaves ${Math.max(0, available)} tokens for startup but the effective prompt, tools, resources, and assignment need about ${additionalOverheadTokens}`,
    );
  return available - additionalOverheadTokens;
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
  estimator?: ContextTokenEstimator,
): ContextLaunchPlan {
  if (!Number.isSafeInteger(additionalOverheadTokens) || additionalOverheadTokens < 0)
    throw new Error('Context preflight overhead is invalid');
  const safeTokens =
    configuration.contextWindow && configuration.maxOutputTokens
      ? safeTransferTokens(configuration.contextWindow, configuration.maxOutputTokens, additionalOverheadTokens)
      : undefined;
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
  if (!configuration.maxOutputTokens)
    throw new Error(`${configuration.context} context requires the target model's declared max output`);
  if (safeTokens === undefined) throw new Error(`${configuration.context} context fit is unavailable`);
  const allMessages = snapshot.messages.map((message) => structuredClone(message));
  const counter = tokenCounter(estimator);
  if (configuration.context === 'fork') {
    const cost = counter.estimate(allMessages);
    if (cost > safeTokens)
      throw new Error(
        `Fork context needs about ${cost} tokens but the selected model safely permits ${safeTokens}; compact the parent and retry, or choose recent, fresh, custom, or a larger-context model`,
      );
    const parentModel = sourceModel(allMessages);
    const warning = warnings(
      cost > configuration.contextWindow / 2 ? 'Fork transfer exceeds 50% of the target context window.' : undefined,
      configuration.modelKey && parentModel && parentModel !== configuration.modelKey
        ? `Cross-model fork from ${parentModel} to ${configuration.modelKey} relies on Pi compatibility transformation; incompatible reasoning, tool IDs, or media may be normalized.`
        : undefined,
      counter.usedFallback ? 'Token count uses a conservative target-visible estimate.' : undefined,
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
      `Explicit recentTokens ${requested} exceeds the measured safe maximum ${safeTokens}; retry with that value or lower`,
    );
  const effective = Math.min(requested, safeTokens);
  if (effective < 1) throw new Error('The selected model has no safe room for recent context');
  const selected = selectRecent(allMessages, effective, counter);
  const cost = counter.estimate(selected);
  const warning = warnings(
    configuration.recentTokens === undefined && effective < requested
      ? `Default recent budget reduced from ${requested} to ${effective} tokens for the target model.`
      : configuration.contextWindow && cost > configuration.contextWindow / 2
        ? 'Recent transfer exceeds 50% of the target context window.'
        : undefined,
    counter.usedFallback ? 'Token count uses a conservative target-visible estimate.' : undefined,
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
