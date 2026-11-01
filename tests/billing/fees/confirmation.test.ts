import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { createPool, withMaintenance } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { rejects } from '../../hubs/helpers.js';
import { bookingFees } from '../../../packages/data/src/repositories/billing-fees.js';
import { feeWorld, syntheticTerms } from './helpers.js';

const db = await provisionTestDatabase('fee_confirmation', { weight: 2 });
test('BILL-003 internal adapter binds exact disclosures; missing source integrations stay unavailable', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate(); await db.createAppLogin();
  const runtime = createPool({ ...db.appConfig, max: 8 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const { a, p, hubA, hubB, draft, approve, activate } = await feeWorld(db.admin, runtime);
  const sourceDigest = computeDigest({ synthetic: 'immutable source terms' }).value;
  const scope = await withMaintenance(db.admin, (trx) => trx.insertInto('billing_fee_scope').values({
    source_kind: 'consultation', source_id: randomUUID(), source_digest: sourceDigest, fee_kind: 'consultation', category_key: 'synthetic_review',
    buyer_person_id: p.outsider, buyer_company_id: null, seller_person_id: p.operator, seller_company_id: null, buyer_hub_id: hubA, seller_hub_id: hubB,
  }).returningAll().executeTakeFirstOrThrow());
  const disclose = (person = p.outsider, hub = hubA, id = scope.id) => a.as(person, (trx) => bookingFees.disclose(trx, hub, id));
  await t.test('missing source provenance and absent published fees fail closed', async () => {
    await rejects(disclose(p.outsider, hubA, randomUUID()), 'P0002', 'admin.not_found');
    await rejects(disclose(), '23514', 'billing.unavailable');
    await rejects(a.as(p.outsider, (trx) => trx.insertInto('billing_fee_scope').values({ ...scope, id: randomUUID() }).execute()), '42501');
  });
  // Both synthetic rates are activated through actual scoped staff, elevation and distinct-person approval.
  const start = new Date(Date.now() + 2000);
  const buyer = await draft(syntheticTerms({ effectiveFrom: start.toISOString(), effectiveTo: null }));
  const seller = await draft(syntheticTerms({ payer: 'seller', basisPoints: 200, effectiveFrom: start.toISOString(), effectiveTo: null }), hubB, p.otherOwner);
  await activate(buyer, await approve(buyer));
  await activate(seller, await approve(seller, seller.digest, p.moderator, p.otherOwner), p.moderator);
  await delay(Math.max(0, start.getTime() - Date.now() + 10));
  const shown = await disclose();
  const sellerShown = await disclose(p.operator, hubB);
  await t.test('each party sees both exact fees with its own source hub; staff cannot impersonate parties', async () => {
    assert.equal(shown.snapshot.buyerFee.id, buyer.id); assert.equal(shown.snapshot.sellerFee.id, seller.id);
    assert.equal(shown.snapshot.sourceHubId, hubA); assert.equal(sellerShown.snapshot.sourceHubId, hubB);
    assert.equal(shown.digest, computeDigest(shown.snapshot).value);
    await rejects(disclose(p.owner), 'P0002', 'admin.not_found');
    await rejects(disclose(p.outsider, hubB), 'P0002', 'admin.not_found');
    await rejects(disclose(p.operator, hubA), 'P0002', 'admin.not_found');
    assert.equal((await a.as(p.owner, (trx) => trx.selectFrom('billing_fee_disclosure').selectAll().execute())).length, 0);
  });
  await t.test('confirmation requires the exact shown digest and the same participant and hub', async () => {
    await rejects(a.as(p.operator, (trx) => bookingFees.confirm(trx, hubB, shown.id, shown.digest)), 'P0002', 'admin.not_found');
    await rejects(a.as(p.outsider, (trx) => bookingFees.confirm(trx, hubB, shown.id, shown.digest)), 'P0002', 'admin.not_found');
    await rejects(a.as(p.outsider, (trx) => bookingFees.confirm(trx, hubA, shown.id, 'f'.repeat(64))), '42501', 'admin.approval_mismatch');
  });
  const confirmation = await a.as(p.outsider, (trx) => bookingFees.confirm(trx, hubA, shown.id, shown.digest));
  const sellerConfirmation = await a.as(p.operator, (trx) => bookingFees.confirm(trx, hubB, sellerShown.id, sellerShown.digest));
  const bookingId = randomUUID();
  await t.test('changed source terms cannot consume a confirmation', async () => {
    await rejects(a.as(p.outsider, (trx) => bookingFees.bind(trx, hubA, confirmation.id, bookingId, 'f'.repeat(64))), '23514', 'billing.source_outdated');
  });
  await t.test('concurrent consumes have one winner and each hub binds only its own party fee', async () => {
    const results = await Promise.allSettled([1, 2].map(() => a.as(p.outsider, (trx) => bookingFees.bind(trx, hubA, confirmation.id, bookingId, sourceDigest))));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ local_fee_id: string; counterparty_fee_id: string }>;
    assert.equal(winner.value.local_fee_id, buyer.id); assert.equal(winner.value.counterparty_fee_id, seller.id);
    const other = await a.as(p.operator, (trx) => bookingFees.bind(trx, hubB, sellerConfirmation.id, bookingId, sourceDigest));
    assert.equal(other.local_fee_id, seller.id); assert.equal(other.counterparty_fee_id, buyer.id);
    assert.equal((await a.as(p.outsider, (trx) => trx.selectFrom('billing_fee_binding').selectAll().execute())).length, 1);
  });
  await t.test('a failed booking transaction rolls back the fee binding', async () => {
    const d = await disclose(); const c = await a.as(p.outsider, (trx) => bookingFees.confirm(trx, hubA, d.id, d.digest));
    const id = randomUUID();
    await assert.rejects(a.as(p.outsider, async (trx) => { await bookingFees.bind(trx, hubA, c.id, id, sourceDigest); throw new Error('Synthetic booking refusal'); }));
    assert.equal((await db.admin.query('SELECT id FROM trustwork.billing_fee_binding WHERE booking_id=$1', [id])).rowCount, 0);
  });
  await t.test('disclosure, confirmation and binding are immutable', async () => {
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.billing_fee_disclosure SET digest=${'f'.repeat(64)} WHERE id=${shown.id}::uuid`.execute(trx)), '23000');
    await rejects(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.billing_fee_confirmation WHERE id=${confirmation.id}::uuid`.execute(trx)), '23000');
  });
  await t.test('expired shown versions are refused at confirmation and booking, never silently replaced', async () => {
    const starts = new Date(Date.now()+1000); const ends = new Date(starts.getTime()+1500);
    const expiring = await draft(syntheticTerms({ categoryKey: 'synthetic_expiring', effectiveFrom: starts.toISOString(), effectiveTo: ends.toISOString() }));
    const other = await draft(syntheticTerms({ categoryKey: 'synthetic_expiring', payer: 'seller', effectiveFrom: starts.toISOString(), effectiveTo: null }), hubB, p.otherOwner);
    await activate(expiring, await approve(expiring)); await activate(other, await approve(other, other.digest, p.moderator, p.otherOwner), p.moderator);
    const next = await draft(syntheticTerms({ categoryKey: 'synthetic_expiring', basisPoints: 300, effectiveFrom: ends.toISOString(), effectiveTo: null }));
    await activate(next, await approve(next));
    const newScope = await withMaintenance(db.admin, (trx) => trx.insertInto('billing_fee_scope').values({ ...scope, id: randomUUID(), source_id: randomUUID(), category_key: 'synthetic_expiring' }).returning('id').executeTakeFirstOrThrow());
    await delay(Math.max(0, starts.getTime()-Date.now()+10));
    const d = await disclose(p.outsider, hubA, newScope.id);
    const c = await a.as(p.outsider, (trx) => bookingFees.confirm(trx, hubA, d.id, d.digest));
    const unconfirmed = await disclose(p.outsider, hubA, newScope.id);
    await delay(Math.max(0, ends.getTime()-Date.now()+10));
    await rejects(a.as(p.outsider, (trx) => bookingFees.confirm(trx, hubA, unconfirmed.id, unconfirmed.digest)), '23514', 'billing.fee_outdated');
    await rejects(a.as(p.outsider, (trx) => bookingFees.bind(trx, hubA, c.id, randomUUID(), sourceDigest)), '23514', 'billing.fee_outdated');
    assert.equal((await disclose(p.outsider, hubA, newScope.id)).snapshot.buyerFee.id, next.id);
  });
});
