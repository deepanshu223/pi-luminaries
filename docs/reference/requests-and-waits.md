# Requests and waits

A request associates a question with its eventual answer. A watch waits for permitted activity. Both allow an agent to yield without repeatedly polling the directory.

**Entry points:** `luminaries_message` actions `request`, `request_many`, `reply`, and `cancel`; `luminaries_await`.

## Request and reply

An open participant can request an answer from another open participant in the same constellation. The request uses ordinary or follow-up delivery and returns a correlation identifying that request.

The recipient answers with `reply`, using the incoming correlation. The correlation determines the destination; a reply does not also take a recipient. The answer must be sent before the recipient finishes if its work is ready to return. Writing a file or ending its own turn is not a correlated answer.

A request already establishes the wait/yield behavior while its correlation is open. It does not need an immediate second await call. Eligible replies and incoming messages wake the requester through normal delivery.

`request_many` creates separate correlated requests for the selected recipients. The requester decides what to do with the answers; there is no automatic consensus or synthesis step.

## Deadlines and cancellation

| Event                                     | Wait                       | Work already running at the recipient           |
| ----------------------------------------- | -------------------------- | ----------------------------------------------- |
| Correlated answer                         | Resolves the request       | Can continue if the recipient has further work. |
| Deadline expires                          | Ends the wait              | Continues.                                      |
| Requester cancels the request             | Ends the wait              | Continues.                                      |
| Authorized owner interrupts the recipient | Separate control operation | Requests that the current turn stop.            |

An optional deadline ends the requester's wait; the recipient's work continues.

Correlation is retained while related delivery or work still needs it. The recipient should answer using the original correlation even after the wait expires or is cancelled. A late answer is recorded as a notification; it does not reopen the wait or wake the requester.

If the task is no longer wanted, communicate the withdrawal. Use authorized interruption when the running turn must stop.

## Waiting for activity

A watch can select only the caller's still-open requests or permitted activity involving itself and descendants it owns. For a peer's answer, make a request; ordinary incoming messages also arrive without a watch.

Selectors for requests, agents, event kinds, and owned activity are combined across the supplied groups. Each supplied group must match; adding a selector narrows the condition rather than creating an alternative wake condition. A request list should not be treated as an implicit “all answers complete” aggregate: inspect the reported request outcomes before synthesizing.

Register the watch, retain its returned ID if needed, and yield. A waiting agent does not need heartbeat calls to list or inspect the constellation.

## Watch lifetime

A turn's watch ends when its condition matches, the turn is interrupted, or another turn starts. Ending a watch does not cancel its underlying requests or another expert's work.

Use a watch ID only for that still-pending watch. After it ends, read the delivered activity or register a new watch if a dependency remains. A missing watch is not a reason to keep replaying the old ID.

Print/JSON parent sessions cannot reactivate later like an interactive Root. A caller using those modes must account for that host limitation when choosing asynchronous work.

See [Messages and controls](messages-and-controls.md) for input timing and [Lifecycle and recovery](lifecycle-and-recovery.md) for uncertain outcomes.
