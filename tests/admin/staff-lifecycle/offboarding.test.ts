import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, type DataPool } from '@trustwork/data';
import { staffAssignments, supportCases, type CommandContext } from '../../../packages/data/src/repositories/admin.js';
import { staffLifecycle } from '../../../packages/data/src/repositories/staff-lifecycle.js';
import { OffboardingChecklistSchema } from '../../../packages/contracts/src/staff-lifecycle.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { actors, buildAdminWorld, rejects, type AdminWorld } from '../../data/admin/helpers.js';

const db = await provisionTestDatabase('staff_offboarding');

/**
 * ADM-004 part 5 on real PostgreSQL under the runtime role: an invitation may name a function position; accountability
 * for a function or an agent role is held by staff holding the role the function needs, suspended at once when that
 * role is revoked (the hub owners are offered it and one must accept), handed over only by acceptance; offboarding is
 * started by admin.staff.revoke for someone else, lists what it will revoke and the open work to hand over with people
 * suggested by role, refuses to complete while an accountability is open, and completes in one transaction. Every person
 * and hub is synthetic.
 */
test('function accountability and offboarding (ADM-004 part 5)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: AdminWorld = await buildAdminWorld(db.admin);
  const { as, elevate, assign, assignSensitive, owner } = actors(db.admin, runtime, w);
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.hubId } as const;

  await assignSensitive({ personId: p.hubOwner, role: 'hub-owner', scope: hub });
  for (const [key, role] of [['moderator', 'moderator'], ['lead', 'support-lead'], ['lead2', 'support-lead'], ['ops', 'ops-engineer'], ['auditor', 'auditor']] as const) {
    await assign({ personId: p[key], role, scope: hub });
  }
  const fake: CommandContext = { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'r1', reasonCode: 'synthetic_test', reasonText: 'x' };
  const assignAcc = (by: string, input: { functionKey: string; kind: 'function_owner' | 'agent_role'; agentRoleKey?: string | null; personId: string; requiredRole: string | null }) =>
    as(by, async (trx) => staffLifecycle.assignAccountability(trx, await elevate(by), { hubId: w.hubId, functionKey: input.functionKey, kind: input.kind, agentRoleKey: input.agentRoleKey ?? null, personId: input.personId, requiredRole: input.requiredRole }));
  const accountability = (id: string) => owner((trx) => trx.selectFrom('staff_accountability').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  const offersOf = (id: string) => owner((trx) => trx.selectFrom('staff_accountability_offer').selectAll().where('accountability_id', '=', id).orderBy('created_at').execute());
  const respond = (by: string, offerId: string, accept: boolean) => as(by, async (trx) => staffLifecycle.respondAccountabilityOffer(trx, await elevate(by), offerId, accept));
  const activeRoles = (personId: string) => owner((trx) => trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', personId).where('revoked_at', 'is', null).execute()).then((r) => r.map((x) => x.role).sort());
  const audit = (action: string) => owner((trx) => trx.selectFrom('admin_audit_event').select(['actor_person_id', 'permission']).where('action', '=', action).orderBy('sequence').execute());

  await t.test('an invitation may name a function position of the hub; the key comes from the catalogue', async () => {
    const email = `position.${randomBytes(3).toString('hex')}@invite.example.invalid`;
    const row = await as(p.owner, async (trx) => staffLifecycle.invite(trx, await elevate(p.owner), { email, role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: null, functionKey: 'trust_safety', functionTitle: 'Trust and safety lead' }));
    assert.deepEqual([row.function_key, row.function_title], ['trust_safety', 'Trust and safety lead']);
    await rejects(as(p.owner, async (trx) => staffLifecycle.invite(trx, await elevate(p.owner), { email: `x.${email}`, role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: null, functionKey: 'cooking' })), '23514', 'admin.function_invalid');
    await rejects(as(p.owner, async (trx) => staffLifecycle.invite(trx, await elevate(p.owner), { email: `y.${email}`, role: 'auditor', scope: { kind: 'platform' }, definitionVersion: 1, validForSeconds: null, functionKey: 'finance' })), '23514', 'admin.function_invalid');
    await owner((trx) => trx.insertInto('email_binding').values({ person_id: p.employee, email_normalized: email, is_primary: true, verified_at: new Date() }).execute());
    const [mine] = await as(p.employee, (trx) => staffLifecycle.mine(trx));
    assert.deepEqual([mine!.function_key, mine!.function_title], ['trust_safety', 'Trust and safety lead']);
  });

  await t.test('negative: only admin.staff.assign names who is accountable, for a catalogue function, to staff holding the role the function needs', async () => {
    await rejects(as(p.customer, (trx) => staffLifecycle.assignAccountability(trx, fake, { hubId: w.hubId, functionKey: 'support', kind: 'function_owner', agentRoleKey: null, personId: p.lead, requiredRole: null })), '42501');
    await rejects(assignAcc(p.moderator, { functionKey: 'support', kind: 'function_owner', personId: p.lead, requiredRole: null }), '42501', 'admin.forbidden');
    await rejects(assignAcc(p.hubOwner, { functionKey: 'cooking', kind: 'function_owner', personId: p.lead, requiredRole: null }), '22023', 'admin.function_invalid');
    await rejects(assignAcc(p.hubOwner, { functionKey: 'support', kind: 'agent_role', agentRoleKey: null, personId: p.lead, requiredRole: null }), '22023', 'admin.function_invalid');
    await rejects(assignAcc(p.hubOwner, { functionKey: 'support', kind: 'function_owner', personId: p.moderator, requiredRole: 'support-lead' }), '23514', 'admin.accountable_without_role');
    await rejects(assignAcc(p.hubOwner, { functionKey: 'support', kind: 'function_owner', personId: p.customer, requiredRole: null }), '23514', 'admin.accountable_without_role');
  });

  let trustOwner = '';
  let triage = '';
  await t.test('accountability is assigned once per function and agent role; the operator may name themselves; reads by permission', async () => {
    trustOwner = (await assignAcc(p.hubOwner, { functionKey: 'trust_safety', kind: 'function_owner', personId: p.moderator, requiredRole: 'moderator' })).id;
    triage = (await assignAcc(p.hubOwner, { functionKey: 'trust_safety', kind: 'agent_role', agentRoleKey: 'moderation_triage', personId: p.moderator, requiredRole: 'moderator' })).id;
    await rejects(assignAcc(p.hubOwner, { functionKey: 'trust_safety', kind: 'function_owner', personId: p.lead, requiredRole: null }), '23505', 'admin.accountability_open');
    const self = await assignAcc(p.hubOwner, { functionKey: 'leadership', kind: 'function_owner', personId: p.hubOwner, requiredRole: 'hub-owner' });
    assert.deepEqual([self.person_id, self.status], [p.hubOwner, 'active']);
    const all = await as(p.hubOwner, (trx) => staffLifecycle.accountabilities(trx, w.hubId));
    assert.deepEqual(all.map((r) => [r.accountability.function_key, r.accountability.kind, r.holder_ok]), [['leadership', 'function_owner', true], ['trust_safety', 'agent_role', true], ['trust_safety', 'function_owner', true]]);
    assert.equal(all[0]!.holder_name, 'Synthetic Hub Owner');
    assert.equal((await as(p.moderator, (trx) => staffLifecycle.accountabilities(trx, w.hubId))).length, 2, 'the holder sees their own rows');
    assert.deepEqual(await as(p.customer, (trx) => staffLifecycle.accountabilities(trx, w.hubId)), []);
    assert.deepEqual((await audit('staff.accountability_assigned')).map((a) => a.permission), ['admin.staff.assign', 'admin.staff.assign', 'admin.staff.assign']);
  });

  await t.test('an abrupt role loss suspends the holder\'s accountabilities at once and offers them to the hub owners', async () => {
    const [moderatorRole] = await owner((trx) => trx.selectFrom('staff_role_assignment').select('id').where('person_id', '=', p.moderator).where('revoked_at', 'is', null).execute());
    await as(p.admin, async (trx) => staffAssignments.revoke(trx, await elevate(p.admin), moderatorRole!.id));
    for (const id of [trustOwner, triage]) {
      const row = await accountability(id);
      assert.deepEqual([row.status, row.suspended_reason], ['suspended', 'holder_lost_role']);
      const offers = await offersOf(id);
      assert.deepEqual(offers.map((o) => [o.to_person_id, o.status]), [[p.hubOwner, 'pending']], 'the hub owner is offered the accountability');
    }
    assert.equal((await as(p.hubOwner, (trx) => staffLifecycle.accountabilities(trx, w.hubId))).find((r) => r.accountability.function_key === 'leadership')!.accountability.status, 'active');
  });

  await t.test('only the person named accepts an offer; acceptance hands the accountability over as a new row; declining leaves it suspended', async () => {
    const [ownerOffer] = await offersOf(trustOwner);
    await rejects(respond(p.moderator, ownerOffer!.id, true), 'P0002', 'admin.not_found');
    await rejects(respond(p.lead, ownerOffer!.id, true), 'P0002', 'admin.not_found');
    const accepted = await respond(p.hubOwner, ownerOffer!.id, true);
    assert.deepEqual([accepted.offer.status, accepted.accountability.person_id, accepted.accountability.status, accepted.accountability.predecessor_id], ['accepted', p.hubOwner, 'active', trustOwner]);
    assert.equal(accepted.offer.successor_id, accepted.accountability.id);
    // The fallback does not hold the moderator role the function needs: the row is held, but reads as suspended until the role is fixed.
    const read = (await as(p.hubOwner, (trx) => staffLifecycle.accountabilities(trx, w.hubId))).find((r) => r.accountability.id === accepted.accountability.id)!;
    assert.deepEqual([read.accountability.status, read.holder_ok], ['active', false]);
    const old = await accountability(trustOwner);
    assert.deepEqual([old.status, old.end_reason, old.ended_by], ['ended', 'handed_over', p.hubOwner]);
    trustOwner = accepted.accountability.id;
    const [triageOffer] = await offersOf(triage);
    const declined = await respond(p.hubOwner, triageOffer!.id, false);
    assert.deepEqual([declined.offer.status, (await accountability(triage)).status], ['declined', 'suspended']);
    await rejects(respond(p.hubOwner, triageOffer!.id, true), '23514', 'admin.invalid_transition');
  });

  await t.test('a suspended accountability resumes once the holder holds the role again; offers go to staff of the hub only', async () => {
    await rejects(as(p.admin, async (trx) => staffLifecycle.resumeAccountability(trx, await elevate(p.admin), triage)), '23514', 'admin.accountable_without_role');
    await assign({ personId: p.moderator, role: 'moderator', scope: hub });
    const resumed = await as(p.admin, async (trx) => staffLifecycle.resumeAccountability(trx, await elevate(p.admin), triage));
    assert.deepEqual([resumed.status, resumed.suspended_reason], ['active', null]);
    await rejects(as(p.admin, async (trx) => staffLifecycle.resumeAccountability(trx, await elevate(p.admin), triage)), '23514', 'admin.invalid_transition');
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.offerAccountability(trx, await elevate(p.hubOwner), trustOwner, p.customer)), '23514', 'admin.accountable_without_role');
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.offerAccountability(trx, await elevate(p.hubOwner), trustOwner, p.hubOwner)), '22023', 'admin.context_invalid');
    await rejects(as(p.lead, async (trx) => staffLifecycle.offerAccountability(trx, await elevate(p.lead), trustOwner, p.moderator)), '42501', 'admin.forbidden');
    const offer = await as(p.hubOwner, async (trx) => staffLifecycle.offerAccountability(trx, await elevate(p.hubOwner), trustOwner, p.moderator));
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.offerAccountability(trx, await elevate(p.hubOwner), trustOwner, p.moderator)), '23505', 'admin.offer_open');
    const back = await respond(p.moderator, offer.id, true);
    assert.equal(back.accountability.person_id, p.moderator);
    trustOwner = back.accountability.id;
    const ended = await as(p.hubOwner, async (trx) => staffLifecycle.endAccountability(trx, await elevate(p.hubOwner), triage));
    assert.deepEqual([ended.status, ended.end_reason], ['ended', 'ended']);
  });

  let offboarding = '';
  await t.test('offboarding starts for someone else with admin.staff.revoke, once per person, and offers every open accountability to the hub owner', async () => {
    const supportOwner = await assignAcc(p.hubOwner, { functionKey: 'support', kind: 'function_owner', personId: p.lead, requiredRole: 'support-lead' });
    await rejects(as(p.moderator, async (trx) => staffLifecycle.startOffboarding(trx, await elevate(p.moderator), p.lead, hub)), '42501', 'admin.forbidden');
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.startOffboarding(trx, await elevate(p.hubOwner), p.hubOwner, hub)), '42501', 'admin.self_offboarding');
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.startOffboarding(trx, await elevate(p.hubOwner), p.customer, hub)), 'P0002', 'admin.not_found');
    const row = await as(p.hubOwner, async (trx) => staffLifecycle.startOffboarding(trx, await elevate(p.hubOwner), p.lead, hub));
    offboarding = row.id;
    assert.deepEqual([row.status, row.started_by, row.person_id], ['open', p.hubOwner, p.lead]);
    await rejects(as(p.admin, async (trx) => staffLifecycle.startOffboarding(trx, await elevate(p.admin), p.lead, { kind: 'platform' })), '23505', 'admin.offboarding_open');
    assert.deepEqual((await offersOf(supportOwner.id)).map((o) => [o.to_person_id, o.status, o.offboarding_id]), [[p.hubOwner, 'pending', offboarding]]);
  });

  await t.test('the checklist lists what completion revokes, what blocks it and the open work with people suggested by role; it needs admin.staff.read', async () => {
    const eligible = await as(p.owner, async (trx) => staffLifecycle.grantEligible(trx, await elevate(p.owner), { personId: p.lead, role: 'moderator', scope: hub, definitionVersion: 1, maxActivationSeconds: 3600, validForSeconds: null }));
    const supportCase = await as(p.customer, (trx) => supportCases.openOwn(trx, { hubId: w.hubId, category: 'account_access', summary: 'Synthetic: cannot open my project' }));
    await as(p.lead2, async (trx) => supportCases.update(trx, await elevate(p.lead2), supportCase.id, { assignedTo: p.lead }));
    await as(p.hubOwner, async (trx) => staffLifecycle.openAccessReview(trx, await elevate(p.hubOwner), { scope: hub, title: 'Synthetic review', roles: ['support-lead'], dueInSeconds: 30 * 86_400 }));
    // A running activation of the eligible role, an accepted invitation to another role, and an admin MCP connection.
    const running = await as(p.lead, async (trx) => staffLifecycle.requestActivation(trx, await elevate(p.lead), eligible.id, 3600));
    assert.equal(running.outcome, 'active');
    const leadMail = `lead.${randomBytes(3).toString('hex')}@invite.example.invalid`;
    await owner((trx) => trx.insertInto('email_binding').values({ person_id: p.lead, email_normalized: leadMail, is_primary: false, verified_at: new Date() }).execute());
    await owner((trx) => trx.insertInto('second_factor').values({ id: crypto.randomUUID(), person_id: p.lead, kind: 'totp', state: 'active', secret_sealed: randomBytes(48), activated_at: new Date() } as never).execute());
    const invitation = await as(p.owner, async (trx) => staffLifecycle.invite(trx, await elevate(p.owner), { email: leadMail, role: 'auditor', scope: hub, definitionVersion: 1, validForSeconds: null }));
    await as(p.lead, (trx) => staffLifecycle.respond(trx, invitation.id, true));
    const connection = await owner(async (trx) => {
      const client = (await sql<{ id: string }>`INSERT INTO trustwork.oauth_client (client_id, registration, client_name, redirect_uris, application_type, token_endpoint_auth_method)
        VALUES ('synthetic-admin-mcp-client', 'dynamic_registration', 'Synthetic admin MCP client', ARRAY['https://client.example.invalid/cb'], 'web', 'none') RETURNING id`.execute(trx)).rows[0]!.id;
      const elevation = (await sql<{ id: string }>`SELECT id FROM trustwork.session_elevation WHERE person_id = ${p.lead}::uuid ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]!.id;
      const consent = (await sql<{ id: string }>`INSERT INTO trustwork.connection_consent (person_id, client_ref, client_id, redirect_uri, surface, scopes, consent_text_version, step_up, elevation_id, locale, expires_at)
        VALUES (${p.lead}::uuid, ${client}::uuid, 'synthetic-admin-mcp-client', 'https://client.example.invalid/cb', 'admin', ARRAY['admin.read'], 1, true, ${elevation}::uuid, 'en', now() + interval '30 days') RETURNING id`.execute(trx)).rows[0]!.id;
      return (await sql<{ id: string }>`INSERT INTO trustwork.connection (hub_id, person_id, surface, client_ref, client_id, resource, redirect_uri, consent_id)
        VALUES (${w.hubId}::uuid, ${p.lead}::uuid, 'admin', ${client}::uuid, 'synthetic-admin-mcp-client', 'https://trustwork.test/mcp/admin', 'https://client.example.invalid/cb', ${consent}::uuid) RETURNING id`.execute(trx)).rows[0]!.id;
    });
    await rejects(as(p.moderator, (trx) => staffLifecycle.offboardingChecklist(trx, offboarding)), 'P0002', 'admin.not_found');
    const checklist = OffboardingChecklistSchema.parse(await as(p.hubOwner, (trx) => staffLifecycle.offboardingChecklist(trx, offboarding)));
    assert.deepEqual(checklist.roles.map((r) => r.role).sort(), ['moderator', 'support-lead'], 'the activated role counts as a role to end');
    assert.deepEqual(checklist.eligibleRoles.map((e) => e.eligibleRoleId), [eligible.id]);
    assert.deepEqual(checklist.activations.map((a) => [a.activationId, a.status]), [[running.activation.id, 'active']]);
    assert.deepEqual(checklist.invitations.map((i) => [i.invitationId, i.role, i.status]), [[invitation.id, 'auditor', 'accepted']]);
    assert.deepEqual(checklist.adminClients.map((c) => [c.connectionId, c.clientId, c.status]), [[connection, 'synthetic-admin-mcp-client', 'active']]);
    assert.equal(checklist.accountabilities.length, 1);
    assert.deepEqual(checklist.accountabilities[0]!.offers.map((o) => [o.toPersonId, o.toPersonName]), [[p.hubOwner, 'Synthetic Hub Owner']]);
    assert.deepEqual(checklist.accountabilities[0]!.suggested.map((s) => s.personId), [p.hubOwner]);
    assert.deepEqual(checklist.supportCases.map((c) => [c.caseId, c.suggested.map((s) => s.personId)]), [[supportCase.id, [p.lead2]]], 'the other support lead is suggested, never the leaver');
    assert.equal(checklist.reviewItems.length, 1);
    assert.deepEqual(checklist.incidents, []);
  });

  await t.test('completion is refused while an accountability is open; after the hand-over it revokes roles, eligible roles and elevations in one transaction', async () => {
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.completeOffboarding(trx, await elevate(p.hubOwner), offboarding)), '23514', 'admin.offboarding_blocked');
    assert.deepEqual(await activeRoles(p.lead), ['moderator', 'support-lead'], 'nothing changed');
    const [offer] = await owner((trx) => trx.selectFrom('staff_accountability_offer').selectAll().where('offboarding_id', '=', offboarding).execute());
    // The blocker is cleared only by the fallback accepting, never by an administrator ending the accountability.
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.endAccountability(trx, await elevate(p.hubOwner), offer!.accountability_id)), '23514', 'admin.offboarding_open');
    await respond(p.hubOwner, offer!.id, true);
    await rejects(as(p.moderator, async (trx) => staffLifecycle.completeOffboarding(trx, await elevate(p.moderator), offboarding)), '42501', 'admin.forbidden');
    const done = await as(p.hubOwner, async (trx) => staffLifecycle.completeOffboarding(trx, await elevate(p.hubOwner), offboarding));
    assert.deepEqual([done.status, done.completed_by], ['completed', p.hubOwner]);
    assert.deepEqual(await activeRoles(p.lead), [], 'the standing role and the activated role ended');
    const eligible = await owner((trx) => trx.selectFrom('staff_eligible_role').select('revoked_at').where('person_id', '=', p.lead).execute());
    assert.ok(eligible.length === 1 && eligible[0]!.revoked_at !== null);
    assert.deepEqual(await owner((trx) => trx.selectFrom('session_elevation').select('id').where('person_id', '=', p.lead).where('revoked_at', 'is', null).execute()), []);
    assert.deepEqual((await owner((trx) => trx.selectFrom('staff_invitation').select('status').where('person_id', '=', p.lead).execute())).map((i) => i.status), ['withdrawn'], 'the accepted invitation cannot be applied any more');
    const connections = await owner((trx) => sql<{ status: string; status_reason: string | null; withdrawn_reason: string | null }>`SELECT c.status, c.status_reason, k.withdrawn_reason
      FROM trustwork.connection c JOIN trustwork.connection_consent k ON k.id = c.consent_id WHERE c.person_id = ${p.lead}::uuid`.execute(trx));
    assert.deepEqual(connections.rows, [{ status: 'revoked', status_reason: 'person_revocation', withdrawn_reason: 'person_revocation' }], 'the admin MCP connection and its consent ended');
    const sessions = await owner((trx) => trx.selectFrom('session').select(['revoked_at', 'revoked_reason']).where('person_id', '=', p.lead).execute());
    assert.ok(sessions.length > 0 && sessions.every((s) => s.revoked_at !== null && s.revoked_reason === 'admin'), 'with the last staff role gone the sessions ended');
    assert.deepEqual((await audit('staff.offboarding_completed')).map((a) => [a.actor_person_id, a.permission]), [[p.hubOwner, 'admin.staff.revoke']]);
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.completeOffboarding(trx, await elevate(p.hubOwner), offboarding)), '23514', 'admin.invalid_transition');
    // The case stays open for reassignment; the person's past actions stay attributed.
    assert.equal((await owner((trx) => trx.selectFrom('support_case').select('assigned_to').where('assigned_to', '=', p.lead).execute())).length, 1);
  });

  await t.test('a cancelled offboarding withdraws the offers it created and changes nothing else', async () => {
    const row = await as(p.hubOwner, async (trx) => staffLifecycle.startOffboarding(trx, await elevate(p.hubOwner), p.moderator, hub));
    const before = await offersOf(trustOwner);
    assert.deepEqual(before.filter((o) => o.status === 'pending').map((o) => o.offboarding_id), [row.id]);
    const cancelled = await as(p.hubOwner, async (trx) => staffLifecycle.cancelOffboarding(trx, await elevate(p.hubOwner), row.id));
    assert.deepEqual([cancelled.status, cancelled.cancelled_by], ['cancelled', p.hubOwner]);
    assert.deepEqual((await offersOf(trustOwner)).filter((o) => o.status === 'pending'), []);
    assert.deepEqual(await activeRoles(p.moderator), ['moderator']);
    assert.equal((await accountability(trustOwner)).status, 'active');
    // Nobody completes or cancels their own offboarding, even with admin.staff.revoke at the scope.
    const ofOwner = await as(p.admin, async (trx) => staffLifecycle.startOffboarding(trx, await elevate(p.admin), p.hubOwner, hub));
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.cancelOffboarding(trx, await elevate(p.hubOwner), ofOwner.id)), '42501', 'admin.self_offboarding');
    await rejects(as(p.hubOwner, async (trx) => staffLifecycle.completeOffboarding(trx, await elevate(p.hubOwner), ofOwner.id)), '42501', 'admin.self_offboarding');
    assert.equal((await as(p.admin, async (trx) => staffLifecycle.cancelOffboarding(trx, await elevate(p.admin), ofOwner.id))).status, 'cancelled');
  });

  await t.test('rows only change state and are never deleted', async () => {
    await rejects(owner((trx) => trx.updateTable('staff_accountability').set({ person_id: p.owner }).where('id', '=', trustOwner).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_accountability').where('id', '=', trustOwner).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx) => trx.updateTable('staff_offboarding').set({ status: 'open' }).where('id', '=', offboarding).execute()), '23000', 'admin.immutable');
    await rejects(owner((trx) => trx.deleteFrom('staff_offboarding').where('id', '=', offboarding).execute()), '23000', 'audit.append_only');
  });
});
