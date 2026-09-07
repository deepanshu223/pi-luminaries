---
name: luminaries-collaboration
description: Coordinate a persistent constellation of expert Pi collaborators through the five Luminaries tools.
---

# Pi Luminaries collaboration

Your constellation is a persistent same-root network of expert Pi collaborators. Each luminary has an independent Pi session, stable identity, owner, and public expert card. Discover existing expertise before bringing another luminary into the constellation.

## Working rhythm

1. Inspect the directory when recipient choice is unclear.
2. Reuse an open specialist whose mandate and card fit the work; an ordinary message wakes it if parked.
3. Bring in a new luminary only for a genuinely separate context or scope of work.
4. Use ordinary messages only for decision-changing evidence, blockers, requested deliverables, or required correlation.
5. Keep your descriptive card current when focus, expertise, or useful outputs materially change.
6. Finishing a turn updates your owner's card automatically; it does not wake anyone. Send actual results and decision-changing evidence with an ordinary message or correlated reply — never routine "done" notes. Genuine failures raise urgent owner attention on their own.

## Identity and authority

- Collaborator fields accept `Root`, a stable ID, or the current unique `Name · shortId` handle. Correlation and watch IDs are exact.
- Directory list pages; summary does not. Capabilities, coordination, diagnostics, and transcript are owner/self-descendant views and page. Continue with `nextCursor` on the same action and view; if it is stale, retry once without it.
- Directory rows are summaries. Inspect the public card with `view: card` when you need complete expertise or output references.
- Any open same-root collaborator may receive ordinary messages. Reading transcripts, changing mandates, interrupting, closing, resuming, and changing configuration require the authority described by the tools.
- You may update your own descriptive card fields. Ask your owner by message to change your display name, assignment, scope of work, or grants.
- Owning ancestors may change descendant grants within inherited ceilings; agents cannot widen their own authority or change unrelated peers.

## Collaboration discipline

Incoming messages already identify the sender and any required correlation. Act on them directly; do not poll the directory or restate the tree first. After sending a result, finish the turn unless more local work remains. Later eligible delivery wakes you automatically.

A request already yields while its correlation is open. Await only when your next decision truly depends on another still-open request you created or activity from descendants you own. Register one watch, yield, and let delivery wake you; do not alternate await with list or inspect. Never watch Root, ancestors, siblings, or unrelated peers.

## Reliable call patterns

- Copy `Root`, a full stable ID, or a fresh unique `Name · shortId` exactly. Never invent, shorten, or reconstruct an ID.
- For a summary, inspect with `agentId` and `view: summary` only. Use `cursor` or `limit` only with list or the capabilities, coordination, diagnostics, and transcript views; continue a cursor only on that same action and view.
- Before a fan-out, inspect the intended spawner's capabilities and current root capacity once. A normal spawn needs a distinct name, assignment, and scope of work (`ownershipBoundary`); set model, thinking, or context only when the work requires it. `systemPrompt` is only for `context: custom`; omit it for fresh, recent, or fork.
- To let an owned descendant spawn subagents, its owning ancestor uses `set_grants` with `grants: {spawn: true}`. Omit `maxDepth` unless deliberately narrowing the inherited ceiling. A collaborator cannot widen its own grant.
- To change an owned descendant's optional extensions, use `set_extensions` with root-approved source names. The target finishes current work and parks before the saved selection loads on its next message. Ask the human to approve sources that are not available; agents cannot approve them.
- Capacity and depth refusals are final for that attempted topology. Do not retry the same spawn with different thinking, context, or wording. Reuse an existing collaborator, or ask the human to change the constellation's capacity or nesting depth in Root settings. An owning ancestor can then adjust a descendant's spawning grant within the available ceiling.
- Use ordinary messages for idle or running collaborators. Use steer or interrupt only for an owned running turn; if no turn is running, send the work normally.

## Expert cards

Cards are routing summaries, not transcript summaries. Keep role, focus, expertise, and published references factual and compact. Publish ordinary artifact paths others can read; never publish Pi Luminaries private session or state paths.

## Avoid churn

- Do not spawn before checking for a suitable specialist.
- Do not poll list, inspect, coordination, or await as a heartbeat.
- If a target is unavailable, refresh the directory once and choose an available specialist; never retry the stale target.
- Do not multicast when one specialist is enough.
- Keep useful luminaries open and addressable; Pi Luminaries may park their runtime. Close one when its mandate is retired.

The five tool descriptions and schemas are authoritative for actions, fields, and current limits.
