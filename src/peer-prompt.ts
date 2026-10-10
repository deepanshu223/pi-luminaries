import { SchedulerStateError, type PeerEventRecord, type SchedulerState } from './scheduler-state.ts';
import { deriveAgentHandles } from './agent-identity.ts';
import { collapseWhitespace, preparePrivateDisplayPaths, sanitizePreparedDisplayText } from './display-sanitizer.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

const MAX_PEER_PRESENTATION_CHARS = 320;

function clipPresentation(value: string): string {
  const characters = [...value];
  return characters.length <= MAX_PEER_PRESENTATION_CHARS
    ? value
    : `${characters.slice(0, MAX_PEER_PRESENTATION_CHARS - 1).join('')}…`;
}

export function peerSource(event: Readonly<PeerEventRecord>, state: Readonly<SchedulerState>): string {
  if (event.origin === 'operator') return 'Luminaries';
  if (event.origin === 'service') return `${LUMINARIES_IDENTITY.label} service`;
  if (event.origin === 'scheduler' || event.origin === 'system') return `${LUMINARIES_IDENTITY.label} system`;
  return participantName(event.senderId, state);
}

function participantName(agentId: string, state: Readonly<SchedulerState>): string {
  if (agentId === state.root.rootId) return 'Root';
  const handles = deriveAgentHandles(
    Object.values(state.agents).map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.displayName.value,
    })),
  );
  return handles.get(agentId) ?? 'Collaborator';
}

export function systemEventSummary(event: Readonly<PeerEventRecord>, participant: string): string {
  switch (event.resolutionCode) {
    case 'request_timeout':
      return `Request to ${participant} timed out without a reply.`;
    case 'recipient_closed':
      return `${participant} closed before replying.`;
    case 'request_delivery_failed':
      return `Request to ${participant} could not be delivered.`;
    case 'request_dispatch_indeterminate':
      return `Request delivery to ${participant} could not be confirmed.`;
  }
  switch (event.systemType) {
    case 'background_completion':
      return `${participant} completed a turn.`;
    case 'watch_activity':
      return 'This wait has finished; new activity is available.';
    case 'health_attention':
      return 'An expert needs attention.';
    case 'control_failure':
      return event.message || 'An action could not be confirmed.';
    case 'permission_decision':
      return `An action by ${participant} was refused by its permissions.`;
    case 'request_timeout':
      return 'A request timed out without a reply.';
    case 'routine':
      return event.message || 'Runtime update.';
    default:
      return event.kind === 'cancel' ? 'A request was cancelled.' : 'Runtime update.';
  }
}

function eventText(event: Readonly<PeerEventRecord>): string {
  if (event.message) return event.message;
  return (
    [event.systemType, event.resolutionCode, event.kind]
      .filter((value) => value !== undefined)
      .map((value) => value.split('_').join(' '))
      .join(' · ') || 'system update'
  );
}

export function peerPresentationDetails(
  events: readonly PeerEventRecord[],
  state: Readonly<SchedulerState>,
): { content: string; lines: string[] } {
  const privatePaths = preparePrivateDisplayPaths(
    Object.values(state.agents).flatMap((agent) =>
      [agent.sessionFile, agent.sessionDir].filter((value): value is string => !!value),
    ),
  );
  const messages = events.map((event) => {
    const system = event.origin === 'scheduler' || event.origin === 'system';
    return {
      from: system ? 'Luminaries update' : peerSource(event, state),
      text: sanitizePreparedDisplayText(
        system ? systemEventSummary(event, participantName(event.senderId, state)) : eventText(event),
        privatePaths,
      ),
    };
  });
  return {
    lines: messages.map(({ from, text }) => clipPresentation(`${from} · ${collapseWhitespace(text).trim()}`)),
    content: messages.map(({ from, text }) => `From ${from}:\n${text}`).join('\n\n'),
  };
}

/** The exact envelope admitted to a Pi model boundary. */
export function formatPeerPrompt(events: readonly PeerEventRecord[], state: Readonly<SchedulerState>): string {
  if (!events.length) throw new SchedulerStateError('event_missing', 'A peer delivery batch cannot be empty');
  return events
    .map(
      (event) =>
        `From ${peerSource(event, state)}${event.requestId ? ` (correlationId ${event.requestId})` : ''}:\n${eventText(event)}`,
    )
    .join('\n\n');
}
