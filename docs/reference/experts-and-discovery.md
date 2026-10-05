# Experts and discovery

An expert is an addressable participant with a retained Pi session and a public card. Discovery lets people and other experts find a conversation whose existing work is relevant.

**Entry points:** `luminaries_directory`; dashboard search, expert cards, and conversations.

## Identity and addressing

A luminary's stable ID survives parking, closing, and resuming. Display names can change or repeat. The directory supplies a readable handle combining the current name and a short identifying suffix.

Model tools accept `Root`, a full stable ID, or a current complete handle such as `Name · shortId`. Copy the reference returned by the directory rather than reconstructing it. [Terminal commands](shared-views.md#opening-a-view) additionally accept short IDs and unique names.

Adoption creates a new identity. A later adoption of a standalone continuation does not reopen or merge into an earlier identity.

## Card contents

| Information                  | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| Assignment and scope of work | Describe the work entrusted to the expert and its responsibility. |
| Role and focus               | Describe its contribution and current line of work.               |
| Expertise                    | Make investigated topics discoverable.                            |
| Published references         | Point to useful artifacts others can read.                        |
| Model and thinking           | Show the configuration being used for the conversation.           |
| Activity and attention       | Show current work and matters requiring intervention.             |

Names and descriptive roles do not select a model or a predefined prompt. An expert can update its own role, focus, expertise, and published references. Its owner or the human can also change its name, assignment, and scope.

Metadata updates describe the expert; they do not themselves start a model turn. Send a message when the expert needs to act on a changed assignment.

Published references point to ordinary artifacts. They do not embed the artifact contents in every reader's context or grant filesystem access. Luminaries rejects references that expose its private session or state paths.

## Directory and history access

The directory lists participants in the same constellation. Dashboard search matches names, expertise, and published outputs. Cards are declared routing information, not verified competence scores.

| View                                                    | Availability                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Open participant summaries and public cards             | Visible to peers in the constellation.                                            |
| Capabilities, coordination, diagnostics, and transcript | Available to the participant itself, its owning ancestors, and the human.         |
| Closed participant detail                               | Subject to retained ownership; the human can inspect closed and archived history. |

A peer can ask an expert a question without reading its private transcript. An owner inspecting history reads the Pi conversation available through the transcript view; directory listings do not contain the whole investigation.

## Paging and changing state

List, card, capabilities, coordination, diagnostics, and transcript results can return a continuation cursor. Continue using the same action, view, and target until the requested information has been read. Summary inspection is not paged.

If a cursor is stale, restart that inspection without the cursor. A list or card is an observation of the directory at read time: a participant may close or change before the next operation. On an unavailable target, refresh the relevant directory state before deciding whether to resume it, choose another expert, or stop.

See [Ownership and permissions](ownership-and-permissions.md) for control authority and [Lifecycle and recovery](lifecycle-and-recovery.md) for retained history.
