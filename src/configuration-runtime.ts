import type { LuminariesActorPool } from './actor-pool.ts';
import { validateOfflineConfigurationState } from './configuration-policy.ts';
import type { ModelDescriptor } from './spawn-configuration.ts';
import { resolveManagedExtensionSelection, type ManagedExtensionPolicy } from './root-configuration.ts';
import {
  SchedulerStateError,
  type AgentRecord,
  type SchedulerPrincipal,
  type SchedulerStore,
} from './scheduler-store.ts';
import type { LuminariesControlRequest } from './luminaries-tools.ts';
import { PiRpcCommandError } from './pi-rpc.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

export interface ConfigurationRuntimeResult {
  status: 'applied' | 'pending' | 'saved' | 'not_ready' | 'refused' | 'indeterminate';
  duplicate: boolean;
  agent?: Readonly<AgentRecord>;
  error?: string;
}

interface ConfigurationRuntimeOptions {
  store: SchedulerStore;
  actorPool: LuminariesActorPool;
  rootId: string;
  rootRuntime?: {
    setModel: (provider: string, modelId: string) => Promise<boolean>;
    setThinking: (level: string) => Promise<boolean>;
  };
  models: () => readonly ModelDescriptor[];
  managedExtensions: () => ManagedExtensionPolicy;
  onDiagnostic: (error: unknown) => void;
}

/** Owns the durable scheduler-to-live-Pi model/thinking transition and its crash boundary. */
export class AgentConfigurationCoordinator {
  private readonly options: ConfigurationRuntimeOptions;
  private readonly extensionChanges = new Map<string, { changeId: string; completion: Promise<void> }>();

  constructor(options: ConfigurationRuntimeOptions) {
    this.options = options;
  }

  async apply(
    input: LuminariesControlRequest,
    principal: SchedulerPrincipal,
    targetId: string,
    ownerId: string,
    changeId: string,
    signal?: AbortSignal,
  ): Promise<ConfigurationRuntimeResult> {
    const target = this.options.store.snapshot().agents[targetId];
    if (!target || target.lifecycle !== 'open')
      throw new SchedulerStateError('agent_unavailable', `Agent '${targetId}' is unavailable`);
    const sourceActivationId =
      principal.kind === 'agent'
        ? Object.values(this.options.store.snapshot().activations).find(
            (activation) => activation.agentId === principal.agentId && activation.state === 'running',
          )?.activationId
        : undefined;
    const configuration = this.resolve(input, target, targetId, changeId);
    if (configuration.kind === 'extensions') {
      if (!configuration.extensions)
        throw new SchedulerStateError('state_invalid', 'Resolved extension configuration is missing');
      return this.applyExtensions(
        {
          changeId: configuration.changeId,
          targetId: configuration.targetId,
          kind: 'extensions',
          extensions: configuration.extensions,
          extensionSources: configuration.extensionSources ?? [],
        },
        principal,
        target,
        ownerId,
        input.action,
        sourceActivationId,
        signal,
      );
    }
    if (configuration.value === undefined)
      throw new SchedulerStateError('state_invalid', 'Resolved configuration value is missing');
    const actor = this.options.actorPool.actors.get(targetId);
    if (actor) this.options.actorPool.cancelIdle(targetId);
    const rootRuntime = targetId === this.options.rootId ? this.options.rootRuntime : undefined;
    if (!actor && rootRuntime) {
      validateOfflineConfigurationState(this.options.store.snapshot(), configuration, principal);
      const alreadyEffective =
        input.action === 'set_model'
          ? target.provider === configuration.provider &&
            target.model === configuration.value &&
            (configuration.thinking === undefined || target.thinking === configuration.thinking)
          : target.thinking === configuration.value;
      if (signal?.aborted)
        throw new SchedulerStateError(
          'bridge_cancelled',
          'The bridge operation was cancelled before owner Pi mutation',
        );
      let modelApplied = false;
      try {
        let refused = false;
        if (input.action === 'set_model') {
          if (!(await rootRuntime.setModel(configuration.provider ?? '', configuration.value))) refused = true;
          else {
            modelApplied = true;
            if (configuration.thinking && !(await rootRuntime.setThinking(configuration.thinking))) refused = true;
          }
        } else if (!(await rootRuntime.setThinking(configuration.value))) refused = true;
        if (refused) {
          const status = modelApplied ? 'indeterminate' : 'refused';
          const error = modelApplied
            ? 'Owner Pi changed model but did not confirm the requested thinking level.'
            : `Owner Pi refused the requested ${input.action === 'set_model' ? 'model' : 'thinking level'}.`;
          await this.notice(targetId, ownerId, changeId, status, input.action, sourceActivationId);
          return { status, duplicate: false, error };
        }
        const applied = await this.options.store.applyOfflineConfiguration(configuration, principal);
        await this.notice(targetId, ownerId, changeId, 'applied', input.action, sourceActivationId);
        return { status: 'applied', duplicate: alreadyEffective, agent: applied.value };
      } catch (error) {
        const status = 'indeterminate' as const;
        await this.notice(targetId, ownerId, changeId, status, input.action, sourceActivationId);
        return { status, duplicate: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!actor) {
      const applied = await this.options.store.applyOfflineConfiguration(configuration, principal, signal);
      await this.notice(targetId, ownerId, changeId, 'applied', input.action, sourceActivationId);
      return { status: 'applied', duplicate: false, agent: applied.value };
    }
    try {
      let begun;
      try {
        begun = await this.options.store.beginLiveConfiguration(configuration, principal, signal);
      } catch (error) {
        if (principal.kind === 'operator' && error instanceof SchedulerStateError && error.code === 'writer_busy')
          return { status: 'not_ready', duplicate: false };
        throw error;
      }
      if (!begun.value) {
        const current = this.options.store.snapshot().agents[targetId];
        if (!current) throw new SchedulerStateError('agent_unavailable', `Agent '${targetId}' disappeared`);
        return { status: 'applied', duplicate: true, agent: current };
      }
      let modelApplied = false;
      try {
        if (input.action === 'set_model') {
          await actor.setModel(configuration.provider ?? '', configuration.value);
          modelApplied = true;
          if (configuration.thinking) await actor.setThinking(configuration.thinking);
        } else await actor.setThinking(configuration.value);
        const applied = await this.options.store.finishLiveConfiguration(targetId, changeId, 'applied');
        await this.notice(targetId, ownerId, changeId, 'applied', input.action, sourceActivationId);
        return { status: 'applied', duplicate: false, agent: applied.value };
      } catch (error) {
        const known = error instanceof PiRpcCommandError && !modelApplied;
        const status = known ? 'refused' : 'indeterminate';
        await this.options.store.finishLiveConfiguration(targetId, changeId, status);
        await this.notice(targetId, ownerId, changeId, status, input.action, sourceActivationId);
        if (!known) {
          actor.requireRecovery();
          await this.options.actorPool.closeAgent(targetId).catch(this.options.onDiagnostic);
        }
        return {
          status,
          duplicate: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      if (this.options.actorPool.actors.has(targetId)) this.options.actorPool.armIdle(targetId);
    }
  }

  extensionChange(agentId: string): Promise<void> | undefined {
    return this.extensionChanges.get(agentId)?.completion;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.extensionChanges.values()].map((operation) => operation.completion));
  }

  private async applyExtensions(
    configuration: {
      changeId: string;
      targetId: string;
      kind: 'extensions';
      extensions: readonly string[];
      extensionSources: readonly string[];
    },
    principal: SchedulerPrincipal,
    target: Readonly<AgentRecord>,
    ownerId: string,
    action: string,
    sourceActivationId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ConfigurationRuntimeResult> {
    const active = this.extensionChanges.get(configuration.targetId);
    if (active) {
      if (active.changeId !== configuration.changeId)
        throw new SchedulerStateError(
          'configuration_busy',
          `Agent '${configuration.targetId}' has a pending extension change`,
        );
      return { status: 'pending', duplicate: true, agent: target };
    }
    const actor = this.options.actorPool.actors.get(configuration.targetId);
    if (!actor) {
      const changed =
        target.launch.extensions.length !== configuration.extensions.length ||
        target.launch.extensions.some((path, index) => path !== configuration.extensions[index]);
      const applied = await this.options.store.applyOfflineConfiguration(configuration, principal, signal);
      await this.notice(configuration.targetId, ownerId, configuration.changeId, 'applied', action, sourceActivationId);
      return { status: 'saved', duplicate: !changed, agent: applied.value };
    }
    const begun = await this.options.store.beginLiveConfiguration(configuration, principal, signal);
    if (!begun.value) {
      const current = this.options.store.snapshot().agents[configuration.targetId];
      if (!current) throw new SchedulerStateError('agent_unavailable', `Agent '${configuration.targetId}' disappeared`);
      return { status: 'saved', duplicate: true, agent: current };
    }
    const completion = this.finishExtensionChange(
      configuration.targetId,
      configuration.changeId,
      ownerId,
      action,
      sourceActivationId,
    ).finally(() => {
      if (this.extensionChanges.get(configuration.targetId)?.completion === completion)
        this.extensionChanges.delete(configuration.targetId);
    });
    this.extensionChanges.set(configuration.targetId, { changeId: configuration.changeId, completion });
    void completion.catch(this.options.onDiagnostic);
    return { status: 'pending', duplicate: false, agent: this.options.store.snapshot().agents[configuration.targetId] };
  }

  private async finishExtensionChange(
    targetId: string,
    changeId: string,
    ownerId: string,
    action: string,
    sourceActivationId: string | undefined,
  ): Promise<void> {
    try {
      await this.options.actorPool.parkAgentAtSafeBoundary(targetId);
      await this.options.store.finishLiveConfiguration(targetId, changeId, 'applied');
      await this.notice(targetId, ownerId, changeId, 'applied', action, sourceActivationId);
    } catch (error) {
      const pending = this.options.store.snapshot().agents[targetId]?.pendingConfiguration;
      if (pending?.changeId === changeId)
        await this.options.store
          .finishLiveConfiguration(targetId, changeId, 'indeterminate')
          .catch(this.options.onDiagnostic);
      await this.notice(targetId, ownerId, changeId, 'indeterminate', action, sourceActivationId).catch(
        this.options.onDiagnostic,
      );
      this.options.onDiagnostic(error);
    }
  }

  private resolve(
    input: LuminariesControlRequest,
    target: Readonly<AgentRecord>,
    targetId: string,
    changeId: string,
  ): {
    changeId: string;
    targetId: string;
    kind: 'model' | 'thinking' | 'extensions';
    value?: string;
    provider?: string;
    thinking?: string;
    extensions?: readonly string[];
    extensionSources?: readonly string[];
  } {
    if (input.action === 'set_extensions') {
      if (targetId === this.options.rootId)
        throw new SchedulerStateError('root_control_denied', 'Root extensions are managed by Pi itself');
      const selection = resolveManagedExtensionSelection(this.options.managedExtensions(), input.extensions);
      return {
        changeId,
        targetId,
        kind: 'extensions',
        extensions: selection.extensions,
        extensionSources: [...(input.extensions ?? [])],
      };
    }
    if (input.action === 'set_model') {
      if (!input.model) throw new SchedulerStateError('input_invalid', 'Model change requires model');
      const slash = input.model.indexOf('/');
      if (slash < 1 || slash === input.model.length - 1)
        throw new SchedulerStateError('input_invalid', 'Model must use provider/model syntax');
      const provider = input.model.slice(0, slash);
      const value = input.model.slice(slash + 1);
      const descriptor = this.options.models().find((model) => model.provider === provider && model.id === value);
      if (!descriptor) throw new SchedulerStateError('model_unavailable', `Model '${input.model}' is unavailable`);
      if (descriptor.reasoning === false && descriptor.thinkingLevel && descriptor.thinkingLevel !== 'off')
        throw new SchedulerStateError('model_unavailable', `Model '${input.model}' has inconsistent thinking metadata`);
      return {
        changeId,
        targetId,
        kind: 'model',
        value,
        provider,
        ...(descriptor.thinkingLevel
          ? { thinking: descriptor.thinkingLevel }
          : descriptor.reasoning === false
            ? { thinking: 'off' }
            : {}),
      };
    }
    if (input.action !== 'set_thinking' || !input.thinking)
      throw new SchedulerStateError('input_invalid', 'Thinking change requires thinking');
    const descriptor = this.options
      .models()
      .find((model) => model.provider === target.provider && model.id === target.model);
    if (descriptor?.reasoning === false && input.thinking !== 'off')
      throw new SchedulerStateError('configuration_refused', `The active model does not support reasoning`);
    if (descriptor?.thinkingLevel && descriptor.thinkingLevel !== input.thinking)
      throw new SchedulerStateError(
        'configuration_refused',
        `The active model requires thinking level '${descriptor.thinkingLevel}'`,
      );
    return { changeId, targetId, kind: 'thinking', value: input.thinking };
  }

  private async notice(
    targetId: string,
    ownerId: string,
    changeId: string,
    outcome: 'applied' | 'refused' | 'indeterminate',
    action: string,
    sourceActivationId: string | undefined,
  ): Promise<void> {
    if (!sourceActivationId) return;
    const targetName =
      this.options.store.snapshot().agents[targetId]?.displayName.value ??
      `A ${LUMINARIES_IDENTITY.label} collaborator`;
    await this.options.store.admitSystemEvent({
      dedupeKey: `configuration:${changeId}:${outcome}`,
      type: outcome === 'indeterminate' ? 'control_failure' : 'routine',
      senderId: ownerId,
      recipientId: ownerId,
      message: `${targetName} ${action} is ${outcome}.`,
      wake: outcome === 'indeterminate',
      sourceActivationId,
    });
  }
}
