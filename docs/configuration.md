# Configure your constellation

Use `/luminaries` to manage an existing constellation. Select Root, press `a`, and choose **Root settings** to change capacity or nesting depth. The same controls are available from an attached terminal. Select a luminary to change its model, thinking level, expert card, or permissions.

**Change nesting depth** sets the deepest level allowed in this constellation: Root is level 0, its luminaries are level 1, and their subagents are level 2. Raising it lets inherited permissions follow the new ceiling. Explicit narrower limits and disabled spawning remain respected; use a luminary's **Permissions** actions when you want to change its authority. You cannot lower the ceiling below a level already occupied by retained descendants.

Changes are saved with the constellation and survive restarting Pi.

## Defaults for a new constellation

Put a `luminaries` section in Pi's global settings at `~/.pi/agent/settings.json`, or in your project's `.pi/settings.json`. Trusted project settings override global settings.

For example, to allow up to 20 open luminaries and three levels of subagents:

```json
{
  "luminaries": {
    "maxOpenAgents": 20,
    "maxDepth": 3
  }
}
```

These file settings provide defaults for new constellations. To change an existing constellation's saved limits, use **Root settings**.

| Setting         | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `maxOpenAgents` | Maximum number of open luminaries. Root does not count toward this limit.          |
| `maxDepth`      | Maximum lineage depth. Root is level 0; luminaries brought in by Root are level 1. |
| `agentNames`    | Optional replacement for the automatic display-name list.                          |

Parking releases a process, but the luminary remains open and still counts toward capacity. Closing a luminary frees its place while preserving its conversation.

## Names

Names label individual experts. Their assignments and expert cards describe what they do and what they know.

When you or Pi create a luminary without choosing a name, Luminaries supplies one from its built-in list of star names. Leave `agentNames` out to use that list, or replace it with your preferred automatic names:

```json
{
  "luminaries": {
    "agentNames": ["Mira", "Polaris", "Rigel"]
  }
}
```

With this setting, automatically named experts draw from Mira, Polaris, and Rigel. The list supplies names; it does not create experts or assign their work. A name you or Pi choose explicitly takes precedence.

Luminaries prefers names not already in use. If names repeat, the short ID beside each name tells the experts apart.

The pool is saved when a constellation is created. Editing this setting affects new constellations and does not rename existing experts. To rename one, open its actions and choose **Edit expert card → Display name**. Adopting a Pi session normally starts with that session's readable name, which you can change during adoption.

## Models and thinking

A new luminary normally inherits its parent's model and thinking level. You can choose a different available model when creating it, or change these settings later through its actions when it is **Ready** or **Parked**.

Luminaries use the provider access configured in Pi. Plan model usage for the number of experts you expect to be active at once.

## Subagents and permissions

The lineage shows who brought each luminary into the constellation. Spawning a subagent must fit both the constellation's nesting depth and the parent's permissions. Ownership does not limit ordinary communication to parent-child pairs: experts in different branches can exchange messages and request each other's help within their granted boundaries.

An owner can change a descendant's permissions within inherited limits. A luminary cannot grant itself more authority. Use **Permissions** in its actions to allow or disable subagent spawning. Only the human operator changes the constellation-wide ceiling through Root settings.

## Additional Pi extensions

Your main Pi session may have extensions that add tools or other capabilities. Luminaries' subagents start with Pi's built-in tools and Luminaries' own collaboration tools; other extensions are not automatically inherited.

Use `agentExtensions` to choose which extra extensions can load in luminaries. For example, if you use `npm:pi-web-access` and want it available only to experts that need it:

```json
{
  "luminaries": {
    "agentExtensions": {
      "npm:pi-web-access": "allow"
    }
  }
}
```

Here, `npm:pi-web-access` is the same source string used with `pi install`. Run `pi list` to find the sources of your installed packages, and copy the full string, including the `npm:` or `git:` prefix and any version you specified.

With `allow`, the extension is available but not loaded by default. The launching parent—Root or another luminary—can select it when creating a child or later for an existing descendant. **In normal use, leave that selection to the parent.**

For manual creation, the same selection is available under **Customize → Advanced launch options → Child extensions**.

For an existing expert, open **Actions → Extensions**. The expert keeps its identity, card, and Pi conversation. If it is working, it finishes that turn and parks at the safe boundary; the next message wakes the same session with the saved extension selection. A parked expert simply saves the selection for its next message.

To approve another installed or Pi-supported source for the current constellation, open **Root → Actions → Root settings → Extension availability**. Approval records the source as `allow`; it does not load the extension into every expert. Models can select approved sources for descendants they own, but they cannot approve arbitrary sources or widen their own authority.

| Value    | Behavior                                                              |
| -------- | --------------------------------------------------------------------- |
| `always` | Include it automatically in every new luminary.                       |
| `allow`  | Include it when selected during creation or for an existing expert.   |
| `deny`   | Prevent it from loading, even if the same source is allowed globally. |

Unlisted extensions stay off. These choices control the subagents, not which extensions your main Pi session loads.

For a local extension, use its file or directory path as the key. Relative paths start from the folder containing the settings file.

For the key `"./extensions/project-tools.ts"`:

| Settings file               | Extension loaded                          |
| --------------------------- | ----------------------------------------- |
| `.pi/settings.json`         | `.pi/extensions/project-tools.ts`         |
| `~/.pi/agent/settings.json` | `~/.pi/agent/extensions/project-tools.ts` |

See [Pi package sources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#package-sources) for the supported source forms.

The extension policy and each expert's selection are saved with the constellation across parking, wake, and Root resume.

For conversations, session handoffs, and additional terminals, see [Using Pi Luminaries](usage.md).
