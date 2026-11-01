import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { rejects } from '../../hubs/helpers.js';
import { billingFees } from '../../../packages/data/src/repositories/billing-fees.js';
import { FeeTermsSchema } from '../../../packages/contracts/src/billing-fees.js';
import { directory } from '../../../packages/data/src/repositories/directory.js';
import { neutralOutputs } from './neutrality.js';
import { feeWorld, syntheticTerms } from './helpers.js';

const db = await provisionTestDatabase('fee_authority', { weight: 2 });
test('BILL-003 fee authority on real PostgreSQL', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate(); await db.createAppLogin();
  const runtime = createPool({ ...db.appConfig, max: 8 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const { a, p, hubA, hubB, draft, approve, activate } = await feeWorld(db.admin, runtime);
  await withMaintenance(db.admin, (trx) => trx.updateTable('person').set({ profile_visibility: 'public' }).where('id', 'in', [p.owner, p.outsider]).execute());
  const peopleBefore = await a.as(p.outsider, (trx) => directory.publicPeople(trx, { after: null, limit: 100 }));
  assert.ok(peopleBefore.length >= 2);
  const neutralBefore = neutralOutputs(p.outsider);
  assert.equal(neutralBefore.comparison.entries.length, 2);
  const f = await draft(syntheticTerms());
  await t.test('SQL and contract bind the exact immutable terms', () => {
    assert.equal(f.digest, computeDigest({ action: 'billing.activate_fee_version', id: f.id, hubId: hubA, version: f.version, terms: f.terms }).value);
    for (const key of ['ranking', 'matching', 'recommendations', 'reputation', 'participantId', 'leadPrice']) {
      assert.equal(FeeTermsSchema.safeParse({ ...f.terms, [key]: 1 }).success, false);
    }
  });
  await t.test('participants, other hubs and missing or foreign elevations cannot draft', async () => {
    await rejects(draft(syntheticTerms(), hubA, p.outsider), '42501', 'admin.forbidden');
    await rejects(draft(syntheticTerms(), hubA, p.otherOwner), '42501', 'admin.forbidden');
    const ctx = await a.elevate(p.officer);
    await rejects(a.as(p.owner, (trx) => billingFees.draft(trx, ctx, hubA, f.terms)), '42501', 'admin.elevation_required');
    await rejects(a.as(p.owner, (trx) => billingFees.draft(trx, { ...ctx, elevationId: randomUUID() }, hubA, f.terms)), '42501', 'admin.elevation_required');
  });
  await t.test('draft and active terms cannot change even through maintenance', async () => {
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.marketplace_fee_version SET basis_points=200 WHERE id=${f.id}::uuid`.execute(trx)), '23514', 'billing.version_frozen');
  });
  await t.test('drafter, forged approval and wrong digest cannot activate', async () => {
    await rejects(activate(f, randomUUID(), p.owner), '42501', 'admin.self_approval');
    await rejects(activate(f, randomUUID()), '42501', 'admin.not_requester');
    const wrong = await approve(f, 'f'.repeat(64));
    await rejects(activate(f, wrong), '23514', 'admin.approval_mismatch');
    const correct = await approve(f);
    await rejects(activate(f, correct, p.officer, 'a'.repeat(64)), '42501', 'admin.approval_mismatch');
    await activate(f, correct);
    await rejects(activate(f, correct), '23514', 'billing.unavailable');
  });
  await t.test('public projection contains only published fee terms for the requested hub', async () => {
    assert.deepEqual(await billingFees.publicList(runtime, hubA), [f]);
    assert.deepEqual(await billingFees.publicList(runtime, hubB), []);
    const json = JSON.stringify(await billingFees.publicList(runtime, hubA));
    for (const privateValue of [p.owner, p.officer, 'drafted_by', 'approval_id', 'reasonText']) assert.ok(!json.includes(privateValue));
  });
  await t.test('active validity cannot silently change', async () => {
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.marketplace_fee_version SET effective_to=effective_to-interval '1 minute' WHERE id=${f.id}::uuid`.execute(trx)), '23514', 'billing.version_frozen');
  });
  await t.test('generic category cannot overlap a specific published category', async () => {
    const generic = await draft(syntheticTerms({ categoryKey: null }));
    await rejects(activate(generic, await approve(generic)), '23P01', 'billing.version_overlap');
  });
  await t.test('concurrent overlapping activations have exactly one winner', async () => {
    const terms = syntheticTerms({ categoryKey: 'synthetic_race' });
    const [left, right] = await Promise.all([draft(terms), draft(terms)]);
    assert.notEqual(left.version, right.version);
    const leftApproval = await approve(left); const rightApproval = await approve(right);
    const results = await Promise.allSettled([activate(left, leftApproval), activate(right, rightApproval)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(loser.reason.hint, 'billing.version_overlap');
  });
  await t.test('adjacent half-open intervals are allowed; backdating is refused', async () => {
    const next = await draft(syntheticTerms({ effectiveFrom: f.terms.effectiveTo!, effectiveTo: null }));
    await activate(next, await approve(next));
    const past = await draft(syntheticTerms({ categoryKey: 'synthetic_past', effectiveFrom: new Date(Date.now()-60000).toISOString() }));
    await rejects(activate(past, await approve(past)), '23514', 'billing.backdated');
  });
  await t.test('real directory order, quote comparison, reputation and immutable acceptance digest are identical after fee changes', async () => {
    assert.deepEqual(await a.as(p.outsider, (trx) => directory.publicPeople(trx, { after: null, limit: 100 })), peopleBefore);
    assert.deepEqual(neutralOutputs(p.outsider), neutralBefore);
    const columns = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='trustwork' AND table_name='marketplace_fee_version'")).rows.map((r) => r.column_name as string);
    assert.ok(!columns.some((c) => /rank|match|recommend|reputation|boost|participant/.test(c)));
  });
  await t.test('successful commands have real scoped audit and consumed approvals', async () => {
    const rows = (await db.admin.query("SELECT actor_person_id, hub_id, second_approver_person_id FROM trustwork.admin_audit_event WHERE action='billing.fee_activated' AND object_id=$1", [f.id])).rows;
    assert.deepEqual(rows, [{ actor_person_id: p.officer, hub_id: hubA, second_approver_person_id: p.owner }]);
  });
});
