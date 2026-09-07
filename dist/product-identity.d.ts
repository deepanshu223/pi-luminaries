export declare const LUMINARIES_IDENTITY: Readonly<{
    readonly settingsKey: "luminaries";
    readonly command: "luminaries";
    readonly flags: Readonly<{
        attach: "luminaries";
        luminary: "luminary";
    }>;
    readonly toolPrefix: "luminaries_";
    readonly tools: Readonly<{
        readonly spawn: "luminaries_spawn";
        readonly directory: "luminaries_directory";
        readonly message: "luminaries_message";
        readonly control: "luminaries_control";
        readonly await: "luminaries_await";
    }>;
    readonly toolNames: readonly ["luminaries_spawn", "luminaries_directory", "luminaries_message", "luminaries_control", "luminaries_await"];
    readonly childEnv: Readonly<{
        url: `${string}_BRIDGE_URL`;
        token: `${string}_BRIDGE_TOKEN`;
        agentId: `${string}_AGENT_ID`;
        rootId: `${string}_ROOT_ID`;
        sessionId: `${string}_SESSION_ID`;
        generation: `${string}_GENERATION`;
        buildId: `${string}_BUILD_ID`;
        parentId: `${string}_PARENT_ID`;
        path: `${string}_AGENT_PATH`;
        outbox: `${string}_OUTBOX_DIR`;
    }>;
    readonly namespace: Readonly<{
        stateDirectory: "luminaries";
        rootsDirectory: "roots";
        publicIdPrefix: "luminaries-";
        uiSlot: "luminaries";
        protocolMessageType: "luminaries_protocol_message";
        childInputCommand: "luminaries-input";
        attachmentFile: "attach.json";
    }>;
    readonly serviceSymbol: "pi-luminaries.waves-service.v1";
    readonly serviceRegistrationSymbol: "pi-luminaries.waves-registration";
    readonly serviceId: "waves";
    readonly serviceVersion: 1;
    readonly packageName: "pi-luminaries";
    readonly label: "Pi Luminaries";
}>;
export type LuminariesToolName = (typeof LUMINARIES_IDENTITY.toolNames)[number];
