import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { rejects } from '../../hubs/helpers.js';
import { approvals } from '../../../packages/data/src/repositories/admin.js';
import { billingReferrals } from '../../../packages/data/src/repositories/billing-fees.js';
import { directory } from '../../../packages/data/src/repositories/directory.js';
import { ReferralTermsSchema, type PublicReferral, type ReferralTerms } from '../../../packages/contracts/src/billing-fees.js';
import { neutralOutputs } from './neutrality.js';
import { feeWorld } from './helpers.js';

const REVIEW = 'synthetic-counsel-review-1';
const terms = (overrides: Partial<ReferralTerms> = {}): ReferralTerms => ({
  programmeKey: 'synthetic_invite', eligibleParties: 'person_or_company', rewardKind: 'platform_credit', currency: 'USD',
  referrerRewardMinor: '500', refereeRewardMinor: '250', maxRewardsPerReferrer: 3,
  effectiveFrom: new Date(Date.now() + 60000).toISOString(), effectiveTo: new Date(Date.now() + 3600000).toISOString(),
  acceptanceTextVersion: 'synthetic-referral-1', publicTerms: { en: 'Synthetic referral terms', es: 'Condiciones sintéticas' }, ...overrides,
});

const db = await provisionTestDatabase('fee_referrals', { weight: 2 });
test('BILL-003 referral terms on real PostgreSQL under the runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate(); await db.createAppLogin();
  const runtime = createPool({ ...db.appConfig, max: 8 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const { a, p, hubA, hubB } = await feeWorld(db.admin, runtime);
  await withMaintenance(db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', 'in', [p.owner, p.outsider]).execute());
  for (const id of [p.owner, p.outsider]) await a.as(id, (trx) => trx.insertInto('consent_record').values({
    subject_person_id: id, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: 'profile_public.v1',
    evidence: JSON.stringify({ method: 'first_party_form', requestId: 'synthetic-referral-neutrality' }),
  }).execute());
  const peopleBefore = await a.as(p.outsider, (trx) => directory.publicPeople(trx, { after: null, limit: 100 }));
  assert.ok(peopleBefore.length >= 2);
  const neutralBefore = neutralOutputs(p.outsider);
  const draft = (input: ReferralTerms, hubId = hubA, person = p.owner) => a.cmd(person, (trx, ctx) => billingReferrals.draft(trx, ctx, hubId, input, REVIEW));
  const approve = async (r: PublicReferral, digest = r.digest, requester = p.officer, approver = p.owner, action: 'growth.activate_referral_terms' | 'billing.activate_fee_version' = 'growth.activate_referral_terms') => {
    const request = await a.cmd(requester, (trx, ctx) => approvals.request(trx, ctx, { action, scope: { kind: 'hub', hubId: r.hubId }, actionDigest: digest }));
    await a.cmd(approver, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return request.id;
  };
  const activate = (r: PublicReferral, approval: string, person = p.officer, digest = r.digest) => a.cmd(person, (trx, ctx) => billingReferrals.activate(trx, ctx, r.hubId, r.id, digest, approval));

  const r = await draft(terms());
  await t.test('only platform credits, and no key that could reach a discovery surface or one participant', () => {
    assert.equal(ReferralTermsSchema.safeParse({ ...r.terms, rewardKind: 'cash' }).success, false);
    for (const key of ['ranking', 'matching', 'recommendations', 'reputation', 'boost', 'participantId', 'personId', 'companyId', 'leadPrice']) {
      assert.equal(ReferralTermsSchema.safeParse({ ...r.terms, [key]: 1 }).success, false, key);
    }
  });
  await t.test('the database refuses what the contract refuses, even when the contract is bypassed', async () => {
    const call = (value: unknown) => a.cmd(p.owner, (trx, ctx) => sql`SELECT trustwork.billing_referral_draft(${JSON.stringify(ctx)}::jsonb, ${hubA}::uuid, ${JSON.stringify(value)}::jsonb, ${REVIEW})`.execute(trx));
    await rejects(call({ ...terms(), ranking: 1 }), '22023', 'billing.invalid_terms');
    await rejects(call({ ...terms(), publicTerms: { en: '   ' } }), '22023', 'billing.invalid_terms');
    await rejects(call({ ...terms(), rewardKind: 'cash' }), '23514');
  });
  await t.test('participants, staff of another hub and missing or foreign elevations cannot draft', async () => {
    await rejects(draft(terms(), hubA, p.outsider), '42501', 'admin.forbidden');
    await rejects(draft(terms(), hubA, p.otherOwner), '42501', 'admin.forbidden');
    const ctx = await a.elevate(p.officer);
    await rejects(a.as(p.owner, (trx) => billingReferrals.draft(trx, ctx, hubA, terms(), REVIEW)), '42501', 'admin.elevation_required');
    await rejects(a.as(p.owner, (trx) => billingReferrals.draft(trx, { ...ctx, elevationId: randomUUID() }, hubA, terms(), REVIEW)), '42501', 'admin.elevation_required');
  });
  await t.test('the runtime role has no table access; terms and history cannot change, even through maintenance', async () => {
    await rejects(runtime.query('SELECT * FROM trustwork.referral_terms_version'), '42501');
    await rejects(runtime.query("UPDATE trustwork.referral_terms_version SET referrer_reward_minor = 0"), '42501');
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.referral_terms_version SET referrer_reward_minor=1 WHERE id=${r.id}::uuid`.execute(trx)), '23514', 'billing.version_frozen');
    await rejects(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.referral_terms_version WHERE id=${r.id}::uuid`.execute(trx)), '23514', 'billing.version_frozen');
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.referral_terms_version SET status='active',activated_by=${p.officer}::uuid,activated_at=now(),approval_id=${randomUUID()}::uuid WHERE id=${r.id}::uuid`.execute(trx)), '42501', 'admin.approval_mismatch');
    await rejects(withMaintenance(db.admin, (trx) => sql`INSERT INTO trustwork.referral_terms_version(hub_id,programme_key,version,eligible_parties,reward_kind,currency,referrer_reward_minor,referee_reward_minor,effective_from,acceptance_text_version,public_terms,legal_review_ref,status,drafted_by,activated_by,activated_at,approval_id)
      SELECT hub_id,programme_key,99,eligible_parties,reward_kind,currency,referrer_reward_minor,referee_reward_minor,effective_from,acceptance_text_version,public_terms,legal_review_ref,'active',drafted_by,${p.officer}::uuid,now(),${randomUUID()}::uuid FROM trustwork.referral_terms_version WHERE id=${r.id}::uuid`.execute(trx)), '23514', 'billing.version_not_draft');
  });
  await t.test('the drafter, a forged or foreign approval and a changed digest cannot activate', async () => {
    await rejects(activate(r, randomUUID(), p.owner), '42501', 'admin.self_approval');
    await rejects(activate(r, randomUUID()), '42501', 'admin.not_requester');
    await rejects(activate(r, await approve(r, 'f'.repeat(64))), '23514', 'admin.approval_mismatch');
    await rejects(activate(r, await approve(r, r.digest, p.officer, p.owner, 'billing.activate_fee_version')), '23514', 'admin.approval_mismatch');
    const correct = await approve(r);
    await rejects(activate(r, correct, p.officer, 'a'.repeat(64)), '42501', 'admin.approval_mismatch');
    await rejects(a.cmd(p.otherOwner, (trx, ctx) => billingReferrals.activate(trx, ctx, hubB, r.id, r.digest, correct)), 'P0002', 'admin.not_found');
    assert.deepEqual(await billingReferrals.publicList(runtime, hubA), [], 'a draft is never public');
    await activate(r, correct);
    await rejects(activate(r, correct), '23514', 'billing.unavailable');
  });
  await t.test('terms must be published in every hub language before activation', async () => {
    const partial = await draft(terms({ programmeKey: 'synthetic_partial', publicTerms: { en: 'Synthetic terms only in English' } }));
    await rejects(activate(partial, await approve(partial)), '23514', 'billing.language_missing');
  });
  await t.test('public projection holds the published terms only; the counsel reference and staff stay private', async () => {
    assert.deepEqual(await billingReferrals.publicList(runtime, hubA), [{ ...r }]);
    assert.deepEqual(await billingReferrals.publicList(runtime, hubB), []);
    const json = JSON.stringify(await billingReferrals.publicList(runtime, hubA));
    for (const secret of [REVIEW, p.owner, p.officer, 'drafted_by', 'approval_id']) assert.ok(!json.includes(secret), secret);
  });
  await t.test('staff see versions at their own hub only, under the referral permissions', async () => {
    const own = await a.cmd(p.officer, (trx, ctx) => billingReferrals.staffList(trx, ctx, hubA));
    const row = own.find((x) => x.id === r.id);
    assert.equal(row?.status, 'active'); assert.equal(row?.legalReviewRef, REVIEW); assert.equal(row?.draftedBy, p.owner); assert.equal(row?.activatedBy, p.officer);
    await rejects(a.cmd(p.otherOwner, (trx, ctx) => billingReferrals.staffList(trx, ctx, hubA)), '42501', 'admin.forbidden');
    await rejects(a.cmd(p.outsider, (trx, ctx) => billingReferrals.staffList(trx, ctx, hubA)), '42501', 'admin.forbidden');
  });
  await t.test('concurrent overlapping activations have exactly one winner', async () => {
    const input = terms({ programmeKey: 'synthetic_race' });
    const [left, right] = await Promise.all([draft(input), draft(input)]);
    assert.notEqual(left.version, right.version);
    const approvalsMade = [await approve(left), await approve(right)];
    const results = await Promise.allSettled([activate(left, approvalsMade[0]!), activate(right, approvalsMade[1]!)]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.hint, 'billing.version_overlap');
  });
  await t.test('adjacent intervals are allowed; backdating is refused', async () => {
    const next = await draft(terms({ effectiveFrom: r.terms.effectiveTo!, effectiveTo: null }));
    await activate(next, await approve(next));
    const past = await draft(terms({ programmeKey: 'synthetic_past', effectiveFrom: new Date(Date.now() - 60000).toISOString() }));
    await rejects(activate(past, await approve(past)), '23514', 'billing.backdated');
    await a.cmd(p.officer, (trx, ctx) => billingReferrals.withdraw(trx, ctx, hubA, next.id, next.digest));
  });
  await t.test('withdrawal is staff-scoped, exact, audited, and frees the interval for a successor', async () => {
    const live = await draft(terms({ programmeKey: 'synthetic_stop' }));
    await activate(live, await approve(live));
    await rejects(a.cmd(p.outsider, (trx, ctx) => billingReferrals.withdraw(trx, ctx, hubA, live.id, live.digest)), '42501', 'admin.forbidden');
    await rejects(a.cmd(p.officer, (trx, ctx) => billingReferrals.withdraw(trx, ctx, hubA, live.id, 'a'.repeat(64))), '42501', 'admin.approval_mismatch');
    await a.cmd(p.officer, (trx, ctx) => billingReferrals.withdraw(trx, ctx, hubA, live.id, live.digest));
    await rejects(a.cmd(p.officer, (trx, ctx) => billingReferrals.withdraw(trx, ctx, hubA, live.id, live.digest)), '23514', 'billing.unavailable');
    assert.ok(!(await billingReferrals.publicList(runtime, hubA)).some((x) => x.id === live.id));
    const successor = await draft(terms({ programmeKey: 'synthetic_stop' }));
    await activate(successor, await approve(successor));
    const rows = (await db.admin.query("SELECT action,actor_person_id FROM trustwork.admin_audit_event WHERE object_id=$1 ORDER BY sequence", [live.id])).rows;
    assert.deepEqual(rows.map((x) => x.action), ['billing.referral_drafted', 'billing.referral_activated', 'billing.referral_withdrawn']);
  });
  await t.test('activation is audited with the second person', async () => {
    const rows = (await db.admin.query("SELECT actor_person_id,hub_id,second_approver_person_id FROM trustwork.admin_audit_event WHERE action='billing.referral_activated' AND object_id=$1", [r.id])).rows;
    assert.deepEqual(rows, [{ actor_person_id: p.officer, hub_id: hubA, second_approver_person_id: p.owner }]);
  });
  await t.test('real directory order, quote comparison, reputation and acceptance digest are identical with a programme active', async () => {
    assert.ok((await billingReferrals.publicList(runtime, hubA)).length > 0);
    assert.deepEqual(await a.as(p.outsider, (trx) => directory.publicPeople(trx, { after: null, limit: 100 })), peopleBefore);
    assert.deepEqual(neutralOutputs(p.outsider), neutralBefore);
    const columns = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='trustwork' AND table_name='referral_terms_version'")).rows.map((x) => x.column_name as string);
    assert.ok(!columns.some((c) => /rank|match|recommend|reputation|boost|score|weight|priorit|participant|subject/.test(c)));
  });
});
