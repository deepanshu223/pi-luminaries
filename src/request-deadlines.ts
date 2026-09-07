import type { SchedulerStore } from './scheduler-store.ts';
import { requestStatus } from './scheduler-state.ts';

export class RequestDeadlineCoordinator {
  private readonly store: SchedulerStore;
  private readonly onDiagnostic: (error: Error) => void;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private closing = false;
  private running?: Promise<void>;
  private rescheduleRequested = false;

  constructor(store: SchedulerStore, onDiagnostic: (error: Error) => void) {
    this.store = store;
    this.onDiagnostic = onDiagnostic;
    this.unsubscribe = store.onChange(() => this.schedule());
    this.schedule();
  }

  close(): void {
    this.closing = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async settled(): Promise<void> {
    await this.running;
  }

  private schedule(): void {
    if (this.closing) return;
    if (this.running) {
      this.rescheduleRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.nextDeadline();
    if (next) this.arm(next.deadlineAtMs);
  }

  private arm(deadlineAtMs: number): void {
    if (this.closing) return;
    const delay = Math.max(0, Math.min(2_147_483_647, deadlineAtMs - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.expireDue()
        .catch((error) => {
          this.onDiagnostic(error instanceof Error ? error : new Error(String(error)));
          return Date.now() + 1_000;
        })
        .then((nextDeadlineAtMs) => {
          this.running = undefined;
          if (this.closing) return;
          if (this.rescheduleRequested) {
            this.rescheduleRequested = false;
            this.schedule();
          } else if (nextDeadlineAtMs !== undefined) this.arm(nextDeadlineAtMs);
        });
    }, delay);
    this.timer.unref();
  }

  private nextDeadline(): { requestId: string; deadlineAtMs: number } | undefined {
    const snapshot = this.store.snapshot();
    let next: { requestId: string; deadlineAtMs: number } | undefined;
    for (const request of Object.values(snapshot.requests)) {
      if (
        requestStatus(snapshot, request) !== 'pending' ||
        request.terminalEventId !== undefined ||
        request.deadlineAtMs === undefined
      )
        continue;
      if (
        !next ||
        request.deadlineAtMs < next.deadlineAtMs ||
        (request.deadlineAtMs === next.deadlineAtMs && request.requestId < next.requestId)
      )
        next = { requestId: request.requestId, deadlineAtMs: request.deadlineAtMs };
    }
    return next;
  }

  private async expireDue(): Promise<number | undefined> {
    for (;;) {
      if (this.closing) return undefined;
      const next = this.nextDeadline();
      if (!next || next.deadlineAtMs > Date.now()) return next?.deadlineAtMs;
      const result = await this.store.timeoutCorrelatedRequest(next.requestId, Date.now());
      if (!result.value) return undefined;
    }
  }
}
