import { type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ParentContextSnapshot } from './context-session.ts';
export declare function captureSpawnCallContext(options: {
    entries: readonly unknown[];
    messages?: readonly unknown[];
    mode?: 'recent' | 'fork';
    requestId: string;
    toolCallId?: string;
    sourceSessionFile?: string;
}): ParentContextSnapshot;
export declare function appendSpawnCallContext(messages: readonly unknown[], call: ParentContextSnapshot): readonly unknown[];
export declare class ParentContextTracker {
    current(sessionManager: ExtensionContext['sessionManager']): ParentContextSnapshot;
    snapshot(mode: 'recent' | 'fork', requestId: string, toolCallId: string | undefined, sessionManager: ExtensionContext['sessionManager']): ParentContextSnapshot;
    boundary(mode: 'recent' | 'fork', requestId: string, toolCallId: string | undefined, sessionManager: ExtensionContext['sessionManager']): ParentContextSnapshot;
    call(mode: 'recent' | 'fork', requestId: string, toolCallId: string | undefined, sessionManager: ExtensionContext['sessionManager']): ParentContextSnapshot;
}
