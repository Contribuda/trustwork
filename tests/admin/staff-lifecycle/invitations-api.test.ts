import test from 'node:test';
import assert from 'node:assert/strict';
import { MyStaffInvitationSchema, StaffInvitationViewSchema } from '../../../packages/contracts/src/staff-lifecycle.js';
import { Client, SKIP_REASON, startHarness } from '../../backend/helpers/app.js';
import { buildHttpWorld, command, emailOf, enrolNow, expectRefusal, PASSWORD, signIn, type AdminWorldHttp } from '../helpers.js';

const h = await startHarness('staff_invitations_api');

/**
 * ADM-004 part 2 through the HTTP API with real sessions and elevated staff: a staff administrator invites an address,
 * the person with that verified address sees and accepts it (after enrolling a second factor), the inviter applies it,
 * and every other party is refused or sees nothing. Every person and hub is synthetic.
 */
test('staff invitations through the API (ADM-004 part 2)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.world.hubId } as const;
  const invite = (client: Client, email: string, role = 'moderator') => command(client, '/v1/admin/staff/invitations', { email, role, scope: hub, definitionVersion: 1, validForSeconds: null });

  await t.test('negative: anonymous, participants and unelevated staff never invite', async () => {
    expectRefusal(await new Client(w.app).post('/v1/admin/staff/invitations', {}, { idempotencyKey: 'anon-1' }), 401, 'auth.session_invalid');
    expectRefusal(await invite(c.customer, emailOf('candidate')), 403, 'access.forbidden', 'staff');
    expectRefusal(await invite(c.owner, emailOf('candidate')), 403, 'access.forbidden', 'elevation');
  });

  await w.elevateAll();
  let invitationId = '';

  await t.test('a staff administrator invites; staff without admin.staff.read see no invitations; the invitee alone sees it', async () => {
    expectRefusal(await invite(c.moderator, emailOf('candidate')), 403, 'access.forbidden');
    expectRefusal(await invite(c.owner, emailOf('owner')), 403, 'access.forbidden', 'self_grant');
    const created = await invite(c.owner, emailOf('candidate'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const view = StaffInvitationViewSchema.parse((created.body as { invitation: unknown }).invitation);
    invitationId = view.id;
    assert.deepEqual([view.status, view.sensitive, view.personId], ['pending', false, null]);
    expectRefusal(await invite(c.owner, emailOf('candidate')), 409, 'validation.revision_conflict', 'invitation_open');
    assert.deepEqual((await c.moderator.get(`/v1/admin/staff/invitations?hubId=${hub.hubId}`)).body, { invitations: [] });
    const listed = (await c.hubOwner.get(`/v1/admin/staff/invitations?hubId=${hub.hubId}`)).body as { invitations: Array<{ id: string }> };
    assert.ok(listed.invitations.some((i) => i.id === invitationId));
    const mine = (await c.candidate.get('/v1/me/staff-invitations')).body as { invitations: unknown[] };
    assert.equal(mine.invitations.length, 1);
    assert.equal(MyStaffInvitationSchema.parse(mine.invitations[0]).inviterName, 'Synthetic Platform Owner');
    assert.deepEqual((await c.outsider.get('/v1/me/staff-invitations')).body, { invitations: [] });
  });

  await t.test('the invitee accepts only with a second factor; anyone else gets "not found"', async () => {
    const respond = (client: Client, accept: boolean, key: string) => client.post(`/v1/me/staff-invitations/${invitationId}/respond`, { accept }, { idempotencyKey: key });
    expectRefusal(await respond(c.outsider, true, 'resp-outsider'), 404, 'access.not_found');
    expectRefusal(await respond(c.candidate, true, 'resp-no-factor'), 403, 'access.forbidden', 'second_factor_required');
    await signIn(c.candidate, emailOf('candidate'));
    assert.equal((await c.candidate.post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    await enrolNow(h, c.candidate);
    const accepted = await respond(c.candidate, true, 'resp-accept');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body, { status: 'accepted' });
  });

  await t.test('only the inviter applies; the role is then held and audited', async () => {
    expectRefusal(await command(c.admin, `/v1/admin/staff/invitations/${invitationId}/apply`), 403, 'access.approval_required', 'not_requester');
    const applied = await command(c.owner, `/v1/admin/staff/invitations/${invitationId}/apply`);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const body = applied.body as { result: { outcome: string }; invitation: unknown };
    assert.equal(body.result.outcome, 'applied');
    const view = StaffInvitationViewSchema.parse(body.invitation);
    assert.deepEqual([view.status, view.personId], ['applied', p.candidate]);
    const assignments = (await c.hubOwner.get(`/v1/admin/staff/assignments?personId=${p.candidate}&activeOnly=true`)).body as { assignments: Array<{ role: string }> };
    assert.deepEqual(assignments.assignments.map((a) => a.role), ['moderator']);
  });

  await t.test('a withdrawn invitation cannot be answered', async () => {
    const created = await invite(c.owner, emailOf('outsider'));
    const id = ((created.body as { invitation: { id: string } }).invitation).id;
    const withdrawn = await command(c.admin, `/v1/admin/staff/invitations/${id}/withdraw`);
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    expectRefusal(await c.outsider.post(`/v1/me/staff-invitations/${id}/respond`, { accept: false }, { idempotencyKey: 'resp-withdrawn' }), 409, 'validation.revision_conflict');
  });
});
