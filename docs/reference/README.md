# Pi Luminaries capability reference

This reference describes the behavior of Pi Luminaries operations for Pi agents and readers who need precise answers. Start with [Foundations](../foundations.md) if the distinction between a luminary, its conversation, its running process, and a terminal view is unfamiliar.

A **participant** is Root or any expert in its constellation.

## Find the relevant capability

| When you need to understand…                                                       | Read                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| How to identify an expert, read its card, or find earlier work                     | [Experts and discovery](experts-and-discovery.md)           |
| What a new expert starts with, or what changing its model and tools preserves      | [Creation and configuration](creation-and-configuration.md) |
| Who can create, inspect, configure, or control whom                                | [Ownership and permissions](ownership-and-permissions.md)   |
| When input reaches a recipient and how control differs from ordinary communication | [Messages and controls](messages-and-controls.md)           |
| How to obtain an answer, wait for activity, cancel a wait, or handle a late reply  | [Requests and waits](requests-and-waits.md)                 |
| What parking, closing, archiving, restart, or uncertain delivery means             | [Lifecycle and recovery](lifecycle-and-recovery.md)         |
| How to recover from an error, missing resource, or interrupted session             | [Troubleshooting](troubleshooting.md)                       |
| How multiple terminals interact with the same conversation                         | [Shared terminal views](shared-views.md)                    |
| What is copied when bringing a session in or continuing it independently           | [Session handoffs](session-handoffs.md)                     |
| How another Pi extension can use the running constellation                         | [Pi extension integration](pi-extension-integration.md)     |

For human procedures and shortcuts, use the [usage guide](../usage.md). Settings and precedence live in [Configuration](../configuration.md).

## Entry points for Pi agents

| Tool                   | Operations                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `luminaries_spawn`     | Create a child with an assignment, scope, and chosen starting context.                                    |
| `luminaries_directory` | List participants, inspect cards or permitted detail views, and update metadata.                          |
| `luminaries_message`   | Send messages or notifications, address several recipients, make requests, reply, and cancel requests.    |
| `luminaries_control`   | Guide running descendants, interrupt, close or resume them, and change permitted configuration or grants. |
| `luminaries_await`     | Wait for permitted request or activity changes, or cancel an active watch.                                |

The tools supplied by the installed extension define the accepted arguments and action names. The pages here explain their effects and interactions. References and IDs returned by an operation must be used in the role they identify: a participant, a request correlation, and a watch are different objects.

The human dashboard also provides operations that are not model tools, including adoption, standalone continuation, archiving, and constellation-wide settings. A Pi agent can help the user reach these controls without claiming it has a matching tool action.

## Read outcomes precisely

See [Receipt, consumption, and result](messages-and-controls.md#receipt-consumption-and-result) to distinguish delivery progress from a returned answer.

When a result depends on lifecycle, authority, or runtime state, read the relevant capability page before choosing the next operation.
