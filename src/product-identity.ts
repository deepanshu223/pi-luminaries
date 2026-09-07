const productKey = 'luminaries' as const;
const packageName = 'pi-luminaries' as const;
const label = 'Pi Luminaries' as const;
const toolPrefix = `${productKey}_` as const;
const environmentPrefix = productKey.toUpperCase();

const tools = Object.freeze({
  spawn: `${toolPrefix}spawn`,
  directory: `${toolPrefix}directory`,
  message: `${toolPrefix}message`,
  control: `${toolPrefix}control`,
  await: `${toolPrefix}await`,
} as const);
const toolNames = Object.freeze([tools.spawn, tools.directory, tools.message, tools.control, tools.await] as const);
const childEnv = Object.freeze({
  url: `${environmentPrefix}_BRIDGE_URL`,
  token: `${environmentPrefix}_BRIDGE_TOKEN`,
  agentId: `${environmentPrefix}_AGENT_ID`,
  rootId: `${environmentPrefix}_ROOT_ID`,
  sessionId: `${environmentPrefix}_SESSION_ID`,
  generation: `${environmentPrefix}_GENERATION`,
  buildId: `${environmentPrefix}_BUILD_ID`,
  parentId: `${environmentPrefix}_PARENT_ID`,
  path: `${environmentPrefix}_AGENT_PATH`,
  outbox: `${environmentPrefix}_OUTBOX_DIR`,
});
const namespace = Object.freeze({
  stateDirectory: productKey,
  rootsDirectory: 'roots',
  publicIdPrefix: `${productKey}-`,
  uiSlot: productKey,
  protocolMessageType: `${productKey}_protocol_message`,
  childInputCommand: `${productKey}-input`,
  attachmentFile: 'attach.json',
});
const flags = Object.freeze({
  attach: productKey,
  luminary: 'luminary',
});

export const LUMINARIES_IDENTITY = Object.freeze({
  settingsKey: productKey,
  command: productKey,
  flags,
  toolPrefix,
  tools,
  toolNames,
  childEnv,
  namespace,
  serviceSymbol: `${packageName}.waves-service.v1`,
  serviceRegistrationSymbol: `${packageName}.waves-registration`,
  serviceId: 'waves',
  serviceVersion: 1,
  packageName,
  label,
} as const);

export type LuminariesToolName = (typeof LUMINARIES_IDENTITY.toolNames)[number];
