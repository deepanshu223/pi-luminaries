# Foundations

Pi Luminaries connects enduring Pi conversations into a constellation. You can ask Pi to coordinate them, work directly with an expert, or follow several conversations as their work develops.

## An expert is a conversation you can return to

A **luminary** has its own Pi session, a stable identity, an assignment, and an expert card. Its conversation develops through the work it does and the input it receives. Changing its model, thinking level, or selected extensions preserves that identity and conversation.

The name identifies the expert. Its **assignment** says what to do, and its **scope of work** says what it is responsible for. Its **expert card** describes its focus, expertise, and useful outputs so you and other experts can find relevant work. Read the conversation and referenced files when you need the evidence behind a card.

Each expert has its own context. Messages carry information between them, and files can hold shared work. Pi manages the conversation's active context and compaction as it grows.

## Root and the constellation

Your original Pi session is **Root**. It owns the constellation, including its saved experts and collaboration state. Resume that Pi session to return to the same constellation.

Experts can create children when permitted. This produces an **ownership tree**: an owner can manage its descendants within its granted authority. Root owns all branches.

An expert can find and consult another open expert at any level or in another branch. Ownership determines who can manage an expert; messages let experts work together across that structure.

You can inspect and operate Root or any expert through the dashboard. The [ownership reference](reference/ownership-and-permissions.md) explains which controls are available to you, owners, and peers.

## Conversation, process, and view

| Thing        | What it is                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Conversation | The expert's saved Pi history and the context Pi builds from it.                                                                  |
| Process      | The running Pi instance doing that expert's work. Parking releases this process while retaining the expert.                       |
| View         | A terminal through which you read and interact with the owner-managed conversation. Several views can show the same conversation. |

A later message wakes a parked expert into the same session. Closing an expert puts its work aside until you or its owner resume it. Archiving organizes closed conversations.

Opening another terminal adds a view. Bringing in an ordinary Pi session or continuing an expert in standalone Pi creates an independent conversation copy. See [Session handoffs](reference/session-handoffs.md) for what each copy contains.

## What Pi and Luminaries each provide

Pi runs the models and tools, stores conversations, manages context and compaction, and renders the conversation. Pi Luminaries adds identities, cards, ownership, message routing, lifecycle controls, and shared terminal access around those sessions.

Each active expert makes its own model requests through Pi's configured providers. Separate processes and contexts can still use the same project files; they are not separate filesystem sandboxes.

The [usage guide](usage.md) covers everyday operations. The [capability reference](reference/README.md) explains their exact behavior.
