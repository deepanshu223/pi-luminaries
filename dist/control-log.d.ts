import { type AgentRecord, type MailboxRecord, type SchedulerState } from './scheduler-state.ts';
type RequestRecord = SchedulerState['requests'][string];
export type ControlLogStateCollection = 'agents' | 'activations' | 'mailbox' | 'requests' | 'watches';
export interface ControlLogNoReplayRecord {
    record: MailboxRecord;
    request?: RequestRecord;
    recordHash: string;
}
export interface ControlLogImage {
    state: SchedulerState;
    closed: ReadonlyMap<string, AgentRecord>;
    noReplay: ReadonlyMap<string, ControlLogNoReplayRecord>;
}
export interface ControlLogStateChanges {
    root: boolean;
    records: Partial<Record<ControlLogStateCollection, ReadonlySet<string>>>;
}
export interface ControlLogCommit {
    state: SchedulerState;
    changes: ControlLogStateChanges;
    closedPuts?: readonly AgentRecord[];
    closedDeletes?: readonly string[];
    noReplayPuts?: ReadonlyMap<string, ControlLogNoReplayRecord>;
}
export interface ControlLogOpenOptions {
    statePath: string;
    bootstrap?: SchedulerState;
}
export declare class ControlLog {
    readonly statePath: string;
    readonly created: boolean;
    readonly deliveryPayloadDirectory: string;
    readonly warnings: readonly string[];
    private readonly lease;
    private readonly directory;
    private readonly snapshotPath;
    private imageValue;
    private journalPath;
    private journal;
    private syncedOffset;
    private snapshotBytes;
    private snapshotRevision;
    private checkpointTask?;
    private poisoned?;
    private closing;
    private readonly diagnosticsRing;
    private constructor();
    static open(options: ControlLogOpenOptions): Promise<ControlLog>;
    get diagnostics(): readonly string[];
    image(): ControlLogImage;
    commit(inputs: readonly ControlLogCommit[]): Promise<void>;
    materializeDeliveryPayload(eventIdInput: string, payloadHash: string): Promise<void>;
    removeDeliveryPayload(eventIdInput: string): Promise<void>;
    close(): Promise<boolean>;
    private rotateCheckpoint;
    private writeCheckpoint;
    private closePoisoned;
    private addDiagnostic;
}
export {};
