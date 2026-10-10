# Creation and configuration

Creating a luminary gives a distinct line of work its own Pi conversation, identity, and place in the constellation. Its starting context and configuration are choices made for that conversation.

**Entry points:** `luminaries_spawn`; dashboard creation. Later changes use `luminaries_control` or the selected expert's actions.

## Conditions and result

An agent creates its own direct child. Creation requires spawn authority, room within the permitted nesting depth, and available constellation capacity. Model, resource, and working-directory choices must fit inherited grants.

The assignment is the first task delivered to the new expert. The scope of work describes its responsibility. A supplied name labels the conversation; otherwise Pi Luminaries chooses from the constellation's naming pool.

Creation records a participant and prepares its Pi session. A spawn receipt does not mean the assignment has finished. Inspect a reported startup failure before assuming the expert is working or creating a replacement.

## Starting context

| Mode     | Parent conversation                                       | Startup behavior                                                                                                           |
| -------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fresh`  | None transferred                                          | Normal Pi startup context plus the assignment.                                                                             |
| `recent` | A recent suffix of the parent's current context           | Transfers complete conversation groups within the selected budget.                                                         |
| `fork`   | The parent's current branch context at the spawn boundary | Transfers that context intact or refuses when it cannot do so.                                                             |
| `custom` | None transferred                                          | Isolated startup context with a supplied system prompt, or the built-in minimal prompt, and explicitly selected resources. |

Recent and fork require an exact parent spawn-call snapshot. They transfer context once; later changes to the parent conversation do not appear in the child automatically.

The recent budget defaults to 16,000 tokens in Luminaries and can be chosen with `recentTokens`; Pi does not impose that default. Available room in the target model can reduce the effective budget. A group starts at each user-equivalent input, including a custom message Pi converts to user input, and includes the following assistant/tool exchange up to the next such input. The receipt reports the effective budget, estimated transfer, and omissions. Recent keeps the newest complete groups that fit; if even the newest group exceeds the budget, creation is refused rather than splitting a tool exchange. Fork is refused when the complete transfer cannot fit; the caller can compact the parent, select a larger-context model, or choose a different mode.

Transfer sizing uses Pi's token estimate. Cross-model transfers use Pi's compatibility handling, which may normalize model-specific reasoning, tool identifiers, or media. Fresh and custom do not budget a nonexistent parent transfer.

Custom controls startup context, not filesystem isolation. Separate experts may still read or modify shared files.

## Models and resources

Omitted model, thinking, and working directory normally inherit from the parent. Explicit models use `provider/model` and must be available in the owning Pi session. Providers and credentials are supplied by Pi.

Launch options can select approved extensions, skills, prompt templates, themes, and a permitted working directory. Additional extensions load according to the constellation's [extension policy](../configuration.md#additional-pi-extensions) and the expert's selection.

## Changing an existing expert

| Change                                       | Conditions and effect                                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model or thinking                            | An owning ancestor or human changes an open, settled expert. Working turns must settle before these changes.                                                      |
| Selected optional extensions                 | An owning ancestor or human replaces the selection from approved sources. Active work settles, the runtime parks, and the next message loads the saved selection. |
| Name, assignment, scope, or descriptive card | Updated through the directory or card controls under the relevant metadata authority.                                                                             |

These changes retain the expert's identity, lineage, and Pi conversation. Selection changes replace the complete optional extension set; an empty set removes optional sources while `always` sources remain.

Starting context, startup resources, and working directory are launch choices rather than general live-edit controls. To begin a separate conversation with different initial context, create another luminary.

Changes can be refused for authority, unavailable configuration, busy state, or conflicting pending operations. Inspect the outcome before retrying; an uncertain applied state requires [recovery](lifecycle-and-recovery.md#failure-and-recovery), not an assumption that nothing changed.
