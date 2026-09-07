export interface AgentIdentity {
    agentId: string;
    displayName: string;
}
/** Derive compact stable IDs without storing a second identity registry. */
export declare function deriveAgentShortIds(agentIds: readonly string[]): ReadonlyMap<string, string>;
export declare function deriveAgentHandles(agents: readonly AgentIdentity[]): ReadonlyMap<string, string>;
export declare function resolveAgentReference(agents: readonly AgentIdentity[], reference: string): string | undefined;
