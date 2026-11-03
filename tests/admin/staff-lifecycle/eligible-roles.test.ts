import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, type DataPool, type Transaction } from '@trustwork/data';
import { adminDigests, approvals, staffAssignments, staffRoleDefinitions, type CommandContext } from '../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../packages/data/src/repositories/identity.js';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { activationState } from '../../../apps/api/src/modules/platform-admin/staff-lifecycle/staff-lifecycle.service.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { actors, buildAdminWorld, rejects, type AdminWorld } from '../../data/admin/helpers.js';

const db = await provisionTestDatabase('staff_eligible_roles');

/**
 * ADM-004 part 3 on real PostgreSQL under the runtime role: eligible roles granted by `admin.staff.assign` (never to
 * oneself, never above the role's cap or 12 hours, never a full-mode conflict), activated by the eligible person with a
 * second factor used within five minutes, a second person for sensitive roles who is neither the holder nor the
 * grantor, a window that ends by itself, early ends, revocation of the eligibility, and the cascade when a person's last
 * standing role is revoked. Every person and hub is synthetic.
 */
test('eligible roles and just-in-time activation (ADM-004 part 3)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, assign, assignSensitive, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.hubId } as const;
  const HOUR = 3600;

  await assignSensitive({ personId: p.hubOwner, role: 'hub-owner', scope: hub });
  await assign({ personId: p.lead, role: 'support-lead', scope: hub });
  await assign({ personId: p.moderator, role: 'moderator', scope: hub });
  await assign({ personId: p.ops, role: 'ops-engineer', scope: hub });
  // A released definition with a two-hour cap, to show the per-role ceiling below twelve hours.
  await owner((trx) => staffRoleDefinitions.release(trx, { version: 2, role: 'moderator', scopes: ['hub'], permissions: ['admin.moderation.read', 'admin.moderation.decide'],
    caps: { creditCapMinorUnits: null, grantMaxHours: 2 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));

  const grant = (by: string, input: { personId: string; role: string; definitionVersion?: number; maxActivationSeconds?: number; validForSeconds?: number | null }) =>
    as(by, async (trx) => staffLifecycle.grantEligible(trx, await elevate(by), {
      personId: input.personId, role: input.role, scope: hub, definitionVersion: input.definitionVersion ?? 1, maxActivationSeconds: input.maxActivationSeconds ?? 4 * HOUR, validForSeconds: input.validForSeconds ?? null,
    }));
  const request = (by: string, eligibleRoleId: string, windowSeconds: number, ctx?: CommandContext) =>
    as(by, async (trx) => staffLifecycle.requestActivation(trx, ctx ?? await elevate(by), eligibleRoleId, windowSeconds));
  const decide = (by: string, activationId: string, decision: 'approve' | 'decline') => as(by, async (trx) => staffLifecycle.decideActivation(trx, await elevate(by), activationId, decision));
  const end = (by: string, activationId: string) => as(by, async (trx) => staffLifecycle.endActivation(trx, await elevate(by), activationId));
  const assignment = (id: string) => owner((trx) => trx.selectFrom('staff_role_assignment').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  const approval = (id: string) => owner((trx) => trx.selectFrom('second_person_approval').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  const isStaffOfHub = (personId: string) => owner(async (trx) => (await sql<{ ok: boolean }>`SELECT trustwork.admin_person_is_staff(${personId}::uuid, NULL, ${w.hubId}::uuid) AS ok`.execute(trx)).rows[0]!.ok);
  const audit = (action: string) => owner((trx) => trx.selectFrom('admin_audit_event').select(['actor_person_id', 'actor_role', 'permission', 'outcome']).where('action', '=', action).orderBy('sequence').execute());

  await t.test('negative: only admin.staff.assign grants eligibility, never to oneself, within the role cap and twelve hours, never a full-mode conflict', async () => {
    const fake: CommandContext = { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'r1', reasonCode: 'synthetic_test', reasonText: 'x' };
    await rejects(as(p.customer, (trx) => staffLifecycle.grantEligible(trx, fake, { personId: p.employee, role: 'moderator', scope: hub, definitionVersion: 1, maxActivationSeconds: HOUR, validForSeconds: null })), '42501');
    await rejects(as(p.moderator, async (trx) => staffLifecycle.grantEligible(trx, await elevate(p.moderator), { personId: p.employee, role: 'moderator', scope: hub, definitionVersion: 1, maxActivationSeconds: HOUR, validForSeconds: null })), '42501', 'admin.forbidden');
    await rejects(grant(p.owner, { personId: p.owner, role: 'moderator' }), '42501', 'admin.self_grant');
    await rejects(grant(p.owner, { personId: p.employee, role: 'node-operator' }), '23514', 'admin.role_scope');
    await rejects(grant(p.owner, { personId: p.employee, role: 'moderator', maxActivationSeconds: 13 * HOUR }), '23514', 'admin.activation_too_long');
    await rejects(grant(p.owner, { personId: p.employee, role: 'moderator', definitionVersion: 2, maxActivationSeconds: 2 * HOUR + 1 }), '23514', 'admin.activation_too_long');
    // The auditor definition runs in full separation-of-duties mode and conflicts with ops-engineer, which ops holds.
    await rejects(grant(p.owner, { personId: p.ops, role: 'auditor' }), '23514', 'admin.sod_conflict');
  });

  let employeeEligible = '';
  await t.test('a staff administrator grants an eligibility; it is audited; one open eligibility per person, role and scope', async () => {
    const row = await grant(p.owner, { personId: p.employee, role: 'moderator', maxActivationSeconds: 4 * HOUR });
    employeeEligible = row.id;
    assert.deepEqual([row.person_id, row.role, row.granted_by, Number(row.max_activation_seconds), row.revoked_at], [p.employee, 'moderator', p.owner, 4 * HOUR, null]);
    await rejects(grant(p.owner, { personId: p.employee, role: 'moderator' }), '23505', 'admin.eligibility_open');
    assert.deepEqual((await audit('staff.grant_eligible_role')).map((a) => [a.actor_person_id, a.permission, a.outcome]), [[p.owner, 'admin.staff.assign', 'applied']]);
    assert.equal(await isStaffOfHub(p.employee), false, 'eligibility grants nothing by itself');
  });

  await t.test('negative: activation needs a second factor used within five minutes, one\'s own eligibility, and a window within the ceiling', async () => {
    const stale = await as(p.employee, (trx) => sessionElevations.insert(trx, {
      sessionId: w.sessions.employee as string, personId: p.employee, factorKind: 'totp', createdAt: new Date(Date.now() - 10 * 60_000), expiresAt: new Date(Date.now() + 30 * 60_000),
    }));
    const staleCtx: CommandContext = { elevationId: stale.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic stale factor' };
    await rejects(request(p.employee, employeeEligible, HOUR, staleCtx), '42501', 'admin.second_factor_stale');
    await rejects(request(p.customer, employeeEligible, HOUR), 'P0002', 'admin.not_found');
    await rejects(request(p.employee, employeeEligible, 5 * HOUR), '23514', 'admin.activation_too_long');
    assert.equal(await isStaffOfHub(p.employee), false);
  });

  let employeeActivation = '';
  await t.test('a non-sensitive eligible role is active at once, from now until the window ends, granted by the eligibility\'s grantor', async () => {
    const { activation, outcome } = await request(p.employee, employeeEligible, 2 * HOUR);
    employeeActivation = activation.id;
    assert.equal(outcome, 'active');
    assert.equal(activation.status, 'active');
    const row = await assignment(activation.assignment_id!);
    assert.deepEqual([row.person_id, row.role, row.granted_by, row.approved_by, row.breakglass], [p.employee, 'moderator', p.owner, null, false]);
    const seconds = Math.round((new Date(row.valid_until!).getTime() - new Date(row.valid_from).getTime()) / 1000);
    assert.equal(seconds, 2 * HOUR);
    assert.equal(await isStaffOfHub(p.employee), true, 'the role is held now');
    // The holder may now read the staff directory of the hub, like any staff member.
    assert.ok((await as(p.employee, (trx) => staffLifecycle.directory(trx, w.hubId))).some((e) => e.person_id === p.employee));
    await rejects(request(p.employee, employeeEligible, HOUR), '23505', 'admin.activation_open');
    assert.deepEqual((await audit('staff.activation_started')).map((a) => [a.actor_person_id, a.actor_role, a.permission]), [[p.employee, 'moderator', 'admin.session.elevate']]);
    const [view] = await as(p.employee, (trx) => staffLifecycle.activations(trx, w.hubId, p.employee));
    assert.equal(activationState(view!, new Date()), 'active');
  });

  await t.test('the activation ends at its window end without a job: the assignment\'s end is checked at every request', async () => {
    const view = (await as(p.employee, (trx) => staffLifecycle.activations(trx, w.hubId, p.employee)))[0]!;
    assert.equal(activationState({ ...view, assignment_valid_until: new Date(Date.now() - 1000) }, new Date()), 'ended');
    // Time travel: move the window into the past (the assignment guard forbids any change but revocation, so the test
    // database disables it for this one statement) and show that nothing else has to run.
    await owner(async (trx) => {
      await sql`ALTER TABLE trustwork.staff_role_assignment DISABLE TRIGGER staff_role_assignment_guard`.execute(trx);
      await sql`UPDATE trustwork.staff_role_assignment SET valid_from = now() - interval '3 hours', valid_until = now() - interval '1 hour' WHERE id = ${view.assignment_id}::uuid`.execute(trx);
      await sql`UPDATE trustwork.staff_activation SET active_from = now() - interval '3 hours', active_until = now() - interval '1 hour' WHERE id = ${view.id}::uuid`.execute(trx);
      await sql`ALTER TABLE trustwork.staff_role_assignment ENABLE TRIGGER staff_role_assignment_guard`.execute(trx);
    });
    assert.equal(await isStaffOfHub(p.employee), false, 'the role ended with the window');
    await rejects(as(p.employee, (trx) => staffLifecycle.directory(trx, w.hubId)), 'P0002', 'admin.not_found');
    const after = (await as(p.employee, (trx) => staffLifecycle.activations(trx, w.hubId, p.employee)))[0]!;
    assert.equal(activationState(after, new Date()), 'ended');
    await rejects(end(p.employee, after.id), '23514', 'admin.invalid_transition');
    // A new activation of the same eligibility is possible again.
    const again = await request(p.employee, employeeEligible, HOUR);
    assert.equal(again.outcome, 'active');
    employeeActivation = again.activation.id;
  });

  await t.test('the holder ends their own activation early; staff with admin.staff.revoke end anyone\'s; others may not', async () => {
    await rejects(end(p.moderator, employeeActivation), '42501', 'admin.forbidden');
    const ended = await end(p.employee, employeeActivation);
    assert.equal(ended.status, 'active', 'the stored status stays; the state is read from the assignment');
    const row = await assignment(ended.assignment_id!);
    assert.deepEqual([row.revoked_by, row.revoke_reason], [p.employee, 'Synthetic test action']);
    assert.equal(await isStaffOfHub(p.employee), false);
    assert.equal(activationState((await as(p.employee, (trx) => staffLifecycle.activations(trx, w.hubId, p.employee)))[0]!, new Date()), 'ended');
    const third = await request(p.employee, employeeEligible, HOUR);
    const byStaff = await end(p.admin, third.activation.id);
    assert.equal((await assignment(byStaff.assignment_id!)).revoked_by, p.admin);
    assert.deepEqual((await audit('staff.activation_ended')).map((a) => a.actor_person_id), [p.employee, p.admin]);
  });

  let hubOwnerEligible = '';
  let pendingActivation = '';
  await t.test('a sensitive role asks a second person in the grantor\'s name, bound to the exact assignment; the holder and the grantor never decide', async () => {
    hubOwnerEligible = (await grant(p.owner, { personId: p.hubOwner, role: 'staff-admin', maxActivationSeconds: 3 * HOUR })).id;
    const { activation, outcome } = await request(p.hubOwner, hubOwnerEligible, HOUR);
    pendingActivation = activation.id;
    assert.deepEqual([outcome, activation.status, activation.sensitive], ['pending_second_person', 'pending', true]);
    assert.equal(await isStaffOfHub(p.hubOwner), true, 'the standing hub-owner role');
    const held = await owner((trx) => trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.hubOwner).where('revoked_at', 'is', null).execute());
    assert.deepEqual(held.map((h) => h.role), ['hub-owner'], 'nothing is held before the second person decides');
    const row = await approval(activation.approval_id!);
    const digest = adminDigests.assignment({ breakglass: false, personId: p.hubOwner, role: 'staff-admin', scope: hub, definitionVersion: 1, validForSeconds: HOUR });
    assert.deepEqual([row.action, row.requested_by, row.status, row.action_digest], ['staff.assign_sensitive_role', p.owner, 'pending', digest]);
    await rejects(decide(p.hubOwner, activation.id, 'approve'), '42501', 'admin.self_approval');
    await rejects(decide(p.owner, activation.id, 'approve'), '42501', 'admin.same_decider');
    await rejects(decide(p.moderator, activation.id, 'approve'), '42501', 'admin.forbidden');
    await rejects(request(p.hubOwner, hubOwnerEligible, HOUR), '23505', 'admin.activation_open');
  });

  await t.test('the second person approves: the approval is consumed and the role is held until the window ends', async () => {
    const decided = await decide(p.admin, pendingActivation, 'approve');
    assert.deepEqual([decided.status, decided.decided_by], ['active', p.admin]);
    const row = await assignment(decided.assignment_id!);
    assert.deepEqual([row.person_id, row.role, row.granted_by, row.approved_by, row.approval_id], [p.hubOwner, 'staff-admin', p.owner, p.admin, decided.approval_id]);
    const consumed = await approval(decided.approval_id!);
    assert.deepEqual([consumed.status, consumed.consumed_ref, consumed.approved_by], ['consumed', row.id, p.admin]);
    assert.ok((await owner((trx) => trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.hubOwner).where('revoked_at', 'is', null).execute())).some((h) => h.role === 'staff-admin'));
    await rejects(decide(p.admin, pendingActivation, 'approve'), '23514', 'admin.invalid_transition');
    assert.deepEqual((await audit('staff.activation_approved')).map((a) => [a.actor_person_id, a.permission]), [[p.admin, 'admin.staff.assign']]);
  });

  await t.test('a declined activation grants nothing; an approval given through the approvals inbox is honoured', async () => {
    const leadEligible = (await grant(p.owner, { personId: p.lead, role: 'hub-owner', maxActivationSeconds: 2 * HOUR })).id;
    const first = await request(p.lead, leadEligible, HOUR);
    const declined = await decide(p.admin, first.activation.id, 'decline');
    assert.deepEqual([declined.status, declined.decided_by], ['declined', p.admin]);
    assert.equal((await approval(declined.approval_id!)).status, 'declined');
    assert.deepEqual((await owner((trx) => trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.lead).where('revoked_at', 'is', null).execute())).map((h) => h.role), ['support-lead']);
    const second = await request(p.lead, leadEligible, HOUR);
    const row = await approval(second.activation.approval_id!);
    await as(p.admin, async (trx) => approvals.decide(trx, await elevate(p.admin), row.id, 'approve', row.action_digest));
    const applied = await decide(p.hubOwner, second.activation.id, 'approve');
    const held = await assignment(applied.assignment_id!);
    assert.deepEqual([held.approved_by, applied.decided_by], [p.admin, p.hubOwner]);
  });

  await t.test('revoking the eligibility withdraws its pending activation and ends its running one at once', async () => {
    const pending = await request(p.hubOwner, hubOwnerEligible, HOUR).catch(() => null);
    assert.equal(pending, null, 'the first activation is still running');
    const revoked = await as(p.admin, async (trx) => staffLifecycle.revokeEligible(trx, await elevate(p.admin), hubOwnerEligible));
    assert.deepEqual([revoked.revoked_by, revoked.revoke_reason], [p.admin, 'Synthetic test action']);
    const activations = await as(p.hubOwner, (trx) => staffLifecycle.activations(trx, w.hubId, p.hubOwner));
    assert.deepEqual(activations.map((a) => activationState(a, new Date())), ['ended']);
    assert.deepEqual((await owner((trx) => trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.hubOwner).where('revoked_at', 'is', null).execute())).map((h) => h.role), ['hub-owner']);
    await rejects(request(p.hubOwner, hubOwnerEligible, HOUR), '23514', 'admin.eligibility_ended');
    await rejects(as(p.admin, async (trx) => staffLifecycle.revokeEligible(trx, await elevate(p.admin), hubOwnerEligible)), '23514', 'admin.invalid_transition');
  });

  await t.test('revoking a person\'s last standing role revokes their eligible roles and ends their activations and elevations at once', async () => {
    // lead: standing support-lead, a running hub-owner activation and a pending request for another eligible role.
    const leadModerator = (await grant(p.owner, { personId: p.lead, role: 'moderator', maxActivationSeconds: HOUR })).id;
    const running = await request(p.lead, leadModerator, HOUR);
    assert.equal(running.outcome, 'active');
    const standing = await owner((trx) => trx.selectFrom('staff_role_assignment').select('id').where('person_id', '=', p.lead).where('role', '=', 'support-lead').executeTakeFirstOrThrow());
    const live = await owner((trx) => trx.selectFrom('session_elevation').select('id').where('person_id', '=', p.lead).where('revoked_at', 'is', null).execute());
    assert.ok(live.length > 0, 'the lead holds live elevations');
    await as(p.admin, async (trx) => staffAssignments.revoke(trx, await elevate(p.admin), standing.id));
    const roles = await owner((trx) => trx.selectFrom('staff_role_assignment').select(['role', 'revoked_at', 'revoke_reason']).where('person_id', '=', p.lead).execute());
    assert.ok(roles.every((r) => r.revoked_at !== null), JSON.stringify(roles));
    assert.ok(roles.some((r) => r.revoke_reason === 'Last standing role revoked'));
    const eligible = await owner((trx) => trx.selectFrom('staff_eligible_role').select(['revoked_at', 'revoked_by']).where('person_id', '=', p.lead).execute());
    assert.ok(eligible.length >= 2 && eligible.every((e) => e.revoked_at !== null && e.revoked_by === p.admin));
    assert.deepEqual(await owner((trx) => trx.selectFrom('session_elevation').select('id').where('person_id', '=', p.lead).where('revoked_at', 'is', null).execute()), []);
    assert.equal(await isStaffOfHub(p.lead), false);
  });

  await t.test('reads: a person sees their own eligible roles and activations; others need admin.staff.read at the scope', async () => {
    const own = await as(p.employee, (trx) => staffLifecycle.eligibleRoles(trx, w.hubId));
    assert.deepEqual(own.map((e) => e.person_id), [p.employee]);
    assert.deepEqual(await as(p.moderator, (trx) => staffLifecycle.eligibleRoles(trx, w.hubId, p.employee)), []);
    assert.deepEqual(await as(p.customer, (trx) => staffLifecycle.activations(trx, w.hubId)), []);
    const all = await as(p.hubOwner, (trx) => staffLifecycle.eligibleRoles(trx, w.hubId));
    assert.ok(all.length >= 3);
  });

  await t.test('terms never change and rows are never deleted', async () => {
    await rejects(owner((trx) => trx.updateTable('staff_eligible_role').set({ max_activation_seconds: '60' }).where('id', '=', employeeEligible).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_eligible_role').where('id', '=', employeeEligible).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx) => trx.updateTable('staff_activation').set({ window_seconds: '60' }).where('id', '=', employeeActivation).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_activation').where('id', '=', employeeActivation).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx: Transaction) => trx.updateTable('staff_activation').set({ status: 'pending' }).where('id', '=', employeeActivation).execute()), '23514', 'admin.invalid_transition');
  });
});
