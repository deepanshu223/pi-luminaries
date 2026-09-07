import { isRecord, SchedulerStateError } from "./scheduler-state.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
function eventInputId(event) {
    if (!isRecord(event) || event.type !== 'message_start')
        return undefined;
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
    pending = new Map();
    get hasPendingInput() {
        for (const boundary of this.pending.values())
            if (!boundary.finished && !boundary.abort)
                return true;
        return false;
    }
    observe(inputId) {
        return this.add(inputId, false);
    }
    observeInterrupt(inputId) {
        return this.add(inputId, true);
    }
    captureEvent(event) {
        const inputId = eventInputId(event);
        if (inputId)
            this.captureInput(inputId);
        return isRecord(event) && event.type === 'agent_settled' ? this.settle() : false;
    }
    reject(error) {
        for (const pending of [...this.pending.values()]) {
            if (pending.finished)
                continue;
            pending.finished = true;
            this.pending.delete(pending.inputId);
            pending.reject(error);
        }
    }
    add(inputId, abort) {
        if (!inputId)
            throw new SchedulerStateError('dispatch_identity', 'Pi input lacks a dispatch identity');
        if (this.pending.has(inputId))
            throw new SchedulerStateError('delivery_race', `Dispatch '${inputId}' already has a pending boundary`);
        let resolveWait = () => undefined;
        let rejectWait = () => undefined;
        const promise = new Promise((resolve, reject) => {
            resolveWait = resolve;
            rejectWait = reject;
        });
        void promise.catch(() => undefined);
        const pending = {
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
                if (pending.finished)
                    return;
                pending.finished = true;
                this.pending.delete(inputId);
                pending.resolve(false);
            },
        };
    }
    captureInput(inputId) {
        const pending = this.pending.get(inputId);
        if (!pending || pending.finished || pending.abort)
            return;
        pending.finished = true;
        this.pending.delete(inputId);
        pending.resolve(true);
    }
    settle() {
        let interruptSettled = false;
        for (const pending of [...this.pending.values()]) {
            if (pending.finished)
                continue;
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
