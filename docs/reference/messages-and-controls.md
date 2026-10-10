# Messages and controls

Messages let experts and the human contribute to an existing conversation. Their delivery mode determines when they become input to Pi.

**Entry points:** `luminaries_message`; `luminaries_control` for explicit owner controls; the dashboard and conversation editor.

## Ordinary delivery

A sender can address any open participant in the same constellation, at any level or across branches.

| Recipient state               | Default message                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Ready                         | Starts a turn with the input.                                                                                      |
| Parked                        | Starts the retained Pi session and delivers the input.                                                             |
| Working                       | Reaches the current turn at Pi's next safe model boundary, or starts the next turn if the current turn ends first. |
| Closed                        | Refused until the participant is resumed.                                                                          |
| Failed or requiring attention | May require recovery or explicit continuation before new work can run.                                             |

A safe model boundary is between model calls after current tool work completes. Busy delivery is steering input, not interruption of an arbitrary running tool.

The owner serializes delivery to each participant. Different experts can work concurrently; simultaneous senders do not create multiple writers for one conversation.

## Choosing a mode

| Mode or action      | Behavior                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Default message     | Wakes an idle recipient or guides a running turn.                                                                              |
| Follow-up message   | Requires a running turn and holds the input for a later turn.                                                                  |
| Notify-only message | Records information without starting model work for the recipient.                                                             |
| Explicit steer      | An owner control for the current descendant turn only. If the turn ends before delivery, the sender receives a refusal notice. |
| Explicit follow-up  | An owner control that queues input behind a running descendant turn.                                                           |
| Interrupt           | Requests that the selected running turn stop; optional replacement input starts subsequent work.                               |

If a follow-up is refused because the turn has already finished, ordinary input is the appropriate way to start new work. A textual request to “stop” is still a message; use interrupt when the operation must request cancellation of the current turn.

Interrupt does not undo completed tool effects. Unread ordinary messages and follow-ups can start another turn immediately afterward. Interrupting Root affects Root's turn, not the independently running experts. Closing a subtree and human park-all controls have their own [lifecycle behavior](lifecycle-and-recovery.md).

## Several recipients

`multicast` sends the same message to a specified set of participants. `request_many` makes correlated requests to several participants. They retain per-recipient delivery and reply identities; they do not combine the participants' contexts or synthesize their answers.

Use the receipt's participant and request references to track each recipient's delivery and answer separately.

## Receipt, consumption, and result

| Observation                                    | What it establishes                                           |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Accepted                                       | The input has been recorded for delivery.                     |
| Consumed                                       | Pi has reached the model boundary associated with that input. |
| A response in the recipient's conversation     | The recipient produced that response locally.                 |
| A message or correlated reply to the requester | The result was explicitly returned through collaboration.     |

An acceptance receipt describes the intended delivery lane; it does not prove consumption. Ordinary input accepted while an expert is working can still start the next turn if that turn ends before delivery. An explicit steer keeps its current-turn target; after a missed-turn notice, use an ordinary message to start new work.

Return useful results to Root or another expert with a message or a reply through the incoming request's correlation. Finishing a turn updates activity but leaves the answer in the responder's own conversation.

Incoming messages identify a participant or delivery channel. **From Luminaries** marks input through the dashboard or attachment controls; it does not establish human authorship or approval. Compact rendering can hide part of a long message; Pi's expand/collapse action reveals the full content.

## Failure and recovery

An unavailable or closed target must be resolved before delivery can continue. Refresh its state rather than repeatedly retrying a stale reference.

Cancellation of the sender's tool call is not evidence that an already-accepted message was withdrawn. Likewise, a transport interruption can leave consumption uncertain. Pi Luminaries records that uncertainty rather than automatically replaying input that may already have caused work. Inspect [recovery state](lifecycle-and-recovery.md#failure-and-recovery) before issuing replacement work.

For answers that need correlation and waits that may expire, see [Requests and waits](requests-and-waits.md).
