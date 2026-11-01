import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import { paymentHub, agreement, ok } from '../../../payments/helpers.js';
import { screenEveryoneClear } from '../../../screening-gates/helpers.js';
import { kernelReference, kernelSync } from '../../../../packages/data/src/repositories/kernel.js';
import type { PaymentBinding, PaymentView } from '../../../../packages/contracts/src/payments.js';
import { workerLogin } from '../../../assistant/helpers.js';
import { DeterministicPaymentFake, PaymentProviders } from '../../../../apps/worker/src/payments/provider.js';
import { registerPayments } from '../../../../apps/worker/src/payments/index.js';
import { HandlerRegistry } from '../../../../apps/worker/src/handlers.js';
import { defaultWorkerConfig } from '../../../../apps/worker/src/config.js';
import { Metrics } from '../../../../apps/worker/src/metrics.js';
import { OutboxRelay } from '../../../../apps/worker/src/relay.js';
import { JobRunner } from '../../../../apps/worker/src/runner.js';

/** The ordinary BE-005 harness crashes each payment command before and after its real database commit. */
export default {
  name: 'PAY-001: immutable payment intent and bound follow-up operations',
  async run({ h, seed, as, exactlyOnce }) {
    await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
    const hub = await paymentHub(h);
    await screenEveryoneClear(h.db.admin);
    const buyer = await as('petr'), seller = await as('carl');
    const q = async (query: string, args: unknown[] = []) => (await h.db.admin.query(query, args)).rows;
    const worker = await workerLogin(h); const pool = worker.pool(4);
    const fake = new DeterministicPaymentFake();
    const registry = new HandlerRegistry(); registerPayments(registry, { pool, providers: new PaymentProviders(new Map([[hub.connectionId, fake]])) });
    const deps = { pool, registry, config: defaultWorkerConfig({ concurrency: 1, relayBatchSize: 1000 }), metrics: new Metrics(), log: () => {} };
    const relay = new OutboxRelay(deps), runner = new JobRunner(deps);
    const tick = async () => { await relay.relayOnce(); await runner.tick(); await runner.idle(); };
    const fresh = async () => {
      const a = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl)).agreement;
      const binding: PaymentBinding = { agreementId: a.id, agreementDigest: a.acceptedTerms.digest.value, offerVersion: a.acceptedTerms.quoteVersion.version, requestVersion: a.acceptedTerms.rfqVersion.version,
        payer: { kind: 'person', id: seed.people.petr }, payee: { kind: 'person', id: seed.people.carl }, collectingHubId: hub.hubId, payerHubId: hub.hubId, payeeHubId: hub.hubId,
        payerCountry: 'US', payeeCountry: 'US', currency: 'USD', amountMinor: '1250', connectionId: hub.connectionId, connectedAccountCountry: 'US', connectedAccountRef: 'synthetic-crash-account', rail: 'qr', evidenceMode: 'synthetic' };
      await q('INSERT INTO trustwork.payment_source(agreement_id,binding) VALUES($1,$2)', [a.id, binding]);
      const order = (await q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [a.id]))[0]!;
      return { agreementId: a.id, budgetId: order.transaction_budget_id as string };
    };
    try {
      const body = await fresh();
      const payment = ok<PaymentView>(await exactlyOnce({ action: 'payments.create', client: buyer, url: '/v1/payments', body,
        effects: async () => (await q('SELECT id FROM trustwork.payment_intent WHERE agreement_id=$1', [body.agreementId])).length }), 201);
      const [op] = await q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [payment.id]);
      fake.plan(op!.id as string, 'requires_confirmation'); await tick();
      for (const kind of ['confirm', 'connected_account', 'refund'] as const) {
        await exactlyOnce({ action: `payments.${kind}`, client: buyer, url: `/v1/payments/${payment.id}/${kind === 'connected_account' ? 'connected-account' : kind}`, body: {},
          effects: async () => (await q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [payment.id, kind])).length });
        await tick();
      }
      const second = ok<PaymentView>(await buyer.post('/v1/payments', await fresh()), 201);
      const [other] = await q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [second.id]);
      fake.plan(other!.id as string, 'succeeded'); await tick();
      await exactlyOnce({ action: 'payments.payout', client: buyer, url: `/v1/payments/${second.id}/payout`, body: {},
        effects: async () => (await q("SELECT id FROM trustwork.payment_operation WHERE payment_id=$1 AND kind='payout'", [second.id])).length });
    } finally { await pool.end(); await worker.close(); }
  },
} satisfies CrashCase;
