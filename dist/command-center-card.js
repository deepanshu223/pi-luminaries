import { collapseWhitespace } from "./display-sanitizer.js";
export const LUMINARIES_MOTION = ['✦', '✧', '✶', '✧'];
export function hasRunningTurn(agent) {
    return agent.humanState === 'working' || agent.humanState === 'starting';
}
export function hasMotionFrame(agent) {
    return !agent.attention && hasRunningTurn(agent);
}
export function motionGlyph(agent, phase) {
    return hasMotionFrame(agent) ? (LUMINARIES_MOTION[phase % LUMINARIES_MOTION.length] ?? LUMINARIES_MOTION[0]) : '';
}
export function stateTone(state) {
    if (state === 'working' || state === 'starting')
        return 'accent';
    if (state === 'waiting')
        return 'muted';
    return 'dim';
}
export function agentTone(agent) {
    return agent.attention ? 'error' : stateTone(agent.humanState);
}
export function stateLabel(state) {
    if (state === 'closed')
        return 'Closed';
    if (state === 'working')
        return 'Working';
    if (state === 'starting')
        return 'Starting';
    if (state === 'waiting')
        return 'Waiting';
    return 'Idle';
}
export function availabilityLabel(agent) {
    if (agent.humanState === 'working' && agent.activity === 'Compacting context')
        return 'Compacting';
    return agent.humanState === 'idle' ? (agent.runtimeResident ? 'Ready' : 'Parked') : stateLabel(agent.humanState);
}
function sourceLabel(source) {
    if (source === 'self')
        return 'updated by collaborator';
    if (source === 'owner')
        return 'corrected by owner';
    if (source === 'operator')
        return 'corrected by operator';
    return 'set at launch';
}
function runtimeDetail(agent) {
    if (agent.lifecycle === 'closed')
        return 'closed · conversation retained';
    return agent.runtimeResident ? 'Pi process open' : 'parked · message to wake';
}
export function agentCard(agent, complete = false) {
    const fields = [];
    if (agent.attention) {
        fields.push({ label: 'Health', value: agent.health.summary });
        fields.push({
            label: 'Next',
            value: agent.parentId === null
                ? agent.canContinueWithMessage
                    ? 'Press Enter to continue from the Root conversation.'
                    : 'Press Enter to review the Root conversation.'
                : agent.canContinueWithMessage
                    ? 'Press a, then Continue with a message. Press Enter to review the conversation.'
                    : 'Press Enter to review the conversation.',
        });
    }
    if (agent.role)
        fields.push({ label: 'Role', value: agent.role });
    fields.push({
        label: 'Model',
        value: `${agent.model ?? 'Pi default model'} · thinking ${agent.thinking ?? 'Pi default'}`,
    });
    if (agent.parentId !== null &&
        (agent.alwaysExtensions.length || agent.selectedExtensions.length || agent.extensionChangePending)) {
        const extensions = [
            ...agent.alwaysExtensions.map((specifier) => `${specifier} · always`),
            ...agent.selectedExtensions,
        ];
        fields.push({
            label: 'Extensions',
            value: [
                ...extensions,
                ...(agent.extensionChangePending ? ['Change pending at the next safe boundary'] : []),
            ].join('\n'),
        });
    }
    if (agent.activity)
        fields.push({ label: 'Current action', value: agent.activity });
    if (agent.dependency)
        fields.push({ label: 'Dependency', value: agent.dependency });
    if (agent.focus) {
        const provenance = complete && agent.focusSource ? `\n${sourceLabel(agent.focusSource)}` : '';
        fields.push({ label: 'Focus', value: `${agent.focus}${provenance}` });
    }
    else if (!complete)
        fields.push({ label: 'Assignment', value: agent.assignment });
    if (agent.interactions.length)
        fields.push({
            label: 'Recent activity',
            value: (complete ? agent.interactions : agent.interactions.slice(0, 2).map(collapseWhitespace)).join('\n'),
        });
    if (agent.expertise.length)
        fields.push({ label: 'Expertise', value: agent.expertise.join('\n') });
    if (agent.artifacts.length)
        fields.push({ label: 'Outputs', value: agent.artifacts.join('\n') });
    if (complete) {
        fields.push({ label: 'Assignment', value: agent.assignment });
        fields.push({ label: 'Scope of work', value: agent.ownershipBoundary });
        fields.push({ label: 'Context', value: agent.contextMode });
        fields.push({
            label: 'Permissions',
            value: [
                `Spawn subagents: ${agent.canSpawn ? 'allowed' : 'not allowed'}`,
                `Interrupt other luminaries: ${agent.canPeerInterrupt ? 'allowed' : 'not allowed'}`,
                `Maximum tree depth: ${agent.maxDepth}`,
            ].join('\n'),
        });
    }
    if (complete)
        fields.push({ label: 'Runtime', value: runtimeDetail(agent) });
    return {
        name: agent.handle,
        breadcrumb: agent.breadcrumb.join(' › '),
        state: availabilityLabel(agent),
        tone: agentTone(agent),
        fields,
    };
}
