# Troubleshooting

Start in `/luminaries`. Select the affected expert, press `i` to read its full card, and open its conversation for the error and recent work. Root can help inspect the problem and manage its experts.

| What you see                                                                             | Where to start                                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Needs you** or **Delivery outcome is uncertain** after an interruption                 | [Continue after uncertain delivery](#continue-after-uncertain-delivery)                 |
| A selected extension is unavailable                                                      | [Recover from a missing extension](#recover-from-a-missing-extension)                   |
| A model or provider fails, or an extension asks for interactive input                    | [Resolve a launch or provider error](#resolve-a-launch-or-provider-error)               |
| A warning about another owner or an occupied session                                     | [Resolve an ownership conflict](#resolve-an-ownership-conflict)                         |
| An attached view is read-only, cannot find an expert, or shows a different constellation | [Find the owning session](#find-the-owning-session)                                     |
| An expert seems stuck, or its answer has not reached Root                                | [Check work and message progress](#check-work-and-message-progress)                     |
| Creation or resume is refused                                                            | [Check lifecycle, capacity, and permissions](#check-lifecycle-capacity-and-permissions) |
| Adoption or standalone continuation fails                                                | [Recover a session handoff](#recover-a-session-handoff)                                 |
| An update produces a build mismatch or `/reload` error                                   | [Restart after a package update](#restart-after-a-package-update)                       |

## Continue after uncertain delivery

After a crash or interrupted connection, **Delivery outcome is uncertain** means Pi Luminaries could not confirm how far an earlier operation got. Check the conversation and any affected files before deciding what should happen next.

When the expert's actions offer **Continue with a message**, use it to give new direction. For example:

> Check what completed before the interruption, then continue from there. Ask me if an earlier action's outcome is unclear.

When this option is available, an ordinary message you enter in that expert's Luminaries conversation also acknowledges the uncertainty. This is new input, rather than the **Queue a follow-up** control for a running turn. Root or an owning ancestor can also send its expert new direction through `luminaries_message` using the default delivery mode. `notify_only` does not acknowledge the warning.

The continuation clears the acknowledged warning while preserving the earlier uncertain outcome. It does not replay the old input or declare that the earlier work succeeded. A peer's routine message alone cannot acknowledge that uncertainty on your behalf.

For Root's own warning, return to its ordinary Pi conversation and give it new direction. If the card instead reports a missing resource, ownership problem, or uncertain configuration, address that cause first. **Needs you** is a reason to read the explanation, not a single error with one universal fix.

## Recover from a missing extension

An extension may disappear after it is uninstalled or its local files move. An affected expert can show **Needs you** while keeping its waiting messages. Root settings and the expert's **Extensions** dialog identify unavailable sources.

- If the expert no longer needs that optional extension, ask Root to remove it from the expert's selection. You can also open the expert's **Actions → Extensions** and remove it yourself. Correcting the selection lets its waiting messages proceed. Open the conversation to follow their progress; the held messages do not need to be sent again.
- If the expert still needs it, restore the source, then exit and resume the owning Pi session so it resolves the available extensions again.
- A source marked `always` applies to every expert when its process starts. Restore that source and restart the owning session. Removing an expert's optional selections cannot remove an `always` source.

After restoring a source and resuming the owning session, send each affected expert an ordinary message, such as asking it to continue. This releases its held messages for delivery; you do not need to resend them.

A missing optional source that no expert selected can remain unavailable without blocking the other experts. See [extension configuration](../configuration.md#additional-pi-extensions) for approval and selection rules.

## Resolve a launch or provider error

Read the actual error in the conversation. Expired credentials, provider limits, an unavailable model, and a missing working directory need different corrections. Experts use Pi's provider configuration; fix the reported source of failure, then send an ordinary message asking the expert to continue. Review any work completed before the failure first.

If a model works in a newly started Pi session but is unavailable to the existing Root, check that both use the same Pi profile and model selection. Exit and resume the owning session to load changed configuration. For a different model, ask Root to change the expert's model or use its **Change model** action when available. See [Models and thinking](../configuration.md#models-and-thinking).

Managed experts run Pi without their own interactive terminal UI. If an extension asks them to open a dialog, configure it through its supported settings or use it in an ordinary interactive Pi session. Opening an attached Luminaries view does not turn the expert's process into an interactive Pi process. A settled expert can [continue in standalone Pi](../usage.md#continue-in-standalone-pi) when that is the appropriate place for the work.

## Resolve an ownership conflict

The error identifies the recorded process ID and host. If that owning Pi process is still running, attach to it rather than starting another owner for the same session.

After an owner has exited, resuming the same Pi session normally recovers its saved constellation. If recovery cannot establish whether the old owner is still alive, inspect the named process before retrying. On Windows, `Get-CimInstance Win32_Process` exposes `ProcessId` and `CreationDate`, including cases where `Get-Process.StartTime` is unavailable.

Do not delete the lock to force a second writer or stop an unrelated process with a reused process ID. If the ownership error persists, keep the saved state and [report the error](#when-the-problem-persists).

## Find the owning session

An attached view becomes read-only when its owning Root is unavailable. Resume that same Pi session; the view attempts to reconnect. You can use Pi's `pi --resume` picker to find the owner.

Run `pi --luminaries` or `pi --luminary <short-id>` from the constellation's project directory, using the same Pi agent directory. If a name is ambiguous, use the short ID shown beside it. Attachments connect to an owner on the same machine.

If you opened a new Root and see an empty constellation, return to the original owning session. Starting another Pi conversation does not reopen the old constellation. Check **Archived** for experts hidden from Current. [Shared terminal views](shared-views.md) describes attachment behavior; [saved-state locations](lifecycle-and-recovery.md#saved-state-and-removal) can help when checking which Pi profile holds the histories.

## Check work and message progress

Open the expert's conversation rather than judging only from the widget. **Compacting** means Pi is making room in its context; let that operation finish. The widget can hide once experts settle, and replies can reach a busy Root later.

If a message was **Accepted** but work seems unchanged, check the recipient's state and most recent tool activity. Input sent during a turn reaches Pi between model calls, after current tool work. A queued follow-up waits for a later turn. See [delivery controls](../usage.md#guide-work-and-understand-delivery) before choosing whether to wait, send direction, or interrupt.

If the expert has answered in its own conversation but Root is still waiting, ask it to return the result through a message or reply to the original request. A **missed steer** notice means the targeted turn ended; send ordinary input if the direction still matters. An expired request wait leaves the expert's work running, and a late reply can be recorded without waking Root.

If you intentionally interrupt work, inspect what completed before asking it to retry. Interrupting Root leaves its experts running, and queued input can start another turn. Use the selected expert's controls for that expert. If progress remains unexplained, preserve the error and recent activity for a report.

## Check lifecycle, capacity, and permissions

For a **Closed** expert, use **Resume** before sending work. For an archived expert, open **Archived** and use its actions to return it to the constellation. Resume may also require reopening its parent or making room in capacity.

If creation is refused, read whether the cause is capacity, nesting depth, or permission. **Root settings** controls the constellation's capacity and depth; **Permissions** controls an expert's allowed actions. Parked experts still count toward capacity. See [configuration](../configuration.md) for changing these settings on an existing constellation.

If an agent gets `authority_denied` while trying to control a peer, ask Root or an owning ancestor to perform the control. Peers can consult one another without owning one another. For `watch_missing`, the agent should inspect the outcome or register a new wait if still needed, rather than reuse the expired watch ID. See [Requests and waits](requests-and-waits.md).

## Recover a session handoff

If adoption cannot find a session, choose it from the picker, check **Other projects**, or enter its exact session ID or file path. The source must be an ordinary Pi session; a managed expert uses the standalone handoff first. Provider access must also be available in the destination Pi session.

For **Continue in standalone Pi**, let the current work settle. Pending operations or open descendants may need resolving before the expert can close for handoff.

If the handoff closes the expert but fails to create the standalone session, its original history remains. Retry **Continue in standalone Pi** from that closed expert. Repeating that handoff reuses its standalone session identity. For an uncertain adoption result, check the directory first: adopting again can create a second expert. See [Session handoffs](session-handoffs.md#repetition-and-partial-failure).

## Restart after a package update

After updating Pi Luminaries, exit the owning Pi process normally and resume the same session. `/reload` may retain imported JavaScript from the earlier build. Restart this way if Pi reports that the package changed after Root started or that runtime files do not match the accepted build manifest.

If a fresh process still reports a build mismatch, check that Pi is loading the intended package installation and that the update completed. Reinstall a complete package from your chosen source if necessary. Preserve the constellation's saved state while repairing the installation.

## When the problem persists

[Report a problem](https://github.com/deepanshu223/pi-luminaries/issues) with your Pi and Pi Luminaries versions, operating system, the affected view, the action you took, and the exact error or a short relevant transcript. Mention whether resuming the same owning session changed the outcome. Remove credentials and private project content before sharing evidence.

For scrolling or text selection, see [dashboard navigation](../usage.md#navigate-the-dashboard) and [conversation controls](../usage.md#talk-to-an-expert).
