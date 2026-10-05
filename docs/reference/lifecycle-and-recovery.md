# Lifecycle and recovery

Pi Luminaries retains experts independently of whether their Pi processes are currently running. Closing and archiving have different effects from parking.

**Entry points:** ordinary messages; `luminaries_control` actions `close`, `close_subtree`, and `resume`; human archive and park-all actions; Pi session resume.

## States and effects

| State or condition | Meaning                                                                              | How work continues                                                  |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Working            | Pi is processing a turn. Activity may show thinking, reading, writing, or tool work. | Let it finish, send input, or use an authorized control.            |
| Compacting         | Pi is making room in the active context.                                             | Pi returns to normal work after compaction.                         |
| Waiting            | The participant has yielded for collaboration.                                       | Eligible replies or activity can wake it.                           |
| Ready              | Open and settled, with a runtime available.                                          | An ordinary message starts work.                                    |
| Parked             | Open, with its runtime released and identity/session retained.                       | An ordinary message wakes the same session.                         |
| Closed             | Retained history, no longer accepting work as an open participant.                   | Explicit resume is required.                                        |
| Archived           | A closed conversation is hidden from Current.                                        | Inspect in Archived, unarchive, or use its available resume action. |
| Needs you          | An observed failure or uncertain operation requires attention.                       | Read its details before choosing continuation or recovery.          |

Activity, lifecycle, and attention are related but separate facts. A waiting expert may have its runtime parked; archiving is organization of closed history.

## Parking and capacity

After settled idle work, Pi Luminaries keeps the process warm for about five minutes before parking it when safe. Pending runtime operations or deliverable work can postpone parking.

Parking retains identity, card, lineage, saved configuration, Pi session, and unresolved collaboration. It keeps the expert open and still counts toward capacity. Root itself is not automatically parked.

Human **Park all collaborators** can wait for safe settlement or interrupt when the human explicitly selects that option. It releases runtimes rather than closing their identities.

## Closing, resuming, and archive

An owning ancestor or the human may close a participant. If it has open descendants, use close-subtree explicitly. Closing ends its active work and frees open capacity while preserving history.

Resume restores the same expert identity and session. It requires room in capacity and an available parent. Resume admits the expert again; send input when there is work to do.

Human archive applies to closed conversations and their closed subtrees. Unarchive restores directory visibility without itself starting model work. The dashboard's archived resume action can restore required archived lineage and may offer a capacity increase; the model's ordinary resume action still requires an open parent.

## Root shutdown and return

The owning Root hosts the constellation. Normal shutdown closes its managed processes. Resume the same owning Pi session to recover the saved constellation, including expert identities, cards, lineage, configuration, and Pi histories.

A turn that was running at shutdown may need new direction after recovery. Completed external effects are not rolled back. The owner must resolve prior writers before another process can write the same expert session.

An attached terminal becomes read-only while the owner is unavailable. It cannot keep the constellation running on its own; see [Shared terminal views](shared-views.md).

After updating the Luminaries runtime, exit the owning Pi process and resume the same Pi session. A fresh process loads the updated runtime together; `/reload` may retain previously imported JavaScript modules.

## Failure and recovery

| Outcome       | Interpretation                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Refused       | The requested operation was not admitted in that form. Read the reason before changing the request. |
| Accepted      | Durable work exists, even if it has not reached Pi yet.                                             |
| Failed        | A known operation or runtime failure was recorded.                                                  |
| Indeterminate | Luminaries cannot prove whether a boundary completed safely.                                        |

An indeterminate input is not automatically replayed as though it had never reached the model. Inspect the conversation, referenced artifacts, and diagnostic state to determine what is known. The human may be offered **Continue with a message** to provide explicit new direction; this does not prove that the earlier work succeeded.

A launch or provider failure can require correcting Pi configuration or the expert's selected resources before continuation. A writer-recovery failure must be resolved before the session can resume safely.

Pi remains authoritative for conversation persistence and compaction. The model's active context may contain summaries of earlier messages.
