import { type AgentConfigurationChange, type AgentRecord, type SchedulerPrincipal, type SchedulerState } from './scheduler-state.ts';
import type { TreePolicyResult } from './tree-policy.ts';
export interface ConfigurationInput {
    changeId: string;
    targetId: string;
    kind: 'model' | 'thinking' | 'extensions';
    value?: string;
    provider?: string;
    thinking?: string;
    extensions?: readonly string[];
    extensionSources?: readonly string[];
}
export declare function validateOfflineConfigurationState(state: Readonly<SchedulerState>, raw: ConfigurationInput, principal: SchedulerPrincipal): {
    input: ConfigurationInput;
    agent: AgentRecord;
};
export declare function applyOfflineConfigurationState(state: SchedulerState, raw: ConfigurationInput, principal: SchedulerPrincipal): TreePolicyResult<AgentRecord>;
export declare function beginLiveConfigurationState(state: SchedulerState, raw: ConfigurationInput, principal: SchedulerPrincipal): TreePolicyResult<AgentConfigurationChange | undefined>;
export declare function finishLiveConfigurationState(state: SchedulerState, targetIdInput: string, changeIdInput: string, outcome: 'applied' | 'refused' | 'indeterminate'): TreePolicyResult<AgentRecord>;
