import { type PeerEventRecord, type SchedulerState } from './scheduler-state.ts';
export declare function peerSource(event: Readonly<PeerEventRecord>, state: Readonly<SchedulerState>): string;
export declare function systemEventSummary(event: Readonly<PeerEventRecord>, participant: string): string;
export declare function peerPresentationDetails(events: readonly PeerEventRecord[], state: Readonly<SchedulerState>): {
    content: string;
    lines: string[];
};
/** The exact envelope admitted to a Pi model boundary. */
export declare function formatPeerPrompt(events: readonly PeerEventRecord[], state: Readonly<SchedulerState>): string;
