import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { billingSalePrices } from '../../../packages/data/src/repositories/billing-fees.js';
import { meteredPrices } from '../../../packages/data/src/repositories/agent-metering.js';
import type { SalePriceTerms, SalePriceVersion } from '../../../packages/contracts/src/billing-fees.js';
import { meteringWorld, syntheticCost, syntheticTerms } from './helpers.js';

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const refused = (e: { hint?: string }) => e.hint === 'billing.subject_priced_elsewhere';

const h = await startHarness('agent_metering_one_price');
test('AGT-004 one model or capability has one live price across both price designs', { skip: h ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w = await meteringWorld(h.db.admin, h.pool);
  const base = { currency: 'USD', amountMinor: '10', effectiveFrom: later(600000), effectiveTo: null, acceptanceTextVersion: 'synthetic-1' };
  let codes = 0;
  const saleCapability = (capabilityId: string, over: Partial<typeof base> = {}): SalePriceTerms => ({ kind: 'capability', code: `synthetic_sale_${(codes += 1)}`, name: 'Synthetic sale', ...base, ...over, capabilityId, meter: 'agent_actions', perUnits: '1' });
  const draftSale = (terms: SalePriceTerms) => w.a.cmd(w.p.owner, (trx, ctx) => billingSalePrices.draft(trx, ctx, w.hubA, terms));
  const activateSale = async (v: SalePriceVersion) => {
    const approval = await w.approve(v.activationDigest);
    return () => w.a.cmd(w.p.officer, (trx, ctx) => billingSalePrices.activate(trx, ctx, w.hubA, v.id, v.digest, approval));
  };
  const draftMetered = async (key: string, over: Parameters<typeof syntheticTerms>[0] = {}) => {
    const subject = { kind: 'capability', key, meter: 'agent_actions' } as const;
    await w.recordCost(syntheticCost({ subject }));
    return w.draft(syntheticTerms({ subject, ...over }));
  };
  const activateMetered = async (v: Awaited<ReturnType<typeof draftMetered>>) => {
    const approval = await w.approve(v.digest);
    return () => w.a.cmd(w.p.officer, (trx, ctx) => meteredPrices.activate(trx, ctx, w.hubA, v.id, v.digest, approval));
  };
  const status = async (id: string) => (await withMaintenance(h.db.admin, (trx) => trx.selectFrom('price_version').select('status').where('id', '=', id).executeTakeFirstOrThrow())).status;

  await t.test('an active sale version refuses a metered price for the same capability', async () => {
    await (await activateSale(await draftSale(saleCapability('project_planner.share_item'))))();
    const metered = await draftMetered('project_planner.share_item');
    await assert.rejects((await activateMetered(metered))(), refused);
    assert.equal(await status(metered.id), 'draft');
  });

  await t.test('an active metered price refuses a sale version for the same capability', async () => {
    await (await activateMetered(await draftMetered('project_planner.revoke_share')))();
    const sale = await draftSale(saleCapability('project_planner.revoke_share'));
    await assert.rejects((await activateSale(sale))(), refused);
    assert.equal(await status(sale.id), 'draft');
  });

  await t.test('other subjects are untouched, and a handover at an end date is allowed', async () => {
    await (await activateMetered(await draftMetered('project_planner.update_item_state')))();
    const end = later(900000);
    await (await activateMetered(await draftMetered('project_planner.record_permit', { effectiveTo: end })))();
    const after = await draftSale(saleCapability('project_planner.record_permit', { effectiveFrom: end }));
    await (await activateSale(after))();
    assert.equal(await status(after.id), 'active', 'no two prices are live at once');
  });

  await t.test('a catalogue model is one subject whatever the case of its id, in both directions', async () => {
    await withMaintenance(h.db.admin, async (trx) => {
      const connection = (await sql<{ id: string }>`INSERT INTO trustwork.provider_connection (hub_id, adapter_id, label, capabilities, mode, hosting_kind, processing_country, created_by)
        VALUES (${w.hubA}::uuid, 'fake', 'Synthetic priced model', ARRAY['llm'], 'fake', 'self_hosted', 'US', ${w.p.owner}::uuid) RETURNING id`.execute(trx)).rows[0]!.id;
      for (const [i, model] of ['Synthetic-Model-A', 'synthetic-model-b'].entries()) {
        await sql`INSERT INTO trustwork.model_pricing (hub_id, connection_id, model_id, version, currency, input_per_million_tokens, output_per_million_tokens, basis, observed_at, recorded_by)
          VALUES (${w.hubA}::uuid, ${connection}::uuid, ${model}, ${i + 1}, 'USD', 2, 4, 'provider_list', now(), ${w.p.owner}::uuid)`.execute(trx);
      }
    });
    const saleModel = (modelId: string): SalePriceTerms => ({ kind: 'model', code: `synthetic_sale_${(codes += 1)}`, name: 'Synthetic sale', ...base, modelId, meter: 'model_tokens', perUnits: '1000' });
    await (await activateSale(await draftSale(saleModel('Synthetic-Model-A'))))();
    const folded = await w.draft(syntheticTerms({ subject: { kind: 'model', key: 'synthetic-model-a', direction: 'input', meter: 'model_tokens' } }));
    await assert.rejects((await activateMetered(folded))(), refused, 'the metered key folds the case of the sale version\'s model id');
    await (await activateMetered(await w.draft(syntheticTerms({ subject: { kind: 'model', key: 'synthetic-model-b', direction: 'output', meter: 'model_tokens' } }))))();
    const sale = await draftSale(saleModel('synthetic-model-b'));
    await assert.rejects((await activateSale(sale))(), refused);
  });

  await t.test('two concurrent activations of one subject: exactly one wins, every time', async () => {
    const subjects = ['project_planner.add_diary_entry', 'execution_evidence.record_claim', 'execution_evidence.attach_evidence', 'execution_evidence.report_defect', 'execution_evidence.decide_claim', 'execution_evidence.open_dispute'];
    for (const [i, key] of subjects.entries()) {
      const [sale, metered] = [await activateSale(await draftSale(saleCapability(key))), await activateMetered(await draftMetered(key))];
      const pair = i % 2 === 0 ? [sale(), metered()] : [metered(), sale()];
      const results = await Promise.allSettled(pair);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `${key}: ${JSON.stringify(results.map((r) => (r.status === 'rejected' ? (r.reason as { hint?: string }).hint : 'ok')))}`);
      const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.ok(refused(failure.reason as { hint?: string }), 'the loser is refused by the guard, never by a deadlock');
    }
  });
});
