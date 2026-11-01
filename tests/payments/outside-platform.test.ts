import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { providerConnections } from '../../packages/data/src/repositories/providers.js';
import { paymentSources } from '../../packages/data/src/repositories/payment-sources.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import { sourceWorld } from './source-helpers.js';
import { localPaymentLists } from './local-list-helpers.js';
import { agreement, ok } from './helpers.js';
import { PaymentAgreementSettlementSchema, PaymentSettlementOptionsSchema, type PaymentOutsideView } from '../../packages/contracts/src/payment-sources.js';
const h = await startHarness('payment_outside');
test('PAY-001 actual bilateral outside-platform outcome has a consumed private agreement projection and no financial effect', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const first = await sourceWorld(h, 'synthetic-outside-payer'), second = await sourceWorld(h, 'synthetic-outside-payee');
  t.after(async () => { await second.close(); await first.close(); await h.close(); });
  await localPaymentLists(h, first, second); await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client(), outsider = h.client(); await login(buyer, 'petr'); await login(seller, 'carl'); await login(outsider, 'anna');
  const payer = await first.bind(buyer), payee = await second.bind(seller);
  const accepted = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl)).agreement;
  const input = { agreementId: accepted.id, payerBindingId: payer.participant, payeeBindingId: payee.participant };
  const optionsUrl = `/v1/payments/sources/agreements/${accepted.id}/options?payerBindingId=${payer.participant}&payeeBindingId=${payee.participant}`;
  const settlementUrl = `/v1/payments/sources/agreements/${accepted.id}/settlement`;
  const ctx = await second.a.elevate(second.w.people.owner);
  const publisher = await second.install((trx) => paymentSources.proposeAdapter(trx, ctx, { schemaVersion: 2, hubId: second.hubId, fact: 'outside_platform_publisher',
    implementationDigest: createHash('sha256').update('synthetic-outside-platform-publisher-v1').digest('hex'), evidenceMode: 'synthetic', expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  const approval = await second.approveDigest(second.w.people.owner, second.w.people.officer, 'payments.register_source_adapter', publisher.digest);
  await second.install((trx) => paymentSources.activateAdapter(trx, ctx, publisher.id, approval));
  const draftInput = { ...input, publisherRegistrationId: publisher.id };
  await t.test('options select the actual payee collector, are safe, and an eligible provider prevents no-route consent', async () => {
    const options = PaymentSettlementOptionsSchema.parse(ok(await buyer.get(optionsUrl)));
    assert.equal(options.collectingHubId, second.hubId); assert.equal(options.payerHubId, first.hubId);
    assert.deepEqual(options.candidates.map((c) => c.connectionId), [second.connectionId]);
    assert.doesNotMatch(JSON.stringify(options), /accountRef|providerEntity|residencePlace|proofDigest|verifiedSubject/);
    assert.equal((await outsider.get(optionsUrl)).status, 403);
    assert.equal((await buyer.post('/v1/payments/sources/outside-platform', draftInput)).status, 403);
    for (const pool of [h.pool, first.pool]) {
      for (const sql of ['SELECT trustwork.payments_collecting_candidates($1,\'US\',\'US\',\'USD\')', 'SELECT trustwork.payments_candidate_lock()', 'SELECT trustwork.payments_local_context(NULL,\'{}\')'])
        await assert.rejects(pool.query(sql, sql.includes('$1') ? [second.hubId] : []), /permission denied/);
    }
  });
  await second.a.cmd(second.w.people.owner, async (trx, c) => providerConnections.disable(trx, c, second.connectionId, (await providerConnections.get(trx, second.connectionId))!.revision));
  let decision: PaymentOutsideView;
  await t.test('verified empty collector set creates separate immutable bilateral consent, without dummy account evidence', async () => {
    assert.deepEqual(PaymentSettlementOptionsSchema.parse(ok(await buyer.get(optionsUrl))).candidates, []);
    const before = await second.q('SELECT * FROM trustwork.ledger_entry ORDER BY id');
    decision = ok<PaymentOutsideView>(await buyer.post('/v1/payments/sources/outside-platform', draftInput), 201);
    assert.equal(decision.outcome, 'outside_platform'); assert.equal(decision.payerAccepted, false);
    assert.equal((await outsider.post(`/v1/payments/sources/outside-platform/${decision.id}/accept`, { digest: decision.digest })).status, 403);
    for (const client of [buyer, seller]) decision = ok(await client.post(`/v1/payments/sources/outside-platform/${decision.id}/accept`, { digest: decision.digest }));
    assert.equal(decision.payerAccepted, true); assert.equal(decision.payeeAccepted, true);
    for (const client of [buyer, seller]) assert.deepEqual(PaymentAgreementSettlementSchema.parse(ok(await client.get(settlementUrl))).outsidePlatform, decision);
    assert.equal((await outsider.get(settlementUrl)).status, 403);
    assert.doesNotMatch(JSON.stringify(decision), /accountRef|providerEntity|residencePlace|proofDigest|verifiedSubject|publisherRegistrationId/);
    assert.equal((await second.q('SELECT * FROM trustwork.payment_intent WHERE agreement_id=$1', [accepted.id])).length, 0);
    assert.equal((await second.q('SELECT * FROM trustwork.payment_operation')).length, 0);
    assert.deepEqual(await second.q('SELECT * FROM trustwork.ledger_entry ORDER BY id'), before);
    assert.equal((await second.q('SELECT * FROM trustwork.payment_account_evidence WHERE identity_link_id IN (SELECT identity_link_id FROM trustwork.payment_participant_binding_version WHERE id=$1)', [payee.participant])).length, 0);
    assert.equal(first.fake.calls.length + second.fake.calls.length, 0);
    for (const pool of [h.pool, first.pool]) for (const table of ['payment_outside_platform_version', 'payment_outside_platform_acceptance'])
      await assert.rejects(pool.query(`SELECT * FROM trustwork.${table}`), /permission denied/);
  });
  await t.test('withdrawal is visible historical evidence and never converts the accepted decision to a payment', async () => {
    ok(await seller.post(`/v1/payments/sources/${decision.id}/revoke`, { kind: 'outside' }));
    assert.equal(PaymentAgreementSettlementSchema.parse(ok(await buyer.get(settlementUrl))).outsidePlatform?.revoked, true);
    const [order] = await second.q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [accepted.id]);
    assert.equal((await buyer.post('/v1/payments', { agreementId: accepted.id, budgetId: order!.transaction_budget_id })).status, 403);
    assert.equal(first.fake.calls.length + second.fake.calls.length, 0);
  });
});
