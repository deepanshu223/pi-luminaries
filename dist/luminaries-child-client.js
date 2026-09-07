import { sendLuminariesToolCall } from "./peer-bridge.js";
import { SchedulerStateError } from "./scheduler-state.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
/** Authenticated child-side adapter for the manager-owned loopback tool gateway. */
export class LuminariesBridgeClient {
    credential;
    expectedSessionId;
    getSessionId;
    constructor(options) {
        this.credential = options.credential;
        this.expectedSessionId = options.expectedSessionId;
        this.getSessionId = options.getSessionId;
    }
    async execute(command, signal, toolCallId, parentContext) {
        if (this.getSessionId() !== this.expectedSessionId)
            throw new SchedulerStateError('session_stale', `Child Pi session does not match its admitted ${LUMINARIES_IDENTITY.label} identity`);
        if (!toolCallId)
            throw new SchedulerStateError('input_invalid', 'Managed child tool execution has no trusted Pi tool-call identity');
        const input = { ...command.input };
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
