import { randomUUID } from 'node:crypto';
import { formatLuminariesToolResult, normalizeLuminariesToolCommand, } from "./luminaries-tools.js";
import { isRecord, sha256 } from "./scheduler-state.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
const TOOL = LUMINARIES_IDENTITY.tools;
const PRODUCT = LUMINARIES_IDENTITY.label;
export const LUMINARIES_WAVES_SERVICE = Symbol.for(LUMINARIES_IDENTITY.serviceSymbol);
export const LUMINARIES_WAVES_SERVICE_VERSION = LUMINARIES_IDENTITY.serviceVersion;
const WAVES_REGISTRATION = Symbol(LUMINARIES_IDENTITY.serviceRegistrationSymbol);
export function isLuminariesWavesService(value) {
    return (isRecord(value) &&
        value.version === LUMINARIES_WAVES_SERVICE_VERSION &&
        typeof value.rootId === 'string' &&
        typeof value.spawn === 'function' &&
        typeof value.directory === 'function' &&
        typeof value.message === 'function' &&
        typeof value.control === 'function' &&
        typeof value.watch === 'function' &&
        typeof value.subscribe === 'function');
}
export function currentWavesService() {
    const value = Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE);
    if (!isLuminariesWavesService(value))
        return undefined;
    const registration = registrationOf(value);
    if (registration && !registration.isOpen()) {
        if (Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE) === value)
            Reflect.deleteProperty(globalThis, LUMINARIES_WAVES_SERVICE);
        return undefined;
    }
    return value;
}
function registrationOf(value) {
    const candidate = Reflect.get(value, WAVES_REGISTRATION);
    if (!isRecord(candidate) || typeof candidate.isOpen !== 'function')
        return undefined;
    const isOpen = candidate.isOpen;
    return { isOpen: () => isOpen() };
}
function requestId() {
    return `waves-${sha256(randomUUID()).slice(0, 40)}`;
}
async function call(host, toolName, input) {
    const operationId = isRecord(input) && typeof input.requestId === 'string' ? input.requestId : requestId();
    const commandInput = isRecord(input)
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'requestId'))
        : input;
    return formatLuminariesToolResult(await host.execute(normalizeLuminariesToolCommand(toolName, commandInput, operationId), undefined));
}
/**
 * Installs one process-local, session-scoped provider for the separate Waves extension.
 * The provider delegates to Luminaries's existing manager and never owns lifecycle or state.
 */
export function installWavesService(manager) {
    const existing = Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE);
    if (existing !== undefined) {
        const registration = isLuminariesWavesService(existing) ? registrationOf(existing) : undefined;
        if (!registration || registration.isOpen())
            throw new Error(`Another ${PRODUCT} Waves service is already installed in this process`);
        Reflect.deleteProperty(globalThis, LUMINARIES_WAVES_SERVICE);
    }
    const host = manager.hostForService();
    const rootId = manager.rootSummary().rootId;
    const listeners = new Set();
    let lastEvent;
    let unsubscribeSummary;
    let closed = false;
    const currentEvent = () => {
        const summary = manager.rootSummary();
        return {
            version: LUMINARIES_WAVES_SERVICE_VERSION,
            rootId: summary.rootId,
            revision: summary.revision,
            openAgents: summary.openAgents,
            workingAgents: summary.workingAgents,
            waitingAgents: summary.waitingAgents,
            attentionAgents: summary.attentionAgents,
        };
    };
    const publish = () => {
        const event = currentEvent();
        if (lastEvent?.revision === event.revision)
            return;
        lastEvent = event;
        for (const listener of listeners) {
            try {
                listener(event);
            }
            catch {
                // A Waves observer cannot disrupt Luminaries's scheduler or other observers.
            }
        }
    };
    const service = {
        version: LUMINARIES_WAVES_SERVICE_VERSION,
        rootId,
        spawn: (input) => call(host, TOOL.spawn, input),
        directory: (input = { action: 'list' }) => call(host, TOOL.directory, input),
        message: (input) => call(host, TOOL.message, input),
        control: (input) => call(host, TOOL.control, input),
        watch: (input) => call(host, TOOL.await, input),
        subscribe(listener) {
            if (closed)
                throw new Error(`The ${PRODUCT} Waves service is closed`);
            listeners.add(listener);
            if (listeners.size === 1) {
                lastEvent = currentEvent();
                unsubscribeSummary = manager.onRootSummaryChange(publish);
            }
            return () => {
                if (!listeners.delete(listener) || listeners.size)
                    return;
                unsubscribeSummary?.();
                unsubscribeSummary = undefined;
                lastEvent = undefined;
            };
        },
    };
    Object.defineProperty(service, WAVES_REGISTRATION, {
        configurable: false,
        enumerable: false,
        value: {
            isOpen: () => !closed && (manager.isRunning?.() ?? true),
        },
    });
    Reflect.set(globalThis, LUMINARIES_WAVES_SERVICE, service);
    return () => {
        if (closed)
            return;
        closed = true;
        unsubscribeSummary?.();
        unsubscribeSummary = undefined;
        listeners.clear();
        if (Reflect.get(globalThis, LUMINARIES_WAVES_SERVICE) === service)
            Reflect.deleteProperty(globalThis, LUMINARIES_WAVES_SERVICE);
    };
}
