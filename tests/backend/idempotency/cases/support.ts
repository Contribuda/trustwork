import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import type { Client, Harness } from '../../helpers/app.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { backdate } from '../../../support/helpers.js';
import { staffAssignments } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/identity.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

const SUPPORT_PERMISSIONS = ['admin.support.case.create', 'admin.support.grant.request', 'admin.support.account.read', 'admin.support.explain', 'admin.support.diagnose',
  'admin.support.notifications', 'admin.support.sessions.revoke', 'admin.support.second_factor.reset', 'admin.support.recovery.rebind'];

/**
 * SUP-001: every support route that completes in its transaction, crashed before and after the commit. Runs after the
 * ADM-001 case, whose founding administrators assign a synthetic support agent and lead (version 2 of the test role
 * definitions, with the support workspace permissions) at the administration world's hub. Every person is synthetic.
 */
export default {
  name: 'SUP-001: support cases, servicing actions and the person\'s own support path',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const founders = await admin.query<{ person_id: string; role: string }>("SELECT person_id, role FROM trustwork.staff_role_assignment WHERE setup_bootstrap AND revoked_at IS NULL AND role = 'platform-owner'");
    const owner = founders.rows[0]?.person_id;
    const hubId = (await admin.query<{ hub_id: string }>("SELECT hub_id FROM trustwork.staff_role_assignment WHERE role = 'support-lead' AND hub_id IS NOT NULL LIMIT 1")).rows[0]?.hub_id;
    assert.ok(owner && hubId, 'the ADM-001 case set up the founders and the hub');
    await withMaintenance(admin, async (trx) => {
      for (const [role, extra] of [['support-agent', []], ['support-lead', ['admin.support.case.close', 'admin.support.grant.approve']]] as const) {
        await trx.insertInto('staff_role_definition_version').values({ role, version: 2, scopes: ['hub'], permissions: [...SUPPORT_PERMISSIONS, ...extra], grant_max_hours: 24, sod_mode: 'reduced' })
          .onConflict((oc) => oc.doNothing()).execute();
      }
    });
    const people = await withMaintenance(admin, async (trx) => {
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      return { agent: await person('Synthetic Crash Support Agent'), lead: await person('Synthetic Crash Support Lead'), subject: await person('Synthetic Crash Support Subject') };
    });
    const ownerSession = await withMaintenance(admin, (trx) => trx.insertInto('session').values({ person_id: owner, token_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
    const ownerPrincipal = await principalFor(admin, owner);
    const elevation = await withPrincipal(h.pool, ownerPrincipal, (trx) => sessionElevations.insert(trx, { sessionId: ownerSession.id, personId: owner, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
    const ctx = { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic crash test setup' };
    for (const [personId, role] of [[people.agent, 'support-agent'], [people.lead, 'support-lead']] as const) {
      await withPrincipal(h.pool, ownerPrincipal, (trx) => staffAssignments.assign(trx, ctx, { personId, role, scope: { kind: 'hub', hubId }, definitionVersion: 2 }));
      h.staff.set(personId, [role]);
    }
    const emails = { agent: 'crash-support-agent@example.invalid', lead: 'crash-support-lead@example.invalid', subject: 'crash-support-subject@example.invalid' };
    await addLogins(h, [[people.agent, emails.agent], [people.lead, emails.lead], [people.subject, emails.subject]]);
    const staff = async (email: string): Promise<Client> => {
      const client = h.client();
      await signIn(client, email);
      const secret = await enrolNow(h, client);
      h.clock.advance(30_000);
      const elevated = await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(elevated.status, 200, JSON.stringify(elevated.body));
      h.clock.reset();
      return client;
    };
    const agent = await staff(emails.agent);
    const lead = await staff(emails.lead);
    const subject = h.client();
    await signIn(subject, emails.subject);
    const cmd = (action: string, rest: Record<string, unknown> = {}) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test action', ...rest });
    const plain = async (client: Client, url: string, rest: Record<string, unknown> = {}) => {
      const key = `plain-${randomUUID()}`;
      const r = await client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic setup for the crash test', ...rest }, { idempotencyKey: key });
      assert.ok(r.status >= 200 && r.status < 300, `${url}: ${JSON.stringify(r.body)}`);
      return r.body as Record<string, Record<string, string>>;
    };
    const audits = (action: string) => () => count(h, 'SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1', [action]);
    const actions = (state: string) => () => count(h, 'SELECT 1 FROM trustwork.account_service_action WHERE subject_person_id = $1 AND state = $2', [people.subject, state]);
    const S = '/v1/admin/support';

    // The person's own path.
    const own = (await exactlyOnce({ action: 'support.own_case_open', client: subject, url: '/v1/support/cases', body: { hubId, category: 'account_access', summary: 'Synthetic crash case' },
      effects: () => count(h, 'SELECT 1 FROM trustwork.support_case WHERE requester_person_id = $1', [people.subject]) })).body as { case: { id: string } };
    const caseId = own.case.id;
    await exactlyOnce({ action: 'support.own_case_note', client: subject, url: `/v1/support/cases/${caseId}/notes`, body: { body: 'Synthetic crash reply' },
      effects: () => count(h, 'SELECT 1 FROM trustwork.support_case_note WHERE author_person_id = $1', [people.subject]) });
    await exactlyOnce({ action: 'support.diagnostics_share', client: subject, url: `/v1/support/cases/${caseId}/diagnostics`, body: { pageId: 'app/home', appVersion: '0.9.0' },
      effects: () => count(h, 'SELECT 1 FROM trustwork.support_diagnostic_snapshot WHERE shared_by = $1', [people.subject]) });

    // Staff cases.
    await exactlyOnce({ action: 'support.case_open', client: agent, url: `${S}/cases`, body: cmd('support.case_open', { hubId, requesterPersonId: people.subject, subject: { kind: 'person', id: people.subject }, category: 'account_access', summary: 'Synthetic crash call' }),
      effects: () => count(h, 'SELECT 1 FROM trustwork.support_case WHERE opened_by = $1', [people.agent]) });
    await exactlyOnce({ action: 'support.case_note', client: agent, url: `${S}/cases/${caseId}/notes`, body: cmd('support.case_note', { body: 'Synthetic crash note', visibility: 'requester' }),
      effects: () => count(h, 'SELECT 1 FROM trustwork.support_case_note WHERE author_person_id = $1', [people.agent]) });
    await exactlyOnce({ action: 'support.case_update', client: lead, url: `${S}/cases/${caseId}/update`, body: cmd('support.case_update', { status: 'triaged' }), effects: audits('support.case_update') });
    await plain(lead, `${S}/cases/${caseId}/update`, { status: 'waiting_on_requester' });
    await exactlyOnce({ action: 'support.own_case_update', client: subject, url: `/v1/support/cases/${caseId}/status`, body: { status: 'triaged' },
      effects: () => count(h, "SELECT 1 FROM trustwork.support_case WHERE id = $1 AND status = 'triaged'", [caseId]) });

    // Servicing actions: request and cancel a rebind; a second-factor reset through approval, activation and execution.
    const rebind = (await exactlyOnce({ action: 'support.action_request', client: agent, url: `${S}/cases/${caseId}/actions`,
      body: cmd('support.action_request', { subjectPersonId: people.subject, action: 'rebind_recovery_email', newEmail: 'crash-support-new@example.invalid', evidenceRefs: [randomUUID()] }),
      effects: () => count(h, 'SELECT 1 FROM trustwork.account_service_action WHERE subject_person_id = $1', [people.subject]) })).body as { action: { id: string } };
    await exactlyOnce({ action: 'support.action_cancel', client: agent, url: `${S}/actions/${rebind.action.id}/cancel`, body: cmd('support.action_cancel'), effects: actions('cancelled') });
    const reset = (await plain(agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: people.subject, action: 'reset_second_factor', evidenceRefs: [randomUUID()], reason: 'Lost authenticator; identity checked on a recorded call' })).action as { id: string; approvalId: string; requestDigest: string };
    await plain(lead, `/v1/admin/approvals/${reset.approvalId}/approve`, { actionDigest: reset.requestDigest });
    await exactlyOnce({ action: 'support.action_activate', client: agent, url: `${S}/actions/${reset.id}/activate`, body: cmd('support.action_activate'), effects: actions('cooling_off') });
    await backdate(h, reset.id);
    await exactlyOnce({ action: 'support.action_execute', client: lead, url: `${S}/actions/${reset.id}/execute`, body: cmd('support.action_execute'), effects: actions('done') });

    // The person stops a pending change of their own sign-in factors.
    const pending = (await plain(agent, `${S}/cases/${caseId}/actions`, { subjectPersonId: people.subject, action: 'rebind_recovery_email', newEmail: 'crash-support-other@example.invalid', evidenceRefs: [randomUUID()] })).action as { id: string };
    // The reset ended every session of the subject: sign in again with a fresh step-up.
    await signIn(subject, emails.subject);
    assert.equal((await subject.post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    await exactlyOnce({ action: 'support.own_action_cancel', client: subject, url: `/v1/support/actions/${pending.id}/cancel`, body: undefined, effects: actions('cancelled') });
  },
} satisfies CrashCase;
