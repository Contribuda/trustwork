import type { DataPool } from '@trustwork/data';
import { assistantWorker, type ObservedOutcome } from '../../../../packages/data/src/repositories/assistant.js';
import { inTransaction } from '../db.js';
import { RetryableJobError, type ExternalJobHandler, type HandlerRegistry, type TransactionalJobHandler } from '../handlers.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';
import { ProviderRejectedError, type EffectProvider, type LookupResult } from './providers.js';

/**
 * Worker side of the agent runtime (AST-001).
 *
 * - `assistant.dispatch` (external job): `assistant_begin_attempt` rechecks the mandate, its revision and expiry, the
 *   company basis, kill switches and the person's stop, the approval and the reservation, and persists the attempt
 *   (operation id, fencing token) before the provider call. The provider result is recorded fenced by the job's token.
 *   A refused recheck revokes the action without any call. An ambiguous error or timeout records `outcome_unknown`.
 * - `assistant.reconcile` (transactional job): a provider lookup by the stable correlation key turns an unknown
 *   outcome into a reconciliation record (final, still acknowledged, or still unknown). Lookups have no effect, so a
 *   crash during reconciliation simply rolls back and runs again. Nothing is ever re-submitted.
 * - `assistant.sweep` (scheduled): an attempt whose dispatch job lost its lease (crashed worker) becomes
 *   `outcome_unknown` and gets a reconciliation job; its reservation stays held.
 * - `recordAssistantReceipt`: asynchronous provider receipts (deduplicated by provider, account and event id).
 */
export const ASSISTANT_DISPATCH = 'assistant.dispatch';
export const ASSISTANT_RECONCILE = 'assistant.reconcile';
export const ASSISTANT_SWEEP_TASK = 'assistant.sweep';

export interface AssistantRuntime {
  pool: DataPool;
  providers: readonly EffectProvider[];
  /** Deployment hub for kill-switch scoping; null applies every hub-scoped switch. */
  hubId: string | null;
  log: Logger;
}
interface IntentPayload { intentId: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseIntent(payload: unknown): IntentPayload {
  const id = (payload as { intentId?: unknown } | null)?.intentId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('assistant job payload needs an intentId');
  return { intentId: id };
}

export function dispatchHandler(runtime: AssistantRuntime): ExternalJobHandler<IntentPayload> {
  const providers = new Map(runtime.providers.map((p) => [p.name, p]));
  return {
    kind: ASSISTANT_DISPATCH,
    mode: 'external',
    parse: parseIntent,
    async run({ job, payload, signal }) {
      const target = await inTransaction(runtime.pool, (trx) => assistantWorker.beginAttempt(trx, payload.intentId, job.id, runtime.hubId));
      if (target.status !== 'dispatch') {
        runtime.log('info', 'assistant action not dispatched', { intentId: payload.intentId, status: target.status, detail: target.status === 'refused' ? target.reason : target.state });
        return;
      }
      const provider = providers.get(target.provider);
      let outcome: ObservedOutcome;
      if (!provider) {
        // Persisted attempt, but no call was made: a definitive pre-effect failure.
        outcome = { kind: 'final', result: 'failed', providerReference: null, evidence: `no adapter for provider ${target.provider}; nothing was sent` };
      } else {
        try {
          const response = await provider.submit({ correlationKey: target.correlationKey, operationId: target.operationId, attemptNo: target.attemptNo, operation: target.operation, payload: target.payload, amount: target.amount }, signal);
          outcome = response.kind === 'acknowledged'
            ? { kind: 'acknowledged', providerReference: response.providerReference }
            : { kind: 'final', result: response.result, providerReference: response.providerReference, evidence: response.evidence };
        } catch (error) {
          if (error instanceof ProviderRejectedError) outcome = { kind: 'final', result: 'failed', providerReference: null, evidence: error.evidence.slice(0, 2000) };
          else outcome = { kind: 'unknown', reason: signal.aborted ? 'timeout' : 'ambiguous_response' };
        }
      }
      const recorded = await inTransaction(runtime.pool, (trx) => assistantWorker.recordOutcome(trx, target.attemptId, outcome));
      runtime.log(outcome.kind === 'unknown' ? 'warn' : 'info', 'assistant action outcome recorded', { intentId: payload.intentId, attemptId: target.attemptId, outcome: outcome.kind, state: recorded });
    },
  };
}

function observedFromLookup(found: LookupResult, provider: string): ObservedOutcome {
  switch (found.status) {
    case 'not_found':
      // The adapter contract: lookup by the deduplicated correlation key is authoritative, so nothing happened.
      return { kind: 'final', result: 'failed', providerReference: null, evidence: `${provider} lookup: no operation for this correlation key; no effect` };
    case 'pending':
      return { kind: 'acknowledged', providerReference: found.providerReference };
    case 'final':
      return { kind: 'final', result: found.result, providerReference: found.providerReference, evidence: found.evidence.slice(0, 2000) };
    case 'unknown':
      return { kind: 'unknown', reason: 'ambiguous_response' };
  }
}

export function reconcileHandler(runtime: AssistantRuntime): TransactionalJobHandler<IntentPayload> {
  const providers = new Map(runtime.providers.map((p) => [p.name, p]));
  return {
    kind: ASSISTANT_RECONCILE,
    mode: 'transactional',
    parse: parseIntent,
    async run({ trx, payload }) {
      const target = await assistantWorker.beginReconciliation(trx, payload.intentId);
      if (target.status !== 'reconcile') return;
      const provider = providers.get(target.provider);
      if (!provider) throw new RetryableJobError(`no adapter for provider ${target.provider}`);
      let found: LookupResult;
      try {
        found = await provider.lookup(target.correlationKey);
      } catch (error) {
        throw new RetryableJobError('provider lookup failed; a lookup has no effect and is retried', { cause: error });
      }
      const outcome = observedFromLookup(found, provider.name);
      const state = await assistantWorker.recordReconciliation(trx, payload.intentId, `lookup:${provider.name}:${target.correlationKey}`.slice(0, 200), outcome);
      runtime.log(outcome.kind === 'final' ? 'info' : 'warn', 'assistant action reconciled', { intentId: payload.intentId, lookup: found.status, state });
    },
  };
}

export function assistantSweepTask(runtime: Pick<AssistantRuntime, 'pool' | 'log'>, intervalSeconds = 30): ScheduledTask {
  return {
    name: ASSISTANT_SWEEP_TASK,
    intervalSeconds,
    run: async () => {
      const parked = await inTransaction(runtime.pool, (trx) => assistantWorker.parkStale(trx, 200));
      if (parked > 0) runtime.log('warn', 'assistant attempts without a live lease parked for reconciliation', { parked });
      return { parked };
    },
  };
}

/** Records one asynchronous provider receipt (webhook body already verified by the adapter); duplicates are ignored. */
export function recordAssistantReceipt(pool: DataPool, receipt: { provider: string; account: string; eventId: string; correlationKey: string } & ObservedOutcome): Promise<string> {
  return inTransaction(pool, (trx) => assistantWorker.recordReceipt(trx, receipt));
}

export function registerAssistant(registry: HandlerRegistry, runtime: AssistantRuntime): HandlerRegistry {
  return registry.onJob(dispatchHandler(runtime)).onJob(reconcileHandler(runtime));
}
