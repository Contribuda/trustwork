import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withPrincipal } from '@trustwork/data';
import { approvals, caseGrants, adminDigests } from '../../packages/data/src/repositories/admin.js';
import { Client, SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { untilDatabaseTimePasses } from '../data/helpers/postgres.js';
import { auditRows, buildHttpWorld, command, companyCase, customerCase, expectRefusal, type AdminWorldHttp } from './helpers.js';

const h = await startHarness('admin_api');

type Body = Record<string, unknown>;
const body = (r: { body: unknown }) => r.body as Body;
const id = (r: { body: unknown }, key: string) => (body(r)[key] as { id: string }).id;

/**
 * ADM-001 on real PostgreSQL under the runtime role, through the HTTP API with real sessions, TOTP enrolment and
 * elevated sessions: every staff route needs a staff role covering the hub this API serves and a live elevation;
 * every command is re-authorized by the DATA-002 database commands at its scope; second-person actions bind an exact
 * digest; refusals of authority leave `denied` audit rows; the moderation facade reaches other modules through ports.
 */
test('platform administration API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  const c = w.clients;
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.world.hubId } as const;
  const otherHub = { kind: 'hub', hubId: w.world.otherHubId } as const;

  await t.test('negative: anonymous, non-staff, other-hub staff and unelevated staff never reach a staff route', async () => {
    expectRefusal(await new Client(w.app).get('/v1/admin/staff/definitions'), 401, 'auth.session_invalid');
    expectRefusal(await c.customer.get('/v1/admin/staff/definitions'), 403, 'access.forbidden', 'staff');
    expectRefusal(await command(c.customer, '/v1/admin/flags', { scope: hub, key: 'ui.dense_tables', value: true, description: 'Synthetic', declaredEffect: 'ui', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), 403, 'access.forbidden', 'staff');
    // A support agent of another hub on the same node holds no role here (wrong scope).
    expectRefusal(await c.otherAgent.get('/v1/admin/staff/definitions'), 403, 'access.forbidden', 'staff');
    expectRefusal(await c.otherAgent.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: '000000' } }, { idempotencyKey: null }), 403, 'access.forbidden', 'staff');
    // Staff without an elevated session.
    expectRefusal(await c.moderator.get('/v1/admin/moderation/cases?hubId=' + w.world.hubId), 403, 'access.forbidden', 'elevation');
    expectRefusal(await command(c.owner, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'editor', scope: hub, definitionVersion: 1 }), 403, 'access.forbidden', 'elevation');
    // Participant moderation routes need no staff role.
    assert.equal((await c.customer.get('/v1/moderation/me')).status, 200);
  });

  await w.elevateAll();

  await t.test('negative: an expired elevation is refused again', async () => {
    assert.equal((await c.auditor.get('/v1/admin/staff/definitions')).status, 200);
    h.clock.advance(16 * 60_000);
    expectRefusal(await c.auditor.get('/v1/admin/staff/definitions'), 403, 'access.forbidden', 'elevation');
    await w.elevateAll();
    assert.equal((await c.auditor.get('/v1/admin/staff/definitions')).status, 200);
  });

  await t.test('materialised grants and separation-of-duties mode per scope', async () => {
    const moderator = body(await c.moderator.get(`/v1/admin/access?hubId=${w.world.hubId}`));
    assert.deepEqual(moderator.roles, ['moderator']);
    assert.ok((moderator.permissions as string[]).includes('admin.moderation.decide'));
    assert.ok(!(moderator.permissions as string[]).includes('admin.staff.assign'));
    assert.deepEqual(body(await c.moderator.get(`/v1/admin/access?hubId=${w.world.otherHubId}`)).roles, [], 'a hub role grants nothing in another hub');
    const owner = body(await c.owner.get('/v1/admin/access'));
    assert.deepEqual(owner.roles, ['platform-owner']);
    const full = body(await c.owner.get(`/v1/admin/staff/sod?hubId=${w.world.hubId}`));
    assert.equal(full.mode, 'full');
    assert.equal(full.staffCount, 10);
    const reduced = body(await c.owner.get(`/v1/admin/staff/sod?hubId=${w.world.otherHubId}`));
    assert.equal(reduced.mode, 'reduced', JSON.stringify(reduced));
    assert.equal(reduced.staffCount, 4, 'owner, admin, admin2 and the other hub agent');
    expectRefusal(await c.moderator.get(`/v1/admin/staff/sod?hubId=${w.world.hubId}`), 403, 'access.forbidden', 'permission');
  });

  let editorAssignment = '';
  await t.test('staff assignment: positive, self-grant, missing permission, wrong scope, sensitive without approval', async () => {
    const moderatorRole = await command(c.admin, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'moderator', scope: hub, definitionVersion: 1, reasonCode: 'staffing' });
    assert.equal(moderatorRole.status, 201, JSON.stringify(moderatorRole.body));
    editorAssignment = id(moderatorRole, 'assignment');
    assert.equal((body(moderatorRole).assignment as Body).grantedBy, p.admin);
    const applied = await auditRows(h, "object_id = $1 AND outcome = 'applied'", [editorAssignment]);
    assert.deepEqual(applied.map((r) => r.action), ['staff.assign_role']);
    assert.equal(applied[0]?.reason_code, 'staffing');

    expectRefusal(await command(c.admin, '/v1/admin/staff/assignments', { personId: p.admin, role: 'moderator', scope: hub, definitionVersion: 1 }), 403, 'access.forbidden', 'self_grant');
    expectRefusal(await command(c.moderator, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'support-agent', scope: hub, definitionVersion: 1 }), 403, 'access.forbidden', 'forbidden');
    // The hub owner may assign in their hub, never in another hub of the node.
    expectRefusal(await command(c.hubOwner, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'support-agent', scope: otherHub, definitionVersion: 1 }), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await command(c.admin, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'hub-owner', scope: hub, definitionVersion: 1 }), 403, 'access.approval_required', 'approval_required');
    const denied = await auditRows(h, "outcome = 'denied' AND actor_person_id = ANY($1::uuid[])", [[p.admin, p.moderator, p.hubOwner]]);
    assert.ok(denied.length >= 3, `denied attempts are audited: ${JSON.stringify(denied)}`);
    assert.ok(denied.some((r) => r.actor_person_id === p.moderator && r.reason_code === 'denied_forbidden'));
  });

  await t.test('idempotency: a replay returns the stored response; a body key different from the header is refused', async () => {
    const key = `adm-replay-${randomUUID()}`;
    const payload = { personId: p.candidate, role: 'support-agent', scope: hub, definitionVersion: 1 };
    const first = await command(c.admin, '/v1/admin/staff/assignments', payload, { key });
    const second = await command(c.admin, '/v1/admin/staff/assignments', payload, { key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(second.body, first.body);
    const { rows } = await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.staff_role_assignment WHERE person_id = $1 AND role = 'support-agent'", [p.candidate]);
    assert.equal(rows[0].n, 1);
    const mismatch = await c.admin.post('/v1/admin/staff/assignments', { contractVersion: '1.0.0', idempotencyKey: 'body-key', reason: 'Synthetic', ...payload }, { idempotencyKey: 'header-key' });
    expectRefusal(mismatch, 422, 'validation.schema', 'idempotency_key_mismatch');
  });

  await t.test('second-person approval bound to the action digest (sensitive role)', async () => {
    const subject = { action: 'staff.assign_sensitive_role', personId: p.candidate, role: 'hub-owner', scope: hub, definitionVersion: 1 };
    const requested = await command(c.owner, '/v1/admin/approvals', { subject });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const approval = body(requested).approval as Body;
    const digest = approval.actionDigest as string;
    assert.equal(digest, adminDigests.assignment({ breakglass: false, personId: p.candidate, role: 'hub-owner', scope: hub, definitionVersion: 1 }), 'the server computed the digest of the described action');

    expectRefusal(await command(c.owner, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: digest }), 403, 'access.second_approver_required', 'self_approval');
    expectRefusal(await command(c.moderator, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: digest }), 404, 'access.not_found');
    expectRefusal(await command(c.admin, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: 'f'.repeat(64) }), 409, 'access.approval_digest_mismatch');
    const forAdmin = body(await c.admin.get('/v1/admin/approvals'));
    assert.ok((forAdmin.forMe as Body[]).some((a) => a.id === approval.id), 'the request waits for a second person');
    const approved = await command(c.admin, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: digest });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(body(approved).sod, { verified: true, mode: 'full', staffCount: 11 });

    // The approval authorizes exactly the reviewed assignment, only for its requester, once.
    expectRefusal(await command(c.owner, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'compliance-officer', scope: hub, definitionVersion: 1, approvalId: approval.id }), 409, 'access.approval_digest_mismatch');
    expectRefusal(await command(c.admin, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'hub-owner', scope: hub, definitionVersion: 1, approvalId: approval.id }), 403, 'access.approval_required', 'not_requester');
    const executed = await command(c.owner, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'hub-owner', scope: hub, definitionVersion: 1, approvalId: approval.id });
    assert.equal(executed.status, 201, JSON.stringify(executed.body));
    assert.equal((body(executed).assignment as Body).approvedBy, p.admin);
    expectRefusal(await command(c.owner, '/v1/admin/staff/assignments', { personId: p.candidate, role: 'hub-owner', scope: hub, definitionVersion: 1, approvalId: approval.id }), 403, 'access.approval_required', 'approval_consumed');
    const recorded = await auditRows(h, "action = 'staff.assign_sensitive_role' AND outcome = 'applied' AND actor_person_id = $1", [p.owner]);
    assert.ok(recorded.some((r) => r.second_approver_person_id === p.admin), 'the audit names the second approver');
  });

  await t.test('separation of duties: full mode needs a different role, reduced mode only a different person', async () => {
    const ask = async (scope: typeof hub | typeof otherHub) => {
      const r = await command(c.admin, '/v1/admin/approvals', { subject: { action: 'staff.assign_sensitive_role', personId: p.employee, role: 'staff-admin', scope, definitionVersion: 1 } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return body(r).approval as Body;
    };
    const inHub = await ask(hub);
    expectRefusal(await command(c.admin2, `/v1/admin/approvals/${inHub.id}/approve`, { actionDigest: inHub.actionDigest }), 403, 'access.second_approver_required', 'same_role');
    const byOwner = await command(c.owner, `/v1/admin/approvals/${inHub.id}/approve`, { actionDigest: inHub.actionDigest });
    assert.equal(byOwner.status, 200, 'a platform owner is a different role');
    const inOther = await ask(otherHub);
    const sameRole = await command(c.admin2, `/v1/admin/approvals/${inOther.id}/approve`, { actionDigest: inOther.actionDigest });
    assert.equal(sameRole.status, 200, JSON.stringify(sameRole.body));
    assert.equal((body(sameRole).sod as Body).mode, 'reduced');
    // Withdraw and decline are recorded too.
    const third = await ask(hub);
    assert.equal((await command(c.admin, `/v1/admin/approvals/${third.id}/withdraw`)).status, 200);
    assert.equal((await auditRows(h, "action = 'approval.withdrawn' AND object_id = $1", [third.id])).length, 1);
    const fourth = await ask(hub);
    const declined = await command(c.owner, `/v1/admin/approvals/${fourth.id}/decline`, { reason: 'Synthetic: not needed' });
    assert.equal((body(declined).approval as Body).status, 'declined');
  });

  await t.test('an expired approval no longer authorizes the action', async () => {
    const digest = adminDigests.assignment({ breakglass: false, personId: p.outsider, role: 'privacy-officer', scope: hub, definitionVersion: 1 });
    const ownerCtx = await w.actors.elevate(p.owner);
    const adminCtx = await w.actors.elevate(p.admin);
    const req = await w.actors.as(p.owner, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: hub, actionDigest: digest }));
    const decided = await w.actors.as(p.admin, (trx) => approvals.decide(trx, adminCtx, req.id, 'approve', digest, 1));
    await untilDatabaseTimePasses(h.db.admin, decided.expires_at as Date);
    expectRefusal(await command(c.owner, '/v1/admin/staff/assignments', { personId: p.outsider, role: 'privacy-officer', scope: hub, definitionVersion: 1, approvalId: req.id }), 403, 'access.approval_required', 'approval_expired');
  });

  await t.test('break-glass: an open incident, a second person, at most 12 hours', async () => {
    const incident = await command(c.ops, '/v1/admin/incidents', { scope: hub, kind: 'security', severity: 'sev2', title: 'Synthetic incident' });
    assert.equal(incident.status, 201, JSON.stringify(incident.body));
    const incidentId = id(incident, 'incident');
    const subject = { action: 'staff.grant_breakglass', personId: p.lead2, role: 'moderator', scope: hub, definitionVersion: 1, incidentId, validForSeconds: 7200 };
    expectRefusal(await command(c.owner, '/v1/admin/approvals', { subject: { ...subject, validForSeconds: 13 * 3600 } }), 422, 'validation.schema');
    const requested = body(await command(c.owner, '/v1/admin/approvals', { subject })).approval as Body;
    assert.equal((await command(c.admin, `/v1/admin/approvals/${requested.id}/approve`, { actionDigest: requested.actionDigest })).status, 200);
    const granted = await command(c.owner, '/v1/admin/staff/breakglass', { personId: p.lead2, role: 'moderator', scope: hub, definitionVersion: 1, incidentId, validForSeconds: 7200, approvalId: requested.id });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    const a = body(granted).assignment as Body;
    assert.equal(a.breakglass, true);
    assert.ok(Date.parse(a.validUntil as string) - Date.parse(a.validFrom as string) <= 12 * 3600_000);
    const revoked = await command(c.admin, `/v1/admin/staff/assignments/${a.id}/revoke`);
    assert.equal((body(revoked).assignment as Body).revokedBy, p.admin);
  });

  await t.test('case access grants: scoped, second person, digest, expiry, revocation, conflicts; no impersonation', async () => {
    const supportCaseId = await customerCase(w);
    const request = { supportCaseId, objectType: 'person', objectIds: [p.customer], projectionClass: 'diagnostic', purpose: 'Synthetic: diagnose sign-in', expiresInSeconds: 3600 };
    const requested = await command(c.agent, '/v1/admin/case-grants', request);
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const grant = body(requested).grant as Body;
    assert.equal(grant.status, 'requested');
    assert.deepEqual(grant.excludedFieldClasses, ['credentials', 'negotiation_private', 'payment_refs']);
    expectRefusal(await command(c.agent, `/v1/admin/case-grants/${grant.id}/decide`, { decision: 'approve', requestDigest: grant.requestDigest }), 403, 'access.second_approver_required', 'self_approval');
    expectRefusal(await command(c.moderator, `/v1/admin/case-grants/${grant.id}/decide`, { decision: 'approve', requestDigest: grant.requestDigest }), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await command(c.lead, `/v1/admin/case-grants/${grant.id}/decide`, { decision: 'approve', requestDigest: '0'.repeat(64) }), 409, 'access.approval_digest_mismatch');
    const approved = await command(c.lead, `/v1/admin/case-grants/${grant.id}/decide`, { decision: 'approve', requestDigest: grant.requestDigest });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((body(approved).grant as Body).active, true);
    const coverage = (client: Client) => client.get(`/v1/admin/case-grants/coverage?objectType=person&objectId=${p.customer}`);
    assert.equal(body(await coverage(c.agent)).covered, true);
    assert.equal(body(await coverage(c.lead)).covered, false, 'only the grantee reads under the grant');
    // A grant is a read right, never a session: the grantee is still themselves.
    assert.equal(((body(await c.agent.get('/v1/me')).principal as Body).personId), p.agent);
    // Revocation ends coverage.
    assert.equal((await command(c.agent, `/v1/admin/case-grants/${grant.id}/revoke`)).status, 200);
    assert.equal(body(await coverage(c.agent)).covered, false);

    // Expiry: a one-second grant (repository path; the API asks for at least a minute) is inactive once it passed.
    const agentCtx = await w.actors.elevate(p.agent);
    const leadCtx = await w.actors.elevate(p.lead);
    const short = await w.actors.as(p.agent, (trx) => caseGrants.request(trx, agentCtx, { supportCaseId, objectType: 'person', objectIds: [p.customer], projectionClass: 'diagnostic', purpose: 'Synthetic: short', expiresInSeconds: 1 }));
    const live = await w.actors.as(p.lead, (trx) => caseGrants.decide(trx, leadCtx, short.id, 'approve', short.request_digest));
    await untilDatabaseTimePasses(h.db.admin, live.expires_at as Date);
    assert.equal(body(await coverage(c.agent)).covered, false, 'an expired grant covers nothing');
    assert.equal((body(await c.agent.get(`/v1/admin/case-grants/${short.id}`)).grant as Body).active, false);
    const logged = await withPrincipal(h.pool, await w.actors.principal(p.agent), (trx) => caseGrants.logAccess(trx, { actorPersonId: p.agent, grantId: short.id, caseId: supportCaseId, hubId: w.world.hubId, kind: 'case_read', objectType: 'person', objectId: p.customer, fieldsHash: 'a'.repeat(64) }).then(() => true, () => false));
    assert.equal(logged, false, 'no read can be logged under an expired grant');

    // Conflict of interest: the agent is a member of the company the case is about.
    const companyCaseId = await companyCase(w);
    expectRefusal(await command(c.agent, '/v1/admin/case-grants', { ...request, supportCaseId: companyCaseId, objectType: 'company', objectIds: [w.world.company] }), 403, 'access.forbidden', 'conflict_of_interest');
    assert.equal((body(await c.lead.get(`/v1/admin/support-cases/${supportCaseId}/case-grants`)).grants as Body[]).length, 2);
  });

  let caseId = '';
  let level2 = '';
  let level4 = '';
  await t.test('moderation: reports, cases, decisions through the content port, the sanction ladder', async () => {
    const reported = await c.customer.post('/v1/moderation/reports', { hubId: w.world.hubId, targetKind: 'publication', targetId: randomUUID(), clauseCode: 'community.spam', text: 'Synthetic report' });
    assert.equal(reported.status, 201, JSON.stringify(reported.body));
    const reportId = id(reported, 'report');
    expectRefusal(await c.customer.get(`/v1/admin/moderation/reports?hubId=${w.world.hubId}`), 403, 'access.forbidden', 'staff');
    const reports = body(await c.moderator.get(`/v1/admin/moderation/reports?hubId=${w.world.hubId}`)).reports as Body[];
    const report = reports.find((r) => r.id === reportId) as Body;
    assert.ok(report && !('reporterPersonId' in report), 'staff see the report, not the reporter');

    const opened = await command(c.moderator, '/v1/admin/moderation/cases', { hubId: w.world.hubId, targetKind: 'publication', targetId: report.targetId, subject: { kind: 'person', id: p.outsider }, reportIds: [reportId], clauseCodes: ['community.spam'] });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const removal = id(opened, 'case');
    const removed = await command(c.moderator, `/v1/admin/moderation/cases/${removal}/decide`, { decision: 'content_removed' });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.ok(w.moderationTargets.calls.some((e) => e.moderationCaseId === removal && e.effect === 'remove'), 'the content owner applies the removal');

    const second = await command(c.moderator, '/v1/admin/moderation/cases', { hubId: w.world.hubId, targetKind: 'profile', targetId: p.outsider, subject: { kind: 'person', id: p.outsider }, clauseCodes: ['community.harassment'] });
    caseId = id(second, 'case');
    assert.equal((await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/decide`, { decision: 'sanction' })).status, 200);
    const l2 = await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 2, featureScope: 'posting', durationSeconds: 7 * 86_400 });
    assert.equal(l2.status, 201, JSON.stringify(l2.body));
    level2 = id(l2, 'sanction');
    expectRefusal(await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 3, featureScope: 'messaging', durationSeconds: 30 * 86_400 }), 403, 'access.forbidden', 'sanction_level_not_allowed');
    expectRefusal(await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 1, featureScope: 'posting', durationSeconds: 30 * 86_400 }), 422, 'validation.schema');
    assert.ok(w.sanctions.calls.some((s) => s.sanctionId === level2 && s.change === 'applied'));
  });

  await t.test('a level 4 sanction needs a second person (A+2), bound to exactly that sanction', async () => {
    expectRefusal(await command(c.hubOwner, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 4, featureScope: 'account', durationSeconds: null }), 403, 'access.approval_required', 'approval_required');
    assert.ok((await auditRows(h, "action = 'moderation.apply_sanction_l4' AND outcome = 'denied' AND actor_person_id = $1", [p.hubOwner])).length >= 1, 'the refused attempt is audited');
    const requested = body(await command(c.hubOwner, '/v1/admin/approvals', { subject: { action: 'moderation.apply_sanction_l4', moderationCaseId: caseId, featureScope: 'account', durationSeconds: null } })).approval as Body;
    expectRefusal(await command(c.hubOwner, `/v1/admin/approvals/${requested.id}/approve`, { actionDigest: requested.actionDigest }), 403, 'access.second_approver_required', 'self_approval');
    const approved = await command(c.moderator, `/v1/admin/approvals/${requested.id}/approve`, { actionDigest: requested.actionDigest });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((body(approved).sod as Body).verified, false, 'the moderator cannot read the staff directory: only the database rules apply');
    expectRefusal(await command(c.hubOwner, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 4, featureScope: 'marketplace', durationSeconds: null, approvalId: requested.id }), 409, 'access.approval_digest_mismatch');
    expectRefusal(await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 4, featureScope: 'account', durationSeconds: null, approvalId: requested.id }), 403, 'access.forbidden', 'sanction_level_not_allowed');
    const applied = await command(c.hubOwner, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 4, featureScope: 'account', durationSeconds: null, approvalId: requested.id });
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const sanction = body(applied).sanction as Body;
    level4 = sanction.id as string;
    assert.equal(sanction.secondApprovalId, requested.id);
    const audit = await auditRows(h, "action = 'moderation.apply_sanction_l4' AND outcome = 'applied' AND object_id = $1", [level4]);
    assert.equal(audit[0]?.second_approver_person_id, p.moderator);
  });

  await t.test('appeals: the subject appeals, a different person decides, overturning lifts the sanction', async () => {
    const mine = body(await c.outsider.get('/v1/moderation/me'));
    const sanctions = mine.sanctions as Body[];
    assert.ok(sanctions.some((s) => s.id === level2) && sanctions.every((s) => !('decidedBy' in s)), 'the subject sees their sanctions without staff identities');
    expectRefusal(await c.customer.post('/v1/moderation/appeals', { subjectKind: 'sanction', subjectId: level2, reason: 'Synthetic: not me' }), 404, 'access.not_found');
    const appeal2 = await c.outsider.post('/v1/moderation/appeals', { subjectKind: 'sanction', subjectId: level2, reason: 'Synthetic: misunderstanding' });
    assert.equal(appeal2.status, 201, JSON.stringify(appeal2.body));
    const appeal4 = await c.outsider.post('/v1/moderation/appeals', { subjectKind: 'sanction', subjectId: level4, reason: 'Synthetic: too harsh' });
    assert.equal(appeal4.status, 201);
    expectRefusal(await command(c.moderator, `/v1/admin/moderation/appeals/${id(appeal2, 'appeal')}/decide`, { decision: 'overturned' }), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await command(c.hubOwner, `/v1/admin/moderation/appeals/${id(appeal4, 'appeal')}/decide`, { decision: 'overturned' }), 403, 'access.second_approver_required', 'same_decider');
    const overturned = await command(c.hubOwner, `/v1/admin/moderation/appeals/${id(appeal2, 'appeal')}/decide`, { decision: 'overturned' });
    assert.equal(overturned.status, 200, JSON.stringify(overturned.body));
    assert.ok(w.sanctions.calls.some((s) => s.sanctionId === level2 && s.change === 'lifted'));
    const upheld = await command(c.owner, `/v1/admin/moderation/appeals/${id(appeal4, 'appeal')}/decide`, { decision: 'upheld' });
    assert.equal(upheld.status, 200, JSON.stringify(upheld.body));
    const detail = body(await c.hubOwner.get(`/v1/admin/moderation/cases/${caseId}`));
    assert.equal((detail.sanctions as Body[]).find((s) => s.id === level2)?.liftedAt !== null, true);
    assert.equal((detail.appeals as Body[]).length, 2);
  });

  await t.test('feature flags never control ranking or access', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const flag = { scope: hub, key: 'editorial.magazine_layout', value: 'two_columns', description: 'Synthetic layout toggle', declaredEffect: 'ui', expiresAt };
    const set = await command(c.owner, '/v1/admin/flags', flag);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    expectRefusal(await command(c.owner, '/v1/admin/flags', { ...flag, key: 'search.ranking_weight' }), 422, 'validation.schema');
    expectRefusal(await command(c.owner, '/v1/admin/flags', { ...flag, key: 'directory.top_badge' }), 422, 'validation.schema');
    expectRefusal(await command(c.owner, '/v1/admin/flags', { ...flag, value: 'boost_verified' }), 422, 'validation.schema');
    expectRefusal(await command(c.owner, '/v1/admin/flags', { ...flag, key: 'directory.access_level' }), 422, 'validation.schema');
    expectRefusal(await command(c.owner, '/v1/admin/flags', { ...flag, score: 10 }), 422, 'validation.unknown_field');
    expectRefusal(await command(c.moderator, '/v1/admin/flags', flag), 403, 'access.forbidden', 'forbidden');
    const listed = body(await c.moderator.get(`/v1/admin/flags?hubId=${w.world.hubId}`)).flags as Body[];
    assert.deepEqual(listed.map((f) => f.key), ['editorial.magazine_layout']);
  });

  await t.test('audit queries: scope-filtered reads, denied attempts, gap-free sequence', async () => {
    const all = body(await c.auditor.get(`/v1/admin/audit?hubId=${w.world.hubId}&limit=500`));
    const events = all.events as Body[];
    assert.ok(events.some((e) => e.outcome === 'denied'), 'denied attempts are visible to the auditor');
    assert.ok(events.every((e, i) => i === 0 || (e.sequence as number) > (events[i - 1]?.sequence as number)));
    const own = body(await c.moderator.get('/v1/admin/audit?limit=500')).events as Body[];
    assert.ok(own.length > 0 && own.every((e) => e.actorPersonId === p.moderator), 'without admin.audit.read a person sees their own actions only');
    const page = body(await c.auditor.get('/v1/admin/audit?limit=2'));
    assert.equal((page.events as Body[]).length, 2);
    const next = body(await c.auditor.get(`/v1/admin/audit?limit=2&afterSequence=${page.nextAfterSequence}`));
    assert.ok(((next.events as Body[])[0]?.sequence as number) > Number(page.nextAfterSequence));
    const continuity = body(await c.owner.get('/v1/admin/audit/continuity'));
    assert.equal(continuity.gapFree, true, JSON.stringify(continuity));
    assert.equal(continuity.firstSequence, 1);
    assert.equal(continuity.count, continuity.lastSequence);
    expectRefusal(await c.moderator.get('/v1/admin/audit/continuity'), 403, 'access.forbidden', 'permission');
    expectRefusal(await c.hubOwner.get('/v1/admin/audit/continuity'), 403, 'access.forbidden', 'permission');
    expectRefusal(await c.auditor.get('/v1/admin/audit/continuity'), 403, 'access.forbidden', 'permission');
  });

  await t.test('staff notices leave through the outbox', async () => {
    const { rows } = await h.db.admin.query<{ type: string }>("SELECT DISTINCT type FROM trustwork.outbox_event WHERE type LIKE 'admin.%' OR type LIKE 'moderation.%' ORDER BY type");
    const types = rows.map((r) => r.type);
    for (const expected of ['admin.approval_decided', 'admin.approval_requested', 'admin.breakglass_granted', 'admin.case_grant_decided', 'admin.staff_role_assigned', 'moderation.appeal_decided', 'moderation.sanction_applied']) {
      assert.ok(types.includes(expected), `${expected} in ${types.join(', ')}`);
    }
  });
});
