# Session handoffs

Adoption and standalone continuation copy a Pi conversation into a new session. The source history remains available, and subsequent work develops independently.

**Entry points:** human **Bring in a Pi session** and **Continue in standalone Pi** actions in an owner or attached dashboard.

## Bring in an ordinary Pi session

The picker offers sessions from the current project and other projects. An exact session ID or file path can identify a source directly. The selected source must be a readable ordinary Pi session, outside Luminaries' private managed state. The owning Root is excluded from the picker.

Luminaries validates the source before requesting an optional name. An empty name uses the source's readable name when present, otherwise an automatic name.

| Property                 | Adopted expert                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Identity and parent      | A new luminary directly under the destination Root.                                      |
| Conversation             | A copy of the source's active Pi conversation branch.                                    |
| Initial state            | Parked; adoption itself does not start model work.                                       |
| Working directory        | The destination Root's working directory.                                                |
| Model and thinking       | Source settings where available and valid under destination Pi configuration and grants. |
| Extensions and authority | The destination constellation's launch policy and inherited limits.                      |

The source session and project files are not moved or modified. Adoption from another project copies conversation, not its filesystem or extension environment. References to source files remain references, so give the adopted expert the files or paths needed for its new work.

Capacity and nesting admission still apply. If the source model is unavailable to the destination Pi session, adoption can be refused; the copied conversation does not bring provider credentials with it.

After adoption, an ordinary message wakes the expert. Root can assign work, and the expert can describe the expertise worth publishing on its card.

## Continue an expert in standalone Pi

The target must be a non-Root luminary whose current work has settled. A working turn or pending runtime operation postpones the handoff. An open expert with open descendants must resolve that ownership branch before it can be individually closed for handoff.

Pi Luminaries closes the source entry and releases its writer, then creates an ordinary Pi session from its active conversation branch. The original closed identity and history remain in the constellation. The new session is independent and is named `Name · standalone`.

The receipt provides an exact `pi --session` command and the native `pi --resume` alternative. The standalone conversation uses ordinary Pi configuration when opened and no longer has the old expert's ownership role. Historical collaboration messages remain part of the copied history.

## Repetition and partial failure

Repeating standalone continuation from the same closed source reuses the handoff's session identity. It does not create a new continuation each time the receipt is requested.

If closing succeeded but creation of the standalone session failed, the source remains closed with its history retained. The error explains that partial result. Retry the handoff from the closed source; do not assume its history was lost.

Adoption is a separate creation operation. Adopting the same source again as a new action can create another expert; inspect the directory after an uncertain result before starting a second adoption.

## Returning later

An independent session can be adopted again, including its later conversation. This creates a new expert. It does not synchronize or merge with the earlier source entry.

| You want…                                                         | Operation                               |
| ----------------------------------------------------------------- | --------------------------------------- |
| Another terminal on the same live conversation                    | [Shared terminal view](shared-views.md) |
| An existing ordinary Pi conversation available to a constellation | Adoption                                |
| An expert's conversation to continue independently of Root        | Standalone continuation                 |
