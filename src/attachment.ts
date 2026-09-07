import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicReplacePrivateFile } from './atomic-file.ts';
import type { LuminariesCommandCenterHost } from './command-center.ts';
import type { LuminariesCommandCenterAgent, LuminariesCommandCenterProjection } from './command-center-projection.ts';
import type { LuminariesConversationReset, LuminariesConversationUpdate } from './agent-conversations.ts';
import type { LuminariesToolName, LuminariesToolResult } from './luminaries-tools.ts';
import type { PeerBridgeServer } from './peer-bridge.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import type { ModelDescriptor } from './spawn-configuration.ts';
import type { ManagedExtensionSource } from './root-configuration.ts';
import { THINKING_LEVELS } from './capability-policy.ts';
import { isUuid } from './identifiers.ts';
import { processAlive } from './process-liveness.ts';
import { isRecord, SchedulerStateError, sha256 } from './scheduler-state.ts';

const ATTACHMENT_PATH = '/v1/attachment';
const ATTACHMENT_TARGET_PATH = `${ATTACHMENT_PATH}/target`;
const ATTACHMENT_HISTORY_PATH = `${ATTACHMENT_PATH}/history`;
const ATTACHMENT_SESSIONS_PATH = `${ATTACHMENT_PATH}/sessions`;
const ATTACHMENT_ACK_PATH = `${ATTACHMENT_PATH}/ack`;
const ATTACHMENT_RECEIPT_DIRECTORY = 'attachment-receipts';
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const INITIAL_CONNECTION_TIMEOUT_MS = 10_000;
const ATTACHMENT_RETRY_MIN_MS = 500;
const ATTACHMENT_RETRY_MAX_MS = 5_000;
/** Finite fallback so a lost or starved owner can never hold "Sending…" open forever. */
const ATTACHMENT_ACTION_TIMEOUT_MS = 20_000;
const OWNER_OFFLINE_MESSAGE = 'Root offline · Read-only · Reconnecting when its owning Pi session resumes.';

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

interface AttachmentDirectoryReset {
  type: 'directory_reset';
  epoch: string;
  revision: number;
  projection: LuminariesCommandCenterProjection;
  models: readonly ModelDescriptor[];
  thinkingLevels: readonly string[];
  extensions: readonly { specifier: string; source: string }[];
  extensionSources: readonly ManagedExtensionSource[];
}

interface AttachmentTarget {
  agentId: string;
  projection: LuminariesCommandCenterProjection;
}

type AttachmentAction =
  | { action: 'send'; operationId: string; agentId: string; message: string; mode: 'auto' | 'follow_up' }
  | { action: 'interrupt'; operationId: string; agentId: string }
  | { action: 'execute'; operationId: string; toolName: LuminariesToolName; input: unknown }
  | { action: 'set_capacity'; operationId: string; capacity: number }
  | { action: 'set_depth'; operationId: string; depth: number }
  | {
      action: 'approve_extension';
      operationId: string;
      specifier: string;
      scope: ManagedExtensionSource['scope'];
      install: boolean;
    }
  | { action: 'park_all'; operationId: string; mode: 'safe' | 'now' }
  | { action: 'detach_session'; operationId: string; agentId: string }
  | {
      action: 'adopt_session';
      operationId: string;
      sessionFile: string;
      options: { name?: string; assignment?: string; expertise?: string[] };
    }
  | { action: 'archive'; operationId: string; agentId: string; archived: boolean }
  | { action: 'resume'; operationId: string; agentId: string };

type AttachmentMutation =
  | { action: 'send'; agentId: string; message: string; mode: 'auto' | 'follow_up' }
  | { action: 'interrupt'; agentId: string }
  | { action: 'execute'; toolName: LuminariesToolName; input: unknown }
  | { action: 'set_capacity'; capacity: number }
  | { action: 'set_depth'; depth: number }
  | {
      action: 'approve_extension';
      specifier: string;
      scope: ManagedExtensionSource['scope'];
      install: boolean;
    }
  | { action: 'park_all'; mode: 'safe' | 'now' }
  | { action: 'detach_session'; agentId: string }
  | {
      action: 'adopt_session';
      sessionFile: string;
      options: { name?: string; assignment?: string; expertise?: string[] };
    }
  | { action: 'archive'; agentId: string; archived: boolean }
  | { action: 'resume'; agentId: string };

interface AttachmentReceipt {
  v: 1;
  operationId: string;
  fingerprint: string;
  status: 'executing' | 'complete';
  response?: { ok: true; value?: unknown };
}

function actionFailure(action: AttachmentAction, failure: 'response was lost' | 'response was incomplete'): string {
  return `Attachment ${failure}; operation ${action.operationId} may already be durable. Retry the unchanged action from this terminal so its operation identity is reused.`;
}

class AttachmentOutcomeUncertainError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

class ConversationGapError extends Error {}
export class AttachmentTargetError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

interface AttachmentClientStream {
  response: ServerResponse;
  blocked: boolean;
  pending?: string;
}

interface AttachmentConversationStream extends AttachmentClientStream {
  agentId: string;
  needsReset: boolean;
}

interface AttachmentConversationGroup {
  clients: Set<AttachmentConversationStream>;
  unsubscribe: () => void;
}

/** Root-lifetime view/control endpoint on the existing authenticated loopback server. */
export class LuminariesAttachmentServer {
  private readonly host: LuminariesCommandCenterHost;
  private readonly bridge: PeerBridgeServer;
  private readonly descriptorPath: string;
  private readonly rootId: string;
  private readonly epoch: string;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly sessionLabel: string;
  private readonly resolveTarget: (reference: string) => Promise<AttachmentTarget>;
  private readonly token = randomBytes(32).toString('base64url');
  private readonly clients = new Set<AttachmentClientStream>();
  private readonly conversationGroups = new Map<string, AttachmentConversationGroup>();
  private directoryUnsubscribe?: () => void;
  private started = false;

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
  }) {
    this.host = options.host;
    this.bridge = options.bridge;
    this.descriptorPath = resolve(options.descriptorPath);
    this.rootId = options.rootId;
    this.epoch = options.epoch;
    this.cwd = resolve(options.cwd);
    this.sessionId = options.sessionId;
    this.sessionLabel = options.sessionLabel;
    this.resolveTarget = options.resolveTarget;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const url = new URL(ATTACHMENT_PATH, this.bridge.url).toString();
    const descriptor: AttachmentDescriptor = {
      v: 1,
      rootId: this.rootId,
      label: LUMINARIES_IDENTITY.label,
      cwd: this.cwd,
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      url,
      token: this.token,
      pid: process.pid,
      hostname: hostname(),
    };
    try {
      this.bridge.setAttachmentHandler(
        (request, response) => this.handle(request, response),
        (request) => isAttachmentObserver(request),
      );
      await atomicReplacePrivateFile(this.descriptorPath, `${JSON.stringify(descriptor)}\n`, {
        maxBytes: MAX_DESCRIPTOR_BYTES,
      });
      this.started = true;
    } catch (error) {
      this.bridge.setAttachmentHandler(undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.bridge.setAttachmentHandler(undefined);
    for (const client of [...this.clients]) this.disconnectDirectory(client);
    for (const group of [...this.conversationGroups.values()])
      for (const client of [...group.clients]) this.disconnectConversation(client);
    await rm(this.descriptorPath, { force: true });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const conversationPath = `${ATTACHMENT_PATH}/conversation`;
    if (
      url.pathname !== ATTACHMENT_PATH &&
      url.pathname !== conversationPath &&
      url.pathname !== ATTACHMENT_TARGET_PATH &&
      url.pathname !== ATTACHMENT_HISTORY_PATH &&
      url.pathname !== ATTACHMENT_SESSIONS_PATH &&
      url.pathname !== ATTACHMENT_ACK_PATH
    )
      return false;
    if (bearer(request.headers.authorization) !== this.token) {
      this.reply(response, 401, { ok: false, message: 'Attachment credential is invalid' });
      return true;
    }
    if (request.method === 'GET' && url.pathname === ATTACHMENT_PATH && !url.search) {
      this.attachDirectory(response);
      return true;
    }
    if (request.method === 'GET' && url.pathname === ATTACHMENT_TARGET_PATH) {
      const keys = [...url.searchParams.keys()];
      const reference = url.searchParams.get('reference');
      if (keys.length !== 1 || keys[0] !== 'reference' || !reference) {
        this.reply(response, 404, { ok: false, message: 'Collaborator target is missing or malformed' });
        return true;
      }
      try {
        this.reply(response, 200, { ok: true, value: await this.resolveTarget(reference) });
      } catch (error) {
        this.reply(response, 404, {
          ok: false,
          ...(error instanceof SchedulerStateError ? { code: error.code } : {}),
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      }
      return true;
    }
    if (request.method === 'GET' && url.pathname === ATTACHMENT_HISTORY_PATH && !url.search) {
      this.reply(response, 200, { ok: true, value: await this.host.operatorClosedHistory() });
      return true;
    }
    if (request.method === 'GET' && url.pathname === ATTACHMENT_SESSIONS_PATH) {
      const keys = [...url.searchParams.keys()];
      const reference = url.searchParams.get('reference');
      if (!url.search) this.reply(response, 200, { ok: true, value: await this.host.operatorSessions() });
      else if (keys.length === 1 && keys[0] === 'reference' && reference) {
        try {
          this.reply(response, 200, { ok: true, value: await this.host.operatorInspectSessionReference(reference) });
        } catch (error) {
          this.reply(response, 404, {
            ok: false,
            ...(error instanceof SchedulerStateError ? { code: error.code } : {}),
            message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          });
        }
      } else this.reply(response, 404, { ok: false, message: 'Pi session reference is missing or malformed' });
      return true;
    }
    if (request.method === 'GET' && url.pathname === conversationPath) {
      const keys = [...url.searchParams.keys()];
      const agentId = url.searchParams.get('agentId');
      let resolved: string | undefined;
      try {
        resolved = agentId ? (await this.resolveTarget(agentId)).agentId : undefined;
      } catch {
        resolved = undefined;
      }
      if (keys.length !== 1 || keys[0] !== 'agentId' || !agentId || resolved !== agentId) {
        this.reply(response, 404, { ok: false, message: 'Attachment conversation is unavailable' });
        return true;
      }
      this.attachConversation(agentId, response);
      return true;
    }
    if (request.method === 'POST' && url.pathname === ATTACHMENT_ACK_PATH && !url.search) {
      try {
        const operationId = parseAcknowledgement(await readBody(request));
        await rm(this.receiptPath(operationId), { force: true });
        this.reply(response, 200, { ok: true });
      } catch (error) {
        this.reply(response, 400, {
          ok: false,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      }
      return true;
    }
    if (request.method !== 'POST' || url.pathname !== ATTACHMENT_PATH || url.search) {
      this.reply(response, 405, { ok: false, message: 'Attachment method is not supported' });
      return true;
    }
    try {
      const action = parseAction(await readBody(request));
      const fingerprint = sha256(JSON.stringify(action));
      const retained = await this.readReceipt(action.operationId);
      if (retained) {
        if (retained.fingerprint !== fingerprint)
          throw new Error(`Attachment operation '${action.operationId}' was reused for a different action`);
        if (retained.status === 'complete' && retained.response) {
          this.reply(response, 200, retained.response);
          return true;
        }
        if (
          action.action !== 'detach_session' &&
          action.action !== 'adopt_session' &&
          action.action !== 'approve_extension'
        ) {
          this.reply(response, 409, {
            ok: false,
            uncertain: true,
            message: actionFailure(action, 'response was lost'),
          });
          return true;
        }
      }
      if (!retained)
        await this.writeReceipt({ v: 1, operationId: action.operationId, fingerprint, status: 'executing' });
      let value: unknown;
      try {
        value = await this.execute(action);
      } catch (error) {
        await rm(this.receiptPath(action.operationId), { force: true });
        throw error;
      }
      const responseValue = { ok: true as const, ...(value === undefined ? {} : { value }) };
      try {
        await this.writeReceipt({
          v: 1,
          operationId: action.operationId,
          fingerprint,
          status: 'complete',
          response: responseValue,
        });
      } catch {
        this.reply(response, 409, {
          ok: false,
          uncertain: true,
          message: actionFailure(action, 'response was lost'),
        });
        return true;
      }
      this.reply(response, 200, responseValue);
    } catch (error) {
      this.reply(response, 400, {
        ok: false,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
    return true;
  }

  private attachDirectory(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const client: AttachmentClientStream = {
      response,
      blocked: false,
    };
    this.clients.add(client);
    if (this.clients.size === 1)
      this.directoryUnsubscribe = this.host.onCommandCenterChange((projection) => this.broadcastDirectory(projection));
    response.once('close', () => this.disconnectDirectory(client));
    this.writeDirectory(client, this.encodeDirectory(this.host.commandCenterProjection()));
  }

  private attachConversation(agentId: string, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const client: AttachmentConversationStream = { response, agentId, blocked: false, needsReset: false };
    let group = this.conversationGroups.get(agentId);
    const first = !group;
    if (!group) {
      group = { clients: new Set(), unsubscribe: () => undefined };
      this.conversationGroups.set(agentId, group);
    }
    group.clients.add(client);
    response.once('close', () => this.disconnectConversation(client));
    if (first)
      group.unsubscribe = this.host.onAgentConversationChange(agentId, (update) =>
        this.broadcastConversation(agentId, update),
      );
    else this.writeConversation(client, this.encodeStream(this.host.agentConversationSnapshot(agentId)));
  }

  private broadcastDirectory(projection: LuminariesCommandCenterProjection): void {
    if (!this.clients.size) return;
    const encoded = this.encodeDirectory(projection);
    for (const client of this.clients) this.writeDirectory(client, encoded);
  }

  private writeDirectory(client: AttachmentClientStream, encoded: string): void {
    if (client.response.destroyed || client.response.writableEnded) return this.disconnectDirectory(client);
    if (client.blocked) {
      client.pending = encoded;
      return;
    }
    if (client.response.write(encoded)) return;
    client.blocked = true;
    client.response.once('drain', () => {
      const pending = client.pending;
      client.pending = undefined;
      client.blocked = false;
      if (pending) this.writeDirectory(client, pending);
    });
  }

  private broadcastConversation(agentId: string, update: LuminariesConversationUpdate): void {
    const group = this.conversationGroups.get(agentId);
    if (!group?.clients.size) return;
    const encoded = this.encodeStream(update);
    for (const client of group.clients) this.writeConversation(client, encoded);
  }

  private writeConversation(client: AttachmentConversationStream, encoded: string): void {
    if (client.response.destroyed || client.response.writableEnded) return this.disconnectConversation(client);
    if (client.blocked) {
      client.needsReset = true;
      return;
    }
    if (client.response.write(encoded)) return;
    client.blocked = true;
    client.response.once('drain', () => {
      client.blocked = false;
      if (!client.needsReset) return;
      client.needsReset = false;
      let reset: LuminariesConversationReset;
      try {
        reset = this.host.agentConversationSnapshot(client.agentId);
      } catch {
        return this.disconnectConversation(client);
      }
      this.writeConversation(client, this.encodeStream(reset));
    });
  }

  private disconnectDirectory(client: AttachmentClientStream): void {
    if (!this.clients.delete(client)) return;
    if (!this.clients.size) {
      this.directoryUnsubscribe?.();
      this.directoryUnsubscribe = undefined;
    }
    if (!client.response.writableEnded) client.response.end();
  }

  private disconnectConversation(client: AttachmentConversationStream): void {
    const group = this.conversationGroups.get(client.agentId);
    if (!group || !group.clients.delete(client)) return;
    if (!group.clients.size) {
      group.unsubscribe();
      this.conversationGroups.delete(client.agentId);
    }
    if (!client.response.writableEnded) client.response.end();
  }

  private encodeDirectory(projection: LuminariesCommandCenterProjection): string {
    return this.encodeStream({
      type: 'directory_reset',
      epoch: this.epoch,
      revision: projection.revision,
      projection,
      models: this.host.operatorModels(),
      thinkingLevels: this.host.operatorThinkingLevels(),
      extensions: this.host.operatorSelectableExtensions(),
      extensionSources: this.host.operatorExtensionSources(),
    } satisfies AttachmentDirectoryReset);
  }

  private encodeStream(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
  }

  private receiptPath(operationId: string): string {
    return join(dirname(this.descriptorPath), ATTACHMENT_RECEIPT_DIRECTORY, `${operationId}.json`);
  }

  private async readReceipt(operationId: string): Promise<AttachmentReceipt | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.receiptPath(operationId), 'utf8'));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (
      !isRecord(value) ||
      value.v !== 1 ||
      value.operationId !== operationId ||
      typeof value.fingerprint !== 'string' ||
      (value.status !== 'executing' && value.status !== 'complete') ||
      (value.status === 'complete' && (!isRecord(value.response) || value.response.ok !== true)) ||
      (value.status === 'executing' && value.response !== undefined)
    )
      throw new Error(`Attachment operation receipt '${operationId}' is invalid`);
    return {
      v: 1,
      operationId,
      fingerprint: value.fingerprint,
      status: value.status,
      ...(isRecord(value.response)
        ? { response: { ok: true, ...('value' in value.response ? { value: value.response.value } : {}) } }
        : {}),
    };
  }

  private async writeReceipt(receipt: AttachmentReceipt): Promise<void> {
    const raw = `${JSON.stringify(receipt)}\n`;
    await atomicReplacePrivateFile(this.receiptPath(receipt.operationId), raw, { maxBytes: Buffer.byteLength(raw) });
  }

  private async execute(action: AttachmentAction): Promise<unknown> {
    if (action.action === 'send')
      return this.host.operatorInput(action.agentId, action.message, action.mode, action.operationId);
    if (action.action === 'interrupt') return this.host.operatorInterrupt(action.agentId, action.operationId);
    if (action.action === 'set_capacity') return this.host.operatorSetCapacity(action.capacity, action.operationId);
    if (action.action === 'set_depth') return this.host.operatorSetDepth(action.depth, action.operationId);
    if (action.action === 'approve_extension')
      return this.host.operatorApproveExtension(action.specifier, action.scope, action.install, action.operationId);
    if (action.action === 'park_all') return this.host.operatorParkAll(action.mode, action.operationId);
    if (action.action === 'detach_session') return this.host.operatorDetachSession(action.agentId, action.operationId);
    if (action.action === 'adopt_session')
      return this.host.operatorAdoptSession(action.sessionFile, action.options, action.operationId);
    if (action.action === 'archive')
      return this.host.operatorSetArchived(action.agentId, action.archived, action.operationId);
    if (action.action === 'resume') return this.host.operatorResume(action.agentId, action.operationId);
    return this.host.operatorExecute(action.toolName, action.input, action.operationId);
  }

  private reply(response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded) return;
    const body = `${JSON.stringify(value)}\n`;
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
  }
}

/** Disposable terminal client. It retains only the latest immutable projection. */
export class LuminariesAttachmentClient implements LuminariesCommandCenterHost {
  private readonly descriptorPath: string;
  private descriptor: AttachmentDescriptor;
  private readonly listeners = new Set<(projection: LuminariesCommandCenterProjection) => void>();
  private readonly abort = new AbortController();
  private readonly conversationControllers = new Set<AbortController>();
  private readonly conversationStreams = new Set<Promise<void>>();
  private readonly conversationSnapshots = new Map<string, LuminariesConversationReset>();
  private directoryEpoch?: string;
  private projection?: LuminariesCommandCenterProjection;
  private models: readonly ModelDescriptor[] = [];
  private thinkingLevels: readonly string[] = [];
  private extensions: readonly { specifier: string; source: string }[] = [];
  private extensionSources: readonly ManagedExtensionSource[] = [];
  private offlineReason?: string;
  private stream?: Promise<void>;
  private resolveReady: () => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;
  private readonly ready: Promise<void>;
  private readonly pendingMutations = new Map<string, string>();

  private constructor(descriptorPath: string, descriptor: AttachmentDescriptor) {
    this.descriptorPath = descriptorPath;
    this.descriptor = descriptor;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
  }

  static async connect(descriptorPath: string): Promise<LuminariesAttachmentClient> {
    let descriptor: AttachmentDescriptor;
    try {
      descriptor = await readDescriptor(descriptorPath);
    } catch (error) {
      throw new Error(
        `${LUMINARIES_IDENTITY.label} attachment details are unavailable or unreadable. Start or resume ${LUMINARIES_IDENTITY.label} and request a current attachment command.`,
        { cause: error },
      );
    }
    const client = new LuminariesAttachmentClient(descriptorPath, descriptor);
    client.stream = client.readStream();
    void client.stream.catch(() => undefined);
    const deadline = setTimeout(
      () =>
        client.rejectReady(
          new Error('Luminaries attachment owner did not publish its initial state before the deadline'),
        ),
      INITIAL_CONNECTION_TIMEOUT_MS,
    );
    deadline.unref?.();
    try {
      await client.ready;
    } catch (error) {
      await client.close();
      if (descriptor.hostname === hostname() && processAlive(descriptor.pid) === false)
        throw new Error(
          `${LUMINARIES_IDENTITY.label} owner is no longer running. Start or resume ${LUMINARIES_IDENTITY.label} and request a current attachment command.`,
          { cause: error },
        );
      throw new Error(
        `${LUMINARIES_IDENTITY.label} owner could not be reached or authenticated. Retry shortly; if it persists, return to the owning Pi session and request a current attachment command.`,
        { cause: error },
      );
    } finally {
      clearTimeout(deadline);
    }
    return client;
  }

  commandCenterProjection(): LuminariesCommandCenterProjection {
    if (!this.projection) throw new Error('Attachment projection is unavailable');
    return this.projection;
  }

  onCommandCenterChange(listener: (projection: LuminariesCommandCenterProjection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readOnlyReason(): string | undefined {
    return this.offlineReason;
  }

  onAgentConversationChange(agentId: string, listener: (update: LuminariesConversationUpdate) => void): () => void {
    const controller = new AbortController();
    this.conversationControllers.add(controller);
    let active = true;
    let stream: Promise<void>;
    stream = this.readConversation(agentId, listener, controller.signal)
      .catch((error) => {
        if (!active || this.abort.signal.aborted) return;
        const current = this.conversationSnapshots.get(agentId);
        const reset: LuminariesConversationReset = {
          type: 'reset',
          epoch: current?.epoch ?? this.directoryEpoch ?? 'attachment',
          agentId,
          incarnation: current?.incarnation ?? 0,
          revision: current?.revision ?? 0,
          hydrated: false,
          messages: current?.messages ?? [],
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        };
        this.conversationSnapshots.set(agentId, reset);
        listener(reset);
      })
      .finally(() => this.conversationStreams.delete(stream));
    this.conversationStreams.add(stream);
    return () => {
      if (!active) return;
      active = false;
      controller.abort();
      this.conversationControllers.delete(controller);
      this.conversationSnapshots.delete(agentId);
    };
  }

  agentConversationSnapshot(agentId: string): LuminariesConversationReset {
    const snapshot = this.conversationSnapshots.get(agentId);
    if (!snapshot) throw new Error(`Attachment conversation '${agentId}' is not selected`);
    return snapshot;
  }

  async operatorInput(
    agentId: string,
    message: string,
    mode: 'auto' | 'follow_up',
  ): Promise<'woken' | 'steered' | 'follow_up_queued'> {
    const value = await this.mutate({ action: 'send', agentId, message, mode });
    if (value !== 'woken' && value !== 'steered' && value !== 'follow_up_queued')
      throw new Error('Attachment returned an invalid message disposition');
    return value;
  }

  async operatorInterrupt(agentId: string): Promise<'interrupted' | 'already_finished'> {
    const value = await this.mutate({ action: 'interrupt', agentId });
    if (value !== 'interrupted' && value !== 'already_finished')
      throw new Error('Attachment returned an invalid interrupt disposition');
    return value;
  }

  async operatorExecute(toolName: LuminariesToolName, input: unknown): Promise<LuminariesToolResult> {
    const value = await this.mutate({ action: 'execute', toolName, input });
    return parseToolResult(value);
  }

  async operatorSetCapacity(capacity: number): Promise<void> {
    await this.mutate({ action: 'set_capacity', capacity });
  }
  async operatorSetDepth(depth: number): Promise<void> {
    await this.mutate({ action: 'set_depth', depth });
  }

  async operatorApproveExtension(
    specifier: string,
    scope: ManagedExtensionSource['scope'],
    install: boolean,
  ): Promise<void> {
    await this.mutate({ action: 'approve_extension', specifier, scope, install });
  }

  async operatorParkAll(mode: 'safe' | 'now'): Promise<void> {
    await this.mutate({ action: 'park_all', mode });
  }

  async operatorDetachSession(agentId: string): Promise<
    | {
        sourceAgentId: string;
        sourceLifecycle: 'closed';
        sessionId: string;
        sessionFile: string;
        sessionName: string;
        command: string;
      }
    | { status: 'not_ready'; message: string }
  > {
    const value = await this.mutate({ action: 'detach_session', agentId });
    if (!isSessionDetachResult(value) && !isSessionDetachNotReadyResult(value))
      throw new Error('Attachment returned an invalid detach result');
    return value;
  }

  async operatorAdoptSession(
    sessionFile: string,
    options: { name?: string; assignment?: string; expertise?: string[] } = {},
  ): Promise<{
    sourceSessionFile: string;
    agentId: string;
    handle: string;
    sessionId: string;
  }> {
    const value = await this.mutate({ action: 'adopt_session', sessionFile, options });
    if (!isSessionAdoptResult(value)) throw new Error('Attachment returned an invalid adopt result');
    return value;
  }

  async operatorSessions(): Promise<
    readonly {
      sessionFile: string;
      sessionId: string;
      cwd: string;
      name?: string;
      modifiedAtMs: number;
      messageCount: number;
      firstMessage: string;
    }[]
  > {
    const url = new URL(this.descriptor.url);
    url.pathname = ATTACHMENT_SESSIONS_PATH;
    const response = await fetch(url, {
      signal: this.abort.signal,
      redirect: 'manual',
      headers: { authorization: `Bearer ${this.descriptor.token}` },
    });
    if (isRedirect(response.status)) throw new Error('Attachment endpoint redirected; refusing the new destination');
    const result: unknown = JSON.parse(await response.text());
    if (!isRecord(result) || result.ok !== true || !Array.isArray(result.value))
      throw new Error('Attachment session response is invalid');
    const sessions = result.value.filter(isSessionChoice);
    if (sessions.length !== result.value.length) throw new Error('Attachment session response is invalid');
    return sessions;
  }

  async operatorInspectSessionReference(reference: string): Promise<{
    sessionFile: string;
    sessionId: string;
    cwd: string;
    name?: string;
  }> {
    const url = new URL(this.descriptor.url);
    url.pathname = ATTACHMENT_SESSIONS_PATH;
    url.search = new URLSearchParams({ reference }).toString();
    const response = await fetch(url, {
      signal: this.abort.signal,
      redirect: 'manual',
      headers: { authorization: `Bearer ${this.descriptor.token}` },
    });
    if (isRedirect(response.status)) throw new Error('Attachment endpoint redirected; refusing the new destination');
    const result: unknown = JSON.parse(await response.text());
    if (!isRecord(result) || result.ok !== true || !isRecord(result.value))
      throw new Error(
        isRecord(result) && typeof result.message === 'string' ? result.message : 'Pi session is unavailable',
      );
    const value = result.value;
    if (
      typeof value.sessionFile !== 'string' ||
      typeof value.sessionId !== 'string' ||
      typeof value.cwd !== 'string' ||
      (value.name !== undefined && typeof value.name !== 'string')
    )
      throw new Error('Attachment session preview is invalid');
    return {
      sessionFile: value.sessionFile,
      sessionId: value.sessionId,
      cwd: value.cwd,
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
    };
  }

  async operatorClosedHistory(): Promise<{
    revision: number;
    agents: readonly LuminariesCommandCenterAgent[];
    archivedCount: number;
  }> {
    const url = new URL(this.descriptor.url);
    url.pathname = ATTACHMENT_HISTORY_PATH;
    const response = await fetch(url, {
      signal: this.abort.signal,
      redirect: 'manual',
      headers: { authorization: `Bearer ${this.descriptor.token}` },
    });
    if (isRedirect(response.status)) throw new Error('Attachment endpoint redirected; refusing the new destination');
    const result: unknown = JSON.parse(await response.text());
    const archivedCount = isRecord(result) && isRecord(result.value) ? result.value.archivedCount : undefined;
    const revision = isRecord(result) && isRecord(result.value) ? result.value.revision : undefined;
    if (
      !isRecord(result) ||
      result.ok !== true ||
      !isRecord(result.value) ||
      !Array.isArray(result.value.agents) ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      typeof archivedCount !== 'number' ||
      !Number.isSafeInteger(archivedCount) ||
      archivedCount < 0
    )
      throw new Error('Attachment history response is invalid');
    const agents = result.value.agents.filter(
      (agent): agent is LuminariesCommandCenterAgent => isProjectedAgent(agent) && agent.lifecycle === 'closed',
    );
    if (agents.length !== result.value.agents.length) throw new Error('Attachment history response is invalid');
    if (archivedCount !== agents.filter((agent) => agent.archived).length)
      throw new Error('Attachment history response is invalid');
    return { revision, agents, archivedCount };
  }

  async operatorSetArchived(agentId: string, archived: boolean): Promise<void> {
    await this.mutate({ action: 'archive', agentId, archived });
  }

  async operatorResume(agentId: string): Promise<void> {
    await this.mutate({ action: 'resume', agentId });
  }

  attachmentInvocation(): string {
    return `pi --${LUMINARIES_IDENTITY.flags.attach}`;
  }

  operatorModels(): readonly ModelDescriptor[] {
    return this.models;
  }

  operatorThinkingLevels(): readonly string[] {
    return this.thinkingLevels;
  }

  operatorSelectableExtensions(): readonly { specifier: string; source: string }[] {
    return this.extensions;
  }

  operatorExtensionSources(): readonly ManagedExtensionSource[] {
    return this.extensionSources;
  }

  async resolveTarget(target: string): Promise<string> {
    return (await this.resolveTargetIdentity(target)).agentId;
  }

  async resolveTargetIdentity(target: string): Promise<{ agentId: string; handle: string }> {
    const value = target.trim();
    if (!value || value.includes('\r') || value.includes('\n'))
      throw new Error('Collaborator target is missing or malformed');
    const url = new URL(this.descriptor.url);
    url.pathname = ATTACHMENT_TARGET_PATH;
    url.search = new URLSearchParams({ reference: value }).toString();
    const response = await fetch(url, {
      signal: this.abort.signal,
      redirect: 'manual',
      headers: { authorization: `Bearer ${this.descriptor.token}` },
    });
    if (isRedirect(response.status)) throw new Error('Attachment endpoint redirected; refusing the new destination');
    const body = await response.text();
    const result: unknown = JSON.parse(body);
    if (!isRecord(result) || typeof result.ok !== 'boolean') throw new Error('Attachment target response is invalid');
    if (!result.ok)
      throw new AttachmentTargetError(
        typeof result.message === 'string' ? result.message : `Attachment target failed (${response.status})`,
        typeof result.code === 'string' ? result.code : undefined,
      );
    if (!response.ok || !isRecord(result.value)) throw new Error('Attachment target response is invalid');
    const resolvedTarget = result.value;
    const resolvedAgentId = resolvedTarget.agentId;
    if (typeof resolvedAgentId !== 'string') throw new Error('Attachment target response is invalid');
    const projection = resolvedTarget.projection;
    if (!isProjection(projection)) throw new Error('Attachment target response is invalid');
    const agent = projection.directory.find((candidate) => candidate.agentId === resolvedAgentId);
    if (!agent) throw new Error('Attachment target response is invalid');
    return { agentId: resolvedAgentId, handle: agent.handle };
  }

  async close(): Promise<void> {
    this.abort.abort();
    for (const controller of this.conversationControllers) controller.abort();
    this.conversationControllers.clear();
    await Promise.allSettled([...(this.stream ? [this.stream] : []), ...this.conversationStreams]);
    this.conversationStreams.clear();
    this.listeners.clear();
    this.conversationSnapshots.clear();
    this.pendingMutations.clear();
  }

  private async readStream(): Promise<void> {
    let retryDelayMs = ATTACHMENT_RETRY_MIN_MS;
    while (!this.abort.signal.aborted) {
      try {
        await this.readFrames(this.descriptor.url, this.abort.signal, (value) => {
          retryDelayMs = ATTACHMENT_RETRY_MIN_MS;
          this.applyDirectory(value);
        });
        if (!this.projection) throw new Error('Live Luminaries owner closed before publishing its attachment');
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!this.projection) this.rejectReady(failure);
        if (this.abort.signal.aborted) return;
      }
      if (this.abort.signal.aborted) return;
      if (this.projection) this.setOffline(OWNER_OFFLINE_MESSAGE);
      await this.refreshDescriptor().catch(() => undefined);
      await waitForAttachmentRetry(this.abort.signal, retryDelayMs);
      retryDelayMs = Math.min(ATTACHMENT_RETRY_MAX_MS, retryDelayMs * 2);
    }
  }

  private async refreshDescriptor(): Promise<void> {
    const descriptor = await readDescriptor(this.descriptorPath);
    if (descriptor.rootId !== this.descriptor.rootId || descriptor.cwd !== this.descriptor.cwd)
      throw new Error('Attachment descriptor changed to a different Luminaries project');
    this.descriptor = descriptor;
  }

  private applyDirectory(value: unknown): void {
    const reset = parseDirectoryReset(value);
    const becameOnline = this.offlineReason !== undefined;
    this.offlineReason = undefined;
    if (this.directoryEpoch === reset.epoch && this.projection && reset.revision <= this.projection.revision) {
      if (becameOnline) this.publishProjection();
      return;
    }
    this.directoryEpoch = reset.epoch;
    this.projection = reset.projection;
    this.models = reset.models;
    this.thinkingLevels = reset.thinkingLevels;
    this.extensions = reset.extensions;
    this.extensionSources = reset.extensionSources;
    this.resolveReady();
    this.publishProjection();
  }

  private async readConversation(
    agentId: string,
    listener: (update: LuminariesConversationUpdate) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let retriedGap = false;
    let retryDelayMs = ATTACHMENT_RETRY_MIN_MS;
    for (;;) {
      try {
        const url = new URL(this.descriptor.url);
        url.pathname = `${ATTACHMENT_PATH}/conversation`;
        url.search = new URLSearchParams({ agentId }).toString();
        await this.readFrames(url.toString(), signal, (value) => {
          retryDelayMs = ATTACHMENT_RETRY_MIN_MS;
          const update = parseConversationUpdate(value, agentId);
          const current = this.conversationSnapshots.get(agentId);
          if (update.type === 'reset') {
            if (current && current.epoch === update.epoch && update.revision < current.revision) return;
            this.conversationSnapshots.set(agentId, update);
            retriedGap = false;
            listener(update);
            return;
          }
          if (
            !current ||
            update.epoch !== current.epoch ||
            update.incarnation !== current.incarnation ||
            update.baseRevision !== current.revision ||
            update.start > current.messages.length ||
            update.deleteCount > current.messages.length - update.start
          )
            throw new ConversationGapError('Attachment conversation revision gap');
          const messages = [...current.messages];
          messages.splice(update.start, update.deleteCount, ...update.messages);
          this.conversationSnapshots.set(agentId, {
            type: 'reset',
            epoch: update.epoch,
            agentId,
            incarnation: update.incarnation,
            revision: update.revision,
            hydrated: true,
            messages,
          });
          listener(update);
        });
        await this.refreshDescriptor();
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof ConversationGapError && !retriedGap) {
          retriedGap = true;
          this.conversationSnapshots.delete(agentId);
          continue;
        }
        await this.refreshDescriptor().catch(() => undefined);
      }
      await waitForAttachmentRetry(signal, retryDelayMs);
      retryDelayMs = Math.min(ATTACHMENT_RETRY_MAX_MS, retryDelayMs * 2);
    }
  }

  private async readFrames(url: string, signal: AbortSignal, apply: (value: unknown) => void): Promise<void> {
    const response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { authorization: `Bearer ${this.descriptor.token}` },
    });
    if (isRedirect(response.status)) throw new Error('Attachment endpoint redirected; refusing the new destination');
    if (!response.ok || !response.body) throw new Error(`Attachment refused connection (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let complete = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          complete = true;
          break;
        }
        pending += decoder.decode(next.value, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line) apply(JSON.parse(line));
          newline = pending.indexOf('\n');
        }
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => undefined);
    }
    pending += decoder.decode();
    if (pending) throw new Error('Attachment owner ended with an incomplete frame');
  }

  private async mutate(mutation: AttachmentMutation): Promise<unknown> {
    if (this.offlineReason) throw new Error(this.offlineReason);
    const fingerprint = JSON.stringify(mutation);
    const pendingOperationId = this.pendingMutations.get(fingerprint);
    const operationId = pendingOperationId ?? randomUUID();
    this.pendingMutations.set(fingerprint, operationId);
    let action: AttachmentAction;
    if (mutation.action === 'send') action = { ...mutation, operationId };
    else if (mutation.action === 'interrupt') action = { ...mutation, operationId };
    else if (mutation.action === 'execute') action = { ...mutation, operationId };
    else if (mutation.action === 'park_all') action = { ...mutation, operationId };
    else action = { ...mutation, operationId };
    try {
      const value = await this.action(action);
      if (this.pendingMutations.get(fingerprint) === operationId) this.pendingMutations.delete(fingerprint);
      return value;
    } catch (error) {
      if (error instanceof AttachmentOutcomeUncertainError) {
        if (!this.pendingMutations.has(fingerprint)) this.pendingMutations.set(fingerprint, operationId);
      } else if (this.pendingMutations.get(fingerprint) === operationId) this.pendingMutations.delete(fingerprint);
      throw error;
    }
  }

  private async action(action: AttachmentAction): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.descriptor.url, {
        method: 'POST',
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(ATTACHMENT_ACTION_TIMEOUT_MS)]),
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.descriptor.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(action),
      });
    } catch (error) {
      throw new AttachmentOutcomeUncertainError(actionFailure(action, 'response was lost'), error);
    }
    let text: string;
    try {
      if (isRedirect(response.status)) throw new Error('Attachment endpoint redirected; refusing the new destination');
      text = await response.text();
    } catch (error) {
      throw new AttachmentOutcomeUncertainError(actionFailure(action, 'response was lost'), error);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new AttachmentOutcomeUncertainError(actionFailure(action, 'response was incomplete'), error);
    }
    if (!isRecord(value) || typeof value.ok !== 'boolean') {
      throw new AttachmentOutcomeUncertainError(
        actionFailure(action, 'response was incomplete'),
        new Error('Attachment returned an invalid response'),
      );
    }
    if (!response.ok && value.ok) {
      throw new AttachmentOutcomeUncertainError(
        actionFailure(action, 'response was incomplete'),
        new Error(`Attachment returned inconsistent status ${response.status}`),
      );
    }
    if (!value.ok && value.uncertain === true) {
      throw new AttachmentOutcomeUncertainError(
        typeof value.message === 'string' ? value.message : actionFailure(action, 'response was lost'),
        new Error('Attachment operation outcome is unresolved'),
      );
    }
    if (!value.ok) {
      throw new Error(
        typeof value.message === 'string' ? value.message : `Attachment action failed (${response.status})`,
      );
    }
    await this.acknowledge(action.operationId, this.abort.signal);
    return value.value;
  }

  private async acknowledge(operationId: string, signal: AbortSignal): Promise<void> {
    try {
      const url = new URL(this.descriptor.url);
      url.pathname = ATTACHMENT_ACK_PATH;
      const response = await fetch(url, {
        method: 'POST',
        signal,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.descriptor.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId }),
      });
      if (isRedirect(response.status)) return;
      const value: unknown = JSON.parse(await response.text());
      if (!response.ok || !isRecord(value) || value.ok !== true) return;
    } catch {
      // The mutation response already resolved the outcome; acknowledgement is best effort.
    }
  }

  private setOffline(reason: string): void {
    if (this.offlineReason === reason) return;
    this.offlineReason = reason;
    this.publishProjection();
  }

  private publishProjection(): void {
    if (!this.projection) return;
    for (const listener of this.listeners) listener(this.projection);
  }
}

async function waitForAttachmentRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  await new Promise<void>((resolveWait, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Attachment closed'));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new Error('Attachment closed'));
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWait();
    }, delayMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readDescriptor(input: string): Promise<AttachmentDescriptor> {
  if (!isAbsolute(input)) throw new Error('Attachment descriptor path must be absolute');
  const requestedPath = resolve(input);
  const info = await lstat(requestedPath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_DESCRIPTOR_BYTES)
    throw new Error('Attachment descriptor is invalid');
  const [parent, path] = await Promise.all([realpath(dirname(requestedPath)), realpath(requestedPath)]);
  if (dirname(path) !== parent) throw new Error('Attachment descriptor is invalid');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(value)) throw new Error('Attachment descriptor is invalid');
  if (
    value.v !== 1 ||
    typeof value.rootId !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.cwd !== 'string' ||
    !isAbsolute(value.cwd) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    typeof value.sessionLabel !== 'string' ||
    !value.sessionLabel ||
    typeof value.url !== 'string' ||
    typeof value.token !== 'string' ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.hostname !== 'string' ||
    !value.hostname ||
    value.token.length < 32 ||
    Object.keys(value).some(
      (key) =>
        !['v', 'rootId', 'label', 'cwd', 'sessionId', 'sessionLabel', 'url', 'token', 'pid', 'hostname'].includes(key),
    )
  )
    throw new Error('Attachment descriptor is invalid');
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== ATTACHMENT_PATH)
    throw new Error('Attachment endpoint is not private loopback');
  return {
    v: 1,
    rootId: value.rootId,
    label: value.label,
    cwd: resolve(value.cwd),
    sessionId: value.sessionId,
    sessionLabel: value.sessionLabel,
    url: url.toString(),
    token: value.token,
    pid: value.pid,
    hostname: value.hostname,
  };
}

export interface AttachmentCandidate {
  descriptorPath: string;
  descriptor: AttachmentDescriptor;
}

export async function discoverAttachmentDescriptors(agentDir: string, cwd: string): Promise<AttachmentCandidate[]> {
  const canonicalCwd = await canonicalAttachmentPath(cwd);
  const candidates: AttachmentCandidate[] = [];
  const roots = join(
    resolve(agentDir),
    LUMINARIES_IDENTITY.namespace.stateDirectory,
    LUMINARIES_IDENTITY.namespace.rootsDirectory,
  );
  let entries;
  try {
    entries = await readdir(roots, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const descriptorPath = join(roots, entry.name, LUMINARIES_IDENTITY.namespace.attachmentFile);
    let descriptor: AttachmentDescriptor;
    try {
      descriptor = await readDescriptor(descriptorPath);
    } catch {
      continue;
    }
    if ((await canonicalAttachmentPath(descriptor.cwd)) !== canonicalCwd) continue;
    if (descriptor.hostname === hostname() && processAlive(descriptor.pid) === false) continue;
    candidates.push({ descriptorPath, descriptor });
  }
  return candidates;
}

async function canonicalAttachmentPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return isRecord(value) && value.code === code;
}

function parseDirectoryReset(value: unknown): AttachmentDirectoryReset {
  if (
    !isRecord(value) ||
    value.type !== 'directory_reset' ||
    typeof value.epoch !== 'string' ||
    !value.epoch ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !isProjection(value.projection) ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.thinkingLevels) ||
    !Array.isArray(value.extensions) ||
    !Array.isArray(value.extensionSources)
  )
    throw new Error('Attachment projection is invalid');
  exactKeys(value, [
    'type',
    'epoch',
    'revision',
    'projection',
    'models',
    'thinkingLevels',
    'extensions',
    'extensionSources',
  ]);
  if (value.revision !== value.projection.revision) throw new Error('Attachment projection revision is inconsistent');
  const models = value.models.map((model) => {
    if (
      !isRecord(model) ||
      typeof model.provider !== 'string' ||
      typeof model.id !== 'string' ||
      typeof model.contextWindow !== 'number' ||
      !Number.isSafeInteger(model.contextWindow) ||
      model.contextWindow < 1 ||
      (model.thinkingLevel !== undefined && !THINKING_LEVELS.some((level) => level === model.thinkingLevel))
    )
      throw new Error('Attachment model catalog is invalid');
    const thinkingLevel = THINKING_LEVELS.find((level) => level === model.thinkingLevel);
    return {
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  });
  const thinkingLevels = value.thinkingLevels.map((level) => {
    if (typeof level !== 'string') throw new Error('Attachment thinking catalog is invalid');
    return level;
  });
  const extensions = value.extensions.map((extension) => {
    if (!isRecord(extension) || typeof extension.specifier !== 'string' || typeof extension.source !== 'string')
      throw new Error('Attachment extension catalog is invalid');
    return { specifier: extension.specifier, source: extension.source };
  });
  const extensionSources = value.extensionSources.map((extension) => {
    if (
      !isRecord(extension) ||
      typeof extension.specifier !== 'string' ||
      (extension.scope !== 'user' && extension.scope !== 'project')
    )
      throw new Error('Attachment extension source catalog is invalid');
    const scope: ManagedExtensionSource['scope'] = extension.scope;
    return { specifier: extension.specifier, scope };
  });
  return {
    type: 'directory_reset',
    epoch: value.epoch,
    revision: value.revision,
    projection: value.projection,
    models,
    thinkingLevels,
    extensions,
    extensionSources,
  };
}

function parseConversationUpdate(value: unknown, agentId: string): LuminariesConversationUpdate {
  if (
    !isRecord(value) ||
    (value.type !== 'reset' && value.type !== 'splice') ||
    typeof value.epoch !== 'string' ||
    !value.epoch ||
    value.agentId !== agentId ||
    typeof value.incarnation !== 'number' ||
    !Number.isSafeInteger(value.incarnation) ||
    value.incarnation < 0 ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.messages)
  )
    throw new Error('Attachment conversation update is invalid');
  const messages = value.messages.map((message) => {
    if (!isRecord(message) || typeof message.role !== 'string')
      throw new Error('Attachment conversation message is invalid');
    return { ...message, role: message.role };
  });
  if (value.type === 'reset') {
    exactKeys(value, ['type', 'epoch', 'agentId', 'incarnation', 'revision', 'hydrated', 'messages', 'error']);
    if (
      typeof value.hydrated !== 'boolean' ||
      (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 500))
    )
      throw new Error('Attachment conversation reset is invalid');
    return {
      type: 'reset',
      epoch: value.epoch,
      agentId,
      incarnation: value.incarnation,
      revision: value.revision,
      hydrated: value.hydrated,
      messages,
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    };
  }
  exactKeys(value, [
    'type',
    'epoch',
    'agentId',
    'incarnation',
    'revision',
    'baseRevision',
    'start',
    'deleteCount',
    'messages',
  ]);
  if (
    typeof value.baseRevision !== 'number' ||
    !Number.isSafeInteger(value.baseRevision) ||
    value.baseRevision < 0 ||
    value.revision <= value.baseRevision ||
    typeof value.start !== 'number' ||
    !Number.isSafeInteger(value.start) ||
    value.start < 0 ||
    typeof value.deleteCount !== 'number' ||
    !Number.isSafeInteger(value.deleteCount) ||
    value.deleteCount < 0
  )
    throw new Error('Attachment conversation splice is invalid');
  return {
    type: 'splice',
    epoch: value.epoch,
    agentId,
    incarnation: value.incarnation,
    revision: value.revision,
    baseRevision: value.baseRevision,
    start: value.start,
    deleteCount: value.deleteCount,
    messages,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isProjectedAgent(value: unknown): value is LuminariesCommandCenterAgent {
  if (!isRecord(value) || !isRecord(value.health)) return false;
  const health = value.health;
  const observations = health.observations;
  return (
    typeof value.agentId === 'string' &&
    (value.parentId === null || typeof value.parentId === 'string') &&
    Number.isSafeInteger(value.depth) &&
    (value.lifecycle === 'open' || value.lifecycle === 'closed') &&
    typeof value.archived === 'boolean' &&
    typeof value.name === 'string' &&
    typeof value.shortId === 'string' &&
    typeof value.handle === 'string' &&
    isStringArray(value.breadcrumb) &&
    (value.role === undefined || typeof value.role === 'string') &&
    (value.focus === undefined || typeof value.focus === 'string') &&
    (value.focusSource === undefined ||
      value.focusSource === 'spawn' ||
      value.focusSource === 'self' ||
      value.focusSource === 'owner' ||
      value.focusSource === 'operator') &&
    typeof value.assignment === 'string' &&
    typeof value.ownershipBoundary === 'string' &&
    isStringArray(value.expertise) &&
    isStringArray(value.artifacts) &&
    (value.state === 'idle' ||
      value.state === 'starting' ||
      value.state === 'running' ||
      value.state === 'waiting' ||
      value.state === 'runtime_parked' ||
      value.state === 'closed') &&
    (value.humanState === 'working' ||
      value.humanState === 'starting' ||
      value.humanState === 'waiting' ||
      value.humanState === 'idle' ||
      value.humanState === 'closed') &&
    typeof value.runtimeResident === 'boolean' &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.thinking === undefined || typeof value.thinking === 'string') &&
    isStringArray(value.selectedExtensions) &&
    isStringArray(value.alwaysExtensions) &&
    typeof value.extensionChangePending === 'boolean' &&
    typeof value.canSpawn === 'boolean' &&
    typeof value.canPeerInterrupt === 'boolean' &&
    Number.isSafeInteger(value.maxDepth) &&
    (value.contextMode === 'fresh' ||
      value.contextMode === 'recent' ||
      value.contextMode === 'fork' ||
      value.contextMode === 'custom') &&
    (value.dependency === undefined || typeof value.dependency === 'string') &&
    typeof value.canContinueWithMessage === 'boolean' &&
    typeof value.active === 'boolean' &&
    typeof value.attention === 'boolean' &&
    (health.level === 'ok' || health.level === 'warning' || health.level === 'critical') &&
    (health.attention === 'none' || health.attention === 'warning' || health.attention === 'critical') &&
    typeof health.summary === 'string' &&
    isStringArray(health.reasons) &&
    Array.isArray(observations) &&
    observations.every(
      (observation) =>
        isRecord(observation) &&
        typeof observation.code === 'string' &&
        (observation.level === 'warning' || observation.level === 'critical') &&
        typeof observation.message === 'string',
    ) &&
    typeof value.activity === 'string' &&
    isStringArray(value.interactions) &&
    typeof value.cwd === 'string' &&
    typeof value.treePrefix === 'string'
  );
}

function isProjection(value: unknown): value is LuminariesCommandCenterProjection {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.rootId !== 'string' ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.closedAgents) ||
    !Array.isArray(value.directory) ||
    typeof value.archivedCount !== 'number' ||
    !Number.isSafeInteger(value.archivedCount) ||
    value.archivedCount < 0 ||
    !Number.isSafeInteger(value.historyRevision) ||
    !isRecord(value.capacity) ||
    !isRecord(value.configuration) ||
    !isRecord(value.counts) ||
    !Array.isArray(value.ambient) ||
    typeof value.visible !== 'boolean'
  )
    return false;
  const capacity = value.capacity;
  const configuration = value.configuration;
  const counts = value.counts;
  if (
    typeof capacity.used !== 'number' ||
    !Number.isSafeInteger(capacity.used) ||
    capacity.used < 0 ||
    typeof capacity.limit !== 'number' ||
    !Number.isSafeInteger(capacity.limit) ||
    capacity.limit < 1 ||
    typeof capacity.available !== 'number' ||
    !Number.isSafeInteger(capacity.available) ||
    capacity.available < 0 ||
    !Number.isSafeInteger(configuration.maxOpenAgents) ||
    !Number.isSafeInteger(configuration.maxDepth) ||
    typeof configuration.namePoolSource !== 'string' ||
    !isRecord(configuration.sources) ||
    typeof configuration.sources.maxOpenAgents !== 'string' ||
    typeof configuration.sources.maxDepth !== 'string' ||
    typeof configuration.sources.serviceGrant !== 'string' ||
    !Array.isArray(configuration.agentExtensions) ||
    !configuration.agentExtensions.every(
      (extension) =>
        isRecord(extension) &&
        typeof extension.specifier === 'string' &&
        (extension.state === 'always' || extension.state === 'allow' || extension.state === 'deny') &&
        typeof extension.source === 'string',
    ) ||
    !isStringArray(configuration.serviceGrant) ||
    typeof counts.working !== 'number' ||
    !Number.isSafeInteger(counts.working) ||
    counts.working < 0 ||
    typeof counts.waiting !== 'number' ||
    !Number.isSafeInteger(counts.waiting) ||
    counts.waiting < 0 ||
    typeof counts.idle !== 'number' ||
    !Number.isSafeInteger(counts.idle) ||
    counts.idle < 0 ||
    typeof counts.attention !== 'number' ||
    !Number.isSafeInteger(counts.attention) ||
    counts.attention < 0
  )
    return false;
  if (![...value.agents, ...value.closedAgents, ...value.directory].every(isProjectedAgent)) return false;
  const directoryIds = new Set(value.directory.map((agent) => agent.agentId));
  const openIds = new Set(value.agents.map((agent) => agent.agentId));
  const closedIds = new Set(value.closedAgents.map((agent) => agent.agentId));
  const root = value.directory.find((agent) => agent.agentId === value.rootId);
  return (
    root?.lifecycle === 'open' &&
    root.parentId === null &&
    directoryIds.size === value.directory.length &&
    openIds.size === value.agents.length &&
    closedIds.size === value.closedAgents.length &&
    value.directory.length === value.agents.length + value.closedAgents.length &&
    value.agents.every((agent) => agent.lifecycle === 'open' && directoryIds.has(agent.agentId)) &&
    value.closedAgents.every((agent) => agent.lifecycle === 'closed' && directoryIds.has(agent.agentId)) &&
    value.directory.every((agent) =>
      agent.lifecycle === 'open' ? openIds.has(agent.agentId) : closedIds.has(agent.agentId),
    ) &&
    value.ambient.every(
      (row) =>
        isRecord(row) &&
        isProjectedAgent(row.agent) &&
        directoryIds.has(row.agent.agentId) &&
        typeof row.prefix === 'string' &&
        typeof row.name === 'string',
    )
  );
}

function parseAcknowledgement(value: unknown): string {
  if (!isRecord(value)) throw new Error('Attachment acknowledgement is invalid');
  exactKeys(value, ['operationId']);
  if (typeof value.operationId !== 'string' || !isUuid(value.operationId))
    throw new Error('Attachment acknowledgement is invalid');
  return value.operationId;
}

function parseAction(value: unknown): AttachmentAction {
  if (!isRecord(value) || typeof value.action !== 'string') throw new Error('Attachment action is invalid');
  if (value.action === 'interrupt') {
    exactKeys(value, ['action', 'operationId', 'agentId']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.agentId !== 'string' ||
      !value.agentId
    )
      throw new Error('Attachment interrupt is invalid');
    return { action: value.action, operationId: value.operationId, agentId: value.agentId };
  }
  if (value.action === 'send') {
    exactKeys(value, ['action', 'operationId', 'agentId', 'message', 'mode']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.agentId !== 'string' ||
      !value.agentId ||
      typeof value.message !== 'string' ||
      !value.message ||
      (value.mode !== 'auto' && value.mode !== 'follow_up')
    )
      throw new Error('Attachment message is invalid');
    return {
      action: value.action,
      operationId: value.operationId,
      agentId: value.agentId,
      message: value.message,
      mode: value.mode,
    };
  }
  if (value.action === 'set_capacity') {
    exactKeys(value, ['action', 'operationId', 'capacity']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.capacity !== 'number' ||
      !Number.isSafeInteger(value.capacity) ||
      value.capacity < 1
    )
      throw new Error('Attachment capacity is invalid');
    return { action: value.action, operationId: value.operationId, capacity: value.capacity };
  }
  if (value.action === 'set_depth') {
    exactKeys(value, ['action', 'operationId', 'depth']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.depth !== 'number' ||
      !Number.isSafeInteger(value.depth) ||
      value.depth < 1
    )
      throw new Error('Attachment nesting depth is invalid');
    return { action: value.action, operationId: value.operationId, depth: value.depth };
  }
  if (value.action === 'approve_extension') {
    exactKeys(value, ['action', 'operationId', 'specifier', 'scope', 'install']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.specifier !== 'string' ||
      !value.specifier ||
      (value.scope !== 'user' && value.scope !== 'project') ||
      typeof value.install !== 'boolean'
    )
      throw new Error('Attachment extension approval is invalid');
    return {
      action: value.action,
      operationId: value.operationId,
      specifier: value.specifier,
      scope: value.scope,
      install: value.install,
    };
  }
  if (value.action === 'park_all') {
    exactKeys(value, ['action', 'operationId', 'mode']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      (value.mode !== 'safe' && value.mode !== 'now')
    )
      throw new Error('Attachment park action is invalid');
    return { action: value.action, operationId: value.operationId, mode: value.mode };
  }
  if (value.action === 'detach_session') {
    exactKeys(value, ['action', 'operationId', 'agentId']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.agentId !== 'string' ||
      !value.agentId
    )
      throw new Error('Attachment detach action is invalid');
    return { action: value.action, operationId: value.operationId, agentId: value.agentId };
  }
  if (value.action === 'adopt_session') {
    exactKeys(value, ['action', 'operationId', 'sessionFile', 'options']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.sessionFile !== 'string' ||
      !value.sessionFile ||
      !isRecord(value.options)
    )
      throw new Error('Attachment adopt action is invalid');
    exactKeys(value.options, ['name', 'assignment', 'expertise']);
    if (
      (value.options.name !== undefined && typeof value.options.name !== 'string') ||
      (value.options.assignment !== undefined && typeof value.options.assignment !== 'string') ||
      (value.options.expertise !== undefined && !isStringArray(value.options.expertise))
    )
      throw new Error('Attachment adopt options are invalid');
    return {
      action: value.action,
      operationId: value.operationId,
      sessionFile: value.sessionFile,
      options: {
        ...(typeof value.options.name === 'string' ? { name: value.options.name } : {}),
        ...(typeof value.options.assignment === 'string' ? { assignment: value.options.assignment } : {}),
        ...(isStringArray(value.options.expertise) ? { expertise: value.options.expertise } : {}),
      },
    };
  }
  if (value.action === 'archive') {
    exactKeys(value, ['action', 'operationId', 'agentId', 'archived']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.agentId !== 'string' ||
      !value.agentId ||
      typeof value.archived !== 'boolean'
    )
      throw new Error('Attachment archive action is invalid');
    return {
      action: value.action,
      operationId: value.operationId,
      agentId: value.agentId,
      archived: value.archived,
    };
  }
  if (value.action === 'resume') {
    exactKeys(value, ['action', 'operationId', 'agentId']);
    if (
      typeof value.operationId !== 'string' ||
      !isUuid(value.operationId) ||
      typeof value.agentId !== 'string' ||
      !value.agentId
    )
      throw new Error('Attachment resume action is invalid');
    return { action: value.action, operationId: value.operationId, agentId: value.agentId };
  }
  if (value.action === 'execute') {
    exactKeys(value, ['action', 'operationId', 'toolName', 'input']);
    if (typeof value.operationId !== 'string' || !isUuid(value.operationId) || !isToolName(value.toolName))
      throw new Error('Attachment tool action is invalid');
    return { action: value.action, operationId: value.operationId, toolName: value.toolName, input: value.input };
  }
  throw new Error('Attachment action is invalid');
}

function isSessionDetachResult(value: unknown): value is {
  sourceAgentId: string;
  sourceLifecycle: 'closed';
  sessionId: string;
  sessionFile: string;
  sessionName: string;
  command: string;
} {
  return (
    isRecord(value) &&
    typeof value.sourceAgentId === 'string' &&
    value.sourceLifecycle === 'closed' &&
    typeof value.sessionId === 'string' &&
    typeof value.sessionFile === 'string' &&
    typeof value.sessionName === 'string' &&
    typeof value.command === 'string'
  );
}

function isSessionDetachNotReadyResult(value: unknown): value is { status: 'not_ready'; message: string } {
  return isRecord(value) && value.status === 'not_ready' && typeof value.message === 'string';
}

function isSessionAdoptResult(
  value: unknown,
): value is { sourceSessionFile: string; agentId: string; handle: string; sessionId: string } {
  return (
    isRecord(value) &&
    typeof value.sourceSessionFile === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.handle === 'string' &&
    typeof value.sessionId === 'string'
  );
}

function isSessionChoice(value: unknown): value is {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  name?: string;
  modifiedAtMs: number;
  messageCount: number;
  firstMessage: string;
} {
  return (
    isRecord(value) &&
    typeof value.sessionFile === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.cwd === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    typeof value.modifiedAtMs === 'number' &&
    Number.isFinite(value.modifiedAtMs) &&
    Number.isSafeInteger(value.messageCount) &&
    typeof value.firstMessage === 'string'
  );
}

function parseToolResult(value: unknown): LuminariesToolResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.content) ||
    value.content.length !== 1 ||
    !isRecord(value.content[0]) ||
    value.content[0].type !== 'text' ||
    typeof value.content[0].text !== 'string' ||
    !isRecord(value.details) ||
    (value.terminate !== undefined && typeof value.terminate !== 'boolean')
  )
    throw new Error('Attachment tool result is invalid');
  return {
    content: [{ type: 'text', text: value.content[0].text }],
    details: value.details,
    ...(value.terminate === true ? { terminate: true } : {}),
  };
}

function isToolName(value: unknown): value is LuminariesToolName {
  return typeof value === 'string' && LUMINARIES_IDENTITY.toolNames.some((name) => name === value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = new Set(expected);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error('Attachment action has unknown fields');
}

function bearer(value: string | undefined): string | undefined {
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function isAttachmentObserver(request: IncomingMessage): boolean {
  if (request.method !== 'GET') return false;
  try {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    return path === ATTACHMENT_PATH || path === `${ATTACHMENT_PATH}/conversation`;
  } catch {
    return false;
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
  }
  if (!chunks.length) throw new Error('Attachment action is empty');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
