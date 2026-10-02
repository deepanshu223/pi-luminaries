import type { ContextMode, EffectiveSpawnConfiguration } from './spawn-configuration.ts';
export interface ParentContextSnapshot {
    messages: readonly unknown[];
    sourceSessionFile?: string;
    selectedToolCallId: string;
}
export interface ContextTransferReceipt {
    mode: ContextMode;
    requestedTokens?: number;
    effectiveTokens: number;
    estimatedTokens: number;
    transferredMessages: number;
    omittedMessages: number;
    targetContextWindow?: number;
    warning?: string;
}
export interface ContextLaunchPlan {
    receipt: ContextTransferReceipt;
    messages: readonly unknown[];
    parentSession?: string;
    noContextFiles: boolean;
    systemPrompt?: string;
}
export declare function planContextLaunch(configuration: EffectiveSpawnConfiguration, snapshot: ParentContextSnapshot | undefined, additionalOverheadTokens?: number): ContextLaunchPlan;
