import { type PeerBridgeCredential } from './peer-bridge.ts';
import type { LuminariesReceipt, LuminariesToolCommand, LuminariesToolHost } from './luminaries-tools.ts';
import type { ParentContextSnapshot } from './context-session.ts';
/** Authenticated child-side adapter for the manager-owned loopback tool gateway. */
export declare class LuminariesBridgeClient implements LuminariesToolHost {
    private readonly credential;
    private readonly expectedSessionId;
    private readonly getSessionId;
    constructor(options: {
        credential: PeerBridgeCredential;
        expectedSessionId: string;
        getSessionId: () => string | undefined;
    });
    execute(command: LuminariesToolCommand, signal: AbortSignal | undefined, toolCallId?: string, parentContext?: ParentContextSnapshot): Promise<LuminariesReceipt>;
}
