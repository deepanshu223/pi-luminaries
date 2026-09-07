import { isAbsolute, resolve } from 'node:path';
import { CapabilityError, THINKING_LEVELS, capabilityAllows, capabilityAllowsCwd, normalizeCapabilityRequest, } from "./capability-policy.js";
import { resolveManagedExtensionSelection } from "./root-configuration.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
function safeText(value, label) {
    if (value === undefined)
        return undefined;
    if (!value)
        throw new CapabilityError('capability_invalid', `${label} is invalid`);
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 32 && character !== '\n' && character !== '\t')
            throw new CapabilityError('capability_invalid', `${label} contains a control character`);
    }
    return value;
}
function modelIdentity(value) {
    const slash = value.indexOf('/');
    if (slash < 1 || slash === value.length - 1)
        throw new CapabilityError('capability_invalid', `Model '${value}' must use provider/model syntax`);
    const provider = value.slice(0, slash);
    const id = value.slice(slash + 1);
    return { provider, id, key: `${provider}/${id}` };
}
function resourcePaths(values, base) {
    return values === undefined ? undefined : [...new Set(values.map((value) => resolve(base, value)))].sort();
}
export function resolveSpawnConfiguration(options) {
    const cwd = resolve(options.input.cwd ?? options.parentCwd);
    if (!isAbsolute(cwd) || !capabilityAllowsCwd(options.parentCapabilities, cwd))
        throw new CapabilityError('capability_escalation', `Spawn cwd '${cwd}' is outside the parent ceiling`);
    const selectedModel = options.input.model
        ? modelIdentity(options.input.model)
        : options.parentModel
            ? {
                provider: options.parentProvider,
                id: options.parentModel,
                key: options.parentProvider ? `${options.parentProvider}/${options.parentModel}` : options.parentModel,
            }
            : undefined;
    if (selectedModel && !capabilityAllows(options.parentCapabilities, 'models', selectedModel.key))
        throw new CapabilityError('capability_escalation', `Model '${selectedModel.key}' is outside the parent ceiling`);
    const descriptor = selectedModel
        ? options.models.find((candidate) => candidate.id === selectedModel.id &&
            (selectedModel.provider === undefined || candidate.provider === selectedModel.provider))
        : undefined;
    if (options.input.model && !descriptor)
        throw new CapabilityError('capability_invalid', `Model '${options.input.model}' is not available in this Pi session`);
    const inheritedThinking = THINKING_LEVELS.find((level) => level === options.parentThinking);
    const thinking = options.input.thinking ??
        descriptor?.thinkingLevel ??
        (descriptor?.reasoning === false ? 'off' : inheritedThinking);
    if (descriptor?.thinkingLevel && thinking !== descriptor.thinkingLevel)
        throw new CapabilityError('capability_invalid', `Model '${selectedModel?.key ?? descriptor.id}' is pinned to thinking level '${descriptor.thinkingLevel}'`);
    if (descriptor?.reasoning === false && thinking !== undefined && thinking !== 'off')
        throw new CapabilityError('capability_invalid', `Model '${selectedModel?.key ?? descriptor.id}' does not reason`);
    if (thinking && !capabilityAllows(options.parentCapabilities, 'thinking', thinking))
        throw new CapabilityError('capability_escalation', `Thinking level '${thinking}' is outside the parent ceiling`);
    const context = options.input.context ?? 'fresh';
    if (context !== 'custom' &&
        [options.input.skills, options.input.promptTemplates, options.input.themes].some((value) => value !== undefined))
        throw new CapabilityError('capability_invalid', 'Explicit context resources are valid only for custom context');
    let selectedExtensions;
    try {
        if (!options.managedExtensions && options.input.extensions?.length)
            throw new Error(`Managed extension selection is unavailable in this ${LUMINARIES_IDENTITY.label} host`);
        selectedExtensions = options.managedExtensions
            ? resolveManagedExtensionSelection(options.managedExtensions, options.input.extensions)
            : { extensions: [] };
    }
    catch (error) {
        throw new CapabilityError('capability_invalid', error instanceof Error ? error.message : String(error));
    }
    const extensions = selectedExtensions.extensions;
    const skills = resourcePaths(options.input.skills, options.parentCwd);
    const promptTemplates = resourcePaths(options.input.promptTemplates, options.parentCwd);
    const themes = resourcePaths(options.input.themes, options.parentCwd);
    for (const [label, values, allowed] of [
        ['Extension', extensions, options.parentCapabilities.extensions],
        ['Skill', skills, options.parentCapabilities.skills],
        ['Prompt template', promptTemplates, options.parentCapabilities.promptTemplates],
        ['Theme', themes, options.parentCapabilities.themes],
    ]) {
        if (!values)
            continue;
        const invalidPath = values.find((value) => !isAbsolute(value));
        if (invalidPath)
            throw new CapabilityError('capability_invalid', `${label} '${invalidPath}' is not absolute`);
        if (allowed === undefined) {
            const outsideCwd = values.find((value) => !capabilityAllowsCwd(options.parentCapabilities, value));
            if (outsideCwd)
                throw new CapabilityError('capability_escalation', `${label} '${outsideCwd}' is outside the parent filesystem ceiling`);
            continue;
        }
        const allowedValues = new Set(allowed);
        const denied = values.find((value) => !allowedValues.has(value));
        if (denied)
            throw new CapabilityError('capability_escalation', `${label} '${denied}' is outside the parent ceiling`);
    }
    const recentTokens = options.input.recentTokens;
    if (recentTokens !== undefined && (!Number.isSafeInteger(recentTokens) || recentTokens < 1))
        throw new CapabilityError('capability_invalid', 'recentTokens is outside its bound');
    if (recentTokens !== undefined && context !== 'recent')
        throw new CapabilityError('capability_invalid', 'recentTokens is valid only for recent context');
    const systemPrompt = safeText(options.input.systemPrompt, 'systemPrompt');
    if (systemPrompt !== undefined && context !== 'custom')
        throw new CapabilityError('capability_invalid', 'systemPrompt is valid only for custom context');
    const grants = options.input.grants ? normalizeCapabilityRequest(options.input.grants) : undefined;
    if (grants?.tools !== undefined)
        throw new CapabilityError('capability_invalid', 'Spawn tool selection is automatic and cannot be overridden');
    if (grants?.extensions !== undefined)
        throw new CapabilityError('capability_invalid', 'Spawn extension selection uses root-approved specifiers, not a capability path list');
    return {
        context,
        ...(recentTokens === undefined ? {} : { recentTokens }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(selectedModel?.provider ? { provider: selectedModel.provider } : {}),
        ...(selectedModel ? { model: selectedModel.id, modelKey: selectedModel.key } : {}),
        ...(descriptor ? { contextWindow: descriptor.contextWindow } : {}),
        ...(descriptor?.maxOutputTokens ? { maxOutputTokens: descriptor.maxOutputTokens } : {}),
        ...(thinking ? { thinking } : {}),
        cwd,
        ...(extensions === undefined ? {} : { extensions }),
        ...(skills === undefined ? {} : { skills }),
        ...(promptTemplates === undefined ? {} : { promptTemplates }),
        ...(themes === undefined ? {} : { themes }),
        ...(grants ? { grants } : {}),
    };
}
