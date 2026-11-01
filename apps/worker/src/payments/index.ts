import { jobs, type DataPool } from '@trustwork/data';
import { PaymentEvidenceSchema, PaymentJobSchema } from '../../../../packages/contracts/src/payments.js';
import { payments } from '../../../../packages/data/src/repositories/payments.js';
import { inTransaction } from '../db.js';
import type { ScheduledTask } from '../scheduler.js';
import type { HandlerRegistry } from '../handlers.js';
import type { PaymentSourceRuntime } from './source-adapter.js';
import { PaymentProviders, awaitPaymentProvider } from './provider.js';

export interface PaymentRuntime {
  pool: DataPool;
  providers: PaymentProviders;
  /** Separate trusted verifier identity. Never grant this command to the raw app/worker role. */
  receiptPool?: DataPool;
  source?: PaymentSourceRuntime;
}

function recordEvidence(runtime: PaymentRuntime, evidence: Parameters<typeof payments.receipt>[1]): Promise<string> {
  if (!runtime.receiptPool) throw new Error('payment verifier unavailable');
  return inTransaction(runtime.receiptPool, (trx) => payments.receipt(trx, evidence));
}

/** Trusted ingress verifies the original bytes before any inbox or semantic state is accepted. */
export async function receivePaymentWebhook(runtime: PaymentRuntime, connectionId: string, raw: Uint8Array, signature: string): Promise<string> {
  const provider = runtime.providers.get(connectionId);
  const evidence = provider.verifyWebhook(raw, signature);
  if (evidence.connectionId !== connectionId || evidence.evidenceMode !== provider.evidenceMode) throw new Error('payment sender mismatch');
  return recordEvidence(runtime, evidence);
}

/** Late outcomes remain consumable after fresh dispatch authority is revoked; lookup never creates an effect. */
export async function reconcilePayment(runtime: PaymentRuntime, operationId: string, signal: AbortSignal): Promise<string> {
  const recorded = await inTransaction(runtime.pool, (trx) => payments.reconcileRecorded(trx, operationId));
  if (recorded) return recorded;
  const instruction = await inTransaction(runtime.pool, (trx) => payments.instruction(trx, operationId));
  if (!instruction) return 'not_dispatched';
  const provider = runtime.providers.get(instruction.binding.connectionId);
  const raw = await awaitPaymentProvider(signal, () => provider.lookup(instruction, signal));
  if (!raw) return 'outcome_unknown';
  const evidence = PaymentEvidenceSchema.parse(raw);
  if (evidence.evidenceMode !== provider.evidenceMode) throw new Error('payment evidence mode mismatch');
  const outcome = await recordEvidence(runtime, evidence);
  await inTransaction(runtime.pool, (trx) => payments.reconcileRecorded(trx, operationId));
  return outcome;
}

export function registerPayments(registry: HandlerRegistry, runtime: PaymentRuntime): void {
  registry.onOutbox({ name: 'payments.enqueue', type: 'payments.requested', parse: PaymentJobSchema.parse,
    async handle(event, ctx) {
      const job = await ctx.enqueue({ kind: 'payments.dispatch', payload: event.payload, maxAttempts: 1 });
      await payments.attachJob(ctx.trx, event.payload.operationId, job.id);
    },
  });
  registry.onJob({ kind: 'payments.dispatch', mode: 'external', parse: PaymentJobSchema.parse,
    async run(ctx) {
      const instruction = await inTransaction(runtime.pool, (trx) => payments.begin(trx, ctx.payload.operationId, ctx.job.id, ctx.job.fencing_token, ctx.attemptId));
      if (!instruction) {
        await reconcilePayment(runtime, ctx.payload.operationId, ctx.signal);
        return;
      }
      const provider = runtime.providers.get(instruction.binding.connectionId);
      if (provider.evidenceMode !== instruction.binding.evidenceMode) throw new Error('payment provider mode mismatch');
      const method = instruction.kind === 'connected_account' ? 'connectedAccount' : instruction.kind;
      const evidence = await inTransaction(runtime.pool, async (trx) => {
        await payments.dispatchGuard(trx, ctx.payload.operationId, ctx.job.id, ctx.job.fencing_token, ctx.attemptId);
        ctx.signal.throwIfAborted();
        return PaymentEvidenceSchema.parse(await awaitPaymentProvider(ctx.signal, () => provider[method](instruction, ctx.signal)));
      });
      if (evidence.evidenceMode !== provider.evidenceMode) throw new Error('payment evidence mode mismatch');
      await recordEvidence(runtime, evidence);
    },
  });
  registry.onJob({ kind: 'payments.reconcile', mode: 'external', parse: PaymentJobSchema.parse,
    async run(ctx) { await reconcilePayment(runtime, ctx.payload.operationId, ctx.signal); },
  });
}

/** Only lookups recur: provider uncertainty never becomes a new create/confirm/refund/payout operation. */
export function paymentReconcileTask(runtime: PaymentRuntime): ScheduledTask {
  return { name: 'payments.lookup_due', intervalSeconds: 60,
    run: () => inTransaction(runtime.pool, async (trx) => {
      const due = await payments.reconcileDue(trx);
      for (const operationId of due) await jobs.enqueue(trx, { kind: 'payments.reconcile', payload: { operationId }, max_attempts: 1 });
      return { queued: due.length };
    }),
  };
}
