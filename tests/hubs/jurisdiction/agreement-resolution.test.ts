import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { orders } from '../../../packages/data/src/repositories/transactions.js';
import { jurisdictionAuthority, jurisdictionEvidence } from '../../../packages/data/src/repositories/jurisdiction-policy.js';
import { evaluateLimits } from '../../../apps/api/src/modules/hubs/jurisdiction/intent-adapter.js';
import { provisionTestDatabase } from '../../data/helpers/postgres.js';
import { authorityFixture, createQuote, sourceDocument } from './authority-fixture.js';
import { syntheticSourceAuthority } from './source-fixture.js';
import { sendSyntheticQuote, acceptSyntheticQuote, placeSyntheticOrder } from './commerce-fixture.js';

const db = await provisionTestDatabase('jurisdiction_agreement', { weight: 2 });
test('operation-specific actual commerce agreement source and authorization', { skip: !db }, async t => {
  if (!db) return; t.after(() => db.close()); await db.migrate(); await db.createAppLogin();
  const f = await authorityFixture(db.admin, db.app), deal = await createQuote(f.a.as, f.p.outsider, f.p.moderator);
  await sendSyntheticQuote(f.a.as, f.p.moderator, deal.quoteId);
  const agreement = await acceptSyntheticQuote(f.a.as, f.p.outsider, deal.quoteId);
  const producer = await syntheticSourceAuthority(db.admin, f), source = sourceDocument('US', 'synthetic-agreement-context');
  source.policy.consentRequirements = [];
  for (const action of ['place_order', 'accept_order'] as const) source.policy.actionLimits.push({ action, approval: 'pre_authorized', approvalAbove: { minorUnits: '50', currency: 'USD' } });
  const imported = await withMaintenance(db.admin, trx => jurisdictionEvidence.importSource(trx, source));
  Object.assign(f.payload.agentSettings.jurisdictions[0]!, { sourceId: imported.id, sourceRevision: imported.revision, sourceDigest: imported.digest, policy: source.policy });
  await f.activate(await f.draft());
  const resolve = (operation: 'place_order' | 'seller_accept') => f.a.as(operation === 'place_order' ? f.p.outsider : f.p.moderator, trx => jurisdictionAuthority.agreementLimits(trx, agreement.id, operation));
  const issue = async (action: 'place_order' | 'accept_order') => {
    for (const [kind, id] of [['person', f.p.outsider], ['person', f.p.moderator], ['project', deal.projectId]] as const) await producer.issue(kind, id, agreement.id, ['US'], action, 'agreement');
  };
  await t.test('no quote alias, arbitrary operation, opposite party or staff authority', async () => {
    assert.equal((await resolve('place_order')).status, 'unknown'); assert.equal((await resolve('seller_accept')).status, 'unknown');
    for (const person of [f.p.moderator, f.p.owner, f.p.otherOwner]) await assert.rejects(f.a.as(person, trx => jurisdictionAuthority.agreementLimits(trx, agreement.id, 'place_order')), { code: '42501' });
    for (const person of [f.p.outsider, f.p.owner]) await assert.rejects(f.a.as(person, trx => jurisdictionAuthority.agreementLimits(trx, agreement.id, 'seller_accept')), { code: '42501' });
    for (const operation of ['withdraw', 'seller_decline', 'negotiate']) await assert.rejects(f.a.as(f.p.outsider, trx => sql`SELECT trustwork.jurisdiction_agreement_limits(${agreement.id}::uuid,${operation})`.execute(trx)), { code: '42501' });
    await assert.rejects(f.a.as(f.p.outsider, trx => jurisdictionAuthority.limits(trx, agreement.id, 'place_order')), { code: '42501' });
    await assert.rejects(f.a.as(f.p.outsider, trx => jurisdictionAuthority.agreementLimits(trx, deal.quoteId, 'place_order')), { code: '42501' });
  });
  await t.test('buyer placement needs its own agreement proof and no live order; seller cannot accept early', async () => {
    await issue('place_order'); const r = await resolve('place_order'); assert.equal(r.status, 'resolved'); assert.equal(r.hubId, f.hubId);
    assert.equal(evaluateLimits(r, { minorUnits: '51', currency: 'USD' }).effect, 'ask');
    const payload = await producer.payload('person', f.p.outsider, agreement.id, ['US'], 'place_order', 'agreement');
    assert.equal(payload.context.kind, 'agreement');
    if (payload.context.kind === 'agreement') assert.equal(payload.context.operation, 'place_order');
    await assert.rejects(async () => producer.stage({ ...payload, action: 'accept_order' }));
    assert.equal((await resolve('seller_accept')).status, 'unknown');
  });
  let order = await placeSyntheticOrder(f.a.as, f.p.outsider, agreement.id);
  await t.test('actual placed order invalidates placement and enables only separately attested seller acceptance', async () => {
    assert.equal((await resolve('place_order')).status, 'unknown'); assert.equal((await resolve('seller_accept')).status, 'unknown');
    await issue('accept_order'); const r = await resolve('seller_accept'); assert.equal(r.status, 'resolved');
    assert.equal(evaluateLimits(r, { minorUnits: '51', currency: 'USD' }).effect, 'ask');
    for (const secret of [order.transaction_budget_id, order.reservation_id!, agreement.accepted_terms_digest, f.p.outsider]) assert.ok(!JSON.stringify(r).includes(secret));
    await assert.rejects(f.a.as(f.p.outsider, trx => sql`SELECT trustwork.jurisdiction_owning_agreement(${agreement.id}::uuid,'accept_order')`.execute(trx)), { code: '42501' });
  });
  await t.test('real order cancellation and seller resolution serialize in both row-lock orders', async () => {
    for (const first of ['cancel', 'resolve'] as const) {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
      const cancel = (hold: boolean) => f.a.as(f.p.outsider, async trx => {
        await orders.setStatus(trx, order.id, order.revision, { status: 'cancelled', cancelled_reason: 'Synthetic cancellation' });
        if (hold) { entered(); await held; }
      });
      const read = (hold: boolean) => f.a.as(f.p.moderator, async trx => {
        const result = await jurisdictionAuthority.agreementLimits(trx, agreement.id, 'seller_accept');
        if (hold) { assert.equal(result.status, 'resolved'); entered(); await held; } return result;
      });
      const winner = first === 'cancel' ? cancel(true) : read(true); await started;
      if (first === 'cancel') {
        try { await assert.rejects(read(false), { code: '55P03' }); } finally { release(); }
        await winner;
      } else {
        const second = cancel(false);
        try {
          let waiting = false;
          for (let n = 0; n < 100; n++) { if ((await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) { waiting = true; break; } await new Promise(r => setTimeout(r, 10)); }
          assert.ok(waiting);
        } finally { release(); }
        await winner; await second;
      }
      assert.equal((await resolve('seller_accept')).status, 'unknown'); assert.equal((await resolve('place_order')).status, 'unknown', 'old no-order proof does not revive');
      await issue('place_order'); assert.equal((await resolve('place_order')).status, 'resolved');
      order = await placeSyntheticOrder(f.a.as, f.p.outsider, agreement.id);
      assert.equal((await resolve('seller_accept')).status, 'unknown'); await issue('accept_order');
    }
  });
  await t.test('unknown legal consent refuses an agreement operation rather than borrowing a quote receipt', async () => {
    source.version = 'synthetic-agreement-consent'; source.policy.consentRequirements = ['synthetic.electronicRecords'];
    const src = await withMaintenance(db.admin, trx => jurisdictionEvidence.importSource(trx, source));
    Object.assign(f.payload.agentSettings.jurisdictions[0]!, { sourceId: src.id, sourceRevision: src.revision, sourceDigest: src.digest, policy: source.policy });
    await f.activate(await f.draft()); const r = await resolve('seller_accept'); assert.equal(r.consentSatisfied, false);
    assert.equal(evaluateLimits(r, { minorUnits: '1', currency: 'USD' }).effect, 'deny');
  });
});
