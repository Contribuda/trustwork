import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { SKIP_REASON, startHarness, type Client } from '../../backend/helpers/app.js';
import { auditRows, buildHttpWorld, command, emailOf, enrolNow, expectRefusal, PASSWORD, signIn, type AdminWorldHttp } from '../helpers.js';

const h = await startHarness('staff_sod_api');

/**
 * ADM-004 audit fixes through the HTTP API with real sessions and elevated staff: the mode the API reports is the
 * database's, the approvals inbox refuses a same-role approver who cannot read the staff directory, and a refused apply
 * or withdraw of an invitation leaves a `denied` audit row at the invitation's scope. Every person and hub is synthetic.
 */
test('separation of duties and invitations through the API (ADM-004)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const act = w.actors;
  const hub = { kind: 'hub', hubId: w.world.hubId } as const;
  const otherHub = { kind: 'hub', hubId: w.world.otherHubId } as const;
  await w.elevateAll();

  await t.test('a reader at a hub gets the database\'s mode, not a count of the rows they may see', async () => {
    // owner, admin, admin2 at the platform, the other hub's agent, and now its hub owner: five people, two of them visible.
    await act.assignSensitive({ personId: p.lead, role: 'hub-owner', scope: otherHub });
    const read = await c.lead.get(`/v1/admin/staff/sod?hubId=${w.world.otherHubId}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body, { target: otherHub, mode: 'full', staffCount: 5, minimumForFull: 5 });
  });

  await t.test('an approver without admin.staff.read: refused through the same role, told the real mode otherwise', async () => {
    // A role that assigns staff but cannot read them: the approver the API could never check.
    await act.owner((trx) => staffRoleDefinitions.release(trx, { version: 2, role: 'moderator', scopes: ['hub'], permissions: ['admin.staff.assign', 'admin.moderation.read'],
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
    for (const personId of [p.agent, p.lead2]) assert.equal((await command(c.owner, '/v1/admin/staff/assignments', { personId, role: 'moderator', scope: hub, definitionVersion: 2 })).status, 201);
    await w.elevateAll();
    const asked = await command(c.agent, '/v1/admin/approvals', { subject: { action: 'staff.assign_sensitive_role', personId: p.employee, role: 'hub-owner', scope: hub, definitionVersion: 1 } });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const requested = (asked.body as { approval: { id: string; actionDigest: string } }).approval;
    expectRefusal(await command(c.lead2, `/v1/admin/approvals/${requested.id}/approve`, { actionDigest: requested.actionDigest }), 403, 'access.second_approver_required', 'same_role');
    const denied = await auditRows(h, "action = 'approval.decide' AND outcome = 'denied' AND object_id = $1", [requested.id]);
    assert.deepEqual(denied.map((r) => [r.actor_person_id, r.reason_code]), [[p.lead2, 'denied_same_role']]);
    const decided = await command(c.hubOwner, `/v1/admin/approvals/${requested.id}/approve`, { actionDigest: requested.actionDigest });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.deepEqual((decided.body as { sod: unknown }).sod, { verified: true, mode: 'full', staffCount: 10 });
  });

  await t.test('invitations: a refused apply or withdraw is audited; an applied one tells the person; a sensitive one names the second person', async () => {
    const invite = async (client: Client, address: string, role: string) => {
      const created = await command(client, '/v1/admin/staff/invitations', { email: address, role, scope: hub, definitionVersion: 1, validForSeconds: null });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return (created.body as { invitation: { id: string } }).invitation.id;
    };
    const accept = async (client: Client, id: string) => {
      const answered = await client.post(`/v1/me/staff-invitations/${id}/respond`, { accept: true }, { idempotencyKey: `respond-${randomBytes(4).toString('hex')}` });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
    };
    await signIn(c.candidate, emailOf('candidate'));
    assert.equal((await c.candidate.post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    await enrolNow(h, c.candidate);

    const plain = await invite(c.owner, emailOf('candidate'), 'moderator');
    await accept(c.candidate, plain);
    const denied = (id: string, action: string) => auditRows(h, "action = $1 AND outcome = 'denied' AND object_type = 'staff_invitation' AND object_id = $2", [action, id]);

    // A staff administrator who is not the inviter, a staff member without the permission, and someone with no role at the hub.
    expectRefusal(await command(c.admin, `/v1/admin/staff/invitations/${plain}/apply`), 403, 'access.approval_required', 'not_requester');
    expectRefusal(await command(c.moderator, `/v1/admin/staff/invitations/${plain}/apply`), 403, 'access.forbidden');
    expectRefusal(await command(c.otherAgent, `/v1/admin/staff/invitations/${plain}/apply`), 403, 'access.forbidden');
    assert.deepEqual((await denied(plain, 'staff.invitation_apply')).map((r) => [r.actor_person_id, r.reason_code]).sort(),
      [[p.admin, 'denied_not_requester'], [p.moderator, 'denied_forbidden']].sort(), 'audited at the invitation, and never for a person with no role there');

    expectRefusal(await command(c.moderator, `/v1/admin/staff/invitations/${plain}/withdraw`), 403, 'access.forbidden');
    assert.deepEqual((await denied(plain, 'staff.invitation_withdrawn')).map((r) => r.actor_person_id), [p.moderator]);

    const applied = await command(c.owner, `/v1/admin/staff/invitations/${plain}/apply`);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const assignmentId = (applied.body as { invitation: { assignmentId: string } }).invitation.assignmentId;
    const notices = await h.db.admin.query<{ aggregate_id: string; payload: Record<string, unknown> }>("SELECT aggregate_id, payload FROM trustwork.outbox_event WHERE type = 'admin.staff_role_assigned' AND payload ->> 'assignmentId' = $1", [assignmentId]);
    assert.deepEqual(notices.rows.map((r) => [r.aggregate_id, r.payload]), [[p.candidate, { assignmentId, role: 'moderator', scopeKind: 'hub', grantedBy: p.owner }]]);

    // A sensitive role: a pending apply is no notice, and the assignment is audited with its second person.
    const sensitive = await invite(c.admin, emailOf('candidate'), 'hub-owner');
    await accept(c.candidate, sensitive);
    const pending = await command(c.admin, `/v1/admin/staff/invitations/${sensitive}/apply`);
    assert.equal((pending.body as { result: { outcome: string } }).result.outcome, 'pending_second_person');
    const approvalId = (pending.body as { invitation: { approvalId: string } }).invitation.approvalId;
    const { rows: before } = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE type = 'admin.staff_role_assigned' AND aggregate_id = $1", [p.candidate]);
    assert.equal(before[0]!.n, 1);
    const digest = ((await c.admin.get(`/v1/admin/approvals/${approvalId}`)).body as { approval: { actionDigest: string } }).approval.actionDigest;
    const approved = await command(c.owner, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: digest });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const done = await command(c.admin, `/v1/admin/staff/invitations/${sensitive}/apply`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const id = (done.body as { invitation: { assignmentId: string } }).invitation.assignmentId;
    const audit = await auditRows(h, "object_id = $1 AND outcome = 'applied'", [id]);
    assert.deepEqual(audit.map((r) => [r.action, r.actor_person_id, r.second_approver_person_id]), [['staff.assign_sensitive_role', p.admin, p.owner]]);
  });
});
