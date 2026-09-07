import { randomUUID } from 'node:crypto';
import type { LuminariesManager } from './luminaries-manager.ts';
import {
  formatLuminariesToolResult,
  normalizeLuminariesToolCommand,
  type LuminariesDirectoryRequest,
  type LuminariesAwaitRequest,
  type LuminariesControlRequest,
  type LuminariesMessageRequest,
  type LuminariesSpawnRequest,
  type LuminariesToolHost,
  type LuminariesToolName,
  type LuminariesToolResult,
} from './luminaries-tools.ts';
import { isRecord, sha256 } from './scheduler-state.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

const TOOL = LUMINARIES_IDENTITY.tools;
const PRODUCT = LUMINARIES_IDENTITY.label;
export const LUMINARIES_WAVES_SERVICE = Symbol.for(LUMINARIES_IDENTITY.serviceSymbol);
export const LUMINARIES_WAVES_SERVICE_VERSION = LUMINARIES_IDENTITY.serviceVersion;
const WAVES_REGISTRATION = Symbol(LUMINARIES_IDENTITY.serviceRegistrationSymbol);

interface WavesRegistration {
  readonly isOpen: () => boolean;
}

export interface LuminariesWavesEventV1 {
  version: 1;
  rootId: string;
  revision: number;
  openAgents: number;
  workingAgents: number;
  waitingAgents: number;
  attentionAgents: number;
}

type WavesInput<T extends { requestId: string }> = Omit<T, 'requestId'> & { requestId?: string };
export type LuminariesWavesSpawnV1 = WavesInput<LuminariesSpawnRequest>;
export type LuminariesWavesDirectoryV1 = WavesInput<LuminariesDirectoryRequest>;
export type LuminariesWavesMessageV1 = WavesInput<LuminariesMessageRequest>;
export type LuminariesWavesControlV1 = WavesInput<LuminariesControlRequest>;
export type LuminariesWavesWatchV1 = WavesInput<LuminariesAwaitRequest>;

export interface LuminariesWavesServiceV1 {
  readonly version: 1;
  readonly rootId: string;
  spawn(input: LuminariesWavesSpawnV1): Promise<LuminariesToolResult>;
  directory(input?: LuminariesWavesDirectoryV1): Promise<LuminariesToolResult>;
  message(input: LuminariesWavesMessageV1): Promise<LuminariesToolResult>;
  control(input: LuminariesWavesControlV1): Promise<LuminariesToolResult>;
  watch(input: LuminariesWavesWatchV1): Promise<LuminariesToolResult>;
  subscribe(listener: (event: LuminariesWavesEventV1) => void): () => void;
}

export function isLuminariesWavesService(value: unknown): value is LuminariesWavesServiceV1 {
  return (
    isRecord(value) &&
    value.version === LUMINARIES_WAVES_SERVICE_VERSION &&
    typeof value.rootId === 'string' &&
    typeof value.spawn === 'function' &&
    typeof value.directory === 'function' &&
    typeof value.message === 'function' &&
    typeof value.control === 'function' &&
    typeof value.watch === 'function' &&
    typeof value.subscribe === 'function'
  );
}

export function currentWavesService(): LuminariesWavesServiceV1 | undefined {
  const value: unknown = Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE);
  if (!isLuminariesWavesService(value)) return undefined;
  const registration = registrationOf(value);
  if (registration && !registration.isOpen()) {
    if (Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE) === value)
      Reflect.deleteProperty(globalThis, LUMINARIES_WAVES_SERVICE);
    return undefined;
  }
  return value;
}

function registrationOf(value: object): WavesRegistration | undefined {
  const candidate: unknown = Reflect.get(value, WAVES_REGISTRATION);
  if (!isRecord(candidate) || typeof candidate.isOpen !== 'function') return undefined;
  const isOpen = candidate.isOpen;
  return { isOpen: () => isOpen() };
}

function requestId(): string {
  return `waves-${sha256(randomUUID()).slice(0, 40)}`;
}

async function call(
  host: LuminariesToolHost,
  toolName: LuminariesToolName,
  input: unknown,
): Promise<LuminariesToolResult> {
  const operationId = isRecord(input) && typeof input.requestId === 'string' ? input.requestId : requestId();
  const commandInput = isRecord(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'requestId'))
    : input;
  return formatLuminariesToolResult(
    await host.execute(normalizeLuminariesToolCommand(toolName, commandInput, operationId), undefined),
  );
}

/**
 * Installs one process-local, session-scoped provider for the separate Waves extension.
 * The provider delegates to Luminaries's existing manager and never owns lifecycle or state.
 */
export function installWavesService(manager: LuminariesManager): () => void {
  const existing: unknown = Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE);
  if (existing !== undefined) {
    const registration = isLuminariesWavesService(existing) ? registrationOf(existing) : undefined;
    if (!registration || registration.isOpen())
      throw new Error(`Another ${PRODUCT} Waves service is already installed in this process`);
    Reflect.deleteProperty(globalThis, LUMINARIES_WAVES_SERVICE);
  }
  const host = manager.hostForService();
  const rootId = manager.rootSummary().rootId;
  const listeners = new Set<(event: LuminariesWavesEventV1) => void>();
  let lastEvent: LuminariesWavesEventV1 | undefined;
  let unsubscribeSummary: (() => void) | undefined;
  let closed = false;
  const currentEvent = (): LuminariesWavesEventV1 => {
    const summary = manager.rootSummary();
    return {
      version: LUMINARIES_WAVES_SERVICE_VERSION,
      rootId: summary.rootId,
      revision: summary.revision,
      openAgents: summary.openAgents,
      workingAgents: summary.workingAgents,
      waitingAgents: summary.waitingAgents,
      attentionAgents: summary.attentionAgents,
    };
  };
  const publish = (): void => {
    const event = currentEvent();
    if (lastEvent?.revision === event.revision) return;
    lastEvent = event;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A Waves observer cannot disrupt Luminaries's scheduler or other observers.
      }
    }
  };
  const service: LuminariesWavesServiceV1 = {
    version: LUMINARIES_WAVES_SERVICE_VERSION,
    rootId,
    spawn: (input) => call(host, TOOL.spawn, input),
    directory: (input = { action: 'list' }) => call(host, TOOL.directory, input),
    message: (input) => call(host, TOOL.message, input),
    control: (input) => call(host, TOOL.control, input),
    watch: (input) => call(host, TOOL.await, input),
    subscribe(listener) {
      if (closed) throw new Error(`The ${PRODUCT} Waves service is closed`);
      listeners.add(listener);
      if (listeners.size === 1) {
        lastEvent = currentEvent();
        unsubscribeSummary = manager.onRootSummaryChange(publish);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size) return;
        unsubscribeSummary?.();
        unsubscribeSummary = undefined;
        lastEvent = undefined;
      };
    },
  };
  Object.defineProperty(service, WAVES_REGISTRATION, {
    configurable: false,
    enumerable: false,
    value: {
      isOpen: () => !closed && (manager.isRunning?.() ?? true),
    } satisfies WavesRegistration,
  });
  Reflect.set(globalThis, LUMINARIES_WAVES_SERVICE, service);
  return () => {
    if (closed) return;
    closed = true;
    unsubscribeSummary?.();
    unsubscribeSummary = undefined;
    listeners.clear();
    if (Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE) === service)
      Reflect.deleteProperty(globalThis, LUMINARIES_WAVES_SERVICE);
  };
}
