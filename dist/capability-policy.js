import { isAbsolute, relative, resolve } from 'node:path';
import { hasUnsafeHumanFacingControl } from "./identifiers.js";
export const CAPABILITY_VERSION = 1;
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const THINKING_SET = new Set(THINKING_LEVELS);
export class CapabilityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'CapabilityError';
        this.code = code;
    }
}
function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new CapabilityError('capability_invalid', `${label} must be an object`);
    return Object.fromEntries(Object.entries(value));
}
function exact(value, allowed, label) {
    const keys = new Set(allowed);
    for (const key of Object.keys(value))
        if (!keys.has(key))
            throw new CapabilityError('capability_invalid', `${label} contains unknown field '${key}'`);
}
function boolean(value, label) {
    if (typeof value !== 'boolean')
        throw new CapabilityError('capability_invalid', `${label} must be boolean`);
    return value;
}
function integer(value, minimum, label, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new CapabilityError('capability_invalid', `${label} is outside its integer bound`);
    return value;
}
function cleanText(value, label) {
    if (typeof value !== 'string' || value.length === 0)
        throw new CapabilityError('capability_invalid', `${label} must be nonempty text`);
    if (hasUnsafeHumanFacingControl(value))
        throw new CapabilityError('capability_invalid', `${label} contains a presentation control`);
    return value;
}
function list(value, label, paths = false) {
    if (!Array.isArray(value))
        throw new CapabilityError('capability_invalid', `${label} must be a list`);
    const result = value.map((item, index) => {
        const text = cleanText(item, `${label}[${index}]`);
        if (paths && !isAbsolute(text))
            throw new CapabilityError('capability_invalid', `${label}[${index}] must be an absolute path`);
        return paths ? resolve(text) : text;
    });
    return [...new Set(result)].sort();
}
function thinkingLevel(value) {
    if (!THINKING_SET.has(value))
        throw new CapabilityError('capability_invalid', `Unsupported thinking level '${value}'`);
    switch (value) {
        case 'off':
        case 'minimal':
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
        case 'max':
            return value;
    }
    throw new CapabilityError('capability_invalid', `Unsupported thinking level '${value}'`);
}
function thinkingList(value) {
    return list(value, 'capabilities.thinking').map((item) => thinkingLevel(item));
}
const FIELDS = [
    'version',
    'spawn',
    'peerInterrupt',
    'maxDepth',
    'models',
    'thinking',
    'tools',
    'extensions',
    'skills',
    'promptTemplates',
    'themes',
    'cwdRoots',
];
export function normalizeCapabilityEnvelope(value) {
    const input = record(value, 'capabilities');
    exact(input, FIELDS, 'capabilities');
    if (input.version !== CAPABILITY_VERSION)
        throw new CapabilityError('capability_invalid', `Unsupported capability version: ${String(input.version)}`);
    return {
        version: CAPABILITY_VERSION,
        spawn: boolean(input.spawn, 'capabilities.spawn'),
        peerInterrupt: boolean(input.peerInterrupt, 'capabilities.peerInterrupt'),
        maxDepth: integer(input.maxDepth, 0, 'capabilities.maxDepth'),
        ...(input.models === undefined ? {} : { models: list(input.models, 'capabilities.models') }),
        ...(input.thinking === undefined ? {} : { thinking: thinkingList(input.thinking) }),
        ...(input.tools === undefined ? {} : { tools: list(input.tools, 'capabilities.tools') }),
        ...(input.extensions === undefined ? {} : { extensions: list(input.extensions, 'capabilities.extensions', true) }),
        ...(input.skills === undefined ? {} : { skills: list(input.skills, 'capabilities.skills', true) }),
        ...(input.promptTemplates === undefined
            ? {}
            : { promptTemplates: list(input.promptTemplates, 'capabilities.promptTemplates', true) }),
        ...(input.themes === undefined ? {} : { themes: list(input.themes, 'capabilities.themes', true) }),
        ...(input.cwdRoots === undefined ? {} : { cwdRoots: list(input.cwdRoots, 'capabilities.cwdRoots', true) }),
    };
}
export function normalizeCapabilityRequest(value) {
    const input = record(value, 'capability grant');
    exact(input, FIELDS.filter((field) => field !== 'version'), 'capability grant');
    return {
        ...(input.spawn === undefined ? {} : { spawn: boolean(input.spawn, 'grant.spawn') }),
        ...(input.peerInterrupt === undefined
            ? {}
            : { peerInterrupt: boolean(input.peerInterrupt, 'grant.peerInterrupt') }),
        ...(input.maxDepth === undefined ? {} : { maxDepth: integer(input.maxDepth, 0, 'grant.maxDepth') }),
        ...(input.models === undefined ? {} : { models: list(input.models, 'grant.models') }),
        ...(input.thinking === undefined ? {} : { thinking: thinkingList(input.thinking) }),
        ...(input.tools === undefined ? {} : { tools: list(input.tools, 'grant.tools') }),
        ...(input.extensions === undefined ? {} : { extensions: list(input.extensions, 'grant.extensions', true) }),
        ...(input.skills === undefined ? {} : { skills: list(input.skills, 'grant.skills', true) }),
        ...(input.promptTemplates === undefined
            ? {}
            : { promptTemplates: list(input.promptTemplates, 'grant.promptTemplates', true) }),
        ...(input.themes === undefined ? {} : { themes: list(input.themes, 'grant.themes', true) }),
        ...(input.cwdRoots === undefined ? {} : { cwdRoots: list(input.cwdRoots, 'grant.cwdRoots', true) }),
    };
}
export function defaultCapabilityEnvelope(cwd, maxDepth) {
    if (!isAbsolute(cwd))
        throw new CapabilityError('capability_invalid', 'Root capability cwd must be absolute');
    return {
        version: CAPABILITY_VERSION,
        spawn: maxDepth > 0,
        peerInterrupt: true,
        maxDepth,
        cwdRoots: [resolve(cwd)],
    };
}
export function sameCapabilityCwd(left, right) {
    return relative(resolve(left), resolve(right)) === '';
}
function within(child, parent) {
    const path = relative(resolve(parent), resolve(child));
    return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}
function narrowList(parent, requested, label) {
    if (requested === undefined)
        return parent === undefined ? undefined : [...parent];
    if (parent === undefined)
        return [...requested];
    const allowed = new Set(parent);
    const denied = requested.find((value) => !allowed.has(value));
    if (denied !== undefined)
        throw new CapabilityError('capability_escalation', `${label} '${denied}' is outside the ancestor ceiling`);
    return [...requested];
}
function narrowRoots(parent, requested) {
    if (requested === undefined)
        return parent === undefined ? undefined : [...parent];
    if (parent === undefined)
        return [...requested];
    const denied = requested.find((candidate) => !parent.some((root) => within(candidate, root)));
    if (denied !== undefined)
        throw new CapabilityError('capability_escalation', `cwd root '${denied}' is outside the ancestor ceiling`);
    return [...requested];
}
function narrowedInteger(requested, parent, label) {
    if (requested === undefined)
        return parent;
    if (requested > parent)
        throw new CapabilityError('capability_escalation', `${label} cannot exceed the ancestor ceiling ${parent}`);
    return requested;
}
export function narrowCapabilityEnvelope(parent, request, childDepth) {
    const normalizedParent = normalizeCapabilityEnvelope(parent);
    const normalized = request === undefined ? {} : normalizeCapabilityRequest(request);
    const requestedSpawn = normalized.spawn ?? normalizedParent.spawn;
    const peerInterrupt = normalized.peerInterrupt ?? normalizedParent.peerInterrupt;
    if (requestedSpawn && !normalizedParent.spawn)
        throw new CapabilityError('capability_escalation', 'Spawn authority is outside the ancestor ceiling');
    if (peerInterrupt && !normalizedParent.peerInterrupt)
        throw new CapabilityError('capability_escalation', 'Peer interrupt is outside the ancestor ceiling');
    if (normalizedParent.maxDepth < childDepth)
        throw new CapabilityError('capability_invalid', `grant.maxDepth is an absolute tree depth; ancestor depth ${normalizedParent.maxDepth} cannot contain child depth ${childDepth}`);
    const candidateMaxDepth = requestedSpawn
        ? narrowedInteger(normalized.maxDepth, normalizedParent.maxDepth, 'grant.maxDepth (absolute tree depth)')
        : childDepth;
    if (candidateMaxDepth < childDepth)
        throw new CapabilityError('capability_invalid', `grant.maxDepth is an absolute tree depth and cannot be below child depth ${childDepth}`);
    const spawn = requestedSpawn && childDepth < candidateMaxDepth;
    const maxDepth = spawn ? candidateMaxDepth : childDepth;
    return normalizeCapabilityEnvelope({
        version: CAPABILITY_VERSION,
        spawn,
        peerInterrupt,
        maxDepth,
        models: narrowList(normalizedParent.models, normalized.models, 'model'),
        thinking: narrowList(normalizedParent.thinking, normalized.thinking, 'thinking level'),
        tools: narrowList(normalizedParent.tools, normalized.tools, 'tool'),
        extensions: narrowList(normalizedParent.extensions, normalized.extensions, 'extension'),
        skills: narrowList(normalizedParent.skills, normalized.skills, 'skill'),
        promptTemplates: narrowList(normalizedParent.promptTemplates, normalized.promptTemplates, 'prompt template'),
        themes: narrowList(normalizedParent.themes, normalized.themes, 'theme'),
        cwdRoots: narrowRoots(normalizedParent.cwdRoots, normalized.cwdRoots),
    });
}
export function capabilityAllows(envelope, field, value) {
    const allowed = envelope[field];
    return allowed === undefined || allowed.some((candidate) => candidate === value);
}
export function capabilityAllowsCwd(envelope, cwd) {
    return envelope.cwdRoots === undefined || envelope.cwdRoots.some((root) => within(cwd, root));
}
