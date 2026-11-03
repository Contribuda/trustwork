import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { createPool, type DataPool } from '@trustwork/data';
import { staffAssignments, type CommandContext } from '../../../packages/data/src/repositories/admin.js';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { toReviewCampaign, toReviewItem } from '../../../apps/api/src/modules/platform-admin/staff-lifecycle/staff-lifecycle.service.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { actors, buildAdminWorld, rejects, type AdminWorld } from '../../data/admin/helpers.js';

const db = await provisionTestDatabase('staff_access_reviews');

/**
 * ADM-004 part 4 on real PostgreSQL under the runtime role: a campaign over the standing assignments of a scope, opened
 * and decided by `admin.staff.revoke`, never by the holder of the item; "remove" revokes the role in the same
 * transaction; an item unanswered at the deadline is escalated to the scope's owner role and is never removed silently;
 * the campaign closes with its last decision; withdrawal with a reason; reads under row-level security. Every person and
 * hub is synthetic.
 */
test('access-review campaigns (ADM-004 part 4)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, assign, assignSensitive, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.hubId } as const;
  const DAY = 86_400;

  await assignSensitive({ personId: p.hubOwner, role: 'hub-owner', scope: hub });
  for (const [key, role] of [['moderator', 'moderator'], ['lead', 'support-lead'], ['lead2', 'support-lead'], ['ops', 'ops-engineer'], ['auditor', 'auditor']] as const) {
    await assign({ personId: p[key], role, scope: hub });
  }
  const open = (by: string, input: { title?: string; roles?: string[] | null; dueInSeconds?: number } = {}) =>
    as(by, async (trx) => staffLifecycle.openAccessReview(trx, await elevate(by), { scope: hub, title: input.title ?? 'Synthetic quarterly review', roles: input.roles ?? null, dueInSeconds: input.dueInSeconds ?? 30 * DAY }));
  const decide = (by: string, itemId: string, verdict: 'keep' | 'remove') => as(by, async (trx) => staffLifecycle.decideAccessReviewItem(trx, await elevate(by), itemId, verdict));
  const items = (campaignId: string) => owner((trx) => trx.selectFrom('staff_access_review_item').selectAll().where('campaign_id', '=', campaignId).orderBy('role').execute());
  const campaign = (id: string) => owner((trx) => trx.selectFrom('staff_access_review_campaign').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  const assignment = (id: string) => owner((trx) => trx.selectFrom('staff_role_assignment').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  const audit = (action: string) => owner((trx) => trx.selectFrom('admin_audit_event').select(['actor_person_id', 'permission', 'object_id']).where('action', '=', action).orderBy('sequence').execute());
  const itemOf = async (campaignId: string, holder: string) => (await items(campaignId)).find((i) => i.holder_person_id === holder)!;

  await t.test('negative: only admin.staff.revoke opens a review, due between one and ninety days, over at least one assignment', async () => {
    const fake: CommandContext = { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'r1', reasonCode: 'synthetic_test', reasonText: 'x' };
    await rejects(as(p.customer, (trx) => staffLifecycle.openAccessReview(trx, fake, { scope: hub, title: 'x', roles: null, dueInSeconds: 30 * DAY })), '42501');
    await rejects(open(p.moderator), '42501', 'admin.forbidden');
    await rejects(open(p.admin, { dueInSeconds: 3600 }), '22023', 'admin.context_invalid');
    await rejects(open(p.admin, { roles: ['privacy-officer'] }), 'P0002', 'admin.review_empty');
  });

  let first = '';
  await t.test('a campaign lists the standing assignments held at the scope and is audited', async () => {
    const row = await open(p.admin);
    first = row.id;
    assert.deepEqual([row.status, row.opened_by, row.roles], ['open', p.admin, null]);
    const listed = await items(first);
    assert.deepEqual(listed.map((i) => i.holder_person_id).sort(), [p.auditor, p.hubOwner, p.lead, p.lead2, p.moderator, p.ops].sort());
    assert.ok(listed.every((i) => i.verdict === null && i.decided_by === null));
    assert.deepEqual((await audit('staff.access_review_opened')).map((a) => [a.actor_person_id, a.permission]), [[p.admin, 'admin.staff.revoke']]);
    const view = toReviewCampaign(row, listed, new Date());
    assert.deepEqual(view.items, { total: 6, kept: 0, removed: 0, pending: 6, escalated: 0 });
  });

  await t.test('negative: a reviewer needs admin.staff.revoke and never reviews their own access', async () => {
    const own = await itemOf(first, p.hubOwner);
    await rejects(decide(p.moderator, (await itemOf(first, p.lead)).id, 'keep'), '42501', 'admin.forbidden');
    await rejects(decide(p.hubOwner, own.id, 'keep'), '42501', 'admin.self_review');
    await rejects(as(p.admin, async (trx) => staffLifecycle.decideAccessReviewItem(trx, await elevate(p.admin), own.id, 'maybe' as 'keep')), '22023', 'admin.context_invalid');
    assert.equal((await itemOf(first, p.hubOwner)).verdict, null);
  });

  await t.test('keep records the decision; remove revokes the role in the same transaction; an ended role is recorded as already ended', async () => {
    const kept = await decide(p.hubOwner, (await itemOf(first, p.moderator)).id, 'keep');
    assert.deepEqual([kept.verdict, kept.effect, kept.decided_by, kept.decision_reason], ['keep', 'kept', p.hubOwner, 'Synthetic test action']);
    assert.equal((await assignment(kept.assignment_id)).revoked_at, null);
    const removed = await decide(p.admin, (await itemOf(first, p.lead2)).id, 'remove');
    assert.deepEqual([removed.verdict, removed.effect], ['remove', 'revoked']);
    const gone = await assignment(removed.assignment_id);
    assert.deepEqual([gone.revoked_by, gone.revoke_reason], [p.admin, 'Synthetic test action']);
    await rejects(decide(p.admin, removed.id, 'keep'), '23514', 'admin.invalid_transition');
    // The ops engineer's role ends through the ordinary revocation before the review reaches it.
    const ops = await itemOf(first, p.ops);
    await as(p.admin, async (trx) => staffAssignments.revoke(trx, await elevate(p.admin), ops.assignment_id));
    const ended = await decide(p.admin, ops.id, 'remove');
    assert.equal(ended.effect, 'already_ended');
    assert.equal((await audit('staff.access_review_decided')).length, 3);
    const view = toReviewCampaign(await campaign(first), await items(first), new Date());
    assert.deepEqual(view.items, { total: 6, kept: 1, removed: 2, pending: 3, escalated: 0 });
  });

  await t.test('an item unanswered at the deadline is escalated: only the scope\'s owner role decides it, nothing is removed silently', async () => {
    const second = await open(p.admin, { title: 'Synthetic auditor review', roles: ['auditor'], dueInSeconds: DAY });
    const [item] = await items(second.id);
    assert.equal(item!.holder_person_id, p.auditor);
    // Time travel: the deadline passes (the campaign guard forbids any change of terms, so the test database disables it for one statement).
    await owner(async (trx) => {
      await sql`ALTER TABLE trustwork.staff_access_review_campaign DISABLE TRIGGER staff_access_review_campaign_guard`.execute(trx);
      await sql`UPDATE trustwork.staff_access_review_campaign SET due_at = now() - interval '1 hour' WHERE id = ${second.id}::uuid`.execute(trx);
      await sql`ALTER TABLE trustwork.staff_access_review_campaign ENABLE TRIGGER staff_access_review_campaign_guard`.execute(trx);
    });
    const due = await campaign(second.id);
    assert.equal(toReviewItem(item!, due.due_at, new Date()).state, 'escalated');
    assert.deepEqual(toReviewCampaign(due, [item!], new Date()).items, { total: 1, kept: 0, removed: 0, pending: 1, escalated: 1 });
    assert.equal((await assignment(item!.assignment_id)).revoked_at, null, 'the role stays until a person decides');
    await rejects(decide(p.admin, item!.id, 'remove'), '42501', 'admin.review_escalated');
    await rejects(decide(p.owner, item!.id, 'remove'), '42501', 'admin.review_escalated');
    const decided = await decide(p.hubOwner, item!.id, 'keep');
    assert.equal(decided.effect, 'kept');
    const closed = await campaign(second.id);
    assert.deepEqual([closed.status, closed.closed_by], ['closed', p.hubOwner]);
    assert.deepEqual((await audit('staff.access_review_closed')).map((a) => a.object_id), [second.id]);
  });

  await t.test('the campaign closes with its last decision', async () => {
    for (const key of ['hubOwner', 'lead', 'auditor'] as const) {
      const item = await itemOf(first, p[key]);
      await decide(p.admin, item.id, 'keep');
    }
    const closed = await campaign(first);
    assert.deepEqual([closed.status, closed.closed_by], ['closed', p.admin]);
    assert.ok(closed.closed_at);
    const view = toReviewCampaign(closed, await items(first), new Date());
    assert.deepEqual(view.items, { total: 6, kept: 4, removed: 2, pending: 0, escalated: 0 });
    await rejects(decide(p.admin, (await itemOf(first, p.lead)).id, 'remove'), '23514', 'admin.invalid_transition');
  });

  await t.test('a campaign opened by mistake is withdrawn with a reason; its items are left undecided and the roles untouched', async () => {
    const third = await open(p.hubOwner, { title: 'Synthetic mistaken review' });
    await rejects(as(p.moderator, async (trx) => staffLifecycle.withdrawAccessReview(trx, await elevate(p.moderator), third.id)), '42501', 'admin.forbidden');
    const withdrawn = await as(p.hubOwner, async (trx) => staffLifecycle.withdrawAccessReview(trx, await elevate(p.hubOwner), third.id));
    assert.deepEqual([withdrawn.status, withdrawn.closed_by], ['withdrawn', p.hubOwner]);
    await rejects(decide(p.admin, (await itemOf(third.id, p.lead)).id, 'remove'), '23514', 'admin.invalid_transition');
    assert.equal((await assignment((await itemOf(third.id, p.lead)).assignment_id)).revoked_at, null);
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.withdrawAccessReview(trx, await elevate(p.hubOwner), third.id)), '23514', 'admin.invalid_transition');
  });

  await t.test('reads need admin.staff.read at the scope; nothing describes what a holder did', async () => {
    assert.deepEqual(await as(p.moderator, (trx) => staffLifecycle.accessReviews(trx, w.hubId)), []);
    assert.deepEqual(await as(p.customer, (trx) => staffLifecycle.accessReviewItems(trx, [first])), []);
    const seen = await as(p.hubOwner, (trx) => staffLifecycle.accessReviews(trx, w.hubId));
    assert.equal(seen.length, 3);
    assert.deepEqual(Object.keys((await as(p.hubOwner, (trx) => staffLifecycle.accessReviewItems(trx, [first])))[0]!).filter((k) => /last|seen|login|count|used/i.test(k)), []);
  });

  await t.test('terms never change and rows are never deleted', async () => {
    await rejects(owner((trx) => trx.updateTable('staff_access_review_campaign').set({ title: 'Renamed' }).where('id', '=', first).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_access_review_campaign').where('id', '=', first).execute()), '23000', 'audit.append_only');
    const item = await itemOf(first, p.lead);
    await rejects(owner((trx) => trx.updateTable('staff_access_review_item').set({ verdict: 'remove' }).where('id', '=', item.id).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_access_review_item').where('id', '=', item.id).execute()), '23000', 'audit.append_only');
  });
});
