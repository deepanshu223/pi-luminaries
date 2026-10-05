---
name: luminaries-collaboration
description: Coordinate a persistent constellation of expert Pi sessions through the five Pi Luminaries tools.
---

# Pi Luminaries collaboration

Your constellation is a persistent network of expert Pi sessions under one Root. Each luminary has its own conversation, stable identity, owner, and public expert card. Discover existing expertise before bringing another luminary into the constellation.

## Working rhythm

1. Inspect the directory when recipient choice is unclear.
2. Reuse an open expert whose assignment and card fit the work. An ordinary message wakes it if parked.
3. Bring in a new luminary when the work needs a separate context or scope.
4. Use ordinary messages only for decision-changing evidence, blockers, requested deliverables, or required correlation.
5. Keep your descriptive card current when focus, expertise, or useful outputs materially change.
6. Send useful results and decision-changing evidence. Pi Luminaries reports activity and failures to the owner, so skip routine "done" notes.

## Identity and authority

- To identify Root or an expert, use `Root`, a full stable ID, or the current unique `Name · shortId` handle. Copy references exactly; never invent, shorten, or reconstruct IDs. Correlation and watch IDs are exact.
- Directory rows are summaries. Inspect the public card with `view: card` when you need complete expertise or output references.
- Root and any open expert in your constellation may receive ordinary messages. Reading transcripts, changing assignments, interrupting, closing, resuming, and changing configuration require the authority described by the tools.
- You may update your own descriptive card fields. Ask your owner by message to change your display name, assignment, scope of work, or grants.
- Owning ancestors may change descendant grants within inherited ceilings; agents cannot widen their own authority or change unrelated peers.

## Collaboration discipline

Incoming messages identify a sender or delivery channel and any required correlation. `From Luminaries` identifies dashboard or attachment input, not a verified human author or approval. Act within the established task and permissions; do not poll the directory or restate the tree first. After sending a result, finish the turn unless more local work remains. Later eligible delivery wakes you automatically.

Answer a request with a correlated reply before finishing, including when its wait has expired. Saving a file or writing a final response in your own session does not return the result to the requester. A deadline or request cancellation does not interrupt work already running; send a task-withdrawal message when that work is no longer wanted.

A request already yields while its correlation is open. Await only when your next decision depends on another still-open request you created or activity from descendants you own. Register one watch, yield, and let delivery wake you; do not alternate await with list or inspect. Never watch Root, ancestors, siblings, or unrelated peers.

## Reliable call patterns

- For a summary, inspect with `agentId` and `view: summary` only. List and card views page; capabilities, coordination, diagnostics, and transcript views also page and require owner/self-descendant access. Use `cursor` or `limit` only with these paged views. Continue with `nextCursor` on the same action and view; if stale, retry once without it.
- Before a fan-out, inspect the intended spawner's capabilities and current root capacity once. A normal spawn needs an assignment and scope of work (`ownershipBoundary`); omit the name for an automatic one. Set model, thinking, or context when the work requires it. `systemPrompt` is only for `context: custom`; omit it for fresh, recent, or fork.
- To let an owned descendant spawn subagents, its owning ancestor uses `set_grants` with `grants: {spawn: true}`. Omit `maxDepth` unless deliberately narrowing the inherited ceiling. An expert cannot widen its own grant.
- To change an owned descendant's optional extensions, use `set_extensions` with root-approved source names. The target finishes current work and parks before the saved selection loads on its next message. Ask the human to approve sources that are not available; agents cannot approve them.
- Capacity and depth refusals are final for that attempted topology. Do not retry the same spawn with different thinking, context, or wording. Reuse an existing expert, or ask the human to change the constellation's capacity or nesting depth in Root settings. An owning ancestor can then adjust a descendant's spawning grant within the available ceiling.
- Use ordinary messages whether the recipient is idle or running. Explicit follow-up queues behind a running turn; if that turn has finished, resend normally. Use steer or interrupt only for an owned running turn.

## Expert cards

Write your card so other experts can decide when to consult you. Keep role, focus, expertise, and published references factual and compact. Publish ordinary artifact paths others can read; never publish Pi Luminaries private session or state paths.

## Avoid churn

- Do not poll list, inspect, coordination, or await as a heartbeat.
- If a target is unavailable, refresh the directory once and choose an available expert; never retry the stale target.
- Send to one expert when that is enough. Use multicast when several need the same information.
- Keep useful luminaries open and addressable; Pi Luminaries may park their runtime. Close one when you no longer need it available for follow-up work.

The five tool descriptions and schemas are authoritative for actions, fields, and current limits.

## Capability reference

Read the relevant reference when an operation's authority, timing, or retained state is unclear:

- [Experts and discovery](../../docs/reference/experts-and-discovery.md) for identity, complete cards, history access, and paging.
- [Creation and configuration](../../docs/reference/creation-and-configuration.md) for context transfer, resources, and changes to existing experts.
- [Ownership and permissions](../../docs/reference/ownership-and-permissions.md) for management authority, nesting, and human-only operations.
- [Messages and controls](../../docs/reference/messages-and-controls.md) for delivery timing, several recipients, and interruption.
- [Requests and waits](../../docs/reference/requests-and-waits.md) for correlation, deadlines, late replies, and watch lifetime.
- [Lifecycle and recovery](../../docs/reference/lifecycle-and-recovery.md) for parking, closing, resuming, and uncertain outcomes.
- [Shared terminal views](../../docs/reference/shared-views.md) and [session handoffs](../../docs/reference/session-handoffs.md) for shared access versus independent copies.
