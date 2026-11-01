import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance, jobs } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import { workerLogin } from '../assistant/helpers.js';
import { agreement, paymentHub, ok } from './helpers.js';
import type { PaymentBinding, PaymentView } from '../../packages/contracts/src/payments.js';
import { PaymentProviders, DeterministicPaymentFake } from '../../apps/worker/src/payments/provider.js';
import { receivePaymentWebhook, reconcilePayment, registerPayments, paymentReconcileTask } from '../../apps/worker/src/payments/index.js';
import { payments } from '../../packages/data/src/repositories/payments.js';
import { HandlerRegistry } from '../../apps/worker/src/handlers.js';
import { defaultWorkerConfig } from '../../apps/worker/src/config.js';
import { Metrics } from '../../apps/worker/src/metrics.js';
import { OutboxRelay } from '../../apps/worker/src/relay.js';
import { JobRunner } from '../../apps/worker/src/runner.js';
import { startPaymentIngress } from '../../apps/worker/src/payments/ingress.js';
import { inTransaction } from '../../apps/worker/src/db.js';

const h = await startHarness('payments_runtime');
test('payments: real API, worker, immutable receipts and BILL holds', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const hub = await paymentHub(h);
  await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client(), outsider = h.client();
  await login(buyer, 'petr'); await login(seller, 'carl'); await login(outsider, 'anna');
  const worker = await workerLogin(h);
  const pool = worker.pool(4);
  t.after(async () => { await pool.end(); await worker.close(); });
  const fake = new DeterministicPaymentFake();
  const providers = new PaymentProviders(new Map([[hub.connectionId, fake]]));
  const runtime = { pool, providers };
  const registry = new HandlerRegistry(); registerPayments(registry, runtime);
  const config = defaultWorkerConfig({ concurrency: 1, relayBatchSize: 1000 });
  const logs: unknown[] = [];
  const deps = { pool, registry, config, metrics: new Metrics(), log: (...args: unknown[]) => { logs.push(args); } };
  const relay = new OutboxRelay(deps), runner = new JobRunner(deps);
  const tick = async () => { await relay.relayOnce(); await runner.tick(); await runner.idle(); };
  const q = async (query: string, args: unknown[] = []) => (await h.db.admin.query(query, args)).rows;
  const fresh = async (amount = '1250', override: Partial<PaymentBinding> = {}) => {
    const a = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl, amount)).agreement;
    const binding: PaymentBinding = { agreementId: a.id, agreementDigest: a.acceptedTerms.digest.value,
      offerVersion: a.acceptedTerms.quoteVersion.version, requestVersion: a.acceptedTerms.rfqVersion.version,
      payer: { kind: 'person', id: seed.people.petr }, payee: { kind: 'person', id: seed.people.carl },
      collectingHubId: hub.hubId, payerHubId: hub.hubId, payeeHubId: hub.hubId, payerCountry: 'US', payeeCountry: 'US', currency: 'USD', amountMinor: amount,
      connectionId: hub.connectionId, connectedAccountRef: 'synthetic-connected-payee', rail: 'qr', evidenceMode: 'synthetic', ...override };
    // This labelled synthetic fixture does not claim that an owning projection publisher exists in production.
    await q('INSERT INTO trustwork.payment_source(agreement_id,binding) VALUES($1,$2)', [a.id, binding]);
    const order = (await q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [a.id]))[0]!;
    return { agreementId: a.id, budgetId: order.transaction_budget_id as string };
  };
  const operation = async (id: string, kind = 'create') => (await q('SELECT * FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [id, kind]))[0]!;
  const reservation = async (id: string) => (await q('SELECT r.* FROM trustwork.reservation r JOIN trustwork.payment_intent p ON p.reservation_id=r.id WHERE p.id=$1', [id]))[0]!;
  let first: PaymentView;
  await t.test('HTTP rejects identity overrides, missing owning source and outsiders; source amount is exact', async () => {
    assert.equal((await h.client().post('/v1/payments', {})).status, 401);
    assert.equal((await buyer.post('/v1/payments', {})).status, 422);
    const body = await fresh();
    assert.equal((await buyer.post('/v1/payments', { ...body, amountMinor: '1' })).status, 422);
    assert.equal((await outsider.post('/v1/payments', body)).status, 403);
    first = ok(await buyer.post('/v1/payments', body), 201);
    assert.equal(first.funds, 'synthetic_no_money_moves');
    assert.equal(ok<PaymentView>(await buyer.post('/v1/payments', body), 201).id, first.id);
    assert.equal((await outsider.get(`/v1/payments/${first.id}`)).status, 403);
    const bad = await fresh('1250', { amountMinor: '1251' });
    assert.equal((await buyer.post('/v1/payments', bad)).status, 403);
  });
  await t.test('actual relay and worker dispatch once; QR deadline never releases the BILL hold', async () => {
    await tick();
    const op = await operation(first.id);
    assert.equal(op.state, 'pending_customer_action', JSON.stringify(logs));
    assert.equal((await reservation(first.id)).effect_pending, true);
    assert.equal(ok<PaymentView>(await buyer.get(`/v1/payments/${first.id}`)).state, 'pending_customer_action');
    assert.equal(await reconcilePayment(runtime, op.id, AbortSignal.timeout(1000)), 'duplicate');
    assert.equal((await reservation(first.id)).effect_pending, true);
  });
  await t.test('signature before inbox; conflicting and reordered outcomes cannot settle twice; late receipt ignores fresh source revocation', async () => {
    const op = await operation(first.id);
    const evidence = fake.complete(op.id, 'succeeded', 'synthetic-success');
    const signed = fake.sign(evidence);
    await assert.rejects(receivePaymentWebhook(runtime, hub.connectionId, signed.raw, 'bad'));
    assert.equal((await q('SELECT * FROM trustwork.payment_receipt WHERE event_id=$1', [evidence.eventId])).length, 0);
    await q('UPDATE trustwork.payment_source SET revoked_at=clock_timestamp() WHERE agreement_id=$1', [first.agreementId]);
    assert.equal(await receivePaymentWebhook(runtime, hub.connectionId, signed.raw, signed.signature), 'applied');
    assert.equal(await receivePaymentWebhook(runtime, hub.connectionId, signed.raw, signed.signature), 'duplicate');
    const conflicting = fake.sign({ ...evidence, eventId: 'synthetic-conflict', state: 'failed' });
    assert.equal(await receivePaymentWebhook(runtime, hub.connectionId, conflicting.raw, conflicting.signature), 'conflict');
    assert.equal((await operation(first.id)).state, 'succeeded');
    assert.equal((await reservation(first.id)).state, 'settled');
    assert.equal((await buyer.post(`/v1/payments/${first.id}/refund`, {})).status, 403);
    await assert.rejects(pool.query('SELECT * FROM trustwork.payment_intent'), /permission denied/);
    await assert.rejects(h.pool.query('SELECT trustwork.payments_receipt($1)', [evidence]), /permission denied/);
  });
  await t.test('unsupported routes return outside_platform; restricted countries and remote authority refuse before provider invocation', async () => {
    const before = fake.calls.length;
    const badPlace = await fresh('1250', { payeeCountry: 'RU' });
    assert.equal((await buyer.post('/v1/payments', badPlace)).status, 403);
    const remote = await fresh('1250', { payeeHubId: '00000000-0000-4000-8000-000000000001' });
    assert.equal((await buyer.post('/v1/payments', remote)).status, 403);
    const unsupported = await fresh('1250', { rail: 'ach' });
    const view = ok<PaymentView>(await buyer.post('/v1/payments', unsupported), 201);
    assert.equal(view.state, 'outside_platform');
    assert.equal((await q('SELECT * FROM trustwork.payment_operation WHERE payment_id=$1', [view.id])).length, 0);
    assert.equal(fake.calls.length, before);
  });
  await t.test('lost acknowledgement retains the original hold; scheduler only looks up the original effect after revocation', async () => {
    const view = ok<PaymentView>(await buyer.post('/v1/payments', await fresh()), 201);
    const op = await operation(view.id);
    fake.plan(op.id, 'succeeded', true);
    await tick();
    assert.equal((await operation(view.id)).state, 'outcome_unknown');
    assert.equal((await reservation(view.id)).state, 'reserved');
    assert.equal((await reservation(view.id)).effect_pending, true);
    await q('UPDATE trustwork.payment_source SET revoked_at=clock_timestamp() WHERE agreement_id=$1', [view.agreementId]);
    assert.equal((await paymentReconcileTask(runtime).run()).queued, 1);
    await runner.tick(); await runner.idle();
    assert.equal((await operation(view.id)).state, 'succeeded');
    assert.equal(fake.calls.filter((id) => id === op.id).length, 1);
    assert.ok(fake.lookups.includes(op.id));
  });
  await t.test('full refund and connected payout bind the exact successful original and cannot overlap or change destination', async () => {
    for (const kind of ['refund', 'payout'] as const) {
      const view = ok<PaymentView>(await buyer.post('/v1/payments', await fresh()), 201);
      const original = await operation(view.id); fake.plan(original.id, 'succeeded'); await tick();
      assert.equal((await buyer.post(`/v1/payments/${view.id}/${kind}`, { amountMinor: '1', destination: 'unbound' })).status, 422);
      const action = ok<{ operationId: string }>(await buyer.post(`/v1/payments/${view.id}/${kind}`, {}));
      assert.equal(ok<{ operationId: string }>(await buyer.post(`/v1/payments/${view.id}/${kind}`, {})).operationId, action.operationId);
      assert.equal((await buyer.post(`/v1/payments/${view.id}/${kind === 'refund' ? 'payout' : 'refund'}`, {})).status, 422);
      await tick();
      const done = await operation(view.id, kind);
      assert.equal(done.state, 'succeeded', JSON.stringify(logs));
      assert.equal(done.original_provider_ref, (await operation(view.id)).provider_ref);
      assert.equal((await reservation(view.id)).refunded_minor, kind === 'refund' ? '1250' : '0');
    }
  });
  await t.test('real raw HTTP ingress authenticates bytes; competing terminal callbacks settle only once', async () => {
    const view = ok<PaymentView>(await buyer.post('/v1/payments', await fresh()), 201); await tick();
    const op = await operation(view.id);
    const evidence = fake.complete(op.id, 'succeeded', 'race-success');
    const ingress = await startPaymentIngress(runtime, 0);
    try {
      const url = `http://127.0.0.1:${ingress.port}/payments/${hub.connectionId}`;
      const signed = fake.sign(evidence);
      const rejected = await fetch(url, { method: 'POST', body: Buffer.from(signed.raw), headers: { 'payment-signature': 'invalid' } });
      assert.equal(rejected.status, 400);
      const failure = fake.sign({ ...evidence, state: 'failed', eventId: 'race-failure' });
      const results = await Promise.all([signed, failure].map((x) => fetch(url, { method: 'POST', body: Buffer.from(x.raw), headers: { 'payment-signature': x.signature } })));
      assert.deepEqual(results.map((r) => r.status), [204, 204]);
      assert.deepEqual((await q('SELECT disposition FROM trustwork.payment_receipt WHERE operation_id=$1 AND event_id LIKE $2 ORDER BY disposition', [op.id, 'race-%'])).map((r) => r.disposition), ['applied', 'conflict']);
      const state = (await operation(view.id)).state;
      assert.equal((await reservation(view.id)).state, state === 'succeeded' ? 'settled' : 'released');
    } finally { await ingress.close(); }
  });
  await t.test('actual leased attempt is fenced; crash after the durable marker but before invocation never resends', async () => {
    const view = ok<PaymentView>(await buyer.post('/v1/payments', await fresh()), 201);
    await relay.relayOnce();
    const [job] = await inTransaction(pool, (trx) => jobs.lease(trx, ['payments.dispatch'], 'synthetic-crash', 60, 1));
    assert.ok(job);
    const op = await operation(view.id);
    await assert.rejects(inTransaction(pool, (trx) => payments.begin(trx, op.id, job.id, '0', `${job.id}:${job.attempt}`)), /stale payment attempt/);
    await inTransaction(pool, (trx) => payments.begin(trx, op.id, job.id, job.fencing_token, `${job.id}:${job.attempt}`));
    assert.equal(await reconcilePayment(runtime, op.id, AbortSignal.timeout(1000)), 'outcome_unknown');
    assert.equal(await inTransaction(pool, (trx) => payments.begin(trx, op.id, job.id, job.fencing_token, `${job.id}:${job.attempt}`)), null);
    assert.equal(fake.calls.filter((id) => id === op.id).length, 0);
    assert.equal((await reservation(view.id)).effect_pending, true);
  });
  await t.test('both-order competing connections serialize final dispatch with source revocation', async () => {
    for (const revokeFirst of [true, false]) {
      const view = ok<PaymentView>(await buyer.post('/v1/payments', await fresh()), 201);
      await relay.relayOnce();
      const [job] = await inTransaction(pool, (trx) => jobs.lease(trx, ['payments.dispatch'], 'synthetic-race', 60, 1));
      assert.ok(job);
      const op = await operation(view.id);
      const attempt = `${job.id}:${job.attempt}`;
      const instruction = await inTransaction(pool, (trx) => payments.begin(trx, op.id, job.id, job.fencing_token, attempt));
      assert.ok(instruction);
      const writer = await h.db.admin.connect();
      try {
        const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout='2s'");
        if (revokeFirst) {
          await writer.query('UPDATE trustwork.payment_source SET revoked_at=clock_timestamp() WHERE agreement_id=$1', [view.agreementId]);
          const refusal = assert.rejects(inTransaction(pool, async (trx) => { await payments.dispatchGuard(trx, op.id, job.id, job.fencing_token, attempt); await fake.create(instruction, AbortSignal.timeout(1000)); }), /owning payment projection unavailable/);
          await writer.query('COMMIT'); await refusal;
          assert.equal(fake.calls.filter((id) => id === op.id).length, 0);
        } else {
          let release!: () => void; const releasePromise = new Promise<void>((r) => { release = r; });
          let entered!: () => void; const enteredPromise = new Promise<void>((r) => { entered = r; });
          const dispatched = inTransaction(pool, async (trx) => { await payments.dispatchGuard(trx, op.id, job.id, job.fencing_token, attempt); entered(); await releasePromise; return fake.create(instruction, AbortSignal.timeout(1000)); });
          await enteredPromise;
          let revoked = false;
          const revocation = writer.query('UPDATE trustwork.payment_source SET revoked_at=clock_timestamp() WHERE agreement_id=$1', [view.agreementId]).then(() => { revoked = true; });
          // Observe the actual blocked writer, not a timing-based guess.
          for (let i = 0; i < 100; i++) {
            if ((await q("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).length) break;
            if (i === 99) assert.fail('source revocation did not block');
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(revoked, false); release();
          const receipt = await dispatched; await revocation; await writer.query('COMMIT');
          await inTransaction(pool, (trx) => payments.receipt(trx, receipt));
          assert.equal(fake.calls.filter((id) => id === op.id).length, 1);
        }
      } finally { await writer.query('ROLLBACK'); writer.release(); }
    }
  });

});
