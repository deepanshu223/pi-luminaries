# Ownership and permissions

The ownership tree determines who may manage an expert. Ordinary messages can cross branches of that tree.

**Entry points:** `luminaries_spawn`, `luminaries_directory`, and `luminaries_control`; human actions and Root settings.

## Relationships

Root is the original Pi session and the ancestor of the whole constellation. A luminary creates direct children and owns their descendants. An agent cannot choose another participant as the parent of its spawn.

An expert's assignment and scope describe responsibility. Enforced grants separately constrain operations and launch choices. Neither a descriptive scope nor a separate Pi process creates a filesystem sandbox.

## Authority by operation

| Operation                                                                    | Pi agent authority                             | Human surface                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| Read open public cards or send ordinary messages                             | Open participants in the same constellation    | Dashboard, cards, and conversations |
| Read transcript, capabilities, coordination, or diagnostics                  | Self or an owning ancestor                     | Inspect any participant             |
| Update focus, expertise, role, or output references                          | Self or an owning ancestor                     | Edit expert card                    |
| Change name, assignment, or scope                                            | An owning ancestor                             | Edit expert card                    |
| Create a child                                                               | The caller's spawn grant and inherited limits  | Create through the dashboard        |
| Change model, thinking, or selected extensions                               | An owning ancestor, within the allowed choices | Selected expert's actions           |
| Explicit steer, follow-up, interrupt, close, or resume through control tools | An owning ancestor                             | Conversation controls and actions   |
| Change a descendant's grants                                                 | An owning ancestor, within inherited ceilings  | Permissions                         |
| Change constellation capacity or depth, approve new extension sources        | No corresponding model tool                    | Root settings                       |
| Adopt, continue in standalone Pi, archive, or park all                       | No corresponding model tool                    | Dashboard actions                   |

A message's delivery mode and an explicit control action are separate interfaces. A peer may send ordinary input without gaining the authority to reconfigure or close the recipient.

## Nesting and capacity

Root is level 0. Each child is one level deeper than its parent. Creation must fit both the constellation's maximum depth and any narrower grant inherited by the spawner.

An owning ancestor can enable a descendant's spawning within the available ceiling. Leaving the descendant depth unspecified inherits that ceiling; setting it deliberately narrows it. An expert cannot grant itself more authority.

All open luminaries, including parked experts, draw from one constellation-wide capacity. Root does not count toward it. Closing frees capacity; resuming requires capacity again and an open parent.

The human can change capacity and nesting depth in an existing constellation. A lower ceiling cannot invalidate retained descendants; an increase does not override explicit narrower grants. See [Configuration](../configuration.md#defaults-for-a-new-constellation).

## Refusals and next steps

An authority refusal means that the caller cannot perform that operation on the target. Sending different wording or choosing a different model does not change the ownership relationship.

For help from a peer, use a message or request. For a management change outside the caller's authority, ask its owner. For constellation-wide settings or new extension approval, ask the human to use Root settings.

Closing a participant with open descendants requires the explicit subtree operation. Read [Lifecycle and recovery](lifecycle-and-recovery.md) before closing or resuming retained branches.
