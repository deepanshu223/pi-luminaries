import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasUnsafeHumanFacingControl } from "./identifiers.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { deepFreeze, isRecord } from "./scheduler-state.js";
const DEFAULT_SERVICE_GRANT = [
    'spawn',
    'directory',
    'message',
    'watch',
    'steer',
    'follow_up',
    'interrupt',
];
const SERVICE_PERMISSIONS = new Set([
    ...DEFAULT_SERVICE_GRANT,
    'close',
    'close_subtree',
    'resume',
    'set_model',
    'set_thinking',
    'set_extensions',
    'set_grants',
]);
const SETTING_KEYS = new Set(['maxOpenAgents', 'maxDepth', 'agentNames', 'agentExtensions', 'serviceGrant']);
function settingSection(value, source) {
    if (!isRecord(value))
        return {};
    const section = value[LUMINARIES_IDENTITY.settingsKey];
    if (section === undefined)
        return {};
    if (!isRecord(section))
        throw new Error(`${source} ${LUMINARIES_IDENTITY.settingsKey} settings must be an object`);
    const unknown = Object.keys(section).find((key) => !SETTING_KEYS.has(key));
    if (unknown)
        throw new Error(`${source} ${LUMINARIES_IDENTITY.settingsKey} setting '${unknown}' is unsupported`);
    return section;
}
function extensionSettings(value, source) {
    if (value === undefined)
        return new Map();
    if (!isRecord(value))
        throw new Error(`${source} agentExtensions must be an object`);
    const result = new Map();
    for (const [specifier, state] of Object.entries(value)) {
        managedExtensionSpecifier(specifier, `${source} agentExtensions`);
        if (state !== 'always' && state !== 'allow' && state !== 'deny')
            throw new Error(`${source} agentExtensions '${specifier}' must be always, allow, or deny`);
        result.set(specifier, { state, source });
    }
    return result;
}
export function managedExtensionSpecifier(value, label = 'Pi extension source') {
    if (typeof value !== 'string' || !value || value === '*' || value.length > 4096 || hasUnsafeHumanFacingControl(value))
        throw new Error(`${label} contains an invalid Pi extension specifier`);
    return value;
}
function settingsView(value, source) {
    const section = settingSection(value, source);
    return {
        maxOpenAgents: section.maxOpenAgents,
        maxDepth: section.maxDepth,
        agentNames: section.agentNames,
        agentExtensions: extensionSettings(section.agentExtensions, source),
        serviceGrant: section.serviceGrant,
    };
}
function positiveInteger(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label} must be a positive finite integer`);
    return value;
}
function names(value, label) {
    if (!Array.isArray(value) || value.length === 0)
        throw new Error(`${label} must be a non-empty list`);
    return value.map((item, index) => {
        if (typeof item !== 'string' || !item.trim() || hasUnsafeHumanFacingControl(item))
            throw new Error(`${label}[${index}] is invalid`);
        return item;
    });
}
function serviceGrant(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be a list`);
    const result = [];
    for (const permission of value) {
        if (typeof permission !== 'string' || !SERVICE_PERMISSIONS.has(permission))
            throw new Error(`${label} contains unsupported permission '${String(permission)}'`);
        if (result.includes(permission))
            throw new Error(`${label} contains duplicates`);
        result.push(permission);
    }
    return result;
}
export async function resolveRootConfiguration(options) {
    const loaded = await options.host.load(options.cwd, options.agentDir, options.projectTrusted);
    const global = settingsView(loaded.global, 'global');
    const project = options.projectTrusted
        ? settingsView(loaded.project, 'trusted-project')
        : { agentExtensions: new Map() };
    const value = (key, fallback) => {
        if (project[key] !== undefined)
            return { value: project[key], source: 'trusted-project' };
        if (global[key] !== undefined)
            return { value: global[key], source: 'global' };
        return { value: fallback, source: 'built-in' };
    };
    const maxOpenAgents = value('maxOpenAgents', 10);
    const maxDepth = value('maxDepth', 1);
    const agentNames = value('agentNames', undefined);
    const configuredServiceGrant = value('serviceGrant', DEFAULT_SERVICE_GRANT);
    const effectiveMaxOpenAgents = positiveInteger(maxOpenAgents.value, `${maxOpenAgents.source} maxOpenAgents`);
    const effectiveMaxDepth = positiveInteger(maxDepth.value, `${maxDepth.source} maxDepth`);
    const effectiveAgentNames = agentNames.value === undefined ? undefined : names(agentNames.value, `${agentNames.source} agentNames`);
    const effectiveServiceGrant = serviceGrant(configuredServiceGrant.value, `${configuredServiceGrant.source} serviceGrant`);
    const extensionSettings = new Map(global.agentExtensions);
    for (const [specifier, setting] of project.agentExtensions)
        extensionSettings.set(specifier, setting);
    const entries = [];
    for (const [specifier, setting] of extensionSettings) {
        if (setting.state === 'deny') {
            entries.push({ specifier, ...setting, paths: [] });
            continue;
        }
        const resolvedPaths = await loaded.resolveExtension(specifier, setting.source);
        if (resolvedPaths.length === 0)
            throw new Error(`Pi extension '${specifier}' resolved no loadable extensions`);
        const paths = [
            ...new Set(await Promise.all(resolvedPaths.map(async (path) => resolve(await realpath(path))))),
        ].sort();
        entries.push({ specifier, ...setting, paths });
    }
    entries.sort((left, right) => left.specifier.localeCompare(right.specifier));
    const permitted = entries.filter((entry) => entry.state !== 'deny');
    const extensions = {
        entries,
        allowedPaths: [...new Set(permitted.flatMap((entry) => entry.paths))].sort(),
    };
    const snapshot = {
        maxOpenAgents: effectiveMaxOpenAgents,
        maxDepth: effectiveMaxDepth,
        ...(effectiveAgentNames ? { agentNames: effectiveAgentNames } : {}),
        serviceGrant: effectiveServiceGrant,
        extensions,
        sources: {
            maxOpenAgents: maxOpenAgents.source,
            maxDepth: maxDepth.source,
            agentNames: agentNames.source,
            serviceGrant: configuredServiceGrant.source,
        },
    };
    return deepFreeze(snapshot);
}
export function resolveManagedExtensionSelection(policy, selected) {
    const requested = [...new Set(selected ?? [])];
    const selectedEntries = requested.map((specifier) => {
        const entry = policy.entries.find((candidate) => candidate.specifier === specifier);
        if (!entry || entry.state !== 'allow')
            throw new Error(`Pi extension '${specifier}' is not allowed for explicit child selection`);
        return entry;
    });
    const loaded = [...policy.entries.filter((entry) => entry.state === 'always'), ...selectedEntries];
    return {
        extensions: [...new Set(loaded.flatMap((entry) => entry.paths))].sort(),
    };
}
export function selectedManagedExtensionSpecifiers(policy, loadedPaths, recordedSources) {
    if (recordedSources)
        return recordedSources.filter((specifier) => policy.entries.find((entry) => entry.specifier === specifier)?.state === 'allow');
    const loaded = new Set(loadedPaths);
    return policy.entries
        .filter((entry) => entry.state === 'allow' && entry.paths.length > 0 && entry.paths.every((path) => loaded.has(path)))
        .map((entry) => entry.specifier);
}
