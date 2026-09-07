function trailingHex(agentId) {
    let start = agentId.length;
    while (start > 0) {
        const code = agentId.charCodeAt(start - 1);
        const hex = (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
        if (!hex)
            break;
        start--;
    }
    return agentId.slice(start).toLowerCase();
}
/** Derive compact stable IDs without storing a second identity registry. */
export function deriveAgentShortIds(agentIds) {
    const uniqueIds = [...new Set(agentIds)];
    const tails = new Map(uniqueIds.map((agentId) => {
        const hex = trailingHex(agentId);
        return [agentId, hex.length >= 6 ? hex : agentId.toLowerCase()];
    }));
    const lengths = new Map(uniqueIds.map((agentId) => {
        const tail = tails.get(agentId) ?? '';
        return [agentId, Math.min(6, tail.length)];
    }));
    const candidate = (agentId) => {
        const tail = tails.get(agentId) ?? '';
        const length = lengths.get(agentId) ?? 0;
        return tail && length > 0 && length <= tail.length ? tail.slice(-length) : agentId.toLowerCase();
    };
    for (;;) {
        const groups = new Map();
        for (const agentId of uniqueIds) {
            const value = candidate(agentId);
            const group = groups.get(value) ?? [];
            group.push(agentId);
            groups.set(value, group);
        }
        let changed = false;
        for (const group of groups.values()) {
            if (group.length < 2)
                continue;
            for (const agentId of group) {
                const tail = tails.get(agentId) ?? '';
                const length = lengths.get(agentId) ?? 0;
                if (length <= tail.length) {
                    lengths.set(agentId, length + 1);
                    changed = true;
                }
            }
        }
        if (!changed)
            break;
    }
    return new Map(uniqueIds.map((agentId) => [agentId, candidate(agentId)]));
}
export function deriveAgentHandles(agents) {
    const shortIds = deriveAgentShortIds(agents.map((agent) => agent.agentId));
    return new Map(agents.map((agent) => [agent.agentId, `${agent.displayName} · ${shortIds.get(agent.agentId) ?? agent.agentId}`]));
}
export function resolveAgentReference(agents, reference) {
    const exact = agents.find((agent) => agent.agentId === reference);
    if (exact)
        return exact.agentId;
    const normalized = reference.trim().toLowerCase();
    const shortIds = deriveAgentShortIds(agents.map((agent) => agent.agentId));
    const handles = deriveAgentHandles(agents);
    const addressed = agents.filter((agent) => {
        const shortId = shortIds.get(agent.agentId)?.toLowerCase();
        const handle = handles.get(agent.agentId)?.toLowerCase();
        return normalized === shortId || normalized === handle;
    });
    if (addressed.length === 1)
        return addressed[0]?.agentId;
    if (addressed.length > 1)
        return undefined;
    const names = agents.filter((agent) => normalized === agent.displayName.trim().toLowerCase());
    return names.length === 1 ? names[0]?.agentId : undefined;
}
