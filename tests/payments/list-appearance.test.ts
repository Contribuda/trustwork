import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { payments } from '../../packages/data/src/repositories/payments.js';
import { sourceWorld } from './source-helpers.js';
import { localPaymentLists } from './local-list-helpers.js';
import { agreement, ok } from './helpers.js';
import { screenEveryoneClear, screen } from '../screening-gates/helpers.js';
import { waitFor } from '../worker/helpers/worker-db.js';
import type { PaymentAuthorizationView, PaymentOutsideView } from '../../packages/contracts/src/payment-sources.js';
import type { PaymentView } from '../../packages/contracts/src/payments.js';
const h = await startHarness('payment_list_appearance');
test('PAY-001 newly configured hub lists and elapsed local-list freshness cannot pass stale payment admission', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const first = await sourceWorld(h, 'synthetic-list-payer'), w = await sourceWorld(h, 'synthetic-list-payee');
  t.after(async () => { await w.close(); await first.close(); await h.close(); });
  const lists = await localPaymentLists(h, first, w); await screenEveryoneClear(h.db.admin); await w.registerIssuer('publisher', 2);
  const buyer = h.client(), seller = h.client(); await login(buyer, 'petr'); await login(seller, 'carl');
  const payer = await first.bind(buyer), payee = await w.bind(seller, true), publisher = await w.registerDecisionPublisher();
  const rescreen = async () => { for (const id of [seed.people.petr, seed.people.carl]) await screen(h.db.admin, { kind: 'person', id }, 'scheduled'); };
  const fresh = async (outside = false) => {
    await w.providerEnabled(true);
    const a = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl)).agreement;
    const bindings = { agreementId: a.id, payerBindingId: payer.participant, payeeBindingId: payee.participant };
    const [order] = await w.q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [a.id]);
    if (outside) {
      await w.providerEnabled(false);
      const decision = ok<PaymentOutsideView>(await buyer.post('/v1/payments/sources/outside-platform', { ...bindings, publisherRegistrationId: publisher.id }), 201);
      ok(await buyer.post(`/v1/payments/sources/outside-platform/${decision.id}/accept`, { digest: decision.digest }));
      return { payment: { agreementId: a.id, budgetId: order!.transaction_budget_id as string }, decision };
    }
    const authorization = ok<PaymentAuthorizationView>(await buyer.post('/v1/payments/sources/authorizations', { ...bindings, accountBindingId: payee.account!, publisherRegistrationId: w.issuers.publisher.id, rail: 'qr' }), 201);
    for (const client of [buyer, seller]) ok(await client.post(`/v1/payments/sources/authorizations/${authorization.id}/accept`, { digest: authorization.digest }));
    return { payment: { agreementId: a.id, budgetId: order!.transaction_budget_id as string }, decision: undefined };
  };
  await w.q("CREATE FUNCTION trustwork.list_payment_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_TABLE_NAME='payment_outside_platform_acceptance' OR NEW.type='payments.requested' THEN PERFORM pg_advisory_xact_lock(827016,1); END IF; RETURN NEW; END $$");
  await w.q('CREATE TRIGGER list_payment_barrier BEFORE INSERT ON trustwork.outbox_event FOR EACH ROW EXECUTE FUNCTION trustwork.list_payment_barrier()');
  // Separate trigger avoids accessing a field that does not exist on the consent row.
  await w.q("CREATE FUNCTION trustwork.list_consent_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(827016,1); RETURN NEW; END $$");
  await w.q('CREATE TRIGGER list_consent_barrier BEFORE INSERT ON trustwork.payment_outside_platform_acceptance FOR EACH ROW EXECUTE FUNCTION trustwork.list_consent_barrier()');
  for (const [world, side] of [[first, 'payer'], [w, 'payee']] as const) for (const surface of ['create', 'worker', 'outside_accept'] as const) for (const writerFirst of [true, false]) await t.test(`${side} configured list appears; actual ${surface}; ${writerFirst ? 'list' : 'payment'} first`, async () => {
    const f = await fresh(surface === 'outside_accept'), proposal = await lists.prepareAdditional(world.hubId);
    const worker = surface === 'worker'; let payment: PaymentView | undefined;
    if (worker) payment = ok(await buyer.post('/v1/payments', f.payment), 201);
    const before = w.fake.calls.length, writer = await h.db.admin.connect(), barrier = await h.db.admin.connect();
    let run: Promise<unknown> | undefined, write: Promise<unknown> | undefined, resume: (() => void) | undefined;
    let response: Awaited<ReturnType<typeof buyer.post>> | undefined;
    const original = payments.dispatchGuard, invoke = w.fake.create.bind(w.fake);
    const request = () => surface === 'outside_accept' ? seller.post(`/v1/payments/sources/outside-platform/${f.decision!.id}/accept`, { digest: f.decision!.digest }) : buyer.post('/v1/payments', f.payment);
    try {
      const p = await w.a.principal(proposal.actor);
      await writer.query('BEGIN'); await writer.query("SET LOCAL statement_timeout='5s'"); await writer.query('SELECT trustwork.set_principal($1,$2)', [p.personId, p.authzEpoch]);
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number;
      const decide = () => writer.query("SELECT trustwork.screening_list_decide($1,$2,'approve',$3,'Synthetic independent list activation')", [JSON.stringify(proposal.ctx), proposal.id, proposal.digest]);
      let reached!: () => void; const ready = new Promise<void>((r) => { reached = r; }), proceed = new Promise<void>((r) => { resume = r; });
      if (worker) {
        if (writerFirst) payments.dispatchGuard = async (...args) => { reached(); await proceed; return original(...args); };
        else w.fake.create = async (i, signal) => { reached(); await proceed; return invoke(i, signal); };
        run = w.tick(); await ready;
      }
      if (writerFirst) {
        await decide();
        if (worker) resume!(); else run = request().then((r) => { response = r; });
        await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_%'")).length > 0, 2000, 'payment waits for new owning list');
        await writer.query('COMMIT'); await run;
        if (response) assert.equal(response.status, 403, JSON.stringify(response.body));
        assert.equal(w.fake.calls.length, before);
      } else {
        if (!worker) {
          await barrier.query('SELECT pg_advisory_lock(827016,1)'); run = request().then((r) => { response = r; });
          await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_%'")).length > 0, 2000, 'actual payment commit boundary');
        }
        write = decide(); await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).length > 0, 2000, 'new list waits for payment authority');
        if (worker) resume!(); else await barrier.query('SELECT pg_advisory_unlock(827016,1)');
        await run; await write; await writer.query('COMMIT');
        if (response) assert.equal(response.status, surface === 'create' ? 201 : 200, JSON.stringify(response.body));
        if (worker) assert.equal(w.fake.calls.length, before + 1);
      }
      if (worker) {
        const [hold] = await w.q('SELECT r.state,r.effect_pending FROM trustwork.reservation r JOIN trustwork.payment_intent p ON p.reservation_id=r.id WHERE p.id=$1', [payment!.id]);
        assert.deepEqual(hold, { state: 'reserved', effect_pending: true });
        await w.runner.tick(); await w.runner.idle(); assert.equal(w.fake.calls.length, before + (writerFirst ? 0 : 1));
      }
    } finally {
      resume?.(); payments.dispatchGuard = original; w.fake.create = invoke;
      await barrier.query('SELECT pg_advisory_unlock_all()'); await writer.query('ROLLBACK'); await Promise.allSettled([run, write]); writer.release(); barrier.release();
      await proposal.finish(); await rescreen(); await w.providerEnabled(true);
      await w.relay.relayOnce(); await w.q("UPDATE trustwork.job SET state='dead' WHERE kind='payments.dispatch' AND state='queued'");
    }
  });
  for (const [list, side] of [[lists.payer, 'payer'], [lists.payee, 'payee']] as const) for (const worker of [false, true]) await t.test(`${side} local list expires after actual ${worker ? 'final worker' : 'HTTP'} domain wait`, async () => {
    const f = await fresh();
    if (worker) ok(await buyer.post('/v1/payments', f.payment), 201);
    // Synthetic age fixture preserves the real interval constraint and actual wall-clock freshness calculation.
    await w.q("UPDATE trustwork.screening_list SET cadence=interval '1 minute',warn_after=interval '1 minute',stale_after=interval '61 seconds',last_checked_at=clock_timestamp()-interval '60 seconds' WHERE id=$1", [list.id]);
    const before = w.fake.calls.length, blocker = await h.db.admin.connect(), original = payments.dispatchGuard;
    let run: Promise<unknown> | undefined, resume: (() => void) | undefined;
    try {
      await blocker.query('BEGIN');
      if (worker) {
        let reached!: () => void; const ready = new Promise<void>((r) => { reached = r; }), proceed = new Promise<void>((r) => { resume = r; });
        payments.dispatchGuard = async (...args) => { reached(); await proceed; return original(...args); };
        run = w.tick(); await ready;
        await blocker.query('SELECT connection_id FROM trustwork.payment_rail WHERE connection_id=$1 FOR UPDATE', [w.connectionId]); resume!();
      } else {
        await blocker.query('SELECT pg_advisory_xact_lock(827016,1)'); run = buyer.post('/v1/payments', f.payment);
      }
      await waitFor(async () => (await w.q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%payments_%'")).length > 0, 2000, 'real payment domain wait');
      await delay(2200); await blocker.query('COMMIT'); const response = await run;
      if (!worker) assert.equal((response as { status: number }).status, 403);
      assert.equal(w.fake.calls.length, before);
    } finally {
      resume?.(); payments.dispatchGuard = original; await blocker.query('ROLLBACK'); blocker.release(); await run;
      await w.q("UPDATE trustwork.screening_list SET cadence=interval '1 day',warn_after=interval '3 days',stale_after=interval '7 days' WHERE id=$1", [list.id]);
      await w.relay.relayOnce(); await w.q("UPDATE trustwork.job SET state='dead' WHERE kind='payments.dispatch' AND state='queued'");
    }
  });
});
