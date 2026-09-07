<div align="center">

![Pi Luminaries — Your constellation of enduring experts.](docs/assets/cover.png)

**Keep the expert who found the answer.**

[Get started](#get-started) · [Your constellation](#your-constellation) · [Usage guide](docs/usage.md) · [Configuration](docs/configuration.md)

</div>

Pi Luminaries gives your Pi session a constellation of experts that can find and talk to one another. Each expert is a Pi subagent with its own conversation and an expert card describing its focus, expertise, and useful work.

**Experts can message one another directly.** An expert can use the cards to find someone who has already investigated a relevant area, ask them for help, and continue with the answer. You can open any expert's conversation and guide its work as it happens.

## Get started

[Install and sign in to Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#quick-start), then install Luminaries:

```bash
pi install npm:pi-luminaries
```

Start a Pi session in your project. For example, while evolving a notes app:

```text
Use Luminaries to understand how this notes app keeps a user's work safe.
Let experts build up context around the parts they find: local storage,
sync, deletion, and recovery. Have them consult each other where those
behaviors meet, and keep their expert cards current so we can return
to the right expert as the app evolves.
```

Luminaries uses the models and provider access already configured in Pi. Experts can use different models and thinking levels; each makes its own model requests.

## Your constellation

Open `/luminaries` to see the constellation and inspect an expert's card. Your original Pi session appears as **Root**.

[![The full Luminaries dashboard with the constellation on the left and Deneb's expert card on the right](docs/assets/dashboard.png)](docs/assets/dashboard.png)

The card brings together the expert's role, model, thinking level, current focus, expertise, and outputs. Experts can keep their cards up to date as their work develops, making that knowledge discoverable to you and the other experts.

When an existing expert needs another Pi extension, approve the source in **Root settings** and select it from that expert's actions. Its next message reopens the same conversation with the added tools.

Open a conversation to read the work, ask a question, or change direction. When a later change needs that knowledge, ask the existing experts:

```text
We're adding shared notebooks. Ask the expert who understands deletion
to consult whoever knows offline edits. What should happen when one
person deletes a note while another is editing it offline?
```

## Experts helping experts

A specialist can bring in another subagent for a focused task. Experts in different branches can still consult each other directly, so Root does not have to relay every exchange.

![A nested constellation alongside a diagram showing ownership and direct communication between experts](docs/assets/nested-collaboration-feature.png)

You choose the constellation's capacity and nesting depth in **Root settings**. These can change as the work grows, while keeping the same experts and conversations.

## Keep useful expertise available

Idle experts park automatically to free memory. Their cards and conversations remain, and a message wakes the same expert.

A constellation belongs to its owning Pi session. Resume that session to return to it. You can close or archive experts when you want to put work aside while retaining its history.

## Move between standalone Pi and a constellation

- **Bring in a Pi session:** adopt an existing Pi conversation as a new expert in your constellation.
- **Continue in standalone Pi:** take an expert's conversation into an ordinary Pi session once its current work has finished.

Both actions create independent copies and preserve the source history. You can bring a standalone conversation back into the constellation later, including the work done since it left.

## Using Luminaries

The [usage guide](docs/usage.md) covers conversations, shortcuts, parking and archive, session handoffs, and opening the same constellation from another terminal.

See [Configuration](docs/configuration.md) for models, permissions, nesting limits, and defaults.

## Feedback

[Share an idea or report a problem](https://github.com/deepanshu223/pi-luminaries/issues) · [MIT license](LICENSE).
