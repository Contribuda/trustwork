import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { PROVIDER_CAPABILITIES } from '@trustwork/contracts';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { rejects } from '../../hubs/helpers.js';
import { approvals } from '../../../packages/data/src/repositories/admin.js';
import { catalogue } from '../../../packages/data/src/repositories/billing.js';
import { billingFees, billingSalePrices } from '../../../packages/data/src/repositories/billing-fees.js';
import { directory } from '../../../packages/data/src/repositories/directory.js';
import { SalePriceTermsSchema, type SalePriceTerms, type SalePriceVersion } from '../../../packages/contracts/src/billing-fees.js';
import { neutralOutputs } from './neutrality.js';
import { feeWorld, syntheticTerms } from './helpers.js';

const window = () => ({ effectiveFrom: new Date(Date.now() + 60000).toISOString(), effectiveTo: new Date(Date.now() + 3600000).toISOString() });
const base = () => ({ currency: 'USD', amountMinor: '125', acceptanceTextVersion: 'synthetic-sale-1', ...window() });
export const modelTerms = (overrides: Partial<Extract<SalePriceTerms, { kind: 'model' }>> = {}): SalePriceTerms => ({ kind: 'model', code: 'synthetic_model', name: 'Synthetic model', modelId: 'synthetic-model-1', meter: 'model_tokens', perUnits: '1000', ...base(), ...overrides });
export const capabilityTerms = (): SalePriceTerms => ({ kind: 'capability', code: 'synthetic_capability', name: 'Synthetic capability', capabilityId: 'core.list_goals', meter: 'agent_actions', perUnits: '1', ...base() });
export const packTerms = (overrides: Partial<Extract<SalePriceTerms, { kind: 'credit_pack' }>> = {}): SalePriceTerms => ({ kind: 'credit_pack', code: 'synthetic_pack', name: 'Synthetic pack', creditMinor: '1000', validityDays: 90, expiryNoticeDays: 14, refundPolicyVersion: 'synthetic-refund-1', ...base(), ...overrides });

/** A cost record is the only proof a catalogue-less hub has that it serves a model. It never sets a sale price. */
export async function seedModel(admin: DataPool, hubId: string, createdBy: string, modelId: string): Promise<string> {
  return withMaintenance(admin, async (trx) => {
    const c = await sql<{ id: string }>`INSERT INTO trustwork.provider_connection(hub_id,adapter_id,label,capabilities,mode,hosting_kind,processing_country,created_by)
      VALUES(${hubId}::uuid,'synthetic_fake','Synthetic connection',ARRAY[${PROVIDER_CAPABILITIES[0]}]::text[],'fake','self_hosted','US',${createdBy}::uuid) RETURNING id`.execute(trx);
    const id = c.rows[0]!.id;
    await sql`INSERT INTO trustwork.model_pricing(hub_id,connection_id,model_id,version,currency,input_per_million_tokens,basis,observed_at,recorded_by) VALUES(${hubId}::uuid,${id}::uuid,${modelId},1,'USD',1,'measured',now(),${createdBy}::uuid)`.execute(trx);
    return id;
  });
}

const db = await provisionTestDatabase('fee_sale_prices', { weight: 2 });
test('BILL-003 model, capability and credit-pack sale versions on real PostgreSQL', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate(); await db.createAppLogin();
  const runtime = createPool({ ...db.appConfig, max: 8 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const { a, p, hubA, hubB, draft: draftFee } = await feeWorld(db.admin, runtime);
  const connection = await seedModel(db.admin, hubA, p.owner, 'synthetic-model-1');
  await withMaintenance(db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', 'in', [p.owner, p.outsider]).execute());
  for (const id of [p.owner, p.outsider]) await a.as(id, (trx) => trx.insertInto('consent_record').values({
    subject_person_id: id, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'profile_public.v1',
    evidence: JSON.stringify({ method: 'first_party_form', requestId: 'synthetic-sale-neutrality' }),
  }).execute());
  const peopleBefore = await a.as(p.outsider, (trx) => directory.publicPeople(trx, { after: null, limit: 100 }));
  assert.ok(peopleBefore.length >= 2);
  const neutralBefore = neutralOutputs(p.outsider);
  const draft = (input: SalePriceTerms, hubId = hubA, person = p.owner) => a.cmd(person, (trx, ctx) => billingSalePrices.draft(trx, ctx, hubId, input));
  const approve = async (v: SalePriceVersion, digest = v.digest, action: 'commerce.activate_price_version' | 'billing.activate_fee_version' = 'commerce.activate_price_version') => {
    const request = await a.cmd(p.officer, (trx, ctx) => approvals.request(trx, ctx, { action, scope: { kind: 'hub', hubId: v.hubId }, actionDigest: digest }));
    await a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return request.id;
  };
  const activate = (v: SalePriceVersion, approval: string, person = p.officer, digest = v.digest, supersede = false) => a.cmd(person, (trx, ctx) => billingSalePrices.activate(trx, ctx, v.hubId, v.id, digest, approval, supersede));

  const model = await draft(modelTerms());
  await t.test('strict terms hold no discovery or participant control, and an expiry always has notice', () => {
    for (const key of ['ranking', 'matching', 'recommendations', 'reputation', 'boost', 'participantId', 'costMinor', 'providerCost']) {
      assert.equal(SalePriceTermsSchema.safeParse({ ...model.terms, [key]: 1 }).success, false, key);
    }
    assert.equal(SalePriceTermsSchema.safeParse(packTerms({ expiryNoticeDays: null })).success, false, 'an expiry without notice');
    assert.equal(SalePriceTermsSchema.safeParse(packTerms({ validityDays: 10, expiryNoticeDays: 10 })).success, false, 'notice as long as the validity');
    assert.equal(SalePriceTermsSchema.safeParse(packTerms({ validityDays: null, expiryNoticeDays: null })).success, true, 'credits that do not expire');
  });
  await t.test('the database refuses what the contract refuses, even when the contract is bypassed', async () => {
    const call = (value: unknown) => a.cmd(p.owner, (trx, ctx) => sql`SELECT trustwork.billing_sale_price_draft(${JSON.stringify(ctx)}::jsonb, ${hubA}::uuid, ${JSON.stringify(value)}::jsonb)`.execute(trx));
    await rejects(call({ ...modelTerms({ code: 'synthetic_bypass' }), ranking: 1 }), '22023', 'billing.invalid_terms');
    await rejects(call({ ...modelTerms({ code: 'synthetic_bypass' }), creditMinor: '1' }), '22023', 'billing.invalid_terms');
    await rejects(call({ ...packTerms({ code: 'synthetic_bypass' }), expiryNoticeDays: null }), '23514');
  });
  await t.test('a price names something this hub really serves, and an offer cannot change kind or name', async () => {
    await rejects(draft(modelTerms({ code: 'synthetic_ghost', modelId: 'synthetic-unknown' })), '23514', 'billing.sale_subject_unknown');
    await rejects(draft({ ...capabilityTerms(), capabilityId: 'core.synthetic_unknown' } as SalePriceTerms), '23514', 'billing.sale_subject_unknown');
    await seedModel(db.admin, hubB, p.otherOwner, 'synthetic-other-hub');
    await rejects(draft(modelTerms({ code: 'synthetic_foreign', modelId: 'synthetic-other-hub' })), '23514', 'billing.sale_subject_unknown');
    await rejects(draft(modelTerms({ name: 'Synthetic renamed' })), '23514', 'billing.invalid_terms');
    await rejects(draft(packTerms({ code: 'synthetic_model' })), '23514', 'billing.invalid_terms');
  });
  await t.test('participants, staff of another hub and missing or foreign elevations cannot draft', async () => {
    await rejects(draft(packTerms(), hubA, p.outsider), '42501', 'admin.forbidden');
    await rejects(draft(packTerms(), hubA, p.otherOwner), '42501', 'admin.forbidden');
    const ctx = await a.elevate(p.officer);
    await rejects(a.as(p.owner, (trx) => billingSalePrices.draft(trx, ctx, hubA, packTerms())), '42501', 'admin.elevation_required');
    await rejects(a.as(p.owner, (trx) => billingSalePrices.draft(trx, { ...ctx, elevationId: randomUUID() }, hubA, packTerms())), '42501', 'admin.elevation_required');
  });
  await t.test('the runtime role has no table access, and terms cannot change even through maintenance', async () => {
    await rejects(runtime.query('SELECT * FROM trustwork.price_sale_terms'), '42501');
    await rejects(runtime.query('SELECT * FROM trustwork.price_sale_activation'), '42501');
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.price_sale_terms SET per_units=1 WHERE price_version_id=${model.id}::uuid`.execute(trx)), '23000', 'audit.append_only');
    await rejects(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.price_sale_terms WHERE price_version_id=${model.id}::uuid`.execute(trx)), '23000', 'audit.append_only');
  });
  await t.test('the owner-run catalogue cannot activate these kinds around the terms or the approval', async () => {
    const bare = await withMaintenance(db.admin, async (trx) => {
      const offer = await catalogue.createOffer(trx, { hubId: hubA, code: 'synthetic_bare_pack', name: 'Synthetic bare pack', kind: 'credit_pack', createdBy: p.owner, status: 'active' });
      return catalogue.draftPriceVersion(trx, { offerId: offer.id, amountMinor: '1', currency: 'USD', effectiveFrom: new Date(Date.now() + 60000), acceptanceTextVersion: 'synthetic-1', draftedBy: p.owner });
    });
    await rejects(withMaintenance(db.admin, (trx) => catalogue.activatePriceVersion(trx, bare.id, p.officer)), '23514', 'billing.sale_terms_missing');
    await rejects(withMaintenance(db.admin, (trx) => catalogue.activatePriceVersion(trx, model.id, p.officer)), '42501', 'admin.approval_mismatch');
  });
  await t.test('the drafter, a forged or foreign approval and a changed digest cannot activate', async () => {
    await rejects(activate(model, randomUUID(), p.owner), '42501', 'admin.self_approval');
    await rejects(activate(model, randomUUID()), '42501', 'admin.not_requester');
    await rejects(activate(model, await approve(model, 'f'.repeat(64))), '23514', 'admin.approval_mismatch');
    await rejects(activate(model, await approve(model, model.digest, 'billing.activate_fee_version')), '23514', 'admin.approval_mismatch');
    const correct = await approve(model);
    await rejects(activate(model, correct, p.officer, 'a'.repeat(64)), '42501', 'admin.approval_mismatch');
    await rejects(a.cmd(p.otherOwner, (trx, ctx) => billingSalePrices.activate(trx, ctx, hubB, model.id, model.digest, correct)), 'P0002', 'admin.not_found');
    assert.deepEqual(await billingSalePrices.publicList(runtime, hubA, 'model'), [], 'a draft is never public');
    await activate(model, correct);
    await rejects(activate(model, correct), '23514', 'billing.unavailable');
  });
  await t.test('each kind is published in its own section with its unit or validity; private values stay out', async () => {
    const capability = await draft(capabilityTerms()); await activate(capability, await approve(capability));
    const pack = await draft(packTerms()); await activate(pack, await approve(pack));
    const [m] = await billingSalePrices.publicList(runtime, hubA, 'model');
    assert.equal(m?.id, model.id); assert.equal(m?.amountMinor, '125'); assert.equal(m?.validity, null); assert.equal(m?.disclosure?.digest, model.digest);
    assert.deepEqual(m?.disclosure?.sale, { modelId: 'synthetic-model-1', capabilityId: null, meter: 'model_tokens', perUnits: '1000' });
    const [c] = await billingSalePrices.publicList(runtime, hubA, 'capability');
    assert.equal(c?.disclosure?.sale?.capabilityId, 'core.list_goals');
    const [k] = await billingSalePrices.publicList(runtime, hubA, 'credit_pack');
    assert.equal(k?.validity, 'P90D');
    assert.deepEqual(k?.disclosure?.creditPack, { creditMinor: '1000', validityDays: 90, expiryNoticeDays: 14, refundPolicyVersion: 'synthetic-refund-1' });
    assert.deepEqual(await billingSalePrices.publicList(runtime, hubB, 'model'), []);
    const json = JSON.stringify([m, c, k]);
    for (const secret of [p.owner, p.officer, connection, 'drafted_by', 'approval_id', 'input_per_million']) assert.ok(!json.includes(secret), secret);
  });
  await t.test('a new provider cost record changes no sale price', async () => {
    const before = await billingSalePrices.publicList(runtime, hubA, 'model');
    await withMaintenance(db.admin, (trx) => sql`INSERT INTO trustwork.model_pricing(hub_id,connection_id,model_id,version,currency,input_per_million_tokens,basis,observed_at,recorded_by) VALUES(${hubA}::uuid,${connection}::uuid,'synthetic-model-1',2,'USD',999,'measured',now(),${p.owner}::uuid)`.execute(trx));
    assert.deepEqual(await billingSalePrices.publicList(runtime, hubA, 'model'), before);
  });
  await t.test('concurrent overlapping activations of one offer have exactly one winner', async () => {
    const input = modelTerms({ code: 'synthetic_race', name: 'Synthetic race' });
    const left = await draft(input); const right = await draft(input);
    const made = [await approve(left), await approve(right)];
    const results = await Promise.allSettled([activate(left, made[0]!), activate(right, made[1]!)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.hint, 'billing.version_overlap');
  });
  await t.test('an open-ended version is replaced only by naming it; the approval covers the end date', async () => {
    const first = await draft(modelTerms({ code: 'synthetic_open', name: 'Synthetic open', effectiveTo: null }));
    await activate(first, await approve(first));
    const next = await draft(modelTerms({ code: 'synthetic_open', name: 'Synthetic open', effectiveFrom: new Date(Date.now() + 120000).toISOString(), effectiveTo: null, amountMinor: '250' }));
    await rejects(activate(next, await approve(next)), '23P01', 'billing.version_overlap');
    await activate(next, await approve(next), p.officer, next.digest, true);
    const rows = (await billingSalePrices.publicList(runtime, hubA, 'model')).filter((r) => r.code === 'synthetic_open');
    assert.equal(rows.length, 2); assert.equal(rows[0]?.effectiveTo, next.terms.effectiveFrom); assert.equal(rows[1]?.effectiveTo, null);
  });
  await t.test('staff lists show every version at their own hub only, under the matching permission', async () => {
    const prices = await a.cmd(p.officer, (trx, ctx) => billingSalePrices.staffList(trx, ctx, hubA));
    const row = prices.find((x) => x.id === model.id);
    assert.equal(row?.status, 'active'); assert.equal(row?.draftedBy, p.owner); assert.equal(row?.activatedBy, p.officer);
    await rejects(a.cmd(p.otherOwner, (trx, ctx) => billingSalePrices.staffList(trx, ctx, hubA)), '42501', 'admin.forbidden');
    await rejects(a.cmd(p.outsider, (trx, ctx) => billingSalePrices.staffList(trx, ctx, hubA)), '42501', 'admin.forbidden');
    const fee = await draftFee(syntheticTerms());
    const fees = await a.cmd(p.officer, (trx, ctx) => billingFees.staffList(trx, ctx, hubA));
    assert.equal(fees.find((x) => x.id === fee.id)?.status, 'draft');
    await rejects(a.cmd(p.otherOwner, (trx, ctx) => billingFees.staffList(trx, ctx, hubA)), '42501', 'admin.forbidden');
    await rejects(a.cmd(p.outsider, (trx, ctx) => billingFees.staffList(trx, ctx, hubA)), '42501', 'admin.forbidden');
  });
  await t.test('activation is audited with the second person', async () => {
    const rows = (await db.admin.query("SELECT actor_person_id,hub_id,second_approver_person_id FROM trustwork.admin_audit_event WHERE action='billing.sale_price_activated' AND object_id=$1", [model.id])).rows;
    assert.deepEqual(rows, [{ actor_person_id: p.officer, hub_id: hubA, second_approver_person_id: p.owner }]);
  });
  await t.test('real directory order, quote comparison, reputation and acceptance digest are identical with sale prices active', async () => {
    assert.deepEqual(await a.as(p.outsider, (trx) => directory.publicPeople(trx, { after: null, limit: 100 })), peopleBefore);
    assert.deepEqual(neutralOutputs(p.outsider), neutralBefore);
    for (const table of ['price_sale_terms', 'price_sale_activation']) {
      const columns = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='trustwork' AND table_name=$1", [table])).rows.map((x) => x.column_name as string);
      assert.ok(!columns.some((c) => /rank|match|recommend|reputation|boost|score|weight|priorit|participant/.test(c)), table);
    }
  });
});
