import type { LuminariesDirectoryRequest } from './luminaries-tools.ts';
import type { PiSessionHost } from './pi-session-host.ts';
import { type ManagedExtensionPolicy } from './root-configuration.ts';
import { type SchedulerState } from './scheduler-state.ts';
export type DirectoryResponseFacts = {
    view: 'directory';
} | {
    view: 'summary';
} | {
    view: 'card';
} | {
    view: 'capabilities';
    extensions: ManagedExtensionPolicy;
} | {
    view: 'diagnostics';
    diagnostics: readonly {
        source: string;
        values: readonly string[];
    }[];
    privatePaths: readonly string[];
} | {
    view: 'transcript';
    history: Awaited<ReturnType<PiSessionHost['readContext']>>;
} | {
    view: 'coordination';
    privatePaths: readonly string[];
};
export declare function buildDirectoryResponse(options: {
    snapshot: Readonly<SchedulerState>;
    input: LuminariesDirectoryRequest;
    callerId?: string;
    targetId: string;
    facts: DirectoryResponseFacts;
}): {
    message: string;
    details: Record<string, unknown>;
};
