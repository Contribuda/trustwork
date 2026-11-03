import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import type pg from 'pg';
import type { Client, Harness, Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { actors, buildAdminWorld } from '../data/admin/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from './helpers.js';
import { supportCases } from '../../packages/data/src/repositories/admin.js';

interface Route { action: string; client: Client; url: string; body?: unknown; effects: () => Promise<number> }
type ExactlyOnce = (route: Route) => Promise<Response>;

const count = async (admin: pg.Pool, query: string, params: unknown[] = []): Promise<number> => (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/**
 * BE-005 crash sequence for every ADM-001 in-transaction route, called from tests/backend/idempotency/crash.test.ts
 * (whose harness injects staff roles for the route guard; the database authorizes from staff_role_assignment, which
 * DATA-002's founding administrators fill here). `exactlyOnce` posts the same body with the key `crash-<action>`, so
 * each console command carries that key in its body too. Effects are counted in the administration tables.
 */
/** Returns the administration world and its actors, so a later subtest can assign staff through the second-person path. */
export async function crashAdminRoutes(h: Harness, exactlyOnce: ExactlyOnce): Promise<{ world: Awaited<ReturnType<typeof buildAdminWorld>>; actors: ReturnType<typeof actors> }> {
  const admin = h.db.admin;
  const flagExpiry = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const world = await buildAdminWorld(admin);
  const p = world.people;
  const a = actors(admin, h.pool, world);
  const hub = { kind: 'hub', hubId: world.hubId } as const;
  await a.assignSensitive({ personId: p.hubOwner, role: 'hub-owner', scope: hub });
  await a.assign({ personId: p.moderator, role: 'moderator', scope: hub });
  await a.assign({ personId: p.lead, role: 'support-lead', scope: hub });
  await a.assign({ personId: p.agent, role: 'support-agent', scope: hub });
  const staff: Record<string, string[]> = { owner: ['platform-owner'], admin: ['staff-admin'], hubOwner: ['hub-owner'], moderator: ['moderator'], lead: ['support-lead'], agent: ['support-agent'] };
  const keys = [...Object.keys(staff), 'customer', 'outsider', 'employee'] as Array<keyof typeof p>;
  await addLogins(h, keys.map((k) => [p[k], `crash-admin-${String(k).toLowerCase()}@example.invalid`]));
  for (const [key, roles] of Object.entries(staff)) h.staff.set(p[key as keyof typeof p], roles);
  const clients = {} as Record<string, Client>;
  const secrets: Record<string, Buffer> = {};
  for (const key of keys) {
    const client = h.client();
    await signIn(client, `crash-admin-${String(key).toLowerCase()}@example.invalid`);
    // ADM-004: the employee accepts a staff invitation below, which needs a second factor.
    if (staff[key] || key === 'employee') secrets[key] = await enrolNow(h, client);
    clients[key] = client;
  }
  h.clock.advance(30_000);
  for (const key of Object.keys(staff)) {
    const r = await (clients[key] as Client).post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key] as Buffer) } }, { idempotencyKey: null });
    assert.equal(r.status, 200, `elevate ${key}: ${JSON.stringify(r.body)}`);
  }
  const c = clients as Record<'owner' | 'admin' | 'hubOwner' | 'moderator' | 'lead' | 'agent' | 'customer' | 'outsider' | 'employee', Client>;
  const cmd = (action: string, rest: Record<string, unknown> = {}) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
  const plain = async (client: Client, url: string, rest: Record<string, unknown>) => {
    const key = `plain-${randomUUID()}`;
    const r = await client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic setup', ...rest }, { idempotencyKey: key });
    assert.ok(r.status >= 200 && r.status < 300, `${url}: ${JSON.stringify(r.body)}`);
    return r.body as Record<string, Record<string, string>>;
  };
  const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>, participant = false) =>
    exactlyOnce({ action, client, url, body: participant ? rest : cmd(action, rest), effects });

  // Incidents and staff.
  const incident = (await run('admin.incident.open', c.owner, '/v1/admin/incidents', { scope: hub, kind: 'availability', severity: 'sev3', title: 'Synthetic crash incident' },
    () => count(admin, 'SELECT 1 FROM trustwork.incident'))).body as { incident: { id: string } };
  const assigned = (await run('admin.staff.assign', c.owner, '/v1/admin/staff/assignments', { personId: p.employee, role: 'support-agent', scope: hub, definitionVersion: 1 },
    () => count(admin, 'SELECT 1 FROM trustwork.staff_role_assignment WHERE person_id = $1', [p.employee]))).body as { assignment: { id: string } };
  await run('admin.staff.revoke', c.admin, `/v1/admin/staff/assignments/${assigned.assignment.id}/revoke`, {},
    () => count(admin, 'SELECT 1 FROM trustwork.staff_role_assignment WHERE revoked_at IS NOT NULL'));
  const conflict = (await run('admin.staff.conflict_declare', c.owner, '/v1/admin/staff/conflicts', { party: { kind: 'person', id: p.outsider } },
    () => count(admin, 'SELECT 1 FROM trustwork.staff_conflict_declaration'))).body as { conflict: { id: string } };
  await run('admin.staff.conflict_end', c.owner, `/v1/admin/staff/conflicts/${conflict.conflict.id}/end`, {},
    () => count(admin, 'SELECT 1 FROM trustwork.staff_conflict_declaration WHERE ended_at IS NOT NULL'));

  // ADM-004 staff invitations: invite, the invitee accepts, the inviter applies; another one is withdrawn.
  const invitations = (status: string) => () => count(admin, 'SELECT 1 FROM trustwork.staff_invitation WHERE status = $1', [status]);
  const invited = (await run('admin.staff.invite', c.owner, '/v1/admin/staff/invitations',
    { email: 'crash-admin-employee@example.invalid', role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: null }, invitations('pending'))).body as { invitation: { id: string } };
  await run('admin.staff.invitation_respond', c.employee, `/v1/me/staff-invitations/${invited.invitation.id}/respond`, { accept: true }, invitations('accepted'), true);
  await run('admin.staff.invitation_apply', c.owner, `/v1/admin/staff/invitations/${invited.invitation.id}/apply`, {}, invitations('applied'));
  const toCancel = (await plain(c.owner, '/v1/admin/staff/invitations', { email: 'crash-admin-outsider@example.invalid', role: 'moderator', scope: hub, definitionVersion: 1, validForSeconds: null })).invitation as { id: string };
  await run('admin.staff.invitation_withdraw', c.admin, `/v1/admin/staff/invitations/${toCancel.id}/withdraw`, {}, invitations('withdrawn'));

  // ADM-004 eligible roles: granted, activated with a fresh second factor (a non-sensitive role at once, a sensitive one
  // after a second person decides), ended early, revoked; and a previewed role change applied.
  let freshened = 0;
  const freshen = async (key: 'lead' | 'moderator') => {
    h.clock.advance(90_000 * ++freshened); // exactlyOnce resets the clock; move past every step an earlier elevation used
    assert.equal((await c[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    const r = await c[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key] as Buffer) } }, { idempotencyKey: null });
    assert.equal(r.status, 200, `re-elevate ${key}: ${JSON.stringify(r.body)}`);
  };
  const eligible = (await run('admin.staff.eligible_grant', c.owner, '/v1/admin/staff/eligible-roles', { personId: p.lead, role: 'moderator', scope: hub, definitionVersion: 1, maxActivationSeconds: 14_400, validForSeconds: null },
    () => count(admin, 'SELECT 1 FROM trustwork.staff_eligible_role'))).body as { eligibleRole: { id: string } };
  await freshen('lead');
  const activated = (await run('admin.staff.activation_request', c.lead, '/v1/admin/staff/activations', { eligibleRoleId: eligible.eligibleRole.id, windowSeconds: 3600 },
    () => count(admin, "SELECT 1 FROM trustwork.staff_activation WHERE status = 'active'"))).body as { activation: { id: string } };
  await run('admin.staff.activation_end', c.lead, `/v1/admin/staff/activations/${activated.activation.id}/end`, {},
    () => count(admin, 'SELECT 1 FROM trustwork.staff_activation a JOIN trustwork.staff_role_assignment s ON s.id = a.assignment_id WHERE s.revoked_at IS NOT NULL'));
  const sensitive = (await plain(c.owner, '/v1/admin/staff/eligible-roles', { personId: p.moderator, role: 'hub-owner', scope: hub, definitionVersion: 1, maxActivationSeconds: 7200, validForSeconds: null })).eligibleRole as { id: string };
  await freshen('moderator');
  const pending = (await plain(c.moderator, '/v1/admin/staff/activations', { eligibleRoleId: sensitive.id, windowSeconds: 3600 })).activation as { id: string };
  await run('admin.staff.activation_decide', c.admin, `/v1/admin/staff/activations/${pending.id}/decide`, { decision: 'approve' },
    () => count(admin, "SELECT 1 FROM trustwork.staff_activation WHERE status = 'active' AND sensitive"));
  await run('admin.staff.eligible_revoke', c.admin, `/v1/admin/staff/eligible-roles/${sensitive.id}/revoke`, {},
    () => count(admin, 'SELECT 1 FROM trustwork.staff_eligible_role WHERE revoked_at IS NOT NULL'));
  const roleChange = { personId: p.agent, scope: hub, add: [{ role: 'auditor', definitionVersion: 1, validForSeconds: null }], remove: [] };
  const previewed = await c.hubOwner.post('/v1/admin/staff/role-changes/preview', roleChange, { idempotencyKey: null });
  assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
  await run('admin.staff.role_change_apply', c.hubOwner, '/v1/admin/staff/role-changes/apply', { ...roleChange, previewDigest: (previewed.body as { preview: { previewDigest: string } }).preview.previewDigest, approvals: [] },
    () => count(admin, "SELECT 1 FROM trustwork.staff_role_assignment WHERE person_id = $1 AND role = 'auditor'", [p.agent]));

  // ADM-004 access reviews: a campaign over the hub's standing roles, one item kept, another campaign withdrawn.
  const review = (await run('admin.staff.access_review_open', c.admin, '/v1/admin/staff/access-reviews', { scope: hub, title: 'Synthetic crash review', roles: null, dueInSeconds: 30 * 86_400 },
    () => count(admin, 'SELECT 1 FROM trustwork.staff_access_review_campaign'))).body as { campaign: { id: string }; items: Array<{ id: string; holderPersonId: string }> };
  const reviewed = review.items.find((i) => i.holderPersonId === p.moderator);
  assert.ok(reviewed, 'the moderator holds a hub role under review');
  await run('admin.staff.access_review_decide', c.admin, `/v1/admin/staff/access-reviews/items/${reviewed.id}/decide`, { verdict: 'keep' },
    () => count(admin, "SELECT 1 FROM trustwork.staff_access_review_item WHERE verdict = 'keep'"));
  const mistaken = (await plain(c.admin, '/v1/admin/staff/access-reviews', { scope: hub, title: 'Synthetic mistaken review', roles: null, dueInSeconds: 30 * 86_400 })).campaign as { id: string };
  await run('admin.staff.access_review_withdraw', c.admin, `/v1/admin/staff/access-reviews/${mistaken.id}/withdraw`, {},
    () => count(admin, "SELECT 1 FROM trustwork.staff_access_review_campaign WHERE status = 'withdrawn'"));

  // ADM-004 accountability and offboarding: the hub owner answers for a function, hands an agent role to the lead who
  // accepts, ends one; the agent is offboarded (the lead's role is handed back first) and another offboarding is cancelled.
  const accountabilityRows = (where: string) => () => count(admin, `SELECT 1 FROM trustwork.staff_accountability WHERE ${where}`);
  await run('admin.staff.accountability_assign', c.hubOwner, '/v1/admin/staff/accountability', { hubId: world.hubId, functionKey: 'leadership', kind: 'function_owner', agentRoleKey: null, personId: p.hubOwner, requiredRole: 'hub-owner' },
    accountabilityRows("function_key = 'leadership'"));
  const supportDesk = (await plain(c.hubOwner, '/v1/admin/staff/accountability', { hubId: world.hubId, functionKey: 'support', kind: 'agent_role', agentRoleKey: 'support_triage', personId: p.hubOwner, requiredRole: null })).accountability as { id: string };
  const offered = (await run('admin.staff.accountability_offer', c.hubOwner, `/v1/admin/staff/accountability/${supportDesk.id}/offer`, { toPersonId: p.lead },
    () => count(admin, 'SELECT 1 FROM trustwork.staff_accountability_offer'))).body as { offer: { id: string } };
  await run('admin.staff.accountability_respond', c.lead, `/v1/admin/staff/accountability/offers/${offered.offer.id}/respond`, { accept: true },
    accountabilityRows("end_reason = 'handed_over'"));
  const handed = (await admin.query<{ id: string }>("SELECT id FROM trustwork.staff_accountability WHERE agent_role_key = 'support_triage' AND status = 'active'")).rows[0];
  assert.ok(handed, 'the lead now answers for the support triage agent role');
  const leadRole = (await admin.query<{ id: string }>("SELECT id FROM trustwork.staff_role_assignment WHERE person_id = $1 AND role = 'support-lead' AND revoked_at IS NULL", [p.lead])).rows[0];
  assert.ok(leadRole);
  // Revoking the lead's role suspends the accountability (the hub owner is offered it); the lead gets the role back and the row resumes.
  await plain(c.admin, `/v1/admin/staff/assignments/${leadRole.id}/revoke`, {});
  await plain(c.owner, '/v1/admin/staff/assignments', { personId: p.lead, role: 'support-lead', scope: hub, definitionVersion: 1 });
  await run('admin.staff.accountability_resume', c.hubOwner, `/v1/admin/staff/accountability/${handed.id}/resume`, {}, accountabilityRows("id = '" + handed.id + "' AND status = 'active'"));
  await run('admin.staff.accountability_end', c.hubOwner, `/v1/admin/staff/accountability/${handed.id}/end`, {}, accountabilityRows("end_reason = 'ended'"));
  const offboarding = (await run('admin.staff.offboarding_start', c.hubOwner, '/v1/admin/staff/offboardings', { personId: p.agent, scope: hub },
    () => count(admin, 'SELECT 1 FROM trustwork.staff_offboarding'))).body as { offboarding: { id: string } };
  await run('admin.staff.offboarding_complete', c.hubOwner, `/v1/admin/staff/offboardings/${offboarding.offboarding.id}/complete`, {},
    () => count(admin, "SELECT 1 FROM trustwork.staff_offboarding WHERE status = 'completed'"));
  const toCancelOffboarding = (await plain(c.hubOwner, '/v1/admin/staff/offboardings', { personId: p.moderator, scope: hub })).offboarding as { id: string };
  await run('admin.staff.offboarding_cancel', c.hubOwner, `/v1/admin/staff/offboardings/${toCancelOffboarding.id}/cancel`, {},
    () => count(admin, "SELECT 1 FROM trustwork.staff_offboarding WHERE status = 'cancelled'"));

  // Approvals: request, approve, decline, withdraw; break-glass consumes one.
  const subject = { action: 'staff.grant_breakglass', personId: p.lead2, role: 'moderator', scope: hub, definitionVersion: 1, incidentId: incident.incident.id, validForSeconds: 3600 };
  const approvals = () => count(admin, 'SELECT 1 FROM trustwork.second_person_approval');
  const requested = (await run('admin.approval.request', c.owner, '/v1/admin/approvals', { subject }, approvals)).body as { approval: { id: string; actionDigest: string } };
  await run('admin.approval.approve', c.admin, `/v1/admin/approvals/${requested.approval.id}/approve`, { actionDigest: requested.approval.actionDigest },
    () => count(admin, "SELECT 1 FROM trustwork.second_person_approval WHERE status = 'approved'"));
  await run('admin.staff.breakglass', c.owner, '/v1/admin/staff/breakglass', { personId: p.lead2, role: 'moderator', scope: hub, definitionVersion: 1, incidentId: incident.incident.id, validForSeconds: 3600, approvalId: requested.approval.id },
    () => count(admin, 'SELECT 1 FROM trustwork.staff_role_assignment WHERE breakglass'));
  const toDecline = (await plain(c.owner, '/v1/admin/approvals', { subject: { action: 'staff.assign_sensitive_role', personId: p.customer, role: 'hub-owner', scope: hub, definitionVersion: 1 } })).approval as { id: string };
  await run('admin.approval.decline', c.admin, `/v1/admin/approvals/${toDecline.id}/decline`, {}, () => count(admin, "SELECT 1 FROM trustwork.second_person_approval WHERE status = 'declined'"));
  const toWithdraw = (await plain(c.owner, '/v1/admin/approvals', { subject: { action: 'staff.assign_sensitive_role', personId: p.outsider, role: 'hub-owner', scope: hub, definitionVersion: 1 } })).approval as { id: string };
  await run('admin.approval.withdraw', c.owner, `/v1/admin/approvals/${toWithdraw.id}/withdraw`, {}, () => count(admin, "SELECT 1 FROM trustwork.second_person_approval WHERE status = 'revoked'"));

  // Case access grants.
  const supportCase = await a.as(p.customer, (trx) => supportCases.openOwn(trx, { hubId: world.hubId, category: 'account_access', summary: 'Synthetic crash case' }));
  const grant = (await run('admin.case_grant.request', c.agent, '/v1/admin/case-grants', { supportCaseId: supportCase.id, objectType: 'person', objectIds: [p.customer], projectionClass: 'diagnostic', purpose: 'Synthetic crash', expiresInSeconds: 3600 },
    () => count(admin, 'SELECT 1 FROM trustwork.case_access_grant'))).body as { grant: { id: string; requestDigest: string } };
  await run('admin.case_grant.decide', c.lead, `/v1/admin/case-grants/${grant.grant.id}/decide`, { decision: 'approve', requestDigest: grant.grant.requestDigest },
    () => count(admin, "SELECT 1 FROM trustwork.case_access_grant WHERE status = 'approved'"));
  await run('admin.case_grant.revoke', c.agent, `/v1/admin/case-grants/${grant.grant.id}/revoke`, {}, () => count(admin, "SELECT 1 FROM trustwork.case_access_grant WHERE status = 'revoked'"));

  // Moderation, sanctions, appeals.
  const report = (await run('moderation.report', c.customer, '/v1/moderation/reports', { hubId: world.hubId, targetKind: 'publication', targetId: p.outsider, clauseCode: 'community.spam', text: null },
    () => count(admin, 'SELECT 1 FROM trustwork.moderation_report'), true)).body as { report: { id: string } };
  const opened = (await run('admin.moderation.case_open', c.moderator, '/v1/admin/moderation/cases', { hubId: world.hubId, targetKind: 'publication', targetId: p.outsider, subject: { kind: 'person', id: p.outsider }, reportIds: [report.report.id], clauseCodes: ['community.spam'] },
    () => count(admin, 'SELECT 1 FROM trustwork.moderation_case'))).body as { case: { id: string } };
  await run('admin.moderation.decide', c.moderator, `/v1/admin/moderation/cases/${opened.case.id}/decide`, { decision: 'sanction' },
    () => count(admin, "SELECT 1 FROM trustwork.moderation_case WHERE status = 'decided'"));
  const sanction = (await run('admin.moderation.sanction_apply', c.moderator, `/v1/admin/moderation/cases/${opened.case.id}/sanctions`, { level: 1, featureScope: 'posting', durationSeconds: 3600 },
    () => count(admin, 'SELECT 1 FROM trustwork.sanction'))).body as { sanction: { id: string } };
  const appeal = (await run('moderation.appeal_file', c.outsider, '/v1/moderation/appeals', { subjectKind: 'sanction', subjectId: sanction.sanction.id, reason: 'Synthetic crash appeal' },
    () => count(admin, 'SELECT 1 FROM trustwork.appeal'), true)).body as { appeal: { id: string } };
  await run('admin.moderation.appeal_decide', c.hubOwner, `/v1/admin/moderation/appeals/${appeal.appeal.id}/decide`, { decision: 'upheld' },
    () => count(admin, "SELECT 1 FROM trustwork.appeal WHERE status = 'upheld'"));
  await run('admin.moderation.sanction_lift', c.hubOwner, `/v1/admin/moderation/sanctions/${sanction.sanction.id}/lift`, {},
    () => count(admin, 'SELECT 1 FROM trustwork.sanction WHERE lifted_at IS NOT NULL'));

  // Feature flags.
  await run('admin.flag.set', c.owner, '/v1/admin/flags', { scope: hub, key: 'ui.crash_toggle', value: true, description: 'Synthetic crash flag', declaredEffect: 'ui', expiresAt: flagExpiry },
    () => count(admin, 'SELECT 1 FROM trustwork.feature_flag'));
  return { world, actors: a };
}
