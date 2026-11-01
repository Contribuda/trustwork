import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import { sourceWorld } from './source-helpers.js';
import { ok } from './helpers.js';
import type { PaymentAuthorizationView } from '../../packages/contracts/src/payment-sources.js';
import type { PaymentView } from '../../packages/contracts/src/payments.js';
import { reconcilePayment, receivePaymentWebhook } from '../../apps/worker/src/payments/index.js';
const h = await startHarness('payment_deadline');
test('PAY-001 registered phone/QR deadline persists uncertainty without another effect or released hold', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const w = await sourceWorld(h); t.after(async () => { await w.close(); await h.close(); });
  await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client(); await login(buyer, 'petr'); await login(seller, 'carl');
  await w.q("UPDATE trustwork.payment_rail SET rails=ARRAY['qr','push_to_phone'] WHERE connection_id=$1", [w.connectionId]);
  const snapshot = async (id: string) => (await w.q('SELECT p.state,r.state AS hold_state,r.effect_pending FROM trustwork.payment_intent p JOIN trustwork.reservation r ON r.id=p.reservation_id WHERE p.id=$1', [id]))[0]!;
  const lookup = w.fake.lookup.bind(w.fake);
  const prepare = async (rail: 'qr' | 'push_to_phone') => {
    const f = await w.fresh(buyer, seller, seed.people.petr, seed.people.carl);
    const authorization = rail === 'qr' ? f.authorization : ok<PaymentAuthorizationView>(await buyer.post('/v1/payments/sources/authorizations', { ...f.body, rail }), 201);
    for (const client of [buyer, seller]) ok(await client.post(`/v1/payments/sources/authorizations/${authorization.id}/accept`, { digest: authorization.digest }));
    const payment = ok<PaymentView>(await buyer.post('/v1/payments', f.payment), 201);
    await w.tick();
    const [op] = await w.q('SELECT * FROM trustwork.payment_operation WHERE payment_id=$1', [payment.id]);
    return { f, payment, op: op! };
  };
  for (const rail of ['qr', 'push_to_phone'] as const) await t.test(`${rail}: expired provider acknowledgement, missing and aborted lookup, original late receipt`, async () => {
    const { f, payment, op } = await prepare(rail);
    assert.ok(new Date(op.customer_action_deadline as string).getTime() < Date.now());
    assert.equal(ok<PaymentView>(await buyer.get(`/v1/payments/${payment.id}`)).state, 'outcome_unknown');
    assert.deepEqual(await snapshot(payment.id), { state: 'outcome_unknown', hold_state: 'reserved', effect_pending: true });
    const before = (await w.q('SELECT * FROM trustwork.payment_receipt WHERE operation_id=$1', [op!.id])).length;
    try {
      w.fake.lookup = async () => null;
      assert.equal(await reconcilePayment(w.runtime, op!.id as string, AbortSignal.timeout(1000)), 'outcome_unknown');
      w.fake.lookup = async () => new Promise(() => {});
      await assert.rejects(reconcilePayment(w.runtime, op!.id as string, AbortSignal.timeout(50)));
      assert.equal((await w.q('SELECT * FROM trustwork.payment_receipt WHERE operation_id=$1', [op!.id])).length, before);
    } finally { w.fake.lookup = lookup; }
    const raw = w.fake.effects.get(op!.id as string)!;
    const mismatch = w.fake.sign({ ...raw, eventId: `currency-mismatch:${op!.id}`, currency: 'EUR', state: 'succeeded' });
    await assert.rejects(receivePaymentWebhook(w.runtime, w.connectionId, mismatch.raw, mismatch.signature), /binding mismatch/);
    assert.deepEqual(await snapshot(payment.id), { state: 'outcome_unknown', hold_state: 'reserved', effect_pending: true });
    ok(await seller.post(`/v1/payments/sources/${f.payee.participant}/revoke`, { kind: 'participant' }));
    const late = w.fake.sign(w.fake.complete(op!.id as string, 'succeeded', `late-deadline:${op!.id}`));
    assert.equal(await receivePaymentWebhook(w.runtime, w.connectionId, late.raw, late.signature), 'applied');
    assert.equal(await receivePaymentWebhook(w.runtime, w.connectionId, late.raw, late.signature), 'duplicate');
    const reordered = w.fake.sign({ ...raw, eventId: `reordered-expired:${op!.id}` });
    assert.equal(await receivePaymentWebhook(w.runtime, w.connectionId, reordered.raw, reordered.signature), 'ignored');
    assert.equal((await snapshot(payment.id)).state, 'succeeded');
    assert.equal((await snapshot(payment.id)).hold_state, 'settled');
    assert.equal(w.fake.calls.filter((id) => id === op!.id).length, 1);
  });

  const waiting = async (minimum: number) => {
    for (let i = 0; i < 100; i++) {
      const [r] = await w.q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%payments_expire_customer_action%' OR query LIKE '%payments_receipt%')");
      if ((r!.n as number) >= minimum) return;
      await delay(10);
    }
    assert.fail('real payment command did not reach its owning row lock');
  };
  await t.test('deadline advances while reconciliation waits for the intent; no callback/receipt is fabricated', async () => {
    const { payment, op } = await prepare('push_to_phone');
    const deadline = Date.now() + 1200;
    const future = w.fake.sign({ ...w.fake.effects.get(op.id as string)!, eventId: `future-deadline:${op.id}`, customerActionDeadline: new Date(deadline).toISOString() });
    assert.equal(await receivePaymentWebhook(w.runtime, w.connectionId, future.raw, future.signature), 'applied');
    assert.equal((await snapshot(payment.id)).state, 'pending_customer_action');
    const receiptCount = (await w.q('SELECT * FROM trustwork.payment_receipt WHERE operation_id=$1', [op.id])).length;
    const blocker = await h.db.admin.connect();
    let pending: Promise<string> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM trustwork.payment_intent WHERE id=$1 FOR UPDATE', [payment.id]);
      w.fake.lookup = async () => null;
      pending = reconcilePayment(w.runtime, op.id as string, AbortSignal.timeout(4000));
      await waiting(1);
      await delay(Math.max(1, deadline - Date.now() + 30));
      await blocker.query('COMMIT');
      assert.equal(await pending, 'outcome_unknown');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); w.fake.lookup = lookup; await pending?.catch(() => {}); }
    assert.equal(ok<PaymentView>(await buyer.get(`/v1/payments/${payment.id}`)).state, 'outcome_unknown');
    assert.deepEqual(await snapshot(payment.id), { state: 'outcome_unknown', hold_state: 'reserved', effect_pending: true });
    assert.equal((await w.q('SELECT * FROM trustwork.payment_receipt WHERE operation_id=$1', [op.id])).length, receiptCount);
    assert.equal(w.fake.calls.filter((id) => id === op.id).length, 1);
    await assert.rejects(h.pool.query('SELECT trustwork.payments_expire_customer_action($1)', [op.id]), /permission denied/);
  });
  await t.test('an acknowledgement deadline expires while its real receipt waits on settlement', async () => {
    const { payment, op } = await prepare('qr');
    const deadline = Date.now() + 1000;
    const evidence = { ...w.fake.effects.get(op.id as string)!, eventId: `receipt-wait:${op.id}`, customerActionDeadline: new Date(deadline).toISOString() };
    const signed = w.fake.sign(evidence), blocker = await h.db.admin.connect();
    let pending: Promise<string> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM trustwork.payment_intent WHERE id=$1 FOR UPDATE', [payment.id]);
      pending = receivePaymentWebhook(w.runtime, w.connectionId, signed.raw, signed.signature);
      await waiting(1); await delay(Math.max(1, deadline - Date.now() + 30));
      await blocker.query('COMMIT'); assert.equal(await pending, 'applied');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending?.catch(() => {}); }
    assert.deepEqual(await snapshot(payment.id), { state: 'outcome_unknown', hold_state: 'reserved', effect_pending: true });
    const [receipt] = await w.q('SELECT evidence FROM trustwork.payment_receipt WHERE event_id=$1', [evidence.eventId]);
    assert.deepEqual(receipt!.evidence, evidence);
    assert.equal(w.fake.calls.filter((id) => id === op.id).length, 1);
  });
  await t.test('reconciliation job-row contention is bounded independently of provider cancellation', async () => {
    const { payment, op } = await prepare('push_to_phone'), blocker = await h.db.admin.connect();
    const lookups = w.fake.lookups.length;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM trustwork.job WHERE id=$1 FOR UPDATE', [op.job_id]);
      await assert.rejects(reconcilePayment(w.runtime, op.id as string, AbortSignal.timeout(8000)), /statement timeout/);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    assert.deepEqual(await snapshot(payment.id), { state: 'outcome_unknown', hold_state: 'reserved', effect_pending: true });
    assert.equal(w.fake.lookups.length, lookups);
    assert.equal(w.fake.calls.filter((id) => id === op.id).length, 1);
  });
  for (const receiptFirst of [false, true]) await t.test(`deadline and original terminal receipt serialize, receiptFirst=${receiptFirst}`, async () => {
    const { payment, op } = await prepare('qr');
    const deadline = Date.now() + 1200;
    const future = w.fake.sign({ ...w.fake.effects.get(op.id as string)!, eventId: `race-future:${op.id}`, customerActionDeadline: new Date(deadline).toISOString() });
    await receivePaymentWebhook(w.runtime, w.connectionId, future.raw, future.signature);
    const terminal = w.fake.sign(w.fake.complete(op.id as string, 'succeeded', `race-terminal:${op.id}`));
    const blocker = await h.db.admin.connect();
    let expiry: Promise<unknown> | undefined, receipt: Promise<string> | undefined;
    const expire = () => w.pool.query('SELECT trustwork.payments_expire_customer_action($1)', [op.id]);
    const receive = () => receivePaymentWebhook(w.runtime, w.connectionId, terminal.raw, terminal.signature);
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM trustwork.payment_intent WHERE id=$1 FOR UPDATE', [payment.id]);
      if (receiptFirst) receipt = receive(); else expiry = expire();
      await waiting(1);
      if (receiptFirst) expiry = expire(); else receipt = receive();
      await waiting(2);
      await delay(Math.max(1, deadline - Date.now() + 30));
      await blocker.query('COMMIT'); await Promise.all([expiry, receipt]);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.allSettled([expiry, receipt]); }
    assert.equal((await snapshot(payment.id)).state, 'succeeded');
    assert.equal((await snapshot(payment.id)).hold_state, 'settled');
    assert.equal(w.fake.calls.filter((id) => id === op.id).length, 1);
    assert.equal(await receivePaymentWebhook(w.runtime, w.connectionId, terminal.raw, terminal.signature), 'duplicate');
  });
});
