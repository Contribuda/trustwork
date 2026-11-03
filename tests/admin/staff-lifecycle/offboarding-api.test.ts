import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AccountabilitySchema, OffboardingSchema, StaffInvitationViewSchema, type Accountability, type Offboarding } from '../../../packages/contracts/src/staff-lifecycle.js';
import { Client, SKIP_REASON, startHarness } from '../../backend/helpers/app.js';
import { buildHttpWorld, command, emailOf, expectRefusal, type AdminWorldHttp } from '../helpers.js';

const h = await startHarness('staff_offboarding_api');

/** Field names that would describe what a staff member does rather than who they are and what they may do. */
const ACTIVITY = /(activ(e|ity)At|last|seen|signIn|login|elevat|count|decision|response|productiv|behavio|duration|minutes|hours|score|rank)/i;
function fieldNames(schema: z.ZodType, out: string[] = []): string[] {
  const def = (schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; options?: z.ZodType[] } }).def;
  if (def.type === 'object' && def.shape) for (const [k, v] of Object.entries(def.shape)) { out.push(k); fieldNames(v, out); }
  if (def.type === 'array' && def.element) fieldNames(def.element, out);
  if ((def.type === 'nullable' || def.type === 'optional') && def.innerType) fieldNames(def.innerType, out);
  if (def.type === 'union' && def.options) for (const o of def.options) fieldNames(o, out);
  return out;
}

/**
 * ADM-004 part 5 through the HTTP API with real sessions and elevated staff: an invitation naming a function position,
 * accountability assigned, suspended by an abrupt role loss and offered to the hub owner who accepts, and the guided
 * offboarding that is blocked until the hand-over and then ends every role in one transaction. Every person is synthetic.
 */
test('function accountability and offboarding through the API (ADM-004 part 5)', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const hubId = w.world.hubId;
  const hub = { kind: 'hub', hubId } as const;
  const accountabilityOf = (r: { body: unknown }): Accountability => AccountabilitySchema.parse((r.body as { accountability: unknown }).accountability);
  const offboardingOf = (r: { body: unknown }): Offboarding => OffboardingSchema.parse((r.body as { offboarding: unknown }).offboarding);
  const activeRoles = async (personId: string): Promise<string[]> => {
    const r = await c.hubOwner.get(`/v1/admin/staff/assignments?personId=${personId}&activeOnly=true`);
    return ((r.body as { assignments: Array<{ role: string }> }).assignments).map((a) => a.role).sort();
  };

  await t.test('negative: anonymous, participants and unelevated staff never name who is accountable or start an offboarding', async () => {
    expectRefusal(await new Client(w.app).post('/v1/admin/staff/offboardings', {}, { idempotencyKey: 'anon-1' }), 401, 'auth.session_invalid');
    expectRefusal(await command(c.customer, '/v1/admin/staff/offboardings', { personId: p.lead, scope: hub }), 403, 'access.forbidden', 'staff');
    expectRefusal(await command(c.hubOwner, '/v1/admin/staff/offboardings', { personId: p.lead, scope: hub }), 403, 'access.forbidden', 'elevation');
  });

  await w.elevateAll();

  await t.test('an invitation may name the function position; the view carries it', async () => {
    const created = await command(c.hubOwner, '/v1/admin/staff/invitations', { email: emailOf('candidate'), role: 'support-agent', scope: hub, definitionVersion: 1, validForSeconds: null, functionKey: 'support', functionTitle: 'Support desk' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const view = StaffInvitationViewSchema.parse((created.body as { invitation: unknown }).invitation);
    assert.deepEqual([view.functionKey, view.functionTitle], ['support', 'Support desk']);
    expectRefusal(await command(c.hubOwner, '/v1/admin/staff/invitations', { email: emailOf('outsider'), role: 'support-agent', scope: hub, definitionVersion: 1, validForSeconds: null, functionKey: 'cooking' }), 422, 'validation.schema', 'function_invalid');
  });

  let supportOwner: Accountability;
  await t.test('admin.staff.assign names the accountable person; the row is suspended at once when their role is revoked and offered to the hub owner', async () => {
    const assign = (client: Client, body: Record<string, unknown>) => command(client, '/v1/admin/staff/accountability', { hubId, functionKey: 'support', kind: 'function_owner', agentRoleKey: null, personId: p.lead, requiredRole: 'support-lead', ...body });
    expectRefusal(await assign(c.moderator, {}), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await assign(c.hubOwner, { personId: p.moderator }), 422, 'validation.schema', 'accountable_without_role');
    expectRefusal(await assign(c.hubOwner, { kind: 'agent_role' }), 422, 'validation.schema');
    const created = await assign(c.hubOwner, {});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    supportOwner = accountabilityOf(created);
    assert.deepEqual([supportOwner.personId, supportOwner.holderName, supportOwner.status, supportOwner.effective, supportOwner.pendingOffers], [p.lead, 'Synthetic Support Lead', 'active', 'active', []]);
    expectRefusal(await assign(c.hubOwner, { personId: p.lead2 }), 409, 'validation.revision_conflict', 'accountability_open');
    const triage = accountabilityOf(await command(c.hubOwner, '/v1/admin/staff/accountability', { hubId, functionKey: 'support', kind: 'agent_role', agentRoleKey: 'support_triage', personId: p.lead, requiredRole: 'support-lead' }));
    assert.equal(triage.kind, 'agent_role');
    // Reads: the holder sees their rows; the moderator (no admin.staff.read) sees nothing; a participant is refused as non-staff.
    assert.equal(((await c.lead.get(`/v1/admin/staff/accountability?hubId=${hubId}`)).body as { accountabilities: unknown[] }).accountabilities.length, 2);
    assert.deepEqual((await c.moderator.get(`/v1/admin/staff/accountability?hubId=${hubId}`)).body, { accountabilities: [] });
    // The lead's role is revoked abruptly.
    const leadRole = ((await c.hubOwner.get(`/v1/admin/staff/assignments?personId=${p.lead}&activeOnly=true`)).body as { assignments: Array<{ id: string }> }).assignments[0]!;
    assert.equal((await command(c.admin, `/v1/admin/staff/assignments/${leadRole.id}/revoke`)).status, 200);
    const rows = ((await c.hubOwner.get(`/v1/admin/staff/accountability?hubId=${hubId}`)).body as { accountabilities: Accountability[] }).accountabilities.map((a) => AccountabilitySchema.parse(a));
    assert.ok(rows.every((a) => a.status === 'suspended' && a.effective === 'suspended' && a.suspendedReason === 'holder_lost_role'));
    assert.ok(rows.every((a) => a.pendingOffers.map((o) => o.toPersonId).includes(p.hubOwner)), 'the hub owner is offered each one');
    const offers = (await c.hubOwner.get('/v1/admin/staff/accountability/offers')).body as { offers: Array<{ id: string; accountabilityId: string }> };
    assert.equal(offers.offers.length, 2);
    assert.deepEqual((await c.admin.get('/v1/admin/staff/accountability/offers')).body, { offers: [] });
    // Only the person named decides; the hub owner accepts the owner role and declines the agent role.
    const ownerOffer = offers.offers.find((o) => o.accountabilityId === supportOwner.id)!;
    expectRefusal(await command(c.admin, `/v1/admin/staff/accountability/offers/${ownerOffer.id}/respond`, { accept: true }), 404, 'access.not_found');
    const accepted = await command(c.hubOwner, `/v1/admin/staff/accountability/offers/${ownerOffer.id}/respond`, { accept: true });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const moved = accountabilityOf(accepted);
    assert.deepEqual([moved.personId, moved.status, moved.effective, moved.predecessorId], [p.hubOwner, 'active', 'suspended', supportOwner.id], 'held by the fallback, suspended until they hold support-lead');
    const declined = await command(c.hubOwner, `/v1/admin/staff/accountability/offers/${offers.offers.find((o) => o.accountabilityId === triage.id)!.id}/respond`, { accept: false });
    assert.equal(accountabilityOf(declined).status, 'suspended');
    assert.equal((await command(c.hubOwner, `/v1/admin/staff/accountability/${triage.id}/end`)).status, 200);
    supportOwner = moved;
  });

  await t.test('offboarding is blocked by an open accountability, offers it to the fallback, and completes in one transaction after the hand-over', async () => {
    // The lead gets the support-lead role back and the support function; then the hub owner offboards the lead.
    assert.equal((await command(c.owner, '/v1/admin/staff/assignments', { personId: p.lead, role: 'support-lead', scope: hub, definitionVersion: 1 })).status, 201);
    const back = await command(c.hubOwner, `/v1/admin/staff/accountability/${supportOwner.id}/offer`, { toPersonId: p.lead });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    const offerId = (back.body as { offer: { id: string } }).offer.id;
    supportOwner = accountabilityOf(await command(c.lead, `/v1/admin/staff/accountability/offers/${offerId}/respond`, { accept: true }));
    assert.deepEqual([supportOwner.personId, supportOwner.effective], [p.lead, 'active']);
    expectRefusal(await command(c.hubOwner, '/v1/admin/staff/offboardings', { personId: p.hubOwner, scope: hub }), 403, 'access.forbidden', 'self_offboarding');
    expectRefusal(await command(c.hubOwner, '/v1/admin/staff/offboardings', { personId: p.candidate, scope: hub }), 404, 'access.not_found');
    const started = await command(c.hubOwner, '/v1/admin/staff/offboardings', { personId: p.lead, scope: hub });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const offboarding = offboardingOf(started);
    assert.deepEqual([offboarding.status, offboarding.blocked, offboarding.checklist.roles.map((r) => r.role), offboarding.checklist.adminClients], ['open', true, ['support-lead'], []]);
    assert.deepEqual(offboarding.checklist.accountabilities.map((a) => [a.functionKey, a.offers.map((o) => o.toPersonId), a.suggested.map((s) => s.personId)]), [['support', [p.hubOwner], [p.hubOwner]]]);
    expectRefusal(await c.moderator.get(`/v1/admin/staff/offboardings/${offboarding.id}`), 404, 'access.not_found');
    assert.equal(offboardingOf(await c.admin.get(`/v1/admin/staff/offboardings/${offboarding.id}`)).id, offboarding.id);
    expectRefusal(await command(c.hubOwner, `/v1/admin/staff/offboardings/${offboarding.id}/complete`), 409, 'validation.revision_conflict', 'offboarding_blocked');
    assert.deepEqual(await activeRoles(p.lead), ['support-lead'], 'nothing changed');
    const fallback = offboarding.checklist.accountabilities[0]!.offers[0]!;
    assert.equal((await command(c.hubOwner, `/v1/admin/staff/accountability/offers/${fallback.offerId}/respond`, { accept: true })).status, 200);
    assert.equal(offboardingOf(await c.hubOwner.get(`/v1/admin/staff/offboardings/${offboarding.id}`)).blocked, false);
    expectRefusal(await command(c.moderator, `/v1/admin/staff/offboardings/${offboarding.id}/complete`), 403, 'access.forbidden', 'forbidden');
    const done = await command(c.hubOwner, `/v1/admin/staff/offboardings/${offboarding.id}/complete`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([offboardingOf(done).status, offboardingOf(done).completedBy], ['completed', p.hubOwner]);
    assert.deepEqual(await activeRoles(p.lead), []);
    expectRefusal(await c.lead.get(`/v1/admin/staff/directory?hubId=${hubId}`), 403, 'access.forbidden', 'staff');
    const cancelled = offboardingOf(await command(c.hubOwner, '/v1/admin/staff/offboardings', { personId: p.moderator, scope: hub }));
    assert.equal(offboardingOf(await command(c.hubOwner, `/v1/admin/staff/offboardings/${cancelled.id}/cancel`)).status, 'cancelled');
    assert.deepEqual(await activeRoles(p.moderator), ['moderator']);
  });

  await t.test('no field of these views describes what a staff member does (schema walk)', () => {
    const names = [...fieldNames(AccountabilitySchema), ...fieldNames(OffboardingSchema)];
    assert.ok(names.length > 40);
    assert.deepEqual(names.filter((n) => ACTIVITY.test(n)), []);
  });
});
