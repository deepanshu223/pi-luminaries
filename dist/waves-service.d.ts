import type { LuminariesManager } from './luminaries-manager.ts';
import { type LuminariesDirectoryRequest, type LuminariesAwaitRequest, type LuminariesControlRequest, type LuminariesMessageRequest, type LuminariesSpawnRequest, type LuminariesToolResult } from './luminaries-tools.ts';
export declare const LUMINARIES_WAVES_SERVICE: unique symbol;
export declare const LUMINARIES_WAVES_SERVICE_VERSION: 1;
export interface LuminariesWavesEventV1 {
    version: 1;
    rootId: string;
    revision: number;
    openAgents: number;
    workingAgents: number;
    waitingAgents: number;
    attentionAgents: number;
}
type WavesInput<T extends {
    requestId: string;
}> = Omit<T, 'requestId'> & {
    requestId?: string;
};
export type LuminariesWavesSpawnV1 = WavesInput<LuminariesSpawnRequest>;
export type LuminariesWavesDirectoryV1 = WavesInput<LuminariesDirectoryRequest>;
export type LuminariesWavesMessageV1 = WavesInput<LuminariesMessageRequest>;
export type LuminariesWavesControlV1 = WavesInput<LuminariesControlRequest>;
export type LuminariesWavesWatchV1 = WavesInput<LuminariesAwaitRequest>;
export interface LuminariesWavesServiceV1 {
    readonly version: 1;
    readonly rootId: string;
    spawn(input: LuminariesWavesSpawnV1): Promise<LuminariesToolResult>;
    directory(input?: LuminariesWavesDirectoryV1): Promise<LuminariesToolResult>;
    message(input: LuminariesWavesMessageV1): Promise<LuminariesToolResult>;
    control(input: LuminariesWavesControlV1): Promise<LuminariesToolResult>;
    watch(input: LuminariesWavesWatchV1): Promise<LuminariesToolResult>;
    subscribe(listener: (event: LuminariesWavesEventV1) => void): () => void;
}
export declare function isLuminariesWavesService(value: unknown): value is LuminariesWavesServiceV1;
export declare function currentWavesService(): LuminariesWavesServiceV1 | undefined;
/**
 * Installs one process-local, session-scoped provider for the separate Waves extension.
 * The provider delegates to Luminaries's existing manager and never owns lifecycle or state.
 */
export declare function installWavesService(manager: LuminariesManager): () => void;
export {};
