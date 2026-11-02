import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPool, type DataPool } from '@trustwork/data';
import { adminDigests, approvals } from '../../../packages/data/src/repositories/admin.js';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { actors, buildAdminWorld, rejects, type AdminWorld } from '../../data/admin/helpers.js';

const db = await provisionTestDatabase('staff_invitations');

/**
 * ADM-004 part 2 on real PostgreSQL under the runtime role: invitations by e-mail with expiry, a response only by the
 * person whose verified address it names (with a second factor to accept), application by the inviter in an elevated
 * session, a second person for sensitive roles, withdrawal, and reads that never reach anyone else. Every person, address
 * and hub is synthetic.
 */
test('staff invitations (ADM-004 part 2)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.hubId } as const;

  // Invitees: verified addresses; one of them enrols a second factor later.
  const address = (who: string) => `${who}.${randomBytes(3).toString('hex')}@invite.example.invalid`;
  const mail = { customer: address('customer'), employee: address('employee'), outsider: address('outsider'), owner: address('owner') };
  await owner(async (trx) => {
    for (const [key, email] of Object.entries(mail)) {
      await trx.insertInto('email_binding').values({ person_id: p[key as keyof typeof mail], email_normalized: email, is_primary: true, verified_at: new Date() }).execute();
    }
  });
  const enrol = (personId: string) => owner((trx) => trx.insertInto('second_factor').values({
    id: crypto.randomUUID(), person_id: personId, kind: 'totp', state: 'active', secret_sealed: randomBytes(48), activated_at: new Date(),
  } as never).execute());
  const invite = async (by: string, email: string, role: string, validForSeconds: number | null = null) =>
    as(by, async (trx) => staffLifecycle.invite(trx, await elevate(by), { email, role, scope: hub, definitionVersion: 1, validForSeconds }));

  await t.test('negative: only admin.staff.assign at the scope invites, never oneself, and one open invitation per address and role', async () => {
    await rejects(as(p.customer, async (trx) => staffLifecycle.invite(trx, { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'r1', reasonCode: 'synthetic_test', reasonText: 'x' },
      { email: mail.employee, role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: null })), '42501');
    await rejects(invite(p.owner, mail.owner, 'moderator'), '42501', 'admin.self_grant');
    await rejects(invite(p.owner, mail.customer, 'node-operator'), '23514', 'admin.role_scope');
    await invite(p.owner, mail.customer, 'moderator');
    await rejects(invite(p.owner, mail.customer, 'moderator'), '23505', 'admin.invitation_open');
  });

  await t.test('the invitee alone sees and answers it; accepting needs a second factor; the address never leaks to others', async () => {
    const mine = await as(p.customer, (trx) => staffLifecycle.mine(trx));
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.inviter_name, 'Synthetic Platform Owner');
    assert.deepEqual(await as(p.outsider, (trx) => staffLifecycle.mine(trx)), []);
    const id = mine[0]!.id;
    await rejects(as(p.outsider, (trx) => staffLifecycle.respond(trx, id, true)), 'P0002', 'admin.not_found');
    await rejects(as(p.customer, (trx) => staffLifecycle.respond(trx, id, true)), '42501', 'admin.second_factor_required');
    // Staff without admin.staff.read and participants read no invitation rows.
    assert.deepEqual(await as(p.customer, (trx) => staffLifecycle.invitations(trx, w.hubId)), []);
    await enrol(p.customer);
    const accepted = await as(p.customer, (trx) => staffLifecycle.respond(trx, id, true));
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.person_id, p.customer);
    await rejects(as(p.customer, (trx) => staffLifecycle.respond(trx, id, false)), '23514', 'admin.invalid_transition');
  });

  await t.test('the inviter applies an accepted non-sensitive invitation in an elevated session; nobody else does', async () => {
    const [row] = await as(p.owner, (trx) => staffLifecycle.invitations(trx, w.hubId));
    assert.equal(row!.email_normalized, mail.customer, 'staff who manage the scope read the address');
    await rejects(as(p.admin, async (trx) => staffLifecycle.apply(trx, await elevate(p.admin), row!.id)), '42501', 'admin.not_requester');
    const applied = await as(p.owner, async (trx) => staffLifecycle.apply(trx, await elevate(p.owner), row!.id));
    assert.equal(applied.outcome, 'applied');
    assert.equal(applied.invitation.status, 'applied');
    const assignment = await owner((trx) => trx.selectFrom('staff_role_assignment').selectAll().where('id', '=', applied.invitation.assignment_id!).executeTakeFirstOrThrow());
    assert.deepEqual([assignment.person_id, assignment.role, assignment.granted_by, assignment.approved_by], [p.customer, 'moderator', p.owner, null]);
    const audit = await owner((trx) => trx.selectFrom('admin_audit_event').select(['action', 'actor_person_id']).where('action', 'in', ['staff.invited', 'staff.assign_role'])
      .where('actor_person_id', '=', p.owner).execute());
    assert.deepEqual(audit.map((a) => a.action).sort(), ['staff.assign_role', 'staff.invited']);
  });

  await t.test('a sensitive role asks a second person for the exact assignment and takes effect only after approval', async () => {
    await invite(p.owner, mail.employee, 'hub-owner', 7 * 86_400);
    await enrol(p.employee);
    const [mine] = await as(p.employee, (trx) => staffLifecycle.mine(trx));
    await as(p.employee, (trx) => staffLifecycle.respond(trx, mine!.id, true));
    const first = await as(p.owner, async (trx) => staffLifecycle.apply(trx, await elevate(p.owner), mine!.id));
    assert.equal(first.outcome, 'pending_second_person');
    assert.equal(first.invitation.status, 'accepted');
    const approval = await owner((trx) => trx.selectFrom('second_person_approval').selectAll().where('id', '=', first.invitation.approval_id!).executeTakeFirstOrThrow());
    const digest = adminDigests.assignment({ breakglass: false, personId: p.employee, role: 'hub-owner', scope: hub, definitionVersion: 1, validForSeconds: 7 * 86_400 });
    assert.deepEqual([approval.action, approval.requested_by, approval.status, approval.action_digest], ['staff.assign_sensitive_role', p.owner, 'pending', digest]);
    await rejects(as(p.owner, async (trx) => staffLifecycle.apply(trx, await elevate(p.owner), mine!.id)), '23514', 'admin.approval_not_approved');
    await as(p.admin, async (trx) => approvals.decide(trx, await elevate(p.admin), approval.id, 'approve', digest));
    const done = await as(p.owner, async (trx) => staffLifecycle.apply(trx, await elevate(p.owner), mine!.id));
    assert.equal(done.outcome, 'applied');
    const assignment = await owner((trx) => trx.selectFrom('staff_role_assignment').selectAll().where('id', '=', done.invitation.assignment_id!).executeTakeFirstOrThrow());
    assert.deepEqual([assignment.role, assignment.approved_by, assignment.approval_id], ['hub-owner', p.admin, approval.id]);
    assert.ok(assignment.valid_until, 'a role with an end date');
  });

  await t.test('withdrawal ends an open invitation and revokes the approval it asked for; an expired invitation is refused without a job', async () => {
    const email = address('later');
    const row = await invite(p.owner, email, 'moderator');
    const withdrawn = await as(p.admin, async (trx) => staffLifecycle.withdraw(trx, await elevate(p.admin), row.id));
    assert.deepEqual([withdrawn.status, withdrawn.withdrawn_by], ['withdrawn', p.admin]);
    await rejects(as(p.admin, async (trx) => staffLifecycle.withdraw(trx, await elevate(p.admin), row.id)), '23514', 'admin.invalid_transition');
    const expired = await owner((trx) => trx.insertInto('staff_invitation').values({
      scope_kind: 'hub', hub_id: w.hubId, role: 'moderator', definition_version: 1, email_normalized: mail.outsider, sensitive: false, invited_by: p.owner,
      reason: 'Synthetic expired invitation', expires_at: new Date(Date.now() - 60_000),
    }).returning('id').executeTakeFirstOrThrow());
    await enrol(p.outsider);
    assert.deepEqual(await as(p.outsider, (trx) => staffLifecycle.mine(trx)), [], 'an expired invitation is not offered');
    await rejects(as(p.outsider, (trx) => staffLifecycle.respond(trx, expired.id, true)), '23514', 'admin.invitation_expired');
    // A new invitation to the same address and role closes the expired one.
    await invite(p.owner, mail.outsider, 'moderator');
    const old = await owner((trx) => trx.selectFrom('staff_invitation').select('status').where('id', '=', expired.id).executeTakeFirstOrThrow());
    assert.equal(old.status, 'withdrawn');
  });

  await t.test('terms never change and rows are never deleted', async () => {
    const row = await owner((trx) => trx.selectFrom('staff_invitation').select('id').limit(1).executeTakeFirstOrThrow());
    await rejects(owner((trx) => trx.updateTable('staff_invitation').set({ role: 'auditor' }).where('id', '=', row.id).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_invitation').where('id', '=', row.id).execute()), '23000', 'audit.append_only');
  });
});
