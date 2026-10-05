# Shared terminal views

An attached terminal views and interacts with conversations hosted by the existing Root. It adds another point of access to the same constellation.

**Entry points:** `pi --luminaries`, `pi --luminary <reference>`, and the dashboard.

## Opening a view

Run the command from the constellation's project directory while its owning Pi session is available.

| Command                          | Opens                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `pi --luminaries`                | The live constellation directory; offers a choice when more than one owner is available. |
| `pi --luminary <short-id>`       | The selected expert's conversation.                                                      |
| `pi --luminary <unique-name>`    | The expert when that name resolves uniquely.                                             |
| `pi --luminary "Name · shortId"` | The participant identified by that complete handle.                                      |

A full stable luminary ID is also accepted. Missing, ambiguous, foreign-project, or offline targets produce an explanation rather than selecting an arbitrary conversation. A closed target opens retained history with explicit resume available.

A Pi agent with terminal-launching tools can run the same command on the user's behalf. Luminaries' **Open another terminal** action supplies the command; launching the operating-system terminal is a separate action.

## What is shared

Attached views receive the owner's directory state, cards, conversation updates, and operation results. Input is routed to that owner, which applies the same authority, lifecycle, and delivery rules as other inputs.

Several views can interact with one participant. This does not start another luminary, create a second model writer, or make a copy of the conversation. Each view has its own local editor and navigation state; drafts and cursor positions are not shared.

Ordinary input from either view can start or guide work. An operation can become unavailable between displaying an action and using it, so the owner checks current state when it is requested.

## Closing and reconnecting

| Event                                 | View behavior                                                                            | Constellation behavior                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Attached terminal closes              | Its connection ends.                                                                     | The owner, expert work, and other views continue.      |
| Owning Root goes offline              | Received content remains available, changes are disabled, and reconnection is attempted. | The view does not take ownership.                      |
| The same owner resumes and reconnects | Current state and live interaction return.                                               | The same retained identities and conversations remain. |

Offline access is limited to content the view has already received. It does not promise access to unloaded history while the owner is unavailable.

Attachments connect to a constellation on the same machine, using the current project directory to find its owner.

For an independent Pi continuation that can operate without the original Root, use a [session handoff](session-handoffs.md).
