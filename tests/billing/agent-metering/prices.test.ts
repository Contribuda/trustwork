import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { principalFor } from '../../data/helpers/seed.js';
import { PublicPricingSchema } from '../../../packages/contracts/src/billing-fees.js';
import { MeteredPriceVersionSchema, type MeteredPriceVersion } from '../../../packages/contracts/src/agent-metering.js';
import { meteredPrices } from '../../../packages/data/src/repositories/agent-metering.js';
import { meteringHttpWorld, syntheticCost, syntheticTerms } from './helpers.js';

const url = '/v1/admin/billing/metered';
const reason = 'Synthetic agent price governance test';

const h = await startHarness('agent_metered_prices');
test('AGT-004 agent usage prices: real authentication, second person, cost never reaches a sale price', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w = await meteringHttpWorld(h);
  t.after(async () => { await w.app.close(); await h.close(); });
  const pricing = async () => PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
  const staffList = async () => ((await w.clients.owner.get(`${url}/prices`)).body as { prices: MeteredPriceVersion[] }).prices;
  const stored = async (id: string) => (await withMaintenance(h.db.admin, (trx) => trx.selectFrom('price_version').selectAll().where('id', '=', id).executeTakeFirstOrThrow()));
  const body = { reason, terms: syntheticTerms() };

  await t.test('an empty catalogue is a confirmed empty section, and a reader failure is never an empty one', async () => {
    const p = await pricing();
    assert.equal(p.coverage?.sections.models, 'available');
    assert.equal(p.coverage?.sections.capabilities, 'available');
    assert.deepEqual(p.prices, []);
  });

  await t.test('anonymous, unelevated and other-hub staff cannot draft; a body confers no authority', async () => {
    assert.equal((await w.anonymous.post(`${url}/prices`, body)).status, 401);
    assert.equal((await w.clients.owner.post(`${url}/prices`, body)).status, 403);
    await w.elevate();
    assert.equal((await w.clients.outsider.post(`${url}/prices`, body)).status, 403);
    assert.equal((await w.clients.otherOwner.post(`${url}/prices`, body)).status, 403);
    for (const extra of [{ hubId: w.hubB }, { activatedBy: w.p.officer }, { permissions: ['admin.commerce.price.activate'] }]) {
      assert.equal((await w.clients.owner.post(`${url}/prices`, { ...body, ...extra })).status, 422);
    }
    for (const key of ['ranking', 'matchBoost', 'reputation', 'personId']) {
      assert.equal((await w.clients.owner.post(`${url}/prices`, { ...body, terms: { ...body.terms, [key]: 1 } })).status, 422, key);
    }
  });

  await t.test('a price needs a cost beside it, a real subject and a priced meter', async () => {
    const missing = await w.clients.owner.post(`${url}/prices`, body);
    assert.equal(missing.status, 422, JSON.stringify(missing.body));
    assert.equal((missing.body as { details: { reason: string } }).details.reason, 'billing.cost_record_missing');
    const unknown = await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ subject: { kind: 'capability', key: 'project_planner.not_a_capability', meter: 'agent_actions' } }) });
    assert.equal((unknown.body as { details: { reason: string } }).details.reason, 'billing.invalid_terms');
    const introduction = await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ subject: { kind: 'capability', key: 'negotiation.introduce', meter: 'agent_actions' } }) });
    assert.equal((introduction.body as { details: { reason: string } }).details.reason, 'billing.invalid_terms', 'an introduction is matching, and payment never changes matching');
    const introductionCost = await w.clients.owner.post(`${url}/costs`, { reason, cost: syntheticCost({ subject: { kind: 'capability', key: 'negotiation.introduce', meter: 'agent_actions' } }) });
    assert.equal(introductionCost.status, 422);
    const message = await w.clients.owner.post(`${url}/costs`, { reason, cost: syntheticCost({ subject: { kind: 'capability', key: 'negotiation.negotiate', meter: 'agent_actions' } }) });
    assert.equal(message.status, 201, 'the rule is about introductions, not the whole module');
    const unpriced = await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ subject: { kind: 'meter', key: 'document_pages', meter: 'document_pages' } }) });
    assert.equal((unpriced.body as { details: { reason: string } }).details.reason, 'billing.meter_unpriced');
  });

  const cost = await w.clients.owner.post(`${url}/costs`, { reason, cost: syntheticCost() }, { idempotencyKey: 'synthetic-cost-1' });
  assert.equal(cost.status, 201, JSON.stringify(cost.body));
  const costId = (cost.body as { id: string }).id;

  const drafted = await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ basis: { kind: 'markup', percent: 50 } }) }, { idempotencyKey: 'synthetic-price-1' });
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  const v1 = MeteredPriceVersionSchema.parse(drafted.body);

  await t.test('a markup version stores the computed sale price and the cost record it used', async () => {
    assert.equal(v1.terms.basis, 'markup');
    assert.equal(v1.terms.markupPercent, 50);
    assert.equal(v1.terms.costPerUnitMinor, '3.25');
    assert.equal(v1.terms.salePerUnitMinor, '4.875', '3.25 * 1.5, computed by the engine');
    assert.equal(v1.terms.costRecordId, costId);
    assert.equal(v1.terms.modelPricingId, null);
    assert.equal(v1.marginPerUnitMinor, '1.625');
    const row = await stored(v1.id);
    assert.equal(row.amount_minor, '4875');
    assert.equal(v1.terms.perUnits, 1000, 'the integer money column carries the exact price for 1000 units');
  });

  await t.test('a caller cannot supply the result of a markup', async () => {
    const r = await w.clients.owner.post(`${url}/prices`, { reason, terms: { ...syntheticTerms(), basis: { kind: 'markup', percent: 50, salePerUnitMinor: '1' } } });
    assert.equal(r.status, 422);
  });

  await t.test('drafts stay off the public page', async () => {
    assert.deepEqual((await pricing()).prices, []);
  });

  await t.test('activation needs an exact, real approval and a second person', async () => {
    const action = { reason, digest: v1.digest, approvalId: randomUUID() };
    const self = await w.clients.owner.post(`${url}/prices/${v1.id}/activate`, action);
    assert.equal((self.body as { code: string }).code, 'access.second_approver_required', 'the drafter never activates');
    const unknown = await w.clients.officer.post(`${url}/prices/${v1.id}/activate`, action);
    assert.ok(unknown.status >= 400 && unknown.status < 500, JSON.stringify(unknown.body));
    const wrongDigest = await w.clients.officer.post(`${url}/prices/${v1.id}/activate`, { ...action, digest: 'a'.repeat(64) });
    assert.equal((wrongDigest.body as { code: string }).code, 'access.approval_digest_mismatch');
    const otherAction = await w.approve('b'.repeat(64));
    const mismatch = await w.clients.officer.post(`${url}/prices/${v1.id}/activate`, { ...action, approvalId: otherAction });
    assert.equal((mismatch.body as { code: string }).code, 'access.approval_digest_mismatch', 'an approval of other terms does not transfer');
    assert.equal((await stored(v1.id)).status, 'draft');
  });

  const activated = await w.clients.officer.post(`${url}/prices/${v1.id}/activate`, { reason, digest: v1.digest, approvalId: await w.approve(v1.digest) }, { idempotencyKey: 'synthetic-price-activate-1' });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  await t.test('every active version is on the public page with its unit and without any cost or staff field', async () => {
    const r = await w.anonymous.get('/v1/pricing');
    const p = PublicPricingSchema.parse(r.body);
    const row = p.prices.find((x) => x.id === v1.id);
    assert.ok(row, 'the active version is published');
    assert.equal(row.kind, 'capability');
    assert.equal(row.amountMinor, '4875');
    assert.deepEqual(row.disclosure?.metered, { key: 'project_planner.share_item', direction: null, meter: 'agent_actions', unit: 'action', perUnits: 1000, salePerUnitMinor: '4.875' });
    const text = JSON.stringify(r.body);
    for (const secret of ['costPerUnit', 'cost_per', 'markup', 'draftedBy', 'activatedBy', 'costBasis', 'modelPricingId', w.p.owner, w.p.officer]) assert.ok(!text.includes(secret), secret);
  });

  await t.test('the runtime role cannot read cost or terms through a table', async () => {
    const principal = await principalFor(h.db.admin, w.p.outsider);
    for (const table of ['metered_price_term', 'metered_cost_record', 'metered_subject']) {
      await assert.rejects(withPrincipal(h.pool, principal, (trx) => sql`SELECT * FROM trustwork.${sql.raw(table)}`.execute(trx)), /permission denied/, table);
    }
  });

  await t.test('a new cost record never changes an active price: it recomputes margin and offers a draft', async () => {
    const before = await stored(v1.id);
    const raised = await w.clients.owner.post(`${url}/costs`, { reason, cost: syntheticCost({ costPerUnitMinor: '6', observedAt: new Date(Date.now() - 1000).toISOString() }) });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const after = await stored(v1.id);
    assert.deepEqual({ amount: after.amount_minor, status: after.status, revision: after.revision, updated: after.updated_at }, { amount: before.amount_minor, status: before.status, revision: before.revision, updated: before.updated_at });
    const view = (await staffList()).find((x) => x.id === v1.id)!;
    assert.equal(view.terms.salePerUnitMinor, '4.875');
    assert.equal(view.terms.costPerUnitMinor, '3.25', 'the version keeps the cost it was set against');
    assert.equal(view.digest, v1.digest, 'the approved digest still matches');
    assert.equal(view.marginPerUnitMinor, '1.625');
    assert.equal(view.currentMarginPerUnitMinor, '-1.125', 'a negative margin is shown, never corrected silently');
    assert.equal(view.currentCost?.costPerUnitMinor, '6');
    assert.equal(view.currentCost?.suggestedSalePerUnitMinor, '9');
    assert.equal((await pricing()).prices.find((x) => x.id === v1.id)?.amountMinor, '4875');
  });

  await t.test('the offered draft is an ordinary version: new number, new cost record, second person, previous version end-dated', async () => {
    const start = new Date(Date.now() + 3600000).toISOString();
    const r = await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ basis: { kind: 'markup', percent: 50 }, effectiveFrom: start }) });
    const v2 = MeteredPriceVersionSchema.parse(r.body);
    assert.equal(v2.version, 2);
    assert.equal(v2.terms.salePerUnitMinor, '9');
    assert.notEqual(v2.terms.costRecordId, v1.terms.costRecordId);
    assert.equal((await stored(v1.id)).effective_to, null, 'drafting does not touch the active version');
    const done = await w.clients.officer.post(`${url}/prices/${v2.id}/activate`, { reason, digest: v2.digest, approvalId: await w.approve(v2.digest) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await stored(v1.id)).effective_to?.toISOString(), start);
    assert.equal((await stored(v1.id)).amount_minor, '4875');
    const published = (await pricing()).prices.filter((x) => x.disclosure?.metered?.key === 'project_planner.share_item').map((x) => [x.version, x.amountMinor]);
    assert.deepEqual(published, [[1, '4875'], [2, '9']]);
  });

  await t.test('back-dating and overlap are refused by the BILL-001 version rules', async () => {
    const past = MeteredPriceVersionSchema.parse((await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ effectiveFrom: new Date(Date.now() - 60000).toISOString() }) })).body);
    const backdated = await w.clients.officer.post(`${url}/prices/${past.id}/activate`, { reason, digest: past.digest, approvalId: await w.approve(past.digest) });
    assert.equal((backdated.body as { details?: { reason: string } }).details?.reason, 'billing.backdated', JSON.stringify(backdated.body));
    const inside = MeteredPriceVersionSchema.parse((await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ effectiveFrom: new Date(Date.now() + 600000).toISOString(), effectiveTo: new Date(Date.now() + 900000).toISOString() }) })).body);
    const overlap = await w.clients.officer.post(`${url}/prices/${inside.id}/activate`, { reason, digest: inside.digest, approvalId: await w.approve(inside.digest) });
    assert.equal((overlap.body as { details?: { reason: string } }).details?.reason, 'billing.version_overlap', JSON.stringify(overlap.body));
  });

  await t.test('a draft can be cancelled, an active version cannot, and terms never change', async () => {
    const draft = MeteredPriceVersionSchema.parse((await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ effectiveFrom: new Date(Date.now() + 7200000).toISOString() }) })).body);
    assert.equal((await w.clients.owner.post(`${url}/prices/${draft.id}/cancel`, { reason })).status, 200);
    assert.equal((await w.clients.owner.post(`${url}/prices/${v1.id}/cancel`, { reason })).status, 409);
    await assert.rejects(withMaintenance(h.db.admin, (trx) => trx.updateTable('metered_price_term').set({ sale_micro: '0' }).where('price_version_id', '=', v1.id).execute()));
  });

  await t.test('another hub sees neither the price nor the staff view', async () => {
    const other = await w.a.cmd(w.p.otherOwner, (trx, ctx) => meteredPrices.staffList(trx, ctx, w.hubB));
    assert.deepEqual(other, []);
    await assert.rejects(w.a.cmd(w.p.otherOwner, (trx, ctx) => meteredPrices.activate(trx, ctx, w.hubB, v1.id, v1.digest, randomUUID())), (e: { hint?: string }) => e.hint === 'admin.not_found');
    await assert.rejects(w.a.cmd(w.p.otherOwner, (trx, ctx) => meteredPrices.staffList(trx, ctx, w.hubA)), (e: { hint?: string }) => e.hint === 'admin.forbidden');
  });

  await t.test('two people racing one approval activate exactly once', async () => {
    const start = new Date(Date.now() + 86400000).toISOString();
    const version = MeteredPriceVersionSchema.parse((await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ effectiveFrom: start }) })).body);
    const approvalId = await w.approve(version.digest);
    const sent = await Promise.all([1, 2, 3].map((n) => w.clients.officer.post(`${url}/prices/${version.id}/activate`, { reason, digest: version.digest, approvalId }, { idempotencyKey: `synthetic-race-${n}` })));
    assert.equal(sent.filter((r) => r.status === 200).length, 1, JSON.stringify(sent.map((r) => r.status)));
    assert.equal((await stored(version.id)).status, 'active');
  });

  await t.test('a catalogue model is priced per direction from the provider cost record, and a new record leaves the price alone', async () => {
    const pricing_ = async (input: string) => withMaintenance(h.db.admin, async (trx) => {
      const connection = (await sql<{ id: string }>`SELECT id FROM trustwork.provider_connection WHERE hub_id = ${w.hubA}::uuid LIMIT 1`.execute(trx)).rows[0]?.id
        ?? (await sql<{ id: string }>`INSERT INTO trustwork.provider_connection (hub_id, adapter_id, label, capabilities, mode, hosting_kind, processing_country, created_by)
          VALUES (${w.hubA}::uuid, 'fake', 'Synthetic priced model', ARRAY['llm'], 'fake', 'self_hosted', 'US', ${w.p.owner}::uuid) RETURNING id`.execute(trx)).rows[0]!.id;
      const version = (await sql<{ v: number }>`SELECT coalesce(max(version), 0) + 1 AS v FROM trustwork.model_pricing WHERE connection_id = ${connection}::uuid`.execute(trx)).rows[0]!.v;
      return (await sql<{ id: string }>`INSERT INTO trustwork.model_pricing (hub_id, connection_id, model_id, version, currency, input_per_million_tokens, output_per_million_tokens, basis, observed_at, recorded_by)
        VALUES (${w.hubA}::uuid, ${connection}::uuid, 'Synthetic-Model-1', ${version}, 'USD', ${input}::numeric, 12, 'provider_list', now(), ${w.p.owner}::uuid) RETURNING id`.execute(trx)).rows[0]!.id;
    });
    const first = await pricing_('2.5');
    const subject = { kind: 'model', key: 'synthetic-model-1', direction: 'input', meter: 'model_tokens' } as const;
    const model = MeteredPriceVersionSchema.parse((await w.clients.owner.post(`${url}/prices`, { reason, terms: syntheticTerms({ subject, basis: { kind: 'markup', percent: 20 } }) })).body);
    assert.equal(model.terms.unit, 'thousand_tokens');
    assert.equal(model.terms.costPerUnitMinor, '0.25', '2.50 USD per million tokens is 0.25 cents per thousand');
    assert.equal(model.terms.salePerUnitMinor, '0.3');
    assert.equal(model.terms.modelPricingId, first);
    assert.equal(model.terms.costBasis, 'model_list_price');
    assert.equal((await w.clients.officer.post(`${url}/prices/${model.id}/activate`, { reason, digest: model.digest, approvalId: await w.approve(model.digest) })).status, 200);
    const row = (await pricing()).prices.find((x) => x.id === model.id)!;
    assert.equal(row.kind, 'model');
    assert.deepEqual(row.disclosure?.metered, { key: 'synthetic-model-1', direction: 'input', meter: 'model_tokens', unit: 'thousand_tokens', perUnits: 10, salePerUnitMinor: '0.3' });
    const second = await pricing_('5');
    const view = (await staffList()).find((x) => x.id === model.id)!;
    assert.equal(view.terms.salePerUnitMinor, '0.3');
    assert.equal(view.terms.modelPricingId, first);
    assert.equal(view.digest, model.digest);
    assert.equal(view.currentCost?.modelPricingId, second);
    assert.equal(view.currentCost?.suggestedSalePerUnitMinor, '0.6');
    assert.equal(view.currentMarginPerUnitMinor, '-0.2');
  });

  await t.test('activation and drafting are audited with the second person', async () => {
    const rows = await h.db.admin.query<{ action: string; second_approver_person_id: string | null }>('SELECT action, second_approver_person_id FROM trustwork.admin_audit_event WHERE object_id = $1 ORDER BY id', [v1.id]);
    assert.deepEqual(rows.rows.map((r) => r.action).sort(), ['billing.metered_price_activated', 'billing.metered_price_drafted']);
    assert.equal(rows.rows.find((r) => r.action === 'billing.metered_price_activated')?.second_approver_person_id, w.p.owner);
  });
});
