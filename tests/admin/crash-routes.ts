import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import type pg from 'pg';
import type { Client, Harness, Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { actors, buildAdminWorld } from '../data/admin/helpers.js';
import { addLogins, enrolNow, signIn } from './helpers.js';
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
export async function crashAdminRoutes(h: Harness, exactlyOnce: ExactlyOnce): Promise<void> {
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
    if (staff[key]) secrets[key] = await enrolNow(h, client);
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
}
