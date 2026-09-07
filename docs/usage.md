# Using Pi Luminaries

Open `/luminaries` or press `Alt+L` to see your constellation. Your original Pi session is **Root**. Select an expert to inspect its card or open its conversation.

## Navigate the dashboard

| Key     | Action                                         |
| ------- | ---------------------------------------------- |
| `Enter` | Open the selected conversation                 |
| `/`     | Find an expert by name, expertise, or output   |
| `i`     | Read the selected expert card in full          |
| `n`     | Create a luminary                              |
| `a`     | Open actions for the selected participant      |
| `v`     | Switch between Current and Archived            |
| `Esc`   | Return to the directory or leave the dashboard |

The mouse wheel scrolls the view. In Windows Terminal, hold `Shift` while dragging to select text, then use the terminal's Copy action.

## Talk to an expert

Open its conversation and send a message, or ask Root to consult it. Sending a message while an expert works steers it at its next safe boundary. To interrupt a running turn from its conversation, press `Ctrl+C` with an empty editor.

Incoming messages have a distinct sender heading and a compact preview. Pi's expand/collapse shortcut (`Ctrl+O` by default) reveals the complete message alongside expanded tool output.

![A follow-up question to Deneb and its attributed reply in the Root conversation](assets/peer-conversation.png)

An expert can consult another expert through ordinary messages. Its card helps others find the relevant context and useful outputs; each expert keeps its own conversation.

## Return to a constellation

Resume the saved Pi session that owns it. The experts keep their identities and histories.

- **Parked:** after about five idle minutes, an expert releases its process to free memory. An ordinary message wakes its retained Pi session.
- **Closed:** its conversation remains available, but it needs an explicit **Resume** action before receiving new work.
- **Archived:** a closed expert is hidden from Current. Press `v` to find it in Archived, inspect its history, or unarchive and resume it.

Parking keeps an expert open and still counts toward capacity. Closing frees its place in the constellation.

## Give an existing expert another extension

Open the expert's actions and choose **Extensions**. Select from the optional sources approved by Root. A working expert finishes its current turn and parks; a parked expert saves the choice immediately. Send the next message to wake the same Pi conversation with the selected extension loaded.

If the source is not available yet, select Root and open **Actions → Root settings → Extension availability**. Choose an installed Pi source or enter a source accepted by `pi install`. Approval makes it selectable without loading it into every expert.

## Bring in an existing Pi session

1. Select Root, open its actions, and choose **Bring in a Pi session**.
2. Choose a conversation from the current project or **Other projects**, or enter its exact session ID or file path.
3. Give the new expert a name and task, and optionally describe its expertise.

Luminaries checks the selected session before asking for the new expert's metadata. It then copies the conversation into a new, parked expert. The original Pi session stays independent. Send a message to continue the adopted conversation.

## Continue in standalone Pi

Once an expert has finished its current turn, choose **Continue in standalone Pi** from its actions. Luminaries closes its constellation entry, retains that history, and creates an ordinary Pi continuation.

Use the exact `pi --session` command in the receipt, or run `pi --resume` and choose the readable **Name · standalone** entry. The receipt stays available until dismissed with `Esc`.

You can later adopt that standalone session as a new expert, including its additional work.

## Open another terminal

Keep the owning Pi session running. From another terminal in the same project, open the live constellation:

```bash
pi --luminaries
```

To open one expert, use its short ID from the directory. Replace the example ID below with the one shown beside your expert:

```bash
pi --luminary fa8318
```

A unique name such as `pi --luminary Vega` also works. If names repeat, use the short ID or the complete handle shown in the directory:

```bash
pi --luminary "Vega · fa8318"
```

These terminals view and guide the same live constellation. They depend on the original Pi session remaining open.

For models, thinking levels, permissions, and nesting limits, see [Configuration](configuration.md).
