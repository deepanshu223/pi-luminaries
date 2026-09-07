import { isRecord, SchedulerStateError } from './scheduler-state.ts';
import { LUMINARIES_IDENTITY } from './product-identity.ts';

export interface ModelBoundaryWait {
  inputId: string;
  promise: Promise<boolean>;
  cancel: () => void;
}

interface PendingBoundary {
  inputId: string;
  abort: boolean;
  finished: boolean;
  resolve: (consumed: boolean) => void;
  reject: (error: Error) => void;
}

function eventInputId(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== 'message_start') return undefined;
  const message = isRecord(event.message) ? event.message : undefined;
  const details = message && isRecord(message.details) ? message.details : undefined;
  return message?.role === 'custom' &&
    message.customType === LUMINARIES_IDENTITY.namespace.protocolMessageType &&
    typeof details?.inputId === 'string' &&
    details.inputId
    ? details.inputId
    : undefined;
}

/** Correlates private Pi events only. Durable transitions remain with the recipient drain. */
export class ModelBoundaryTracker {
  private readonly pending = new Map<string, PendingBoundary>();

  get hasPendingInput(): boolean {
    for (const boundary of this.pending.values()) if (!boundary.finished && !boundary.abort) return true;
    return false;
  }

  observe(inputId: string): ModelBoundaryWait {
    return this.add(inputId, false);
  }

  observeInterrupt(inputId: string): ModelBoundaryWait {
    return this.add(inputId, true);
  }

  captureEvent(event: unknown): boolean {
    const inputId = eventInputId(event);
    if (inputId) this.captureInput(inputId);
    return isRecord(event) && event.type === 'agent_settled' ? this.settle() : false;
  }

  reject(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.finished) continue;
      pending.finished = true;
      this.pending.delete(pending.inputId);
      pending.reject(error);
    }
  }

  private add(inputId: string, abort: boolean): ModelBoundaryWait {
    if (!inputId) throw new SchedulerStateError('dispatch_identity', 'Pi input lacks a dispatch identity');
    if (this.pending.has(inputId))
      throw new SchedulerStateError('delivery_race', `Dispatch '${inputId}' already has a pending boundary`);
    let resolveWait: (consumed: boolean) => void = () => undefined;
    let rejectWait: (error: Error) => void = () => undefined;
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    void promise.catch(() => undefined);
    const pending: PendingBoundary = {
      inputId,
      abort,
      finished: false,
      resolve: resolveWait,
      reject: rejectWait,
    };
    this.pending.set(inputId, pending);
    return {
      inputId,
      promise,
      cancel: () => {
        if (pending.finished) return;
        pending.finished = true;
        this.pending.delete(inputId);
        pending.resolve(false);
      },
    };
  }

  private captureInput(inputId: string): void {
    const pending = this.pending.get(inputId);
    if (!pending || pending.finished || pending.abort) return;
    pending.finished = true;
    this.pending.delete(inputId);
    pending.resolve(true);
  }

  private settle(): boolean {
    let interruptSettled = false;
    for (const pending of [...this.pending.values()]) {
      if (pending.finished) continue;
      if (!pending.abort) {
        pending.finished = true;
        this.pending.delete(pending.inputId);
        pending.resolve(false);
        continue;
      }
      pending.finished = true;
      this.pending.delete(pending.inputId);
      interruptSettled = true;
      pending.resolve(true);
    }
    return interruptSettled;
  }
}
