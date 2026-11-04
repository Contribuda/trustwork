import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { computeDigest } from '@trustwork/contracts';
import { createPool, type DataPool } from '@trustwork/data';
import { adminDigests, approvals, staffAssignments, staffRoleDefinitions, type StaffScope } from '../../../packages/data/src/repositories/admin.js';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { actors, buildAdminWorld, rejects, settle, type AdminWorld } from '../../data/admin/helpers.js';

const db = await provisionTestDatabase('staff_sod_database');

/**
 * ADM-004 audit fixes on real PostgreSQL under the runtime role: the full-mode "different role" rule of the staff actions is
 * decided by the database when an approval is given and when it is used, by any route, and the mode the API reads is the
 * one the database enforces, whatever the reader may see. Other second-person actions keep what they had. Every person, address and hub is synthetic.
 */
test('the database decides the different-role rule (ADM-004)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 6 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, assign, assignSensitive, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hub: StaffScope = { kind: 'hub', hubId: w.hubId };
  const otherHub: StaffScope = { kind: 'hub', hubId: w.otherHubId };
  // Approving needs a change the digest proves, so each digest here comes with its input.
  const subjects = new Map<string, Record<string, string>>();
  const digest = () => { const input = { synthetic: randomBytes(8).toString('hex') }; const value = computeDigest(input).value; subjects.set(value, input); return value; };
  const STAFF_ACTION = 'staff.assign_sensitive_role';
  const ask = async (by: string, action: string, scope: StaffScope, actionDigest: string) =>
    as(by, async (trx) => approvals.request(trx, await elevate(by), { action, scope, actionDigest, subject: subjects.get(actionDigest) }));
  const approve = async (by: string, id: string, actionDigest: string) => as(by, async (trx) => approvals.decide(trx, await elevate(by), id, 'approve', actionDigest));
  const sod = (by: string, scope: StaffScope) => as(by, (trx) => staffLifecycle.sod(trx, scope));

  // Four people cover the other hub: the two founders at the platform and two hub owners.
  await assignSensitive({ personId: p.otherAgent, role: 'hub-owner', scope: otherHub });
  await assignSensitive({ personId: p.outsider, role: 'hub-owner', scope: otherHub });
  const email = `invited.${randomBytes(3).toString('hex')}@invite.example.invalid`;
  await owner(async (trx) => {
    await trx.insertInto('email_binding').values({ person_id: p.employee, email_normalized: email, is_primary: true, verified_at: new Date() }).execute();
    await trx.insertInto('second_factor').values({ id: crypto.randomUUID(), person_id: p.employee, kind: 'totp', state: 'active', secret_sealed: randomBytes(48), activated_at: new Date() } as never).execute();
  });
  const invite = () => as(p.otherAgent, async (trx) => staffLifecycle.invite(trx, await elevate(p.otherAgent), { email, role: 'hub-owner', scope: otherHub, definitionVersion: 1, validForSeconds: null }));
  const apply = (id: string) => as(p.otherAgent, async (trx) => staffLifecycle.apply(trx, await elevate(p.otherAgent), id));
  const assignmentDigest = adminDigests.assignment({ breakglass: false, personId: p.employee, role: 'hub-owner', scope: otherHub, definitionVersion: 1 });

  await t.test('reduced mode needs only a different person', async () => {
    assert.deepEqual(await sod(p.otherAgent, otherHub), { mode: 'reduced', staffCount: 4 });
    const actionDigest = digest();
    const request = await ask(p.otherAgent, STAFF_ACTION, otherHub, actionDigest);
    await rejects(approve(p.otherAgent, request.id, actionDigest), '42501', 'admin.self_approval');
    assert.equal((await approve(p.outsider, request.id, actionDigest)).status, 'approved');
  });

  await t.test('an invitation of a sensitive role: the rule holds at apply, even for an approval given in reduced mode', async () => {
    const invited = await invite();
    await as(p.employee, (trx) => staffLifecycle.respond(trx, invited.id, true));
    const asked = await apply(invited.id);
    assert.equal(asked.outcome, 'pending_second_person');
    assert.equal((await approve(p.outsider, asked.invitation.approval_id!, assignmentDigest)).status, 'approved', 'the same role is enough in reduced mode');

    // A node staff member joins: the hub reaches five people, and its own readers cannot see that assignment.
    await assign({ personId: p.ops, role: 'ops-engineer', scope: { kind: 'node', nodeId: w.nodeId } });
    assert.deepEqual(await sod(p.otherAgent, otherHub), { mode: 'full', staffCount: 5 });
    await rejects(apply(invited.id), '42501', 'admin.same_role');
    const row = await owner((trx) => trx.selectFrom('staff_invitation').select(['status', 'assignment_id']).where('id', '=', invited.id).executeTakeFirstOrThrow());
    assert.deepEqual(row, { status: 'accepted', assignment_id: null }, 'nothing took effect');
    // The same approval through the direct route: the digest is identical and the caller is the requester, and it is refused all the same.
    await rejects(as(p.otherAgent, async (trx) => staffAssignments.assign(trx, await elevate(p.otherAgent),
      { personId: p.employee, role: 'hub-owner', scope: otherHub, definitionVersion: 1, approvalId: asked.invitation.approval_id! })), '42501', 'admin.same_role');
    assert.deepEqual(await owner((trx) => trx.selectFrom('staff_role_assignment').select('id').where('person_id', '=', p.employee).execute()), []);
    const held = await owner((trx) => trx.selectFrom('second_person_approval').select('status').where('id', '=', asked.invitation.approval_id!).executeTakeFirstOrThrow());
    assert.equal(held.status, 'approved', 'nothing was consumed');

    // The way out: withdraw, invite again, and someone acting through another role approves.
    await as(p.otherAgent, async (trx) => staffLifecycle.withdraw(trx, await elevate(p.otherAgent), invited.id));
    const again = await invite();
    await as(p.employee, (trx) => staffLifecycle.respond(trx, again.id, true));
    const second = await apply(again.id);
    await rejects(approve(p.outsider, second.invitation.approval_id!, assignmentDigest), '42501', 'admin.same_role');
    assert.equal((await approve(p.admin, second.invitation.approval_id!, assignmentDigest)).status, 'approved');
    const done = await apply(again.id);
    assert.equal(done.outcome, 'applied');

    const audit = await owner((trx) => trx.selectFrom('admin_audit_event').select(['action', 'second_approver_person_id', 'approval_id', 'approval_digest'])
      .where('object_id', '=', done.invitation.assignment_id!).execute());
    assert.deepEqual(audit, [{ action: 'staff.assign_sensitive_role', second_approver_person_id: p.admin, approval_id: second.invitation.approval_id, approval_digest: assignmentDigest }],
      'a sensitive assignment is audited under the action bound to a second approver');
  });

  // The audit's scenario on the first hub: two hub staff, one node staff member and the two founders make five people.
  // A role that assigns staff but cannot read them: the approver the API could never check.
  await owner((trx) => staffRoleDefinitions.release(trx, { version: 2, role: 'moderator', scopes: ['hub'], permissions: ['admin.staff.assign', 'admin.moderation.read', 'admin.moderation.decide'],
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
  const moderatorV2 = async (personId: string) => as(p.owner, async (trx) => staffAssignments.assign(trx, await elevate(p.owner), { personId, role: 'moderator', scope: hub, definitionVersion: 2 }));
  await moderatorV2(p.moderator);
  await moderatorV2(p.lead);

  await t.test('the mode is the database\'s answer for a reader who cannot see node or platform assignments', async () => {
    const visible = await as(p.lead, (trx) => trx.selectFrom('staff_role_assignment').select('person_id').execute());
    assert.deepEqual(visible.map((r) => r.person_id), [p.lead], 'the reader sees only their own assignment');
    assert.deepEqual(await sod(p.lead, hub), { mode: 'full', staffCount: 5 });
  });

  await t.test('negative: nobody outside the scope reads its mode', async () => {
    await rejects(sod(p.customer, hub), 'P0002', 'admin.not_found');
    await rejects(sod(p.otherAgent, hub), 'P0002', 'admin.not_found');
    await rejects(sod(p.moderator, otherHub), 'P0002', 'admin.not_found');
  });

  await t.test('an approver without admin.staff.read cannot approve through the requester\'s role', async () => {
    const actionDigest = digest();
    const request = await ask(p.moderator, STAFF_ACTION, hub, actionDigest);
    await rejects(approve(p.lead, request.id, actionDigest), '42501', 'admin.same_role');
    const still = await owner((trx) => trx.selectFrom('second_person_approval').select(['status', 'approved_by']).where('id', '=', request.id).executeTakeFirstOrThrow());
    assert.deepEqual(still, { status: 'pending', approved_by: null });
    assert.equal((await approve(p.owner, request.id, actionDigest)).status, 'approved', 'a platform owner acts through a different role');
  });

  await t.test('a decline needs no different role: refusing a change is never the risk', async () => {
    const actionDigest = digest();
    const request = await ask(p.moderator, STAFF_ACTION, hub, actionDigest);
    const declined = await as(p.lead, async (trx) => approvals.decide(trx, await elevate(p.lead), request.id, 'decline', actionDigest));
    assert.equal(declined.status, 'declined');
  });

  await t.test('only roles that grant the action count, and one such role the requester lacks is enough', async () => {
    await assign({ personId: p.lead, role: 'ops-engineer', scope: hub });
    const actionDigest = digest();
    const request = await ask(p.moderator, STAFF_ACTION, hub, actionDigest);
    await rejects(approve(p.lead, request.id, actionDigest), '42501', 'admin.same_role');
    await assignSensitive({ personId: p.hubOwner, role: 'hub-owner', scope: hub });
    await moderatorV2(p.hubOwner);
    assert.equal((await approve(p.hubOwner, request.id, actionDigest)).status, 'approved');
  });

  await t.test('a break-glass approval carries the rule too; other second-person actions keep what they had', async () => {
    const glass = digest();
    await owner((trx) => staffRoleDefinitions.release(trx, { version: 3, role: 'moderator', scopes: ['hub'], permissions: ['admin.staff.breakglass', 'admin.staff.assign', 'admin.moderation.read', 'admin.moderation.decide'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
    for (const personId of [p.moderator, p.lead]) await as(p.owner, async (trx) => staffAssignments.assign(trx, await elevate(p.owner), { personId, role: 'moderator', scope: hub, definitionVersion: 3 }));
    const request = await ask(p.moderator, 'staff.grant_breakglass', hub, glass);
    await rejects(approve(p.lead, request.id, glass), '42501', 'admin.same_role');
    // Same role, full mode, an ordinary action: the database asks for a different person, as before.
    const actionDigest = digest();
    const ordinary = await ask(p.moderator, 'moderation.apply_sanction_l4', hub, actionDigest);
    assert.equal((await approve(p.lead, ordinary.id, actionDigest)).status, 'approved');
    assert.equal((await as(p.moderator, (trx) => approvals.consume(trx, { approvalId: ordinary.id, action: 'moderation.apply_sanction_l4', scope: hub, actionDigest, ref: crypto.randomUUID() }))).status, 'consumed');
  });

  await t.test('concurrency: a same-role approver never wins the race against a different-role approver', async () => {
    for (let round = 0; round < 4; round += 1) {
      const actionDigest = digest();
      const request = await ask(p.moderator, STAFF_ACTION, hub, actionDigest);
      const [same, different] = await Promise.all([settle(approve(p.lead, request.id, actionDigest)), settle(approve(p.owner, request.id, actionDigest))]);
      assert.ok(['admin.same_role', 'admin.approval_not_pending'].includes(same?.hint ?? ''), same?.message ?? 'the same-role approver was not refused');
      assert.equal(different, null);
      const row = await owner((trx) => trx.selectFrom('second_person_approval').select('approved_by').where('id', '=', request.id).executeTakeFirstOrThrow());
      assert.equal(row.approved_by, p.owner);
    }
  });

  await t.test('the scope of an invitation is told to staff covering it and to nobody else', async () => {
    const other = `scope.${randomBytes(3).toString('hex')}@invite.example.invalid`;
    const row = await as(p.owner, async (trx) => staffLifecycle.invite(trx, await elevate(p.owner), { email: other, role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: null }));
    assert.deepEqual(await as(p.moderator, (trx) => staffLifecycle.invitations(trx, w.hubId)), [], 'a moderator cannot read the invitation');
    assert.deepEqual(await as(p.moderator, (trx) => staffLifecycle.invitationScope(trx, row.id)), hub);
    assert.equal(await as(p.customer, (trx) => staffLifecycle.invitationScope(trx, row.id)), null);
    assert.equal(await as(p.otherAgent, (trx) => staffLifecycle.invitationScope(trx, row.id)), null);
  });
});
