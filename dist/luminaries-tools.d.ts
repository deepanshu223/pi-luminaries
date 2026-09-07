import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type CapabilityRequest, type ThinkingLevel } from './capability-policy.ts';
import { type ContextMode, type SpawnConfigurationInput } from './spawn-configuration.ts';
import { type LuminariesToolName } from './product-identity.ts';
export type { LuminariesToolName } from './product-identity.ts';
declare const TOOL: Readonly<{
    readonly spawn: "luminaries_spawn";
    readonly directory: "luminaries_directory";
    readonly message: "luminaries_message";
    readonly control: "luminaries_control";
    readonly await: "luminaries_await";
}>;
export interface LuminariesToolResult {
    content: [{
        type: 'text';
        text: string;
    }];
    details: Record<string, unknown>;
    terminate?: boolean;
}
export interface LuminariesReceipt {
    message: string;
    details: Record<string, unknown>;
    terminate?: boolean;
}
export interface LuminariesToolHost {
    execute(command: LuminariesToolCommand, signal: AbortSignal | undefined, toolCallId?: string): Promise<LuminariesReceipt>;
}
export type LuminariesToolHostResolver = (context: ExtensionContext) => Promise<LuminariesToolHost> | LuminariesToolHost;
export interface LuminariesSpawnRequest extends SpawnConfigurationInput {
    requestId: string;
    name?: string;
    assignment: string;
    ownershipBoundary: string;
    expertCard?: {
        role?: string;
        focus?: string;
        expertise?: string[];
        publishedRefs?: string[];
    };
    context?: ContextMode;
    thinking?: ThinkingLevel;
}
export interface LuminariesDirectoryRequest {
    requestId: string;
    action: 'list' | 'inspect' | 'update';
    agentId?: string;
    patch?: Record<string, unknown>;
    includeClosed?: boolean;
    view?: 'summary' | 'card' | 'capabilities' | 'coordination' | 'diagnostics' | 'transcript';
    cursor?: string;
    limit?: number;
}
export interface LuminariesMessageRequest {
    requestId: string;
    action: 'send' | 'multicast' | 'request' | 'request_many' | 'reply' | 'cancel';
    recipientId?: string;
    recipientIds?: string[];
    message?: string;
    mode?: 'default' | 'follow_up' | 'notify_only';
    correlationId?: string;
    deadlineMs?: number;
}
export interface LuminariesControlRequest {
    requestId: string;
    action: 'steer' | 'follow_up' | 'interrupt' | 'close' | 'close_subtree' | 'resume' | 'set_model' | 'set_thinking' | 'set_extensions' | 'set_grants';
    agentId?: string;
    message?: string;
    model?: string;
    thinking?: ThinkingLevel;
    extensions?: string[];
    grants?: CapabilityRequest;
}
export interface LuminariesAwaitRequest {
    requestId: string;
    action: 'wait' | 'cancel';
    watchId?: string;
    requestIds?: string[];
    agentIds?: string[];
    eventKinds?: Array<'message' | 'request' | 'reply' | 'cancel' | 'resolution' | 'system'>;
    owned?: boolean;
}
export type LuminariesToolRequest = LuminariesSpawnRequest | LuminariesDirectoryRequest | LuminariesMessageRequest | LuminariesControlRequest | LuminariesAwaitRequest;
export type LuminariesToolCommand = {
    toolName: typeof TOOL.spawn;
    input: LuminariesSpawnRequest;
} | {
    toolName: typeof TOOL.directory;
    input: LuminariesDirectoryRequest;
} | {
    toolName: typeof TOOL.message;
    input: LuminariesMessageRequest;
} | {
    toolName: typeof TOOL.control;
    input: LuminariesControlRequest;
} | {
    toolName: typeof TOOL.await;
    input: LuminariesAwaitRequest;
};
interface JsonSchema {
    type: 'object';
    additionalProperties?: false;
    properties?: Record<string, unknown>;
    required?: readonly string[];
    minProperties?: number;
}
export interface LuminariesToolDefinition {
    name: LuminariesToolName;
    label: string;
    description: string;
    parameters: JsonSchema;
    executionMode: 'parallel';
    renderShell: 'self';
    execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: ExtensionContext): Promise<LuminariesToolResult>;
    renderCall(args: unknown, theme: LuminariesRenderTheme): LuminariesRenderComponent;
    renderResult(result: {
        content?: readonly unknown[];
        details?: unknown;
    }, options: {
        expanded: boolean;
        isPartial: boolean;
    }, theme: LuminariesRenderTheme, context: {
        args?: unknown;
        isError: boolean;
    }): LuminariesRenderComponent;
}
interface LuminariesRenderTheme {
    fg(color: string, text: string): string;
}
interface LuminariesRenderComponent {
    render(width: number): string[];
    invalidate(): void;
}
export declare function messageGroupReceipt(details: unknown): {
    summary: string;
    problems: string[];
};
/** Pi owns the shared expansion state; collapsing a delivery never changes its model input. */
export declare function renderLuminariesProtocolMessage(message: {
    content?: unknown;
    details?: unknown;
}, options: {
    expanded?: boolean;
    outputPad?: number;
}, theme: LuminariesRenderTheme): LuminariesRenderComponent;
export declare function createLuminariesTools(resolveHost: LuminariesToolHostResolver): readonly LuminariesToolDefinition[];
export declare function normalizeLuminariesToolCommand(name: LuminariesToolName, value: unknown, toolCallId: string): LuminariesToolCommand;
export declare function normalizePiToolCallId(toolCallId: string): string;
export declare function formatLuminariesToolResult(receipt: LuminariesReceipt): LuminariesToolResult;
