import { PiRpcCommandError } from "./pi-rpc.js";
import { SchedulerStateError, SchedulerStore } from "./scheduler-store.js";
import { peerMailboxRecord, peerMailboxRecords } from "./scheduler-state.js";
import { eligiblePeerEventsForRecipient } from "./peer-event-policy.js";
const MAX_DIAGNOSTICS = 32;
const PI_EVIDENCE_TIMEOUT_MS = 120_000;
const SHUTDOWN_JOIN_TIMEOUT_MS = 10_000;
function errorOf(value) {
    return value instanceof Error ? value : new Error(String(value));
}
function terminal(status) {
    return (status === 'settled' ||
        status === 'aborted' ||
        status === 'refused' ||
        status === 'failed' ||
        status === 'indeterminate');
}
export function waitForPiEvidence(promise, label, timeoutMs = PI_EVIDENCE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = timeoutMs === null
            ? undefined
            : setTimeout(() => reject(new SchedulerStateError('delivery_indeterminate', `${label} exceeded its finite evidence wait`)), timeoutMs);
        timer?.unref();
        promise.then((value) => {
            if (timer)
                clearTimeout(timer);
            resolve(value);
        }, (error) => {
            if (timer)
                clearTimeout(timer);
            reject(error);
        });
    });
}
/** One disposable per-recipient drain over the canonical Store inbox. */
export class RecipientDrain {
    options;
    rootGate = Promise.resolve();
    pumps = new Map();
    pendingHints = new Set();
    dormantRecipients = new Set();
    quarantinedRecipients = new Set();
    background = new Set();
    pendingSettlements = new Map();
    diagnosticsRing = [];
    unsubscribe;
    closing = false;
    constructor(options) {
        this.options = options;
        this.unsubscribe = options.store.onChange((_revision, affectedRecipientIds) => {
            for (const recipientId of affectedRecipientIds)
                this.hint(recipientId);
        });
    }
    get diagnostics() {
        return [...this.diagnosticsRing];
    }
    hint(recipientId) {
        if (this.closing || this.dormantRecipients.has(recipientId))
            return;
        if (this.quarantinedRecipients.has(recipientId)) {
            if (!this.hasRecoveryInput(recipientId))
                return;
            this.quarantinedRecipients.delete(recipientId);
        }
        if (this.pumps.has(recipientId)) {
            this.pendingHints.add(recipientId);
            return;
        }
        const pump = this.pump(recipientId).catch((error) => this.addDiagnostic(error));
        this.pumps.set(recipientId, pump);
        void pump.finally(() => {
            if (this.pumps.get(recipientId) !== pump)
                return;
            this.pumps.delete(recipientId);
            if (this.pendingHints.delete(recipientId) && !this.closing)
                setImmediate(() => this.hint(recipientId));
        });
    }
    setDormant(recipientId, dormant) {
        if (dormant)
            this.dormantRecipients.add(recipientId);
        else
            this.dormantRecipients.delete(recipientId);
    }
    scanOnce() {
        const recipients = new Set(Object.values(this.options.store.snapshot().mailbox).flatMap((record) => record.lane !== 'direct' && record.status === 'accepted' ? [record.recipientId] : []));
        for (const recipientId of recipients)
            this.hint(recipientId);
    }
    runRoot(operation) {
        const result = this.rootGate.then(operation, operation);
        this.rootGate = result.then(() => undefined, () => undefined);
        return result;
    }
    async settle(settlement) {
        this.pendingSettlements.set(settlement.activationId, settlement);
        const finished = await this.options.store.finishActivationIfRunning(settlement.activationId, settlement.leaseToken, settlement.outcome, true);
        if (finished.value?.state === 'running')
            return;
        this.pendingSettlements.delete(settlement.activationId);
        if ((settlement.outcome === 'settled' || settlement.outcome === 'aborted') && finished.value)
            this.options.onRecipientIdle?.(finished.value.agentId);
    }
    quiesce() {
        if (this.closing)
            return;
        this.closing = true;
        this.unsubscribe();
    }
    async drain() {
        while (this.pumps.size || this.background.size) {
            try {
                await waitForPiEvidence(Promise.allSettled([...this.pumps.values(), ...this.background]), 'Recipient drain shutdown', SHUTDOWN_JOIN_TIMEOUT_MS);
            }
            catch (error) {
                this.addDiagnostic(error);
                return;
            }
        }
    }
    observeSettlement(settlement) {
        const eventual = settlement.then((value) => this.settle(value));
        void eventual.catch((error) => this.addDiagnostic(error));
        this.track(waitForPiEvidence(eventual, 'Pi turn settlement', null));
    }
    async close() {
        this.quiesce();
        await this.drain();
        this.pendingHints.clear();
        this.dormantRecipients.clear();
        this.quarantinedRecipients.clear();
        this.pendingSettlements.clear();
        this.pumps.clear();
        this.background.clear();
    }
    async pump(recipientId) {
        for (;;) {
            const progressed = recipientId === this.options.store.snapshot().root.rootId
                ? await this.runRoot(() => this.dispatchOne(recipientId))
                : await this.dispatchOne(recipientId);
            if (!progressed || this.closing)
                return;
        }
    }
    async dispatchOne(recipientId) {
        const accepted = eligiblePeerEventsForRecipient(this.options.store.snapshot(), recipientId)[0];
        if (!accepted)
            return false;
        const agent = this.options.store.snapshot().agents[recipientId];
        if (agent?.attention?.kind === 'needs_attention' && !this.hasRecoveryInput(recipientId)) {
            this.quarantinedRecipients.add(recipientId);
            return false;
        }
        let port;
        try {
            port = await this.options.acquirePort(recipientId);
        }
        catch (error) {
            this.addDiagnostic(error);
            const agent = this.options.store.snapshot().agents[recipientId];
            if (agent?.parentId !== null && agent?.lifecycle === 'open')
                await this.options.store
                    .setAgentAttention(recipientId, 'needs_attention', error instanceof SchedulerStateError ? error.code.slice(0, 64) : 'runtime_start_failed')
                    .catch((failure) => this.addDiagnostic(failure));
            if (agent?.parentId !== null)
                this.quarantinedRecipients.add(recipientId);
            return false;
        }
        if (agent && agent.parentId !== null) {
            try {
                await this.options.store.materializeDeliveryPayload(accepted.eventId);
            }
            catch (error) {
                this.addDiagnostic(error);
                this.quarantinedRecipients.add(recipientId);
                await this.options.store
                    .setAgentAttention(recipientId, 'needs_attention', 'payload_materialization_failed')
                    .catch((failure) => this.addDiagnostic(failure));
                return false;
            }
        }
        const begun = await this.options.store.applyMailboxIntent({
            kind: 'begin_delivery',
            recordId: accepted.eventId,
            runtimeOwner: port.runtimeOwner,
        });
        if (!begun.value || !('eventId' in begun.value)) {
            await this.removeDerivedPayload(accepted.eventId);
            this.options.onRecipientIdle?.(recipientId);
            return false;
        }
        const plan = begun.value;
        let attempt;
        try {
            attempt = port.deliver(plan);
        }
        catch (error) {
            await this.requeueBeforeBoundary(plan, errorOf(error));
            return false;
        }
        let settlementDeferred = false;
        try {
            try {
                await waitForPiEvidence(attempt.accepted, `Pi acceptance for '${plan.eventId}'`);
            }
            catch (error) {
                const deliveryRace = error instanceof SchedulerStateError && error.code === 'delivery_race';
                const known = deliveryRace || error instanceof PiRpcCommandError;
                if (deliveryRace) {
                    await this.requeueBeforeBoundary(plan, error);
                    attempt.cancelBoundary('known');
                    return false;
                }
                await this.failAttempt(plan, errorOf(error), known);
                attempt.cancelBoundary(known ? 'known' : 'indeterminate');
                return true;
            }
            settlementDeferred = true;
            this.track(this.consumeLater(plan, attempt).finally(() => {
                this.observeSettlement(attempt.settled);
                this.track(attempt.settled.then(async (settlement) => {
                    const pending = this.pendingSettlements.get(settlement.activationId);
                    if (pending)
                        await this.settle(pending);
                }));
            }));
            return true;
        }
        finally {
            if (!settlementDeferred)
                this.observeSettlement(attempt.settled);
        }
    }
    async requeueBeforeBoundary(plan, error, settlement) {
        await this.options.store.applyMailboxIntent({
            kind: 'release_delivery',
            recordId: plan.eventId,
            attemptId: plan.attemptId,
            ...(settlement ? { settlement } : {}),
        });
        const pending = this.pendingSettlements.get(plan.activationId);
        if (pending)
            await this.settle(pending);
        if (error)
            this.addDiagnostic(error);
    }
    async consumeLater(plan, attempt) {
        let evidence;
        try {
            evidence = await waitForPiEvidence(attempt.consumed, `Exact follow-up boundary for '${plan.eventId}'`, null);
        }
        catch (error) {
            evidence = errorOf(error);
        }
        const settlement = evidence === false
            ? await waitForPiEvidence(attempt.settled, `Pi settlement after missed boundary for '${plan.eventId}'`, null)
            : undefined;
        const event = peerMailboxRecord(this.options.store.snapshot(), plan.eventId);
        if (!event) {
            await this.removeDerivedPayload(plan.eventId);
            return;
        }
        if (event.attemptId !== plan.attemptId)
            return;
        if (terminal(event.status) || event.consumedSeq !== undefined) {
            await this.removeDerivedPayload(plan.eventId);
            return;
        }
        if (evidence instanceof Error) {
            await this.failAttempt(plan, evidence, false);
            attempt.cancelBoundary('indeterminate');
            return;
        }
        if (!evidence) {
            if (settlement &&
                peerMailboxRecords(this.options.store.snapshot()).some((candidate) => candidate.mode === 'follow_up' &&
                    candidate.status === 'sending' &&
                    candidate.activationId === settlement.activationId &&
                    candidate.consumedSeq === undefined &&
                    candidate.acceptedSeq < event.acceptedSeq))
                return;
            await this.requeueBeforeBoundary(plan, undefined, settlement);
            attempt.cancelBoundary('known');
            return;
        }
        await this.options.store
            .applyMailboxIntent({
            kind: 'admit_boundary',
            recordId: plan.eventId,
            attemptId: plan.attemptId,
        })
            .catch((error) => {
            if (!(error instanceof SchedulerStateError && error.code === 'mailbox_missing'))
                throw error;
        });
        await this.removeDerivedPayload(plan.eventId);
    }
    async failAttempt(plan, error, refused) {
        const event = peerMailboxRecord(this.options.store.snapshot(), plan.eventId);
        if (!event || terminal(event.status) || event.consumedSeq !== undefined) {
            await this.removeDerivedPayload(plan.eventId);
            return;
        }
        await this.options.store.applyMailboxIntent({
            kind: 'finish_delivery',
            recordId: plan.eventId,
            attemptId: plan.attemptId,
            status: refused ? 'failed' : 'indeterminate',
            outcomeCode: refused ? 'pi_refused_input' : 'pi_input_unconfirmed',
        });
        await this.removeDerivedPayload(plan.eventId);
        this.addDiagnostic(error);
    }
    async removeDerivedPayload(eventId) {
        await this.options.store.removeDeliveryPayload(eventId).catch((error) => this.addDiagnostic(error));
    }
    track(operation) {
        const tracked = operation.catch((error) => this.addDiagnostic(error));
        this.background.add(tracked);
        void tracked.finally(() => this.background.delete(tracked));
    }
    hasRecoveryInput(recipientId) {
        const snapshot = this.options.store.snapshot();
        const attention = snapshot.agents[recipientId]?.attention;
        if (attention?.kind !== 'needs_attention')
            return true;
        return Object.values(snapshot.mailbox).some((record) => record.lane !== 'direct' &&
            record.lane !== 'system' &&
            record.recipientId === recipientId &&
            record.status === 'accepted' &&
            record.acceptedSeq > attention.seq);
    }
    addDiagnostic(value) {
        const error = errorOf(value);
        this.diagnosticsRing.push(error.message.slice(0, 500));
        if (this.diagnosticsRing.length > MAX_DIAGNOSTICS)
            this.diagnosticsRing.shift();
        this.options.onDiagnostic(error);
    }
}
export { formatPeerPrompt } from "./peer-prompt.js";
