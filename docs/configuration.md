# Configure your constellation

Use `/luminaries` to manage an existing constellation. Select Root, press `a`, and choose **Root settings** to change capacity or nesting depth. The same controls are available from an attached terminal. Select a luminary to change its model, thinking level, expert card, or permissions.

**Change nesting depth** sets how many levels the constellation can have below Root. Root is level 0, experts created by Root are level 1, and experts they create are level 2. Raising the limit lets experts with inherited spawning permission use the added levels. An expert's own narrower limit or disabled spawning stays in effect until you change it through **Permissions**. The limit must accommodate every existing level, including closed and archived experts.

Changes are saved with the constellation and survive restarting Pi.

## Defaults for a new constellation

Put a `luminaries` section in Pi's global settings at `~/.pi/agent/settings.json`, or in your project's `.pi/settings.json`. Trusted project settings override global settings.

Without overrides, a new constellation allows **10 open luminaries**, excluding Root, and a **maximum nesting depth of 1**. Root can bring in luminaries at level 1; raise the depth in **Root settings** to let them bring in further luminaries.

For example, to allow up to 20 open luminaries and nesting through level 3, with Root at level 0 and luminaries at levels 1, 2, and 3:

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

When you or Pi create an expert without choosing a name, Pi Luminaries supplies one from its built-in list of star names. Leave `agentNames` out to use that list, or replace it with your preferred automatic names:

```json
{
  "luminaries": {
    "agentNames": ["Mira", "Polaris", "Rigel"]
  }
}
```

This list supplies the names used when creating experts. You or Pi choose each expert's assignment and configuration separately. An explicitly chosen name takes precedence.

Pi Luminaries prefers names not already in use. If names repeat, the short ID beside each name tells the experts apart.

The naming pool is saved when a constellation is created, so changes to this setting apply to new constellations. Existing names stay as they are. To rename an expert, open its actions and choose **Edit expert card → Display name**. Adopting a Pi session normally starts with that session's readable name, which you can change during adoption.

## Models and thinking

A new expert normally inherits its parent's model and thinking level. You can choose a different available model when creating it, or change these settings later through its actions when it is **Ready** or **Parked**.

You can also ask Root or an owning ancestor to make these changes through its Pi Luminaries tools. The change applies to the existing expert and conversation. Tool calls identify models as `provider/model`; the picker shows models available to the owning Pi session.

Experts use the provider access configured in Pi. Each active expert makes its own model requests.

## Subagents and permissions

The constellation shows who created each expert. Creating another expert requires room within the nesting limit and permission to spawn. Experts can consult one another directly at any level and across branches, within their messaging permissions.

Root or an owning ancestor can change an expert's permissions within inherited limits. An expert cannot grant itself more authority. To allow or disable spawning manually, select the expert and choose **Permissions**. You set the constellation-wide nesting limit through **Root settings**.

## Additional Pi extensions

Experts start with Pi's built-in tools and Pi Luminaries' collaboration tools. Choose which additional Pi extensions they can use through `agentExtensions`.

For example, to make `npm:pi-web-access` available to experts that need it:

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

With `allow`, Root or an owning expert can select the extension for a new or existing descendant. It loads only for experts where it has been selected. **You can leave this selection to the parent.**

The selection is the complete set of optional sources for that expert. Root can add, remove, or replace it; an empty selection removes all optional sources. Sources marked `always` remain included.

For manual creation, the same selection is available under **Customize → Advanced launch options → Child extensions**.

For existing experts and new sources, follow [Add or remove an expert's extensions](usage.md#add-or-remove-an-experts-extensions). Your approval makes a source available in the current constellation. Root and owning experts can then select it for their descendants. Approving new sources remains your choice.

| Value    | Behavior                                                                                      |
| -------- | --------------------------------------------------------------------------------------------- |
| `always` | Include it in every expert when its Pi process starts, including after parking or restarting. |
| `allow`  | Include it when selected during creation or for an existing expert.                           |
| `deny`   | Prevent it from loading, even if the same source is allowed globally.                         |

Unlisted extensions stay off. These settings apply to the experts; your main Pi session keeps its own extension configuration.

For a local extension, use its file or directory path as the key. Relative paths start from the folder containing the settings file.

For the key `"./extensions/project-tools.ts"`:

| Settings file               | Extension loaded                          |
| --------------------------- | ----------------------------------------- |
| `.pi/settings.json`         | `.pi/extensions/project-tools.ts`         |
| `~/.pi/agent/settings.json` | `~/.pi/agent/extensions/project-tools.ts` |

See [Pi package sources](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#package-sources) for the supported source forms.

File settings supply the extension policy when a constellation is created. That policy and each expert's selection are then saved across parking, wake, and Root resume. For an existing constellation, use **Root settings → Extension availability** for new approvals and the expert's **Extensions** action for selections.

If an extension becomes unavailable, see [Recover from a missing extension](reference/troubleshooting.md#recover-from-a-missing-extension).

## Integration access

`serviceGrant` controls the commands available to another Pi extension through the optional [Pi extension integration](reference/pi-extension-integration.md). It is separate from permissions granted to luminaries.

For example, to disable service commands in a new constellation:

```json
{
  "luminaries": {
    "serviceGrant": []
  }
}
```

See [service permissions](reference/pi-extension-integration.md#grants-and-boundaries) for the default access and other available permissions. The grant is saved with the constellation when it is created.

For conversations, session handoffs, and additional terminals, see [Using Pi Luminaries](usage.md).
