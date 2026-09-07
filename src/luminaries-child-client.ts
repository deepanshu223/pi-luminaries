import { sendLuminariesToolCall, type PeerBridgeCredential } from './peer-bridge.ts';
import { SchedulerStateError } from './scheduler-state.ts';
import type { LuminariesReceipt, LuminariesToolCommand, LuminariesToolHost } from './luminaries-tools.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';
import type { ParentContextSnapshot } from './context-session.ts';

/** Authenticated child-side adapter for the manager-owned loopback tool gateway. */
export class LuminariesBridgeClient implements LuminariesToolHost {
  private readonly credential: PeerBridgeCredential;
  private readonly expectedSessionId: string;
  private readonly getSessionId: () => string | undefined;

  constructor(options: {
    credential: PeerBridgeCredential;
    expectedSessionId: string;
    getSessionId: () => string | undefined;
  }) {
    this.credential = options.credential;
    this.expectedSessionId = options.expectedSessionId;
    this.getSessionId = options.getSessionId;
  }

  async execute(
    command: LuminariesToolCommand,
    signal: AbortSignal | undefined,
    toolCallId?: string,
    parentContext?: ParentContextSnapshot,
  ): Promise<LuminariesReceipt> {
    if (this.getSessionId() !== this.expectedSessionId)
      throw new SchedulerStateError(
        'session_stale',
        `Child Pi session does not match its admitted ${LUMINARIES_IDENTITY.label} identity`,
      );
    if (!toolCallId)
      throw new SchedulerStateError(
        'input_invalid',
        'Managed child tool execution has no trusted Pi tool-call identity',
      );
    const input: Record<string, unknown> = { ...command.input };
    delete input.requestId;
    return sendLuminariesToolCall({
      url: this.credential.url,
      token: this.credential.token,
      toolCallId,
      toolName: command.toolName,
      input,
      ...(parentContext ? { parentContext } : {}),
      ...(signal ? { signal } : {}),
    });
  }
}
