import type { LuminariesCommandCenterAgent, LuminariesHumanState } from './command-center-projection.ts';
export declare const LUMINARIES_MOTION: readonly ["✦", "✧", "✶", "✧"];
export type AgentCardTone = 'accent' | 'dim' | 'error' | 'muted';
export interface AgentCardField {
    label: 'Health' | 'Next' | 'Role' | 'Model' | 'Extensions' | 'Current action' | 'Assignment' | 'Scope of work' | 'Focus' | 'Dependency' | 'Recent activity' | 'Expertise' | 'Outputs' | 'Context' | 'Permissions' | 'Runtime';
    value: string;
}
export interface AgentCardModel {
    name: string;
    breadcrumb: string;
    state: string;
    tone: AgentCardTone;
    fields: readonly AgentCardField[];
}
export declare function hasRunningTurn(agent: LuminariesCommandCenterAgent): boolean;
export declare function hasMotionFrame(agent: LuminariesCommandCenterAgent): boolean;
export declare function motionGlyph(agent: LuminariesCommandCenterAgent, phase: number): string;
export declare function stateTone(state: LuminariesHumanState): AgentCardTone;
export declare function agentTone(agent: LuminariesCommandCenterAgent): AgentCardTone;
export declare function stateLabel(state: LuminariesHumanState): string;
export declare function availabilityLabel(agent: LuminariesCommandCenterAgent): string;
export declare function agentCard(agent: LuminariesCommandCenterAgent, complete?: boolean): AgentCardModel;
