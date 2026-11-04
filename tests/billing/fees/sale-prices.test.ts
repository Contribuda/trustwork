import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
  const approve = async (v: SalePriceVersion, digest = v.activationDigest, action: 'commerce.activate_price_version' | 'billing.activate_fee_version' = 'commerce.activate_price_version') => {
    const request = await a.cmd(p.officer, (trx, ctx) => approvals.request(trx, ctx, { action, scope: { kind: 'hub', hubId: v.hubId }, actionDigest: digest }));
    await a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return request.id;
  };
  const activate = (v: SalePriceVersion, approval: string, person = p.officer, digest = v.digest, supersede: string | null = null) => a.cmd(person, (trx, ctx) => billingSalePrices.activate(trx, ctx, v.hubId, v.id, digest, approval, supersede));

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
    await rejects(runtime.query('SELECT * FROM trustwork.price_sale_supersession'), '42501');
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
    await rejects(activate(model, await approve(model, model.digest)), '23514', 'admin.approval_mismatch');
    await rejects(activate(model, await approve(model, model.activationDigest, 'billing.activate_fee_version')), '23514', 'admin.approval_mismatch');
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
    await seedModel(db.admin, hubA, p.owner, 'synthetic-race');
    const input = modelTerms({ code: 'synthetic_race', name: 'Synthetic race', modelId: 'synthetic-race' });
    const left = await draft(input); const right = await draft(input);
    const made = [await approve(left), await approve(right)];
    const results = await Promise.allSettled([activate(left, made[0]!), activate(right, made[1]!)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.hint, 'billing.version_overlap');
  });
  const at = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
  const boundDigest = async (v: SalePriceVersion, supersedes: string) => (await db.admin.query<{ d: string }>('SELECT trustwork.billing_sale_activation_digest($1,$2::uuid) AS d', [v.digest, supersedes])).rows[0]!.d;
  const signedDigest = (id: string) => withMaintenance(db.admin, async (trx) => (await sql<{ d: string }>`SELECT trustwork.billing_sale_digest(p,o,s) AS d FROM trustwork.price_version p
    JOIN trustwork.offer o ON o.id=p.offer_id JOIN trustwork.price_sale_terms s ON s.price_version_id=p.id WHERE p.id=${id}::uuid`.execute(trx)).rows[0]!.d);
  await t.test('supersession: the approved digest binds the choice, the signed end stays, and the change is audited', async () => {
    await seedModel(db.admin, hubA, p.owner, 'synthetic-open');
    const terms = (overrides: Parameters<typeof modelTerms>[0]) => modelTerms({ code: 'synthetic_open', name: 'Synthetic open', modelId: 'synthetic-open', ...overrides });
    const early = await draft(terms({ effectiveFrom: at(3), effectiveTo: at(6) }));
    await activate(early, await approve(early));
    const first = await draft(terms({ effectiveFrom: early.terms.effectiveTo!, effectiveTo: null }));
    await activate(first, await approve(first));
    const next = await draft(terms({ effectiveFrom: at(12), effectiveTo: null, amountMinor: '250' }));
    const staffRow = async (id: string) => (await a.cmd(p.officer, (trx, ctx) => billingSalePrices.staffList(trx, ctx, hubA))).find((x) => x.id === id);

    const offered = (await staffRow(next.id))?.supersedable;
    assert.deepEqual(offered?.map((x) => x.versionId), [first.id], 'a draft offers only what it may supersede');
    const bound = offered![0]!.activationDigest;
    assert.equal(bound, await boundDigest(next, first.id));
    assert.notEqual(bound, next.activationDigest, 'superseding is a different approval from plain activation');

    const plain = await approve(next);
    await rejects(activate(next, plain), '23P01', 'billing.version_overlap');
    await rejects(activate(next, plain, p.officer, next.digest, first.id), '23514', 'admin.approval_mismatch');
    const approved = await approve(next, bound);
    await rejects(activate(next, approved), '23514', 'admin.approval_mismatch');
    const forEarly = await approve(next, await boundDigest(next, early.id));
    await rejects(activate(next, forEarly, p.officer, next.digest, first.id), '23514', 'admin.approval_mismatch');
    await rejects(activate(next, forEarly, p.officer, next.digest, early.id), '23514', 'billing.supersede_invalid');
    await rejects(activate(next, approved, p.officer, next.digest, model.id), '23514', 'billing.supersede_invalid');
    assert.equal((await staffRow(first.id))?.status, 'active', 'every refusal left the live version alone');

    await activate(next, approved, p.officer, next.digest, first.id);

    const row = (await db.admin.query('SELECT effective_to,status FROM trustwork.price_version WHERE id=$1', [first.id])).rows[0];
    assert.equal(row.effective_to, null, 'the digested end date is not rewritten');
    assert.equal(row.status, 'superseded');
    assert.equal(await signedDigest(first.id), first.digest, 'the digest its approver signed still recomputes');
    const staff = await staffRow(first.id);
    assert.equal(staff?.digest, first.digest); assert.equal(staff?.terms.effectiveTo, null);
    assert.equal(staff?.effectiveEnd, next.terms.effectiveFrom); assert.equal(staff?.supersededBy, next.id);
    const shown = (await billingSalePrices.publicList(runtime, hubA, 'model')).filter((r) => r.code === 'synthetic_open');
    assert.deepEqual(shown.map((r) => r.id), [early.id, first.id, next.id], 'the old price stays published until the new one starts');
    const old = shown.find((r) => r.id === first.id);
    assert.equal(old?.effectiveTo, next.terms.effectiveFrom, 'readers see the effective end');
    assert.equal(old?.disclosure?.digest, first.digest);
    assert.equal(old?.disclosure?.supersededBy?.versionId, next.id); assert.equal(old?.disclosure?.supersededBy?.signedEffectiveTo, null);

    const audit = (await db.admin.query("SELECT actor_person_id,second_approver_person_id,reason_text FROM trustwork.admin_audit_event WHERE action='billing.sale_price_superseded' AND object_id=$1", [first.id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_person_id, p.officer); assert.equal(audit[0].second_approver_person_id, p.owner);
    assert.equal(audit[0].reason_text, `Superseded by ${next.id}; end none to ${next.terms.effectiveFrom}`, 'the audit row names the new version, the old end and the new end');

    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.price_version SET effective_to=effective_from+interval '1 day' WHERE id=${next.id}::uuid`.execute(trx)), '23514', 'billing.version_frozen');
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.price_version SET status='superseded' WHERE id=${next.id}::uuid`.execute(trx)), '42501', 'admin.approval_mismatch');
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.price_sale_supersession SET ends_at=now() WHERE price_version_id=${first.id}::uuid`.execute(trx)), '23000', 'audit.append_only');
    const again = await draft(terms({ effectiveFrom: at(20), effectiveTo: null }));
    await rejects(activate(again, await approve(again, await boundDigest(again, first.id)), p.officer, again.digest, first.id), '23514', 'billing.supersede_invalid');
  });
  await t.test('a short version cannot end a longer one; a version that outlasts it can', async () => {
    await seedModel(db.admin, hubA, p.owner, 'synthetic-promo');
    const terms = (overrides: Parameters<typeof modelTerms>[0]) => modelTerms({ code: 'synthetic_promo', name: 'Synthetic promo', modelId: 'synthetic-promo', ...overrides });
    const open = await draft(terms({ effectiveFrom: at(3), effectiveTo: null }));
    await activate(open, await approve(open));
    const promo = await draft(terms({ effectiveFrom: at(8), effectiveTo: at(9), amountMinor: '1' }));
    assert.deepEqual((await a.cmd(p.officer, (trx, ctx) => billingSalePrices.staffList(trx, ctx, hubA))).find((x) => x.id === promo.id)?.supersedable, [], 'it is not even offered');
    await rejects(activate(promo, await approve(promo, await boundDigest(promo, open.id)), p.officer, promo.digest, open.id), '23514', 'billing.supersede_leaves_gap');
    const row = (await billingSalePrices.publicList(runtime, hubA, 'model')).find((r) => r.id === open.id);
    assert.equal(row?.effectiveTo, null, 'the open-ended price still stands');

    await seedModel(db.admin, hubA, p.owner, 'synthetic-finite');
    const finite = (overrides: Parameters<typeof modelTerms>[0]) => modelTerms({ code: 'synthetic_finite', name: 'Synthetic finite', modelId: 'synthetic-finite', ...overrides });
    const short = await draft(finite({ effectiveFrom: at(3), effectiveTo: at(20) }));
    await activate(short, await approve(short));
    const shorter = await draft(finite({ effectiveFrom: at(8), effectiveTo: at(10) }));
    await rejects(activate(shorter, await approve(shorter, await boundDigest(shorter, short.id)), p.officer, shorter.digest, short.id), '23514', 'billing.supersede_leaves_gap');
    const longer = await draft(finite({ effectiveFrom: at(8), effectiveTo: at(30) }));
    await activate(longer, await approve(longer, await boundDigest(longer, short.id)), p.officer, longer.digest, short.id);
  });
  await t.test('activation takes the advisory lock before the offer row, the same order as drafting', async () => {
    await seedModel(db.admin, hubA, p.owner, 'synthetic-lock');
    const v = await draft(modelTerms({ code: 'synthetic_lock', name: 'Synthetic lock', modelId: 'synthetic-lock' }));
    const approval = await approve(v);
    let release!: () => void; let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holder = withMaintenance(db.admin, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('trustwork.billing.sale'), hashtext(${`${hubA}:synthetic_lock`}::text))`.execute(trx);
      held(); await gate;
    });
    await holding;
    const pending = activate(v, approval);
    try {
      const blocked = async () => (await db.admin.query<{ n: number }>("SELECT count(*)::int n FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname=current_database() AND l.locktype='advisory' AND NOT l.granted")).rows[0]!.n > 0;
      for (let i = 0; i < 200 && !await blocked(); i++) await delay(50);
      assert.ok(await blocked(), 'activation waits on the advisory lock');
      await withMaintenance(db.admin, (trx) => sql`SELECT id FROM trustwork.offer WHERE hub_id=${hubA}::uuid AND code='synthetic_lock' FOR UPDATE NOWAIT`.execute(trx));
    } finally { release(); }
    await holder; await pending;
  });
  await t.test('two offers cannot price one model or capability on one meter at once, even concurrently', async () => {
    await seedModel(db.admin, hubA, p.owner, 'synthetic-shared');
    const left = await draft(modelTerms({ code: 'synthetic_left', name: 'Synthetic left', modelId: 'synthetic-shared' }));
    const right = await draft(modelTerms({ code: 'synthetic_right', name: 'Synthetic right', modelId: 'synthetic-shared' }));
    const made = [await approve(left), await approve(right)];
    const results = await Promise.allSettled([activate(left, made[0]!), activate(right, made[1]!)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.hint, 'billing.version_overlap');
    const otherMeter = await draft(modelTerms({ code: 'synthetic_meter', name: 'Synthetic meter', modelId: 'synthetic-shared', meter: 'agent_actions' }));
    await activate(otherMeter, await approve(otherMeter));
    const winner = results[0]!.status === 'fulfilled' ? left : right;
    const later = await draft(modelTerms({ code: 'synthetic_later', name: 'Synthetic later', modelId: 'synthetic-shared', effectiveFrom: winner.terms.effectiveTo!, effectiveTo: null }));
    await activate(later, await approve(later));
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
    for (const table of ['price_sale_terms', 'price_sale_activation', 'price_sale_supersession']) {
      const columns = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='trustwork' AND table_name=$1", [table])).rows.map((x) => x.column_name as string);
      assert.ok(!columns.some((c) => /rank|match|recommend|reputation|boost|score|weight|priorit|participant/.test(c)), table);
    }
  });
});
