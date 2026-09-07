import { readdir, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultPackageManager, getAgentDir, SettingsManager, } from '@earendil-works/pi-coding-agent';
import { FileLeaseConflictError } from "./atomic-file.js";
import { loadAcceptedBuild } from "./accepted-build.js";
import { defaultCapabilityEnvelope, THINKING_LEVELS } from "./capability-policy.js";
import { isLuminariesId } from "./scheduler-state.js";
import { LuminariesCommandCenterController } from "./command-center.js";
import { LuminariesBridgeClient } from "./luminaries-child-client.js";
import { LuminariesManager, luminariesStatePathForSession } from "./luminaries-manager.js";
import { AttachmentTargetError, discoverAttachmentDescriptors, LuminariesAttachmentClient } from "./attachment.js";
import { installWavesService } from "./waves-service.js";
import { ParentContextTracker } from "./parent-context.js";
import { createPiSessionHost } from "./pi-session-host.js";
import { createLuminariesTools, renderLuminariesProtocolMessage, } from "./luminaries-tools.js";
import { sendLuminariesBuildIdentity } from "./peer-bridge.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { parseChildInput, readChildInputContent } from "./child-input.js";
import { sanitizeDisplayText } from "./display-sanitizer.js";
import { managedExtensionSpecifier, resolveRootConfiguration, } from "./root-configuration.js";
const luminariesProcess = process;
/** Production Pi extension boundary. Factory registration is intentionally resource-free. */
export default function luminariesExtension(pi, configurationHost) {
    const child = readChildBinding();
    let manager;
    let managerCreation;
    let managerStart;
    let childContextSessionId;
    let attachmentClient;
    let wavesCleanup;
    let parentTurn;
    let ownerContext;
    const parentContext = new ParentContextTracker();
    const rootConfigurationHost = configurationHost ?? piRootConfigurationHost();
    const sessionHost = createPiSessionHost();
    const luminariesToolDefinitions = new Map();
    const commandCenter = new LuminariesCommandCenterController(undefined, luminariesToolDefinitions);
    let acceptedBuild;
    const currentBuild = () => (acceptedBuild ??= loadAcceptedBuild());
    const childClient = child
        ? new LuminariesBridgeClient({
            credential: child.credential,
            expectedSessionId: child.expectedSessionId,
            getSessionId: () => childContextSessionId,
        })
        : undefined;
    const createManager = async (context) => {
        ownerContext = context;
        const agentDir = getAgentDir();
        const build = await currentBuild();
        const rootConfiguration = await resolveRootConfiguration({
            cwd: context.cwd,
            agentDir,
            projectTrusted: context.isProjectTrusted(),
            host: rootConfigurationHost,
        });
        const managedExtensionHost = piManagedExtensionHost(context.cwd, agentDir, context.isProjectTrusted(), rootConfiguration);
        return new LuminariesManager({
            sessionId: context.sessionManager.getSessionId(),
            sessionFile: context.sessionManager.getSessionFile(),
            cwd: context.cwd,
            agentDir,
            capabilities: rootCapabilities(context.cwd, rootConfiguration),
            rootConfiguration,
            managedExtensionHost,
            currentHostFacts: () => managerHostFacts(pi, ownerContext ?? context),
            setRootModel: async (provider, modelId) => {
                const host = ownerContext ?? context;
                const model = contextModels(host).find((candidate) => candidate.provider === provider && candidate.id === modelId);
                if (!model)
                    return false;
                const accepted = await pi.setModel(model);
                if (!accepted)
                    return false;
                const current = host.model;
                if (!current || current.provider !== provider || current.id !== modelId)
                    throw new Error('Owner Pi did not confirm the requested model');
                return true;
            },
            setRootThinking: async (level) => {
                const thinking = THINKING_LEVELS.find((candidate) => candidate === level);
                if (!thinking)
                    return false;
                pi.setThinkingLevel(thinking);
                return pi.getThinkingLevel() === thinking;
            },
            ...(build ? { acceptedBuild: build } : {}),
            sessionHost,
            parentContextSnapshot: (mode, requestId, toolCallId) => parentContext.snapshot(mode, requestId, toolCallId, context.sessionManager),
            operatorContextSnapshot: () => parentContext.current(context.sessionManager),
            childExtension: fileURLToPath(import.meta.url),
            rootTransport: parentTransport(pi, context),
        });
    };
    const startManager = (current) => current
        .start()
        .then(() => {
        if (manager === current && !wavesCleanup)
            wavesCleanup = installWavesService(current);
    })
        .catch(async (error) => {
        const attachmentInvocation = error instanceof FileLeaseConflictError ? current.attachmentInvocation() : undefined;
        if (manager === current) {
            manager = undefined;
            managerCreation = undefined;
            managerStart = undefined;
        }
        await current.close().catch(() => undefined);
        if (error instanceof FileLeaseConflictError &&
            error.ownerIsLiveOrIndeterminate &&
            error.owner &&
            (error.owner.hostname !== hostname() || error.owner.pid !== process.pid))
            throw new Error(`${LUMINARIES_IDENTITY.label} is already active for this saved Pi session in another Pi process. Run this exact command:\n${attachmentInvocation}\nOr retry after that owner closes. Other Pi sessions remain independent.`, { cause: error });
        if (error instanceof FileLeaseConflictError)
            throw new Error(`${LUMINARIES_IDENTITY.label} could not verify exclusive ownership for this saved Pi session. Retry shortly; do not remove private state or start another owner.`, { cause: error });
        throw error;
    });
    const ensureManager = async (extensionContext) => {
        ownerContext = extensionContext;
        if (!manager) {
            const creation = (managerCreation ??= createManager(extensionContext));
            try {
                const created = await creation;
                if (managerCreation !== creation) {
                    await created.close();
                    throw new Error(`${LUMINARIES_IDENTITY.label} manager creation was cancelled`);
                }
                manager = created;
            }
            catch (error) {
                if (managerCreation === creation)
                    managerCreation = undefined;
                throw error;
            }
        }
        const current = manager;
        if (!current)
            throw new Error(`${LUMINARIES_IDENTITY.label} manager creation did not produce a manager`);
        current.setParentTransport(parentTransport(pi, extensionContext));
        managerStart ??= startManager(current);
        await managerStart;
        if (manager !== current)
            throw new Error(`${LUMINARIES_IDENTITY.label} manager changed during startup`);
        if (parentTurn && parentTurn.preparedFor !== current) {
            await current.parentBeforeAgentStart(parentTurn.prompt);
            parentTurn.preparedFor = current;
        }
        if (parentTurn?.agentStarted && parentTurn.startedFor !== current) {
            await current.parentAgentStart();
            parentTurn.startedFor = current;
        }
        return current;
    };
    const resolveHost = async (context) => {
        const attached = attachmentClient;
        if (attached)
            return {
                execute: async (command) => {
                    const result = await attached.operatorExecute(command.toolName, command.input);
                    return {
                        message: result.content[0].text,
                        details: result.details,
                        ...(result.terminate ? { terminate: true } : {}),
                    };
                },
            };
        if (childClient) {
            childContextSessionId = context.sessionManager.getSessionId();
            return {
                execute: (command, signal, toolCallId) => {
                    const needsParentContext = command.toolName === LUMINARIES_IDENTITY.tools.spawn &&
                        (command.input.context === 'recent' || command.input.context === 'fork');
                    const snapshot = needsParentContext
                        ? command.input.context === 'fork'
                            ? parentContext.boundary('fork', command.input.requestId, toolCallId, context.sessionManager)
                            : parentContext.call('recent', command.input.requestId, toolCallId, context.sessionManager)
                        : undefined;
                    return childClient.execute(command, signal, toolCallId, snapshot);
                },
            };
        }
        const current = await ensureManager(context);
        commandCenter.attach(uiContext(context), current);
        return current.hostForParent(context);
    };
    for (const tool of createLuminariesTools(resolveHost)) {
        luminariesToolDefinitions.set(tool.name, tool);
        pi.registerTool(tool);
    }
    pi.registerMessageRenderer(LUMINARIES_IDENTITY.namespace.protocolMessageType, renderLuminariesProtocolMessage);
    pi.on('message_end', (event) => {
        parentContext.observe(event.message);
        if (manager)
            manager.parentMessageEnd(event.message);
    });
    pi.on('message_update', (event) => {
        parentContext.observe(event.message);
        if (manager)
            manager.parentMessageUpdate(event);
    });
    pi.on('tool_execution_start', (event) => {
        if (manager)
            manager.parentMessageUpdate(event);
    });
    pi.on('tool_execution_update', (event) => {
        if (manager)
            manager.parentMessageUpdate(event);
    });
    pi.on('tool_execution_end', (event) => {
        if (manager)
            manager.parentMessageUpdate(event);
    });
    pi.on('session_compact', (event) => {
        if (manager)
            manager.parentMessageUpdate(event);
    });
    if (childClient && child) {
        pi.registerCommand(LUMINARIES_IDENTITY.namespace.childInputCommand, {
            handler: async (args) => {
                const input = parseChildInput(args.trim());
                const content = await readChildInputContent(input, child.outbox);
                await pi.sendMessage({
                    customType: LUMINARIES_IDENTITY.namespace.protocolMessageType,
                    content: content.prompt,
                    display: true,
                    details: {
                        inputId: input.inputId,
                        source: input.source,
                        content: sanitizeDisplayText(content.presentationContent, [dirname(dirname(child.outbox))]),
                        ...(input.lines ? { lines: input.lines } : {}),
                        ...(input.presentation ? { presentation: input.presentation } : {}),
                    },
                }, input.delivery === 'steer'
                    ? { deliverAs: 'steer', triggerTurn: true }
                    : input.delivery === 'follow_up'
                        ? { deliverAs: 'followUp', triggerTurn: true }
                        : { triggerTurn: true });
            },
        });
        pi.on('session_start', async (_event, context) => {
            childContextSessionId = context.sessionManager.getSessionId();
            if (childContextSessionId !== child.expectedSessionId)
                throw new Error(`${LUMINARIES_IDENTITY.label} child session identity does not match its authenticated binding`);
            const build = await currentBuild();
            if (build?.id !== child.expectedBuildId)
                throw new Error(`${LUMINARIES_IDENTITY.label} child package build is not accepted`);
            if (build)
                await sendLuminariesBuildIdentity({
                    url: child.credential.url,
                    token: child.credential.token,
                    buildId: build.id,
                });
        });
        pi.on('session_shutdown', (event) => {
            if (event.reason === 'reload')
                luminariesProcess.__PI_AGENT_LUMINARIES_CHILD_RELOAD_BINDING__ = child;
        });
        return;
    }
    const refreshRootHostFacts = async (context) => {
        ownerContext = context;
        const current = manager;
        const starting = managerStart;
        if (!current || !starting)
            return;
        await starting;
        if (manager === current)
            await current.refreshRootHostFacts();
    };
    const openAttachment = async (context, target) => {
        const clients = new Set();
        try {
            const argv = process.argv.slice(2);
            const attachFlag = `--${LUMINARIES_IDENTITY.flags.attach}`;
            const luminaryFlag = `--${LUMINARIES_IDENTITY.flags.luminary}`;
            const attachRequested = argv.includes(attachFlag) || argv.some((argument) => argument.startsWith(`${attachFlag}=`));
            const luminaryRequested = argv.includes(luminaryFlag) || argv.some((argument) => argument.startsWith(`${luminaryFlag}=`));
            if (argv.some((argument) => argument.startsWith(`${attachFlag}=`)))
                throw new Error(`${attachFlag} does not take a value. Use ${luminaryFlag} <shortId> for one luminary.`);
            if (attachRequested && luminaryRequested)
                throw new Error(`Use either ${attachFlag} for the constellation or ${luminaryFlag} <shortId>, not both.`);
            if (luminaryRequested && (typeof target !== 'string' || !target.trim()))
                throw new Error(`${luminaryFlag} requires a short ID, unique name, exact Name · shortId handle, or full stable ID.`);
            const surface = uiContext(context, false);
            const ui = surface.ui;
            if (context.mode !== 'tui' || !ui?.custom)
                throw new Error(`${LUMINARIES_IDENTITY.label} attachment requires interactive TUI mode`);
            const candidates = await discoverAttachmentDescriptors(getAgentDir(), context.cwd);
            if (!candidates.length) {
                const message = `No live ${LUMINARIES_IDENTITY.label} root is published for this project directory`;
                if (!ui.select)
                    throw new Error(message);
                await ui.select(`${LUMINARIES_IDENTITY.label} attachment unavailable`, [message]);
                return;
            }
            let selected = candidates[0];
            if (target) {
                const targetValue = target.trim();
                const matches = [];
                const ambiguities = [];
                for (const candidate of candidates) {
                    const client = await LuminariesAttachmentClient.connect(candidate.descriptorPath);
                    clients.add(client);
                    try {
                        const resolved = await client.resolveTargetIdentity(targetValue);
                        matches.push({ client, agentId: resolved.agentId, handle: resolved.handle });
                    }
                    catch (error) {
                        await client.close();
                        clients.delete(client);
                        if (error instanceof AttachmentTargetError && error.code === 'agent_ambiguous')
                            ambiguities.push(error.message);
                    }
                }
                const normalizedTarget = targetValue.toLowerCase();
                const exactMatches = matches.filter((match) => match.agentId === targetValue || match.handle.toLowerCase() === normalizedTarget);
                if (exactMatches.length === 1) {
                    const exact = exactMatches[0];
                    if (!exact)
                        throw new Error(`Luminary '${targetValue}' is not available in this project`);
                    attachmentClient = exact.client;
                    commandCenter.attach(surface, exact.client);
                    await commandCenter.open(surface, exact.agentId);
                    return;
                }
                if (ambiguities.length || matches.length > 1) {
                    const handles = [...matches.map((match) => match.handle), ...ambiguities]
                        .filter((value, index, all) => all.indexOf(value) === index)
                        .join('; ');
                    throw new Error(`Luminary '${targetValue}' is ambiguous. Use an exact handle or stable ID: ${handles}`);
                }
                const match = matches[0];
                if (!match)
                    throw new Error(`Luminary '${targetValue}' is not available in this project`);
                attachmentClient = match.client;
                commandCenter.attach(surface, match.client);
                await commandCenter.open(surface, match.agentId);
                return;
            }
            if (candidates.length > 1) {
                if (!ui.select)
                    throw new Error(`${LUMINARIES_IDENTITY.label} has multiple roots for this project`);
                const choices = candidates.map((candidate) => `${candidate.descriptor.sessionLabel} · ${candidate.descriptor.rootId.slice(-6)}`);
                const choice = await ui.select(`${LUMINARIES_IDENTITY.label} roots`, choices);
                const index = choice ? choices.indexOf(choice) : -1;
                if (index < 0)
                    return;
                selected = candidates[index];
            }
            const client = await LuminariesAttachmentClient.connect(selected.descriptorPath);
            clients.add(client);
            attachmentClient = client;
            commandCenter.attach(surface, client);
            await commandCenter.open(surface);
        }
        finally {
            await Promise.allSettled([...clients].map((client) => client.close()));
            if (attachmentClient && clients.has(attachmentClient))
                attachmentClient = undefined;
            try {
                context.shutdown();
            }
            catch {
                // Preserve the attachment error or refusal that caused this cleanup.
            }
        }
    };
    const openCommandCenter = async (context) => {
        if (attachmentClient) {
            const surface = uiContext(context, false);
            commandCenter.attach(surface, attachmentClient);
            await commandCenter.open(surface);
            return;
        }
        const current = await ensureManager(context);
        await current.refreshRootHostFacts();
        const surface = uiContext(context);
        commandCenter.attach(surface, current);
        await commandCenter.open(surface);
    };
    pi.registerFlag(LUMINARIES_IDENTITY.flags.attach, {
        type: 'boolean',
        description: `Open the ${LUMINARIES_IDENTITY.label} command center for this project`,
    });
    pi.registerFlag(LUMINARIES_IDENTITY.flags.luminary, {
        type: 'string',
        description: `Open one luminary by short ID, unique name, exact handle, or stable ID`,
    });
    pi.registerCommand(LUMINARIES_IDENTITY.command, {
        description: `Open the ${LUMINARIES_IDENTITY.label} command center`,
        handler: async (_args, context) => openCommandCenter(context),
    });
    // Ctrl+Shift+L collapses to Pi's Ctrl+L model-selector key in ordinary terminals.
    pi.registerShortcut('alt+l', {
        description: `Open the ${LUMINARIES_IDENTITY.label} command center`,
        handler: async (context) => openCommandCenter(context),
    });
    pi.on('session_start', async (_event, context) => {
        const attach = pi.getFlag(LUMINARIES_IDENTITY.flags.attach) === true;
        const target = pi.getFlag(LUMINARIES_IDENTITY.flags.luminary);
        const argv = process.argv.slice(2);
        const luminaryRequested = argv.some((argument) => argument === `--${LUMINARIES_IDENTITY.flags.luminary}` ||
            argument.startsWith(`--${LUMINARIES_IDENTITY.flags.luminary}=`));
        if (attach || luminaryRequested) {
            await openAttachment(context, typeof target === 'string' ? target : undefined);
            return;
        }
        if (await hasPersistedLuminariesState(context)) {
            const current = await ensureManager(context);
            commandCenter.attach(uiContext(context), current);
        }
    });
    pi.on('session_shutdown', async () => {
        const current = manager;
        const creating = managerCreation;
        manager = undefined;
        managerCreation = undefined;
        managerStart = undefined;
        parentTurn = undefined;
        commandCenter.dispose();
        wavesCleanup?.();
        wavesCleanup = undefined;
        await (current ?? (await creating?.catch(() => undefined)))?.close();
        await attachmentClient?.close();
        attachmentClient = undefined;
    });
    pi.on('model_select', async (_event, context) => refreshRootHostFacts(context));
    pi.on('thinking_level_select', async (_event, context) => refreshRootHostFacts(context));
    pi.on('before_agent_start', async (event, context) => {
        parentContext.clear();
        parentTurn = { prompt: event.prompt, agentStarted: false };
        ownerContext = context;
        const current = manager;
        if (!current)
            return;
        await managerStart;
        if (manager !== current)
            throw new Error(`${LUMINARIES_IDENTITY.label} manager changed during startup`);
        await current.refreshRootHostFacts();
        await current.parentBeforeAgentStart(parentTurn.prompt);
        parentTurn.preparedFor = current;
    });
    pi.on('agent_start', async (_event, context) => {
        if (parentTurn)
            parentTurn.agentStarted = true;
        const current = manager;
        if (current) {
            current.setParentTransport(parentTransport(pi, context));
            await current.parentAgentStart();
            if (parentTurn)
                parentTurn.startedFor = current;
        }
        else
            void context;
    });
    pi.on('message_start', async (event) => {
        parentContext.observe(event.message);
        if (manager)
            await manager.parentMessageStart(event.message);
    });
    pi.on('agent_settled', async (_event, _context) => {
        if (manager)
            await manager.parentAgentSettled();
        parentTurn = undefined;
    });
}
function parentTransport(pi, context) {
    return {
        sendMessage: (message, options) => pi.sendMessage(message, options),
        abort: () => context.abort(),
    };
}
function uiContext(context, parentConversation = true) {
    return {
        mode: context.mode,
        parentConversation,
        ui: context.ui,
    };
}
function contextModels(context) {
    return context.scopedModels.length
        ? context.scopedModels.map((entry) => entry.model)
        : context.modelRegistry.getAvailable();
}
function modelDescriptor(value, pinnedThinking) {
    const thinkingLevel = THINKING_LEVELS.find((level) => level === pinnedThinking);
    return {
        provider: value.provider,
        id: value.id,
        contextWindow: value.contextWindow,
        maxOutputTokens: value.maxTokens,
        reasoning: value.reasoning,
        ...(thinkingLevel ? { thinkingLevel } : {}),
    };
}
function rootCapabilities(cwd, configuration) {
    const capabilities = defaultCapabilityEnvelope(resolve(cwd), configuration.maxDepth);
    return {
        ...capabilities,
        extensions: [...configuration.extensions.allowedPaths],
    };
}
function managerHostFacts(pi, context) {
    const current = context.model;
    return {
        ...(current ? { provider: current.provider, model: current.id } : {}),
        thinking: pi.getThinkingLevel(),
        models: context.scopedModels.length
            ? context.scopedModels.map((entry) => modelDescriptor(entry.model, entry.thinkingLevel))
            : context.modelRegistry.getAvailable().map((model) => modelDescriptor(model)),
        startupPrompt: context.getSystemPrompt(),
        activeToolTokens: activeToolTokens(pi),
    };
}
function activeToolTokens(pi) {
    const active = new Set(pi.getActiveTools());
    const tools = pi
        .getAllTools()
        .filter((tool) => active.has(tool.name))
        .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
        ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
    }));
    return Math.ceil(Buffer.byteLength(JSON.stringify(tools)) / 4);
}
function readChildBinding() {
    const reloaded = luminariesProcess.__PI_AGENT_LUMINARIES_CHILD_RELOAD_BINDING__;
    luminariesProcess.__PI_AGENT_LUMINARIES_CHILD_RELOAD_BINDING__ = undefined;
    if (reloaded)
        return reloaded;
    const env = LUMINARIES_IDENTITY.childEnv;
    const requiredKeys = [
        env.url,
        env.token,
        env.agentId,
        env.rootId,
        env.sessionId,
        env.generation,
        env.parentId,
        env.path,
        env.outbox,
    ];
    const values = requiredKeys.map((key) => process.env[key]);
    const buildId = process.env[env.buildId];
    if (values.every((value) => value === undefined) && buildId === undefined)
        return undefined;
    if (values.some((value) => value === undefined))
        throw new Error(`Incomplete ${LUMINARIES_IDENTITY.label} child bridge binding`);
    const [url, token, agentId, rootId, sessionId, generation, parentId, path, outbox] = values;
    if (!url || !token || !agentId || !rootId || !sessionId || !generation || !parentId || !path || !outbox)
        throw new Error(`Incomplete ${LUMINARIES_IDENTITY.label} child bridge binding`);
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/v1/tools')
        throw new Error(`${LUMINARIES_IDENTITY.label} child bridge URL is not a loopback endpoint`);
    if (!isLuminariesId(agentId) ||
        !isLuminariesId(rootId) ||
        !isLuminariesId(generation) ||
        !isLuminariesId(parentId) ||
        path.length > 2048 ||
        path.includes('\0') ||
        path.includes('\r') ||
        path.includes('\n') ||
        !isAbsolute(outbox) ||
        outbox.includes('\0') ||
        outbox.includes('\r') ||
        outbox.includes('\n') ||
        sessionId.length < 1 ||
        token.length < 32)
        throw new Error(`${LUMINARIES_IDENTITY.label} child bridge binding contains invalid identity`);
    if (buildId !== undefined && !isSha256(buildId))
        throw new Error(`${LUMINARIES_IDENTITY.label} child bridge build identity is invalid`);
    for (const key of [...requiredKeys, env.buildId])
        delete process.env[key];
    return {
        credential: { url, token, agentId, rootId, sessionId, generation, ...(buildId ? { buildId } : {}) },
        expectedSessionId: sessionId,
        generation,
        ...(buildId ? { expectedBuildId: buildId } : {}),
        parentId,
        path,
        outbox: resolve(outbox),
    };
}
function isSha256(value) {
    if (value.length !== 64)
        return false;
    for (const character of value)
        if (!'0123456789abcdef'.includes(character))
            return false;
    return true;
}
function piRootConfigurationHost() {
    return {
        async load(cwd, agentDir, projectTrusted) {
            const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
            const errors = settings.drainErrors();
            if (errors.length)
                throw errors[0]?.error ?? new Error('Pi settings could not be loaded');
            const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
            return {
                global: settings.getGlobalSettings(),
                project: settings.getProjectSettings(),
                async resolveExtension(specifier, source) {
                    const resolved = await packages.resolveExtensionSources([specifier], {
                        ...(source === 'trusted-project' ? { local: true } : {}),
                    });
                    return resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
                },
            };
        },
    };
}
function piManagedExtensionHost(cwd, agentDir, projectTrusted, startup) {
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
    const configuredSource = (specifier) => packages.listConfiguredPackages().find((entry) => entry.source === specifier && entry.installedPath);
    const resolveEntry = async (specifierInput, state) => {
        const specifier = managedExtensionSpecifier(specifierInput);
        const startupEntry = startup.extensions.entries.find((entry) => entry.specifier === specifier);
        const configured = configuredSource(specifier);
        const projectPath = projectTrusted && (settings.getProjectSettings().extensions ?? []).includes(specifier);
        const source = configured?.scope === 'project' || projectPath ? 'trusted-project' : (startupEntry?.source ?? 'global');
        if (state === 'deny')
            return { specifier, state, source, paths: [] };
        if (startupEntry?.paths.length)
            return { ...startupEntry, state };
        const resolved = await packages.resolveExtensionSources([specifier], {
            ...(source === 'trusted-project' ? { local: true } : {}),
        });
        const paths = [
            ...new Set(await Promise.all(resolved.extensions
                .filter((entry) => entry.enabled)
                .map(async (entry) => resolve(await realpath(entry.path))))),
        ].sort();
        if (!paths.length)
            throw new Error(`Pi extension '${specifier}' resolved no loadable extensions`);
        return { specifier, state, source, paths };
    };
    const resolvePolicy = async (states) => {
        const entries = await Promise.all(Object.entries(states).map(([specifier, state]) => resolveEntry(specifier, state)));
        entries.sort((left, right) => left.specifier.localeCompare(right.specifier));
        return {
            entries,
            allowedPaths: [
                ...new Set(entries.filter((entry) => entry.state !== 'deny').flatMap((entry) => entry.paths)),
            ].sort(),
        };
    };
    const listSources = () => {
        const values = [
            ...packages
                .listConfiguredPackages()
                .filter((entry) => entry.installedPath)
                .map((entry) => ({ specifier: entry.source, scope: entry.scope })),
            ...(settings.getGlobalSettings().extensions ?? []).map((specifier) => ({
                specifier,
                scope: 'user',
            })),
            ...(projectTrusted ? (settings.getProjectSettings().extensions ?? []) : []).map((specifier) => ({
                specifier,
                scope: 'project',
            })),
        ];
        return values.filter((entry, index) => values.findIndex((candidate) => candidate.specifier === entry.specifier && candidate.scope === entry.scope) ===
            index);
    };
    let sources;
    return {
        sources: () => (sources ??= listSources()),
        resolve: resolvePolicy,
        async approve(specifierInput, scope, install) {
            const specifier = managedExtensionSpecifier(specifierInput);
            const configured = configuredSource(specifier);
            if (install && !configured) {
                await packages.installAndPersist(specifier, { ...(scope === 'project' ? { local: true } : {}) });
                await settings.flush();
                sources = listSources();
            }
            return resolveEntry(specifier, 'allow');
        },
    };
}
async function hasPersistedLuminariesState(context) {
    const sessionFile = context.sessionManager.getSessionFile();
    if (!sessionFile)
        return false;
    const statePath = luminariesStatePathForSession({
        sessionId: context.sessionManager.getSessionId(),
    });
    const controlDirectory = join(dirname(statePath), 'control');
    try {
        if ((await readdir(controlDirectory)).some((name) => name === 'snapshot.jsonl' || name.startsWith('journal.')))
            return true;
    }
    catch (error) {
        if (!(isRecord(error) && error.code === 'ENOENT'))
            throw error;
    }
    const candidates = [statePath, `${statePath}.bak`, `${statePath}.corrupt-0`, `${statePath}.corrupt-1`];
    for (const path of candidates) {
        try {
            await stat(path);
            return true;
        }
        catch (error) {
            if (isRecord(error) && error.code === 'ENOENT')
                continue;
            throw error;
        }
    }
    return false;
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
