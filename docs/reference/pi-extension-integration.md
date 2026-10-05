# Pi extension integration

Waves is the optional integration API that lets another Pi extension in the owning process access the active Luminaries constellation. Its service delegates to the existing owner; it does not create a constellation or host its own processes.

This page is for extension authors. Ordinary collaboration uses the [five model tools](README.md#entry-points-for-pi-agents) and the dashboard.

## Access and lifetime

Import `currentWavesService` from `pi-luminaries/waves-v1`. It returns the active service when one is registered and running in the current Pi process, or `undefined` when unavailable.

For example, from an extension callback after Pi Luminaries is active:

```ts
import { currentWavesService } from 'pi-luminaries/waves-v1';

const service = currentWavesService();
if (!service) throw new Error('Open the Luminaries constellation in this Pi session first.');

const result = await service.directory({ action: 'list' });
```

The service is session-scoped. Resolve it again after switching or resuming sessions rather than retaining a stale owner reference. An attached viewer or unrelated process does not acquire the owner service through this import.

## Operations and events

| Method      | Behavior                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| `spawn`     | Create a child through the owner's collaboration path.                             |
| `directory` | Perform granted directory operations.                                              |
| `message`   | Send messages or use request/reply operations.                                     |
| `control`   | Perform the specifically granted control action.                                   |
| `watch`     | Register or cancel a permitted wait.                                               |
| `subscribe` | Observe subsequent constellation summary changes; returns an unsubscribe function. |

Call arguments and receipts use the collaboration contracts. The exported declarations in [waves-v1.d.ts](../../dist/waves-v1.d.ts) and [waves-service.d.ts](../../dist/waves-service.d.ts) define the interface.

Summary notifications describe revision and activity counts. They are not a transcript feed, and subscribing does not supply an initial directory snapshot. Read the directory for participant information. Unsubscribe when the consumer no longer needs updates.

## Grants and boundaries

The constellation's saved `serviceGrant` determines which commands a consumer may invoke. Control operations are granted by action, such as `set_model` or `close`, rather than by a general control permission. See [Integration access](../configuration.md#integration-access) for configuration.

Without a configured override, a new constellation grants these service permissions:

| Permission  | Available operation                                                         |
| ----------- | --------------------------------------------------------------------------- |
| `spawn`     | Create a luminary under Root.                                               |
| `directory` | List participants, inspect permitted views, and update metadata.            |
| `message`   | Send messages and notifications, make requests, reply, and cancel requests. |
| `watch`     | Register or cancel waits.                                                   |
| `steer`     | Send direction to a running turn.                                           |
| `follow_up` | Queue input after a running turn.                                           |
| `interrupt` | Stop a running turn, optionally with replacement input.                     |

Optional permissions are `close`, `close_subtree`, `resume`, `set_model`, `set_thinking`, `set_extensions`, and `set_grants`. An explicit `serviceGrant` list replaces the defaults; `[]` disables service commands. These permissions govern extension integration access, separately from each luminary's grants.

`subscribe` observes summary changes and is independent of `serviceGrant`; summary subscriptions remain available with an empty grant.

A grant names an operation class. For example, `directory` includes directory operations and must not be interpreted as a read-only guarantee. The service additionally refuses private transcript and diagnostic inspection and access to closed history.

Service access does not confer permission to install extensions, create new owner processes, or bypass the operation's lifecycle checks. It uses the same owner-managed delivery and recovery paths.

Calls apply to the active constellation in the owning Pi process.
