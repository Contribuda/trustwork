import { listCrashCases } from '../../../web/admin/screening/list-crashes.js';
import assert from 'node:assert/strict';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import type { Client, Harness } from '../../helpers/app.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, signIn } from '../../../admin/helpers.js';
import { workerLogin } from '../../../assistant/helpers.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { adminDigests, approvals, staffAssignments } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/identity.js';
import { activateList, CONS_ENTRIES, person, screen, SDN_ENTRIES } from '../../../screening/helpers.js';
import { baselineIds } from '../../../screening-lists/helpers.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/**
 * Makes a synthetic person a compliance officer of the node through DATA-002's second-person path: the founding
 * platform owner asks, the founding staff administrator approves, the owner assigns (both from the ADM-001 case).
 */
async function complianceOfficer(h: Harness, personId: string): Promise<void> {
  const admin = h.db.admin;
  const founders = await admin.query<{ person_id: string; role: string; node: string }>(
    "SELECT a.person_id, a.role, (SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.revoked_at IS NULL AND a.role IN ('platform-owner', 'staff-admin')");
  const owner = founders.rows.find((r) => r.role === 'platform-owner');
  const staffAdmin = founders.rows.find((r) => r.role === 'staff-admin');
  assert.ok(owner && staffAdmin, 'the ADM-001 case set up the founding administrators');
  const nodeId = owner.node;
  await withMaintenance(admin, (trx) => trx.insertInto('staff_role_definition_version').values({ role: 'compliance-officer', version: 1, scopes: ['node'], permissions: ['admin.claims.read'], grant_max_hours: 72, sod_mode: 'reduced' }).onConflict((oc) => oc.doNothing()).execute());
  const ctxOf = async (who: string) => {
    const session = await withMaintenance(admin, (trx) => trx.insertInto('session').values({ person_id: who, token_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))), idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
    const elevation = await withPrincipal(h.pool, await principalFor(admin, who), (trx) => sessionElevations.insert(trx, { sessionId: session.id, personId: who, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
    return { elevationId: elevation.id, requestId: `req-${crypto.randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic crash test setup' };
  };
  const scope = { kind: 'node', nodeId } as const;
  const digest = adminDigests.assignment({ breakglass: false, personId, role: 'compliance-officer', scope, definitionVersion: 1 });
  const ownerCtx = await ctxOf(owner.person_id);
  const request = await withPrincipal(h.pool, await principalFor(admin, owner.person_id), (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope, actionDigest: digest }));
  await withPrincipal(h.pool, await principalFor(admin, staffAdmin.person_id), async (trx) => approvals.decide(trx, await ctxOf(staffAdmin.person_id), request.id, 'approve', digest));
  await withPrincipal(h.pool, await principalFor(admin, owner.person_id), (trx) => staffAssignments.assign(trx, ownerCtx, { personId, role: 'compliance-officer', scope, definitionVersion: 1, approvalId: request.id }));
}

/**
 * SANC-003: every screening route that completes in its transaction, crashed before and after the commit: confirm,
 * the subject's appeal, the appeal decision (a proposed reversal), the second person's approval and a proposal of
 * "not the same person". Every person and list entry is synthetic.
 */
export default {
  name: 'SANC-003: screening decisions and the appeal',
  async run({ h, exactlyOnce }) {
    const workers = await workerLogin(h);
    try {
      const worker = workers.pool(2);
      await withMaintenance(h.db.admin, (trx) => trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute());
      const lists = await baselineIds(h.db.admin);
      await activateList(worker, lists.sdn, SDN_ENTRIES);
      await activateList(worker, lists.cons, CONS_ENTRIES);
      // Two compliance officers and two matched subjects, all synthetic.
      const officers: Client[] = [];
      for (const label of ['one', 'two']) {
        const officer = await person(h.db.admin, `Synthetic Compliance Officer ${label}`);
        await addLogins(h, [[officer.id, `crash-screening-${label}@example.invalid`]]);
        await complianceOfficer(h, officer.id);
        h.staff.set(officer.id, ['trust-reviewer']);
        const client = h.client();
        await signIn(client, `crash-screening-${label}@example.invalid`);
        const secret = await enrolNow(h, client);
        h.clock.advance(30_000);
        const elevated = await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
        assert.equal(elevated.status, 200, JSON.stringify(elevated.body));
        officers.push(client);
      }
      const [first, second] = officers as [Client, Client];
      await listCrashCases(h,first,second,worker,exactlyOnce);
      // SANC-006: the existing manual command audits and completes in the request transaction.
      await exactlyOnce({ action: 'screening.rescreen_request', client: first, url: '/v1/admin/screening/rescreen-runs', body: { reason: 'Synthetic manual review' }, effects: () => count(h, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'screening.rescreen_requested'") });
      const milo = await person(h.db.admin, 'Milo Fictivsky');
      await addLogins(h, [[milo.id, 'crash-screening-subject@example.invalid']]);
      const orla = await person(h.db.admin, 'Orla Testworthy');
      await screen(worker, { kind: 'person', id: milo.id });
      await screen(worker, { kind: 'person', id: orla.id });
      const matchOf = async (personId: string) => (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.screening_match WHERE subject_person_id = $1', [personId])).rows[0]!.id;
      const audits = (action: string) => () => count(h, 'SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1', [action]);
      const miloMatch = await matchOf(milo.id);

      await exactlyOnce({ action: 'screening.match_confirm', client: first, url: `/v1/admin/screening/matches/${miloMatch}/confirm`, body: { reason: 'Synthetic: identifiers match', evidence: 'registration_identifier' }, effects: audits('screening.match_confirmed') });
      const subject = h.client();
      await signIn(subject, 'crash-screening-subject@example.invalid');
      await exactlyOnce({ action: 'screening.appeal_file', client: subject, url: '/v1/screening/me/appeal', body: { companyId: null, reason: 'Synthetic: that is not me' }, effects: () => count(h, "SELECT 1 FROM trustwork.audit_event WHERE action = 'screening.appeal_filed'") });
      await exactlyOnce({ action: 'screening.appeal_reassign', client: second, url: `/v1/admin/screening/matches/${miloMatch}/appeal-assignment`, body: { expectedVersion: 1, reviewerId: null, reason: 'Synthetic routing crash check' }, effects: audits('screening.appeal_reassigned') });
      await exactlyOnce({ action: 'screening.appeal_decide', client: second, url: `/v1/admin/screening/matches/${miloMatch}/appeal-decision`, body: { decision: 'propose_reversal', reason: 'Synthetic: another person', evidence: 'identity_document' }, effects: audits('screening.reversal_proposed') });
      const digest = (await h.db.admin.query<{ approval_digest: string }>("SELECT approval_digest FROM trustwork.screening_decision WHERE match_id = $1 AND kind = 'propose_reversal'", [miloMatch])).rows[0]!.approval_digest;
      await exactlyOnce({ action: 'screening.proposal_decide', client: first, url: `/v1/admin/screening/matches/${miloMatch}/proposal-decision`, body: { decision: 'approve', actionDigest: digest, reason: 'Synthetic: agreed' }, effects: audits('screening.reversal_approved') });
      await exactlyOnce({ action: 'screening.match_propose', client: first, url: `/v1/admin/screening/matches/${await matchOf(orla.id)}/propose-not-same-person`, body: { reason: 'Synthetic: another birth year', evidence: 'date_of_birth' }, effects: audits('screening.not_same_person_proposed') });
    } finally {
      await workers.close();
    }
  },
} satisfies CrashCase;
