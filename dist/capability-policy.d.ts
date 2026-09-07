export declare const CAPABILITY_VERSION: 1;
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface CapabilityEnvelope {
    version: typeof CAPABILITY_VERSION;
    spawn: boolean;
    peerInterrupt: boolean;
    maxDepth: number;
    models?: string[];
    thinking?: ThinkingLevel[];
    tools?: string[];
    extensions?: string[];
    skills?: string[];
    promptTemplates?: string[];
    themes?: string[];
    cwdRoots?: string[];
}
export interface CapabilityRequest {
    spawn?: boolean;
    peerInterrupt?: boolean;
    maxDepth?: number;
    models?: string[];
    thinking?: ThinkingLevel[];
    tools?: string[];
    extensions?: string[];
    skills?: string[];
    promptTemplates?: string[];
    themes?: string[];
    cwdRoots?: string[];
}
export declare class CapabilityError extends Error {
    readonly code: 'capability_invalid' | 'capability_escalation';
    constructor(code: CapabilityError['code'], message: string);
}
export declare function normalizeCapabilityEnvelope(value: unknown): CapabilityEnvelope;
export declare function normalizeCapabilityRequest(value: unknown): CapabilityRequest;
export declare function defaultCapabilityEnvelope(cwd: string, maxDepth: number): CapabilityEnvelope;
export declare function sameCapabilityCwd(left: string, right: string): boolean;
export declare function narrowCapabilityEnvelope(parent: CapabilityEnvelope, request: CapabilityRequest | undefined, childDepth: number): CapabilityEnvelope;
export declare function capabilityAllows(envelope: CapabilityEnvelope, field: 'models' | 'thinking' | 'tools', value: string): boolean;
export declare function capabilityAllowsCwd(envelope: CapabilityEnvelope, cwd: string): boolean;
