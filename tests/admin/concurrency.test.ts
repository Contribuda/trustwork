import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { SKIP_REASON, startHarness, type Response } from '../backend/helpers/app.js';
import { lockWaiters, until } from '../backend/idempotency/helpers.js';
import { buildHttpWorld, command, customerCase, type AdminWorldHttp } from './helpers.js';

const h = await startHarness('admin_race');

type Body = Record<string, unknown>;
const body = (r: Response) => r.body as Body;

/**
 * A gate on one table: a BEFORE UPDATE trigger waits on an advisory lock the test holds, so the first transaction to
 * update a row stops inside its update with the row locked while the competing request queues behind it; releasing
 * the gate lets the database decide. Every race below therefore really overlaps, whatever the scheduling.
 */
async function gate(admin: pg.Pool, table: string, key: number) {
  await admin.query(`CREATE OR REPLACE FUNCTION public.test_admin_gate_${table}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`);
  await admin.query(`DROP TRIGGER IF EXISTS test_admin_gate ON trustwork.${table}`);
  await admin.query(`CREATE TRIGGER test_admin_gate BEFORE UPDATE ON trustwork.${table} FOR EACH ROW EXECUTE FUNCTION public.test_admin_gate_${table}()`);
  return async <T>(start: () => Promise<T>): Promise<T> => {
    const held = await admin.connect();
    await held.query('BEGIN');
    await held.query('SELECT pg_advisory_xact_lock($1)', [key]);
    let racing: Promise<T> | null = null;
    try {
      racing = start();
      await until(async () => (await lockWaiters(admin)) >= 2, `two requests queued on ${table}`);
    } finally {
      await held.query('COMMIT').catch(() => undefined);
      held.release();
    }
    return racing;
  };
}

const statuses = (responses: Response[]) => responses.map((r) => r.status).sort((a, b) => a - b);

test('concurrent staff decisions: exactly one wins, the audit stays gap-free', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w: AdminWorldHttp = await buildHttpWorld(h);
  t.after(async () => { await w.close(); await h.close(); });
  await w.elevateAll();
  const c = w.clients;
  const p = w.people;
  const hub = { kind: 'hub', hubId: w.world.hubId } as const;
  const approvalGate = await gate(h.db.admin, 'second_person_approval', 81_001);

  const sensitiveRequest = async (personId: string) => {
    const r = await command(c.owner, '/v1/admin/approvals', { subject: { action: 'staff.assign_sensitive_role', personId, role: 'hub-owner', scope: hub, definitionVersion: 1 } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return body(r).approval as Body;
  };

  await t.test('two second persons approve the same request at once', async () => {
    const approval = await sensitiveRequest(p.candidate);
    const results = await approvalGate(() => Promise.all([
      command(c.admin, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: approval.actionDigest }),
      command(c.hubOwner, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: approval.actionDigest }),
    ]));
    assert.deepEqual(statuses(results), [200, 409], JSON.stringify(results.map((r) => r.body)));
    const loser = results.find((r) => r.status === 409) as Response;
    assert.equal((body(loser).details as Body).reason, 'approval_not_pending');
    const { rows } = await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE object_id = $1 AND action = 'approval.approved'", [approval.id]);
    assert.equal(rows[0].n, 1, 'one decision recorded');
  });

  await t.test('the requester executes one approval twice at once (different idempotency keys)', async () => {
    const approval = await sensitiveRequest(p.employee);
    assert.equal((await command(c.admin, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: approval.actionDigest })).status, 200);
    const assign = () => command(c.owner, '/v1/admin/staff/assignments', { personId: p.employee, role: 'hub-owner', scope: hub, definitionVersion: 1, approvalId: approval.id });
    const results = await approvalGate(() => Promise.all([assign(), assign()]));
    assert.deepEqual(statuses(results), [201, 403], JSON.stringify(results.map((r) => r.body)));
    const { rows } = await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.staff_role_assignment WHERE approval_id = $1', [approval.id]);
    assert.equal(rows[0].n, 1, 'one assignment per approval');
  });

  await t.test('a level 4 sanction executed twice at once with one approval', async () => {
    const opened = await command(c.moderator, '/v1/admin/moderation/cases', { hubId: w.world.hubId, targetKind: 'profile', targetId: p.outsider, subject: { kind: 'person', id: p.outsider }, clauseCodes: ['community.fraud'] });
    const caseId = (body(opened).case as Body).id as string;
    assert.equal((await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/decide`, { decision: 'sanction' })).status, 200);
    const subject = { action: 'moderation.apply_sanction_l4', moderationCaseId: caseId, featureScope: 'account', durationSeconds: null };
    const approval = body(await command(c.hubOwner, '/v1/admin/approvals', { subject })).approval as Body;
    assert.equal((await command(c.owner, `/v1/admin/approvals/${approval.id}/approve`, { actionDigest: approval.actionDigest })).status, 200);
    const apply = () => command(c.hubOwner, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 4, featureScope: 'account', durationSeconds: null, approvalId: approval.id });
    const results = await approvalGate(() => Promise.all([apply(), apply()]));
    assert.deepEqual(statuses(results), [201, 403], JSON.stringify(results.map((r) => r.body)));
    const { rows } = await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.sanction WHERE second_approval_id = $1', [approval.id]);
    assert.equal(rows[0].n, 1, 'one level 4 sanction per approval');
    assert.equal(w.sanctions.calls.filter((s) => s.level === 4 && s.change === 'applied').length, 1, 'the enforcing modules hear of it once');
  });

  await t.test('two staff decide the same appeal at once', async () => {
    const opened = await command(c.moderator, '/v1/admin/moderation/cases', { hubId: w.world.hubId, targetKind: 'comment', targetId: randomUUID(), subject: { kind: 'person', id: p.customer }, clauseCodes: ['community.spam'] });
    const caseId = (body(opened).case as Body).id as string;
    await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/decide`, { decision: 'sanction' });
    const sanction = body(await command(c.moderator, `/v1/admin/moderation/cases/${caseId}/sanctions`, { level: 1, featureScope: 'commenting', durationSeconds: 86_400 })).sanction as Body;
    const appeal = body(await c.customer.post('/v1/moderation/appeals', { subjectKind: 'sanction', subjectId: sanction.id, reason: 'Synthetic appeal' })).appeal as Body;
    const appealGate = await gate(h.db.admin, 'appeal', 81_002);
    const results = await appealGate(() => Promise.all([
      command(c.owner, `/v1/admin/moderation/appeals/${appeal.id}/decide`, { decision: 'overturned' }),
      command(c.hubOwner, `/v1/admin/moderation/appeals/${appeal.id}/decide`, { decision: 'upheld' }),
    ]));
    assert.deepEqual(statuses(results), [200, 409], JSON.stringify(results.map((r) => r.body)));
    const { rows } = await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE object_id = $1 AND action = 'appeal.decide'", [appeal.id]);
    assert.equal(rows[0].n, 1);
  });

  await t.test('approve and deny of one case grant at once', async () => {
    const supportCaseId = await customerCase(w);
    const grant = body(await command(c.agent, '/v1/admin/case-grants', { supportCaseId, objectType: 'person', objectIds: [p.customer], projectionClass: 'diagnostic', purpose: 'Synthetic race', expiresInSeconds: 3600 })).grant as Body;
    const grantGate = await gate(h.db.admin, 'case_access_grant', 81_003);
    const results = await grantGate(() => Promise.all([
      command(c.lead, `/v1/admin/case-grants/${grant.id}/decide`, { decision: 'approve', requestDigest: grant.requestDigest }),
      command(c.lead2, `/v1/admin/case-grants/${grant.id}/decide`, { decision: 'deny', requestDigest: grant.requestDigest }),
    ]));
    assert.deepEqual(statuses(results), [200, 409], JSON.stringify(results.map((r) => r.body)));
  });

  await t.test('the audit sequence stays gap-free under concurrent staff commands', async () => {
    const flags = await Promise.all(Array.from({ length: 8 }, (_, i) => command(c.owner, '/v1/admin/flags', {
      scope: hub, key: `ui.synthetic_toggle_${i}`, value: i % 2 === 0, description: 'Synthetic concurrent flag', declaredEffect: 'ui', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })));
    assert.deepEqual(flags.map((r) => r.status), Array(8).fill(200));
    const continuity = body(await c.owner.get('/v1/admin/audit/continuity'));
    assert.equal(continuity.gapFree, true, JSON.stringify(continuity));
    assert.equal(continuity.count, continuity.lastSequence);
  });
});
