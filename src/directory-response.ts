import { projectCompactAgentSummary, projectCompactDirectory, type CompactDirectoryAgent } from './agent-directory.ts';
import { projectTranscriptInspection } from './command-center-projection.ts';
import { sanitizePreparedDisplayText } from './display-sanitizer.ts';
import type { LuminariesDirectoryRequest } from './luminaries-tools.ts';
import type { PiSessionHost } from './pi-session-host.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import {
  buildBytePage,
  decodeProjectionCursor,
  PUBLIC_RESULT_BYTES,
  receiptWireBytes,
  type ProjectionCursorScope,
} from './public-pagination.ts';
import { selectedManagedExtensionSpecifiers, type ManagedExtensionPolicy } from './root-configuration.ts';
import {
  SchedulerStateError,
  directMailboxRecords,
  isRecord,
  isStrictAncestor,
  mailboxRecordSeq,
  openCollaboratorCount,
  peerMailboxRecords,
  requestSeq,
  requestStatus,
  sha256,
  TERMINAL_PEER_EVENT_STATUSES,
  watchSeq,
  type DirectControlRecord,
  type SchedulerState,
} from './scheduler-state.ts';

const PRODUCT = LUMINARIES_IDENTITY.label;
const MAX_RESULT_BYTES = PUBLIC_RESULT_BYTES;

export type DirectoryResponseFacts =
  | { view: 'directory' }
  | { view: 'summary' }
  | { view: 'card' }
  | { view: 'capabilities'; extensions: ManagedExtensionPolicy }
  | {
      view: 'diagnostics';
      diagnostics: readonly { source: string; values: readonly string[] }[];
      privatePaths: readonly string[];
    }
  | { view: 'transcript'; history: Awaited<ReturnType<PiSessionHost['readContext']>> }
  | { view: 'coordination'; privatePaths: readonly string[] };

function isTerminalControlStatus(status: DirectControlRecord['status']): boolean {
  return status === 'aborted' || status === 'refused' || status === 'failed' || status === 'indeterminate';
}
function truncateBytes(value: string, maximum: number): { value: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(value);
  if (originalBytes <= maximum) return { value, truncated: false, originalBytes };
  let result = value.slice(0, maximum);
  while (Buffer.byteLength(result) > maximum) result = result.slice(0, -1);
  return { value: result, truncated: true, originalBytes };
}
function splitTextByBytes(value: string, maximum: number): string[] {
  if (Buffer.byteLength(value) <= maximum) return [value];
  const chunks: string[] = [];
  let parts: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (parts.length && bytes + characterBytes > maximum) {
      chunks.push(parts.join(''));
      parts = [];
      bytes = 0;
    }
    parts.push(character);
    bytes += characterBytes;
  }
  if (parts.length) chunks.push(parts.join(''));
  return chunks;
}

export function buildDirectoryResponse(options: {
  snapshot: Readonly<SchedulerState>;
  input: LuminariesDirectoryRequest;
  callerId?: string;
  targetId: string;
  facts: DirectoryResponseFacts;
}): { message: string; details: Record<string, unknown> } {
  const { snapshot, input, callerId, targetId, facts } = options;
  const callerKey = callerId ?? 'operator';
  const selected = snapshot.agents[targetId];
  if (facts.view === 'directory') {
    const entries = projectCompactDirectory(snapshot, callerId, input.includeClosed === true);
    const resultMessage = `${PRODUCT} directory page ready.`;
    const scope: ProjectionCursorScope = {
      rootId: snapshot.root.rootId,
      callerId: callerKey,
      view: 'directory',
      filter: sha256(JSON.stringify({ includeClosed: input.includeClosed === true })),
      revision: 0,
    };
    const afterKey = decodeProjectionCursor(input.cursor, scope);
    const details = buildBytePage<CompactDirectoryAgent>({
      items: entries,
      afterKey,
      keyOf: (entry) => entry.path,
      requestedLimit: input.limit ?? Math.max(1, entries.length),
      scope,
      buildDetails: (items, nextCursor, remaining) => ({
        action: input.action,
        view: 'directory',
        capacity: {
          used: Math.min(openCollaboratorCount(snapshot), snapshot.root.maxOpenAgents),
          limit: snapshot.root.maxOpenAgents,
        },
        entries: items,
        page: {
          returned: items.length,
          remaining,
          ...(nextCursor ? { nextCursor } : {}),
        },
      }),
      measureDetails: (details) =>
        receiptWireBytes(input.requestId, resultMessage, {
          requestId: input.requestId,
          duplicate: false,
          ...details,
        }),
    });
    return { message: resultMessage, details };
  }
  if (!selected) throw new SchedulerStateError('agent_unavailable', `Collaborator '${targetId}' is unavailable`);
  const view = facts.view;
  if (facts.view === 'summary') {
    return {
      message: `${PRODUCT} summary for '${selected.agentId}' is ready.`,
      details: {
        action: input.action,
        view,
        agent: projectCompactAgentSummary(snapshot, selected, callerId),
      },
    };
  }
  if (facts.view === 'card') {
    const fields = [
      ...(selected.expertCard.role ? [{ key: 'role:0000000000', field: 'role', ...selected.expertCard.role }] : []),
      ...(selected.expertCard.focus ? [{ key: 'focus:0000000000', field: 'focus', ...selected.expertCard.focus }] : []),
      ...(selected.expertCard.expertise?.value ?? []).map((value, index) => ({
        key: `expertise:${String(index).padStart(10, '0')}`,
        field: 'expertise',
        value,
        source: selected.expertCard.expertise?.source,
        updatedAtMs: selected.expertCard.expertise?.updatedAtMs,
      })),
      ...(selected.expertCard.publishedRefs?.value ?? []).map((value, index) => ({
        key: `publishedRefs:${String(index).padStart(10, '0')}`,
        field: 'publishedRefs',
        value,
        source: selected.expertCard.publishedRefs?.source,
        updatedAtMs: selected.expertCard.publishedRefs?.updatedAtMs,
      })),
    ];
    const entries = fields.flatMap((entry) => {
      const chunks = splitTextByBytes(entry.value, Math.floor(MAX_RESULT_BYTES / 8));
      return chunks.map((value, part) => ({
        ...entry,
        key: `${entry.key}:${String(part).padStart(10, '0')}`,
        value,
        ...(chunks.length > 1 ? { part: part + 1, parts: chunks.length } : {}),
      }));
    });
    const resultMessage = `${PRODUCT} public card for '${selected.agentId}' is ready.`;
    const scope: ProjectionCursorScope = {
      rootId: snapshot.root.rootId,
      callerId: callerKey,
      view,
      filter: sha256(selected.agentId),
      revision: snapshot.revision,
    };
    const details = buildBytePage({
      items: entries,
      afterKey: decodeProjectionCursor(input.cursor, scope),
      keyOf: (entry) => entry.key,
      requestedLimit: input.limit ?? Math.max(1, entries.length),
      scope,
      buildDetails: (items, nextCursor, remaining) => ({
        action: input.action,
        view,
        agentId: selected.agentId,
        entries: items.map(({ key: _key, ...entry }) => entry),
        page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
      }),
      measureDetails: (details) =>
        receiptWireBytes(input.requestId, resultMessage, {
          requestId: input.requestId,
          duplicate: false,
          ...details,
        }),
    });
    return { message: resultMessage, details };
  }
  if (facts.view === 'capabilities') {
    const extensionPolicy = facts.extensions;
    const entries = (
      [
        ['capability', 'models', selected.capabilities.models],
        ['capability', 'thinking', selected.capabilities.thinking],
        ['capability', 'tools', selected.capabilities.tools],
        ['capability', 'extensions', selected.capabilities.extensions],
        ['capability', 'skills', selected.capabilities.skills],
        ['capability', 'promptTemplates', selected.capabilities.promptTemplates],
        ['capability', 'themes', selected.capabilities.themes],
        ['capability', 'cwdRoots', selected.capabilities.cwdRoots],
        ['launch', 'extensions', selected.launch.extensions],
        ['launch', 'skills', selected.launch.skills],
        ['launch', 'promptTemplates', selected.launch.promptTemplates],
        ['launch', 'themes', selected.launch.themes],
      ] as const
    ).flatMap(([section, field, values]) =>
      (values ?? []).map((value, index) => ({
        key: `${section}:${field}:${String(index).padStart(10, '0')}`,
        section,
        field,
        value,
      })),
    );
    const base = {
      action: input.action,
      view,
      agentId: selected.agentId,
      effective: {
        model: selected.provider ? `${selected.provider}/${selected.model ?? 'inherited'}` : selected.model,
        thinking: selected.thinking,
        context: selected.context,
      },
      capabilities: {
        spawn: selected.capabilities.spawn,
        peerInterrupt: selected.capabilities.peerInterrupt,
        maxDepth: selected.capabilities.maxDepth,
      },
      launch: {
        noContextFiles: selected.launch.noContextFiles,
        restrictSkills: selected.launch.restrictSkills,
        restrictPromptTemplates: selected.launch.restrictPromptTemplates,
        restrictThemes: selected.launch.restrictThemes,
      },
      extensions: {
        selected: selectedManagedExtensionSpecifiers(
          extensionPolicy,
          selected.launch.extensions,
          selected.launch.extensionSources,
        ),
        always: extensionPolicy.entries.filter((entry) => entry.state === 'always').map((entry) => entry.specifier),
        available: extensionPolicy.entries.filter((entry) => entry.state === 'allow').map((entry) => entry.specifier),
        pending: selected.pendingConfiguration?.kind === 'extensions',
      },
    };
    const resultMessage = `${PRODUCT} capabilities for '${selected.agentId}' are ready.`;
    const scope: ProjectionCursorScope = {
      rootId: snapshot.root.rootId,
      callerId: callerKey,
      view,
      filter: sha256(selected.agentId),
      revision: snapshot.revision,
    };
    const details = buildBytePage({
      items: entries,
      afterKey: decodeProjectionCursor(input.cursor, scope),
      keyOf: (entry) => entry.key,
      requestedLimit: input.limit ?? Math.max(1, entries.length),
      scope,
      buildDetails: (items, nextCursor, remaining) => ({
        ...base,
        entries: items.map((entry) => ({ section: entry.section, field: entry.field, value: entry.value })),
        page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
      }),
      measureDetails: (details) =>
        receiptWireBytes(input.requestId, resultMessage, {
          requestId: input.requestId,
          duplicate: false,
          ...details,
        }),
    });
    return { message: resultMessage, details };
  }
  const related = (agentId: string): boolean =>
    agentId === selected.agentId || isStrictAncestor(snapshot, selected.agentId, agentId);
  if (facts.view === 'diagnostics') {
    const records: Array<{ key: string; seq: number; value: Record<string, unknown> }> = [];
    for (const event of peerMailboxRecords(snapshot))
      if (related(event.senderId) || related(event.recipientId)) {
        const seq = mailboxRecordSeq(event);
        records.push({
          key: `${String(seq).padStart(16, '0')}:event:${event.eventId}`,
          seq,
          value: {
            kind: 'event_evidence',
            eventId: event.eventId,
            origin: event.origin,
            eventKind: event.kind,
            ...(event.systemType ? { systemType: event.systemType } : {}),
            senderId: event.senderId,
            recipientId: event.recipientId,
            traceId: event.traceId,
            status: event.status,
            ...(event.outcomeCode ? { outcomeCode: event.outcomeCode } : {}),
            acceptedSeq: event.acceptedSeq,
            durableSeq: seq,
          },
        });
      }
    for (const source of facts.diagnostics)
      source.values.forEach((message, index) => {
        const fingerprint = sha256(`${source.source}:${message}`).slice(0, 16);
        records.push({
          key: `${String(snapshot.revision).padStart(16, '0')}:diagnostic:${source.source}:${String(index).padStart(4, '0')}:${fingerprint}`,
          seq: snapshot.revision,
          value: {
            kind: 'runtime_diagnostic',
            source: source.source,
            fingerprint,
            message: truncateBytes(sanitizePreparedDisplayText(message, facts.privatePaths), 1_000).value,
          },
        });
      });
    records.sort((left, right) => left.key.localeCompare(right.key));
    const scope: ProjectionCursorScope = {
      rootId: snapshot.root.rootId,
      callerId: callerKey,
      view,
      filter: sha256(selected.agentId),
      revision: snapshot.revision,
    };
    const afterKey = decodeProjectionCursor(input.cursor, scope);
    const resultMessage = `${PRODUCT} diagnostics for '${selected.agentId}' are ready.`;
    const details = buildBytePage({
      items: records,
      afterKey,
      keyOf: (record) => record.key,
      requestedLimit: input.limit ?? 32,
      scope,
      buildDetails: (items, nextCursor, remaining) => ({
        action: input.action,
        view,
        agentId: selected.agentId,
        records: items.map((item) => item.value),
        page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
      }),
      measureDetails: (details) =>
        receiptWireBytes(input.requestId, resultMessage, {
          requestId: input.requestId,
          duplicate: false,
          ...details,
        }),
    });
    return { message: resultMessage, details };
  }
  if (facts.view === 'transcript') {
    const history = facts.history;
    const lastEntry = history.entries.at(-1);
    const contextId = isRecord(lastEntry) && typeof lastEntry.id === 'string' ? lastEntry.id : 'empty';
    const scope: ProjectionCursorScope = {
      rootId: snapshot.root.rootId,
      callerId: callerKey,
      view,
      filter: sha256(`${selected.agentId}:${selected.sessionId}:${contextId}`),
      revision: snapshot.revision,
    };
    const afterKey = decodeProjectionCursor(input.cursor, scope);
    const resultMessage = `${PRODUCT} transcript page for '${selected.agentId}' is ready.`;
    const rows = projectTranscriptInspection(history.messages, snapshot, selected.agentId).flatMap((row, index) => {
      const chunks = splitTextByBytes(row.text, Math.floor(MAX_RESULT_BYTES / 8));
      return chunks.map((text, part) => ({
        key: `${index}:${part}`,
        row: {
          ...row,
          text,
          ...(chunks.length > 1 ? { part: part + 1, parts: chunks.length } : {}),
        },
      }));
    });
    const details = buildBytePage({
      items: rows,
      ...(afterKey ? { afterKey } : {}),
      keyOf: (row) => row.key,
      requestedLimit: input.limit ?? 24,
      scope,
      buildDetails: (items, nextCursor, remaining) => ({
        action: input.action,
        view,
        agentId: selected.agentId,
        lifecycle: selected.lifecycle,
        transcript: items.map((item) => item.row),
        page: {
          returned: items.length,
          remaining,
          ...(nextCursor ? { nextCursor } : {}),
        },
      }),
      measureDetails: (details) =>
        receiptWireBytes(input.requestId, resultMessage, {
          requestId: input.requestId,
          duplicate: false,
          ...details,
        }),
    });
    return { message: resultMessage, details };
  }
  const records: Array<{ key: string; seq: number; value: Record<string, unknown> }> = [];
  for (const request of Object.values(snapshot.requests))
    if (related(request.requesterId) || related(request.recipientId)) {
      const status = requestStatus(snapshot, request);
      const seq = requestSeq(snapshot, request);
      records.push({
        key: `${String(seq).padStart(16, '0')}:request:${request.requestId}`,
        seq,
        value: {
          kind: 'request',
          lifecycle: status === 'pending' ? 'live' : 'terminal',
          requestId: request.requestId,
          requesterId: request.requesterId,
          recipientId: request.recipientId,
          status,
        },
      });
    }
  for (const event of peerMailboxRecords(snapshot))
    if (related(event.senderId) || related(event.recipientId))
      records.push({
        key: `${String(mailboxRecordSeq(event)).padStart(16, '0')}:event:${event.eventId}`,
        seq: mailboxRecordSeq(event),
        value: {
          kind: 'event',
          lifecycle: TERMINAL_PEER_EVENT_STATUSES.has(event.status) ? 'terminal' : 'live',
          senderId: event.senderId,
          recipientId: event.recipientId,
          status: event.status,
          ...(event.message === undefined
            ? {}
            : { message: truncateBytes(sanitizePreparedDisplayText(event.message, facts.privatePaths), 1_024).value }),
          outcomeCode: event.outcomeCode,
        },
      });
  for (const watch of Object.values(snapshot.watches))
    if (related(watch.ownerId)) {
      const seq = watchSeq(watch);
      records.push({
        key: `${String(seq).padStart(16, '0')}:watch:${watch.watchId}`,
        seq,
        value: {
          kind: 'watch',
          lifecycle: watch.status === 'active' ? 'live' : 'terminal',
          watchId: watch.watchId,
          ownerId: watch.ownerId,
          requestIds: watch.requestIds ?? [],
          agentIds: watch.agentIds ?? [],
          eventKinds: watch.eventKinds ?? [],
          status: watch.status,
        },
      });
    }
  for (const control of directMailboxRecords(snapshot))
    if (related(control.targetId)) {
      const seq = mailboxRecordSeq(control);
      records.push({
        key: `${String(seq).padStart(16, '0')}:control:${control.controlId}`,
        seq,
        value: {
          kind: 'control',
          lifecycle: isTerminalControlStatus(control.status) ? 'terminal' : 'live',
          targetId: control.targetId,
          action: control.action,
          status: control.status,
          outcomeCode: control.outcomeCode,
        },
      });
    }
  records.sort((left, right) => left.key.localeCompare(right.key));
  const scope: ProjectionCursorScope = {
    rootId: snapshot.root.rootId,
    callerId: callerKey,
    view,
    filter: sha256(selected.agentId),
    revision: snapshot.revision,
  };
  const afterKey = decodeProjectionCursor(input.cursor, scope);
  const resultMessage = `${PRODUCT} ${view} page for '${selected.agentId}' is ready.`;
  const details = buildBytePage({
    items: records,
    afterKey,
    keyOf: (record) => record.key,
    requestedLimit: input.limit ?? 24,
    scope,
    buildDetails: (items, nextCursor, remaining) => ({
      action: input.action,
      view,
      agentId: selected.agentId,
      records: items.map((item) => item.value),
      page: { returned: items.length, remaining, ...(nextCursor ? { nextCursor } : {}) },
    }),
    measureDetails: (details) =>
      receiptWireBytes(input.requestId, resultMessage, { requestId: input.requestId, duplicate: false, ...details }),
  });
  return { message: resultMessage, details };
}
