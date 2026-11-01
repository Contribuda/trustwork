import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import { localPaymentLists } from './local-list-helpers.js';
import { screeningListsStaff } from '../../packages/data/src/repositories/screening-lists.js';
import { sourceWorld } from './source-helpers.js';
import { agreement, ok } from './helpers.js';
import type { PaymentAuthorizationView } from '../../packages/contracts/src/payment-sources.js';
import type { PaymentView } from '../../packages/contracts/src/payments.js';
const h = await startHarness('payment_local_hubs');
test('PAY-001 actual independently accepted two-hub source on one node', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const payerHub = await sourceWorld(h, 'synthetic-payer'), payeeHub = await sourceWorld(h, 'synthetic-payee');
  t.after(async () => { await payeeHub.close(); await payerHub.close(); await h.close(); });
  const lists = await localPaymentLists(h, payerHub, payeeHub);
  await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client(); await login(buyer, 'petr'); await login(seller, 'carl');
  const payer = await payerHub.bind(buyer), payee = await payeeHub.bind(seller, true);
  const accepted = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl)).agreement;
  const body = { agreementId: accepted.id, payerBindingId: payer.participant, payeeBindingId: payee.participant,
    accountBindingId: payee.account!, publisherRegistrationId: payeeHub.issuers.publisher.id, rail: 'qr' };
  await t.test('version1 publisher retains the original single-hub boundary', async () => {
    assert.equal((await buyer.post('/v1/payments/sources/authorizations', body)).status, 403);
  });
  await payeeHub.registerIssuer('publisher', 2);
  body.publisherRegistrationId = payeeHub.issuers.publisher.id;
  for (const [hub, list] of [[payerHub, lists.payer], [payeeHub, lists.payee]] as const) await t.test(`paused configured list at responsible hub ${hub.hubId} refuses both-party authorization`, async () => {
    await payerHub.a.cmd(payerHub.w.people.officer, (trx, ctx) => screeningListsStaff.setStatus(trx, ctx, { listId: list.id, status: 'paused', reason: 'Synthetic paused owning list' }));
    assert.equal((await buyer.post('/v1/payments/sources/authorizations', body)).status, 403);
    await payerHub.a.cmd(payerHub.w.people.officer, (trx, ctx) => screeningListsStaff.setStatus(trx, ctx, { listId: list.id, status: 'active', reason: 'Synthetic resume owning list' }));
  });
  await t.test('separately activated version2 pays through the payee hub, with exact bilateral consent', async () => {
    const authorization = ok<PaymentAuthorizationView>(await buyer.post('/v1/payments/sources/authorizations', body), 201);
    assert.equal(authorization.hubId, payeeHub.hubId);
    for (const client of [buyer, seller]) ok(await client.post(`/v1/payments/sources/authorizations/${authorization.id}/accept`, { digest: authorization.digest }));
    const [order] = await payeeHub.q('SELECT transaction_budget_id FROM trustwork.commercial_order WHERE agreement_id=$1', [accepted.id]);
    const payment = ok<PaymentView>(await buyer.post('/v1/payments', { agreementId: accepted.id, budgetId: order!.transaction_budget_id }), 201);
    await payeeHub.tick();
    assert.equal(payeeHub.fake.calls.length, 1);
    assert.equal(payerHub.fake.calls.length, 0);
    assert.equal(ok<PaymentView>(await buyer.get(`/v1/payments/${payment.id}`)).state, 'outcome_unknown');
    const [source] = await payeeHub.q('SELECT snapshot,binding FROM trustwork.payment_authorization_version WHERE id=$1', [authorization.id]);
    const snapshot = source!.snapshot as { schemaVersion: number; reviews: Record<string, unknown> };
    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(Object.keys(snapshot.reviews).sort(), [payer.participant, payee.participant].sort());
    const binding = source!.binding as { payerHubId: string; payeeHubId: string; collectingHubId: string; connectionId: string };
    assert.equal(binding.payerHubId, payerHub.hubId); assert.equal(binding.payeeHubId, payeeHub.hubId);
    assert.equal(binding.collectingHubId, payeeHub.hubId); assert.equal(binding.connectionId, payeeHub.connectionId);
  });
});
