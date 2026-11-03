import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { decideMatches, LISTED_PERSON_NAME, rename, screen, screenEveryoneClear, setBaselineStale } from '../screening-gates/helpers.js';
import { COUNTERPARTY_FORBIDDEN_GATE_KEYS } from '../../packages/contracts/src/screening-gates.js';
import { workerLogin } from '../assistant/helpers.js';
import { agreement, paymentHub, paymentVerifier, ok } from './helpers.js';
import type { PaymentBinding, PaymentView } from '../../packages/contracts/src/payments.js';
import { PaymentProviders, DeterministicPaymentFake } from '../../apps/worker/src/payments/provider.js';
import { receivePaymentWebhook, registerPayments } from '../../apps/worker/src/payments/index.js';
import { HandlerRegistry } from '../../apps/worker/src/handlers.js';
import { defaultWorkerConfig } from '../../apps/worker/src/config.js';
import { Metrics } from '../../apps/worker/src/metrics.js';
import { OutboxRelay } from '../../apps/worker/src/relay.js';
import { JobRunner } from '../../apps/worker/src/runner.js';

const h = await startHarness('payments_payout_gate');
test('PAY-001 payout account and payout ask the SANC-004 gate; restricted places and foreign money refuse before the provider', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const hub = await paymentHub(h, 'synthetic-payout-gate');
  await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client();
  await login(buyer, 'petr'); await login(seller, 'carl');
  const worker = await workerLogin(h), pool = worker.pool(4), verifier = await paymentVerifier(h);
  t.after(async () => { await pool.end(); await worker.close(); await verifier.close(); await h.close(); });
  const fake = new DeterministicPaymentFake();
  const runtime = { pool, providers: new PaymentProviders(new Map([[hub.connectionId, fake]])), receiptPool: verifier.pool };
  const registry = new HandlerRegistry(); registerPayments(registry, runtime);
  const deps = { pool, registry, config: defaultWorkerConfig({ concurrency: 1, relayBatchSize: 1000 }), metrics: new Metrics(), log: () => {} };
  const relay = new OutboxRelay(deps), runner = new JobRunner(deps);
  const tick = async () => { await relay.relayOnce(); await runner.tick(); await runner.idle(); };
  const q = async (query: string, args: unknown[] = []) => (await h.db.admin.query(query, args)).rows;
  const payee = { kind: 'person' as const, id: seed.people.carl };
  const payeeName = (await q('SELECT display_name FROM trustwork.person WHERE id=$1', [payee.id]))[0]!.display_name as string;
  /** Labelled synthetic owning projection, as in runtime.test.ts; it claims no production publisher. */
  const fresh = async (override: Partial<PaymentBinding> = {}) => {
    const a = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl, '1250')).agreement;
    const binding: PaymentBinding = { agreementId: a.id, agreementDigest: a.acceptedTerms.digest.value,
      offerVersion: a.acceptedTerms.quoteVersion.version, requestVersion: a.acceptedTerms.rfqVersion.version,
      payer: { kind: 'person', id: seed.people.petr }, payee, collectingHubId: hub.hubId, payerHubId: hub.hubId, payeeHubId: hub.hubId,
      payerCountry: 'US', payeeCountry: 'US', currency: 'USD', amountMinor: '1250', connectionId: hub.connectionId,
      connectedAccountCountry: 'US', connectedAccountRef: 'synthetic-gate-payee', rail: 'qr', evidenceMode: 'synthetic', ...override };
    await q('INSERT INTO trustwork.payment_source(agreement_id,binding) VALUES($1,$2)', [a.id, binding]);
    const order = (await q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [a.id]))[0]!;
    return { agreementId: a.id, budgetId: order.transaction_budget_id as string };
  };
  const operation = async (paymentId: string, kind: string) => (await q('SELECT * FROM trustwork.payment_operation WHERE payment_id=$1 AND kind=$2', [paymentId, kind]))[0];
  const reservation = async (paymentId: string) => (await q('SELECT r.state,r.effect_pending,r.refunded_minor::text AS refunded_minor FROM trustwork.reservation r JOIN trustwork.payment_intent p ON p.reservation_id=r.id WHERE p.id=$1', [paymentId]))[0]!;
  const gateState = async () => (await q("SELECT money_held, reasons FROM trustwork.screening_gate_check(ARRAY['person'], ARRAY[$1::uuid])", [payee.id]))[0]!;
  /** The owning screening path: the payee's name meets a synthetic baseline entry, so money is held pending review. */
  const holdPayee = async () => {
    await rename(h.db.admin, payee, LISTED_PERSON_NAME);
    assert.equal((await screen(h.db.admin, payee, 'payee')).outcome, 'possible_match');
    assert.deepEqual(await gateState(), { money_held: true, reasons: ['review_pending'] });
  };
  /** Two reviewers decide "not the same person"; the payee's original synthetic name is screened clear again. */
  const clearPayee = async () => {
    await decideMatches(h.db.admin, payee, 'not_same_person');
    await rename(h.db.admin, payee, payeeName);
    assert.equal((await screen(h.db.admin, payee, 'payee')).outcome, 'clear');
    assert.deepEqual(await gateState(), { money_held: false, reasons: [] });
  };
  const charged = async () => {
    const view = ok<PaymentView>(await buyer.post('/v1/payments', await fresh()), 201);
    const create = (await operation(view.id, 'create'))!;
    fake.plan(create.id as string, 'succeeded');
    await tick();
    assert.equal((await operation(view.id, 'create'))!.state, 'succeeded');
    assert.equal((await reservation(view.id)).state, 'settled');
    return view;
  };
  const forbidden = new RegExp(`"(?:${COUNTERPARTY_FORBIDDEN_GATE_KEYS.join('|')}|review_pending|possible_match|lists_unavailable)"`);
  const refused = async (paymentId: string, action: 'connected-account' | 'payout', before: number) => {
    const response = await buyer.post(`/v1/payments/${paymentId}/${action}`, {});
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.doesNotMatch(JSON.stringify(response.body), forbidden, 'the payer learns nothing about the payee\'s screening');
    assert.equal(await operation(paymentId, action === 'connected-account' ? 'connected_account' : 'payout'), undefined, 'no operation is reserved');
    assert.equal(fake.calls.length, before, 'no provider call');
    assert.equal((await q("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE type='payments.requested' AND aggregate_id=$1", [paymentId]))[0]!.n, 1, 'no new outbox instruction');
  };

  await t.test('a payee whose money is held pending review refuses payout account creation and payout before any provider call', async () => {
    const view = await charged();
    await holdPayee();
    try {
      const before = fake.calls.length;
      await refused(view.id, 'connected-account', before);
      await refused(view.id, 'payout', before);
      assert.equal((await reservation(view.id)).refunded_minor, '0');
    } finally { await clearPayee(); }
    const account = ok<{ operationId: string }>(await buyer.post(`/v1/payments/${view.id}/connected-account`, {}));
    await tick();
    assert.equal((await operation(view.id, 'connected_account'))!.state, 'succeeded');
    assert.equal((await operation(view.id, 'connected_account'))!.id, account.operationId);
  });

  await t.test('an unknown answer refuses a payout: an unscreened payee, stale baseline lists; the payout proceeds once the answer is clear', async () => {
    const view = await charged();
    const before = fake.calls.length;
    await q("UPDATE trustwork.screening_subject_state SET last_outcome='not_screened' WHERE subject_person_id=$1", [payee.id]);
    try { await refused(view.id, 'payout', before); } finally { await screenEveryoneClear(h.db.admin); }
    await setBaselineStale(h.db.admin, true);
    try { await refused(view.id, 'payout', before); } finally { await setBaselineStale(h.db.admin, false); }
    const payout = ok<{ operationId: string }>(await buyer.post(`/v1/payments/${view.id}/payout`, {}));
    await tick();
    const done = (await operation(view.id, 'payout'))!;
    assert.equal(done.id, payout.operationId);
    assert.equal(done.state, 'succeeded');
    assert.equal(done.original_provider_ref, (await operation(view.id, 'create'))!.provider_ref);
    assert.equal(fake.calls.length, before + 1);
  });

  await t.test('the worker asks the gate again at dispatch: a hold decided after HTTP admission stops the payout before the provider', async () => {
    const view = await charged();
    ok<{ operationId: string }>(await buyer.post(`/v1/payments/${view.id}/payout`, {}));
    await holdPayee();
    const before = fake.calls.length;
    try {
      await tick();
      const op = (await operation(view.id, 'payout'))!;
      assert.equal(op.state, 'queued');
      assert.equal(op.invoked_at, null, 'the durable marker proves the provider was never asked');
      assert.equal(fake.calls.length, before);
      assert.deepEqual(await reservation(view.id), { state: 'settled', effect_pending: true, refunded_minor: '0' });
      const job = (await q('SELECT state FROM trustwork.job WHERE id=$1', [op.job_id]))[0]!;
      assert.ok(['outcome_unknown', 'dead', 'failed'].includes(job.state as string), job.state as string);
    } finally { await clearPayee(); }
  });

  await t.test('a restricted payee or connected-account place refuses at creation, before the provider and before any hold', async () => {
    const before = fake.calls.length;
    for (const override of [{ connectedAccountCountry: 'RU' }, { payeeCountry: 'CU' }, { payerCountry: 'RU' }] as const) {
      const body = await fresh(override);
      assert.equal((await buyer.post('/v1/payments', body)).status, 403, JSON.stringify(override));
      assert.equal((await q('SELECT 1 FROM trustwork.payment_intent WHERE agreement_id=$1', [body.agreementId])).length, 0);
      assert.equal((await q('SELECT effect_pending FROM trustwork.reservation r JOIN trustwork.commercial_order o ON o.reservation_id=r.id WHERE o.agreement_id=$1', [body.agreementId]))[0]!.effect_pending, false);
    }
    assert.equal(fake.calls.length, before);
  });

  await t.test('rails cannot serve a restricted place or contradict their connection, even when the owner writes them', async () => {
    const insert = (columns: Record<string, unknown>) => {
      const row: Record<string, unknown> = { connection_id: hub.connectionId, currencies: ['USD'], countries: ['US'], rails: ['qr'], capabilities: ['create', 'confirm', 'refund', 'payout', 'connected_account'], custody: 'provider_connected_accounts', evidence_mode: 'synthetic', approval_ref: 'synthetic-guard-case', ...columns };
      const keys = Object.keys(row);
      return h.db.admin.query(`INSERT INTO trustwork.payment_rail(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => row[k]));
    };
    // A second, payments-only draft connection of the same hub (the connection guard owns restricted processing places).
    const other = (await q("INSERT INTO trustwork.provider_connection(hub_id,adapter_id,label,capabilities,mode,endpoint,hosting_kind,processing_country,storage_country,region,zero_retention,trains_on_inputs,broker,created_by) SELECT hub_id,adapter_id,'Synthetic guard connection',ARRAY['payments'],mode,endpoint,hosting_kind,processing_country,storage_country,region,zero_retention,trains_on_inputs,broker,created_by FROM trustwork.provider_connection WHERE id=$1 RETURNING id", [hub.connectionId]))[0]!.id as string;
    for (const [columns, reason] of [
      [{ connection_id: other, countries: ['US', 'RU'] }, /restricted or unknown place/],
      [{ connection_id: other, countries: ['CU'] }, /restricted or unknown place/],
      [{ connection_id: other, countries: ['us'] }, /restricted or unknown place/],
      [{ connection_id: other, evidence_mode: 'licensed_provider' }, /evidence mode must match/],
      [{ connection_id: other, custody: 'operator_account' }, /connected accounts|check constraint/],
      [{ connection_id: other, capabilities: ['create', 'payout'] }, /payouts-capable/],
      [{ connection_id: other, capabilities: ['create'], rails: ['hawala'] }, /unknown payment rail kind/],
      [{ connection_id: other, capabilities: ['create'], currencies: ['usd'] }, /ISO 4217/],
      [{ connection_id: '00000000-0000-4000-8000-00000000dead' }, /provider connection|foreign key/],
    ] as const) await assert.rejects(insert(columns), reason, JSON.stringify(columns));
    // The connection guard (PROV) already refuses a connection in a restricted place; the rail guard repeats the check.
    await assert.rejects(q("UPDATE trustwork.provider_connection SET processing_country='RU' WHERE id=$1", [other]), /restricted place/);
    await insert({ connection_id: other, capabilities: ['create'] });
    await assert.rejects(q("UPDATE trustwork.payment_rail SET countries=array_append(countries,'RU') WHERE connection_id=$1", [other]), /restricted or unknown place/);
    await assert.rejects(q("UPDATE trustwork.payment_rail SET evidence_mode='licensed_provider' WHERE connection_id=$1", [other]), /evidence mode/);
    await assert.rejects(q('UPDATE trustwork.payment_rail SET connection_id=$2 WHERE connection_id=$1', [other, hub.connectionId]), /immutable|duplicate key/);
    assert.deepEqual((await q('SELECT countries FROM trustwork.payment_rail WHERE connection_id=$1', [other]))[0], { countries: ['US'] });
    await q('DELETE FROM trustwork.payment_rail WHERE connection_id=$1', [other]);
    for (const raw of [h.pool, pool]) await assert.rejects(raw.query("INSERT INTO trustwork.payment_rail(connection_id,currencies,countries,rails,capabilities,custody,evidence_mode,approval_ref) VALUES($1,ARRAY['USD'],ARRAY['US'],ARRAY['qr'],ARRAY['create'],'provider_connected_accounts','synthetic','forged')", [other]), /permission denied/);
  });

  await t.test('payout evidence in another currency or amount is a binding mismatch, never a conversion; the ledger does not move', async () => {
    const view = await charged();
    ok<{ operationId: string }>(await buyer.post(`/v1/payments/${view.id}/payout`, {}));
    const pending = (await operation(view.id, 'payout'))!;
    fake.plan(pending.id as string, 'outcome_unknown');
    await tick();
    assert.equal((await operation(view.id, 'payout'))!.state, 'outcome_unknown');
    const raw = fake.effects.get(pending.id as string)!;
    const receipts = async () => (await q('SELECT count(*)::int AS n FROM trustwork.payment_receipt WHERE operation_id=$1', [pending.id]))[0]!.n as number;
    const before = await receipts();
    for (const [name, evidence] of [
      ['currency', { ...raw, eventId: `eur:${pending.id}`, currency: 'EUR', state: 'succeeded' }],
      ['amount', { ...raw, eventId: `cents:${pending.id}`, amountMinor: '1249', state: 'succeeded' }],
      ['larger amount', { ...raw, eventId: `more:${pending.id}`, amountMinor: '125000', state: 'succeeded' }],
      ['destination', { ...raw, eventId: `account:${pending.id}`, connectedAccountRef: 'synthetic-other-account', state: 'succeeded' }],
    ] as const) {
      const signed = fake.sign(evidence);
      await assert.rejects(receivePaymentWebhook(runtime, hub.connectionId, signed.raw, signed.signature), /binding mismatch/, name);
    }
    assert.equal(await receipts(), before);
    assert.equal((await operation(view.id, 'payout'))!.state, 'outcome_unknown');
    assert.deepEqual(await reservation(view.id), { state: 'settled', effect_pending: true, refunded_minor: '0' });
    const exact = fake.sign(fake.complete(pending.id as string, 'succeeded', `exact:${pending.id}`));
    assert.equal(await receivePaymentWebhook(runtime, hub.connectionId, exact.raw, exact.signature), 'applied');
    assert.equal((await operation(view.id, 'payout'))!.state, 'succeeded');
    assert.deepEqual(await reservation(view.id), { state: 'settled', effect_pending: true, refunded_minor: '0' });
  });
});
