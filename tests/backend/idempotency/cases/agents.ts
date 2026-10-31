import { hash } from '@node-rs/argon2';
import { withMaintenance } from '@trustwork/data';
import { auditCount } from '../../hardening/helpers.js';
import type { Client, Response } from '../../helpers/app.js';
import type { CrashCase } from '../cases.js';

/**
 * AGT-001: goals, reports, job subscriptions, envelopes, escalations, the company representative and company mandates.
 * The case builds its own synthetic people and company (the earlier cases change the shared personas' memberships).
 */
const PASSWORD = 'fixture-password-agt-crash-01';
const UNTIL = '2027-12-31T00:00:00.000Z';

export default {
  name: 'AGT-001: goals, reports, subscriptions, envelopes, escalations, representative and company mandates',
  async run({ h, exactlyOnce }) {
    const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const ids = await withMaintenance(h.db.admin, async (trx) => {
      const person = async (name: string, email: string) => {
        const row = await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('email_binding').values({ person_id: row.id, email_normalized: email, is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
        await trx.insertInto('credential').values({ person_id: row.id, kind: 'password', password_hash: passwordHash }).execute();
        return row.id;
      };
      const admin = await person('Synthetic Agents Admin', 'agt-admin@example.invalid');
      const member = await person('Synthetic Agents Member', 'agt-member@example.invalid');
      const buyer = await person('Synthetic Agents Buyer', 'agt-buyer@example.invalid');
      const company = (await trx.insertInto('company').values({ display_name: 'Synthetic Agents LLC', claim_status: 'claimed' }).returning('id').executeTakeFirstOrThrow()).id;
      const at = new Date('2026-10-01T09:00:00Z');
      await trx.insertInto('membership').values({ person_id: admin, company_id: company, role: 'administrator', permissions: ['company.deals.manage', 'company.members.manage'], status: 'active', valid_from: at }).execute();
      await trx.insertInto('membership').values({ person_id: member, company_id: company, role: 'member', permissions: ['company.deals.manage'], status: 'active', valid_from: at }).execute();
      return { admin, member, buyer, company };
    });
    const signIn = async (email: string): Promise<Client> => {
      const c = h.client();
      const r = await c.post('/v1/auth/login', { email, password: PASSWORD }, { idempotencyKey: null });
      if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
      return c;
    };
    const [admin, member, buyer] = [await signIn('agt-admin@example.invalid'), await signIn('agt-member@example.invalid'), await signIn('agt-buyer@example.invalid')];
    const body = <T>(r: Response): T => {
      if (r.status < 200 || r.status >= 300) throw new Error(JSON.stringify(r.body));
      return r.body as T;
    };
    const audits = (action: string) => () => auditCount(h.db.admin, action);
    const base = `/v1/companies/${ids.company}`;

    // A published RFQ of the buyer that invites the company.
    let rfq = body<{ rfq: { id: string; revision: number; currentVersionId: string } }>(await buyer.post('/v1/rfqs', {
      owner: { kind: 'person', id: ids.buyer }, projectId: null, category: null, publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor: { via: 'person' },
      payload: { title: 'Synthetic pavers', lines: [{ lineId: 'pavers', kind: 'goods', description: 'Concrete pavers', specification: {}, quantity: { value: '10', unit: 'm2' }, alternativesAllowed: true }],
        deliveryTerms: { location: { region: 'US-CA' }, window: { from: { date: '2027-03-01', timeZone: 'America/Los_Angeles' }, to: { date: '2027-03-31', timeZone: 'America/Los_Angeles' } } },
        acceptanceCriteria: 'Level', paymentTermsRequested: 'Net 30', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [] },
    }));
    rfq = body(await buyer.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: { via: 'person' } }));
    body(await buyer.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party: { kind: 'company', id: ids.company }, channel: 'platform', actor: { via: 'person' } }));
    const terms = { moduleKeys: ['representative'], actions: ['communicate'], contexts: [{ kind: 'rfq', id: rfq.rfq.id }], limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null },
      conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [], escalation: { kind: 'ask_principal' }, validUntil: UNTIL };

    // Goals, evidence, reports, subscriptions.
    const created = body<{ goal: { id: string }; confirmation: { digest: unknown } }>(await exactlyOnce({ action: 'agents.goal_create', client: admin, url: '/v1/assistant/goals', effects: audits('agents.goal_created'), body: {
      onBehalfOf: null, text: 'Answer RFQ invitations quickly.', successCriteria: ['Every invitation answered within a day'], budgetRange: null, horizon: '2027-06-30T00:00:00.000Z', reportCadence: 'weekly',
      needs: [{ moduleKey: 'negotiation', actions: ['communicate'], contexts: [{ kind: 'rfq', id: rfq.rfq.id }], perWindow: null, approvalPolicy: { mode: 'ask_each' } }],
    } }));
    const goal = body<{ id: string; revision: number }>(await exactlyOnce({ action: 'agents.goal_confirm', client: admin, url: `/v1/assistant/goals/${created.goal.id}/confirm`, body: { digest: created.confirmation.digest }, effects: audits('agents.goal_confirmed') }));
    await exactlyOnce({ action: 'agents.goal_evidence', client: admin, url: `/v1/assistant/goals/${goal.id}/progress`, body: { evidenceRefs: [{ kind: 'rfq', id: rfq.rfq.id }], code: 'invitation_answered' }, effects: audits('agents.goal_evidence') });
    const report = body<{ id: string }>(await exactlyOnce({ action: 'agents.goal_report', client: admin, url: `/v1/assistant/goals/${goal.id}/report`, effects: audits('agents.report_generated') }));
    await exactlyOnce({ action: 'agents.report_share', client: admin, url: `/v1/assistant/reports/${report.id}/share`, body: { personIds: [ids.member] }, effects: audits('agents.report_shared') });
    const sub = body<{ id: string; revision: number }>(await exactlyOnce({ action: 'agents.job_subscription_create', client: admin, url: '/v1/assistant/job-subscriptions', effects: audits('agents.job_subscription_created'),
      body: { onBehalfOf: null, moduleKey: 'negotiation', jobTemplateKey: 'daily_digest', trigger: { kind: 'request' }, mandateId: null } }));
    await exactlyOnce({ action: 'agents.job_subscription_status', client: admin, url: `/v1/assistant/job-subscriptions/${sub.id}/status`, body: { status: 'paused', expectedRevision: sub.revision }, effects: audits('agents.job_subscription_status') });
    const current = body<{ revision: number }>(await admin.get(`/v1/assistant/goals/${goal.id}`));
    await exactlyOnce({ action: 'agents.goal_status', client: admin, url: `/v1/assistant/goals/${goal.id}/status`, body: { status: 'paused', outcome: null, expectedRevision: current.revision }, effects: audits('agents.goal_paused') });

    // The representative and company mandates.
    await exactlyOnce({ action: 'agents.representative_configure', client: admin, url: `${base}/representative`, body: { accountablePersonId: ids.member, expectedRevision: null }, effects: audits('agents.representative_configured') });
    await exactlyOnce({ action: 'agents.representative_accept', client: member, url: `${base}/representative/accept`, effects: audits('agents.representative_accepted') });
    const cm = body<{ id: string; termsDigest: unknown }>(await exactlyOnce({ action: 'agents.company_mandate_grant', client: admin, url: `${base}/agent-mandates`, body: { executor: { kind: 'company_representative' }, terms }, effects: audits('agents.company_mandate_granted') }));

    // The representative (run by its accountable member) writes to the buyer; the buyer resolves the escalation it got.
    await exactlyOnce({ action: 'agents.envelope_send', client: member, url: '/v1/assistant/envelopes', effects: audits('agents.envelope_delivered'), body: {
      actingAs: { kind: 'company_representative', companyMandateId: cm.id }, to: { kind: 'person', id: ids.buyer }, context: { kind: 'rfq', id: rfq.rfq.id }, intent: 'clarify', refs: [],
      note: null, negotiationSessionId: null, expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
    } });
    const escalation = body<{ escalations: { id: string }[] }>(await buyer.get('/v1/assistant/escalations')).escalations[0]!;
    await exactlyOnce({ action: 'agents.escalation_resolve', client: buyer, url: `/v1/assistant/escalations/${escalation.id}/resolve`, body: { status: 'dismissed' }, effects: audits('agents.escalation_resolved') });

    // Re-confirmation of a company mandate waiting for it (as after a granter left), then revocation.
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('company_mandate').set({ status: 'awaiting_reconfirmation', reconfirm_due_at: new Date(Date.now() + 86400_000), status_reason: 'granter_left' }).where('id', '=', cm.id).execute());
    const reconfirmed = body<{ revision: number }>(await exactlyOnce({ action: 'agents.company_mandate_reconfirm', client: member, url: `${base}/agent-mandates/${cm.id}/reconfirm`, body: { termsDigest: cm.termsDigest }, effects: audits('agents.company_mandate_reconfirmed') }));
    await exactlyOnce({ action: 'agents.company_mandate_revoke', client: admin, url: `${base}/agent-mandates/${cm.id}/revoke`, body: { expectedRevision: reconfirmed.revision }, effects: audits('agents.company_mandate_revoked') });

    const suspended = body<{ revision: number }>(await exactlyOnce({ action: 'agents.representative_suspend', client: admin, url: `${base}/representative/suspend`, effects: audits('agents.representative_suspended') }));
    await exactlyOnce({ action: 'agents.representative_resume', client: admin, url: `${base}/representative/resume`, body: { expectedRevision: suspended.revision }, effects: audits('agents.representative_resumed') });
    await exactlyOnce({ action: 'agents.representative_disable', client: admin, url: `${base}/representative/disable`, effects: audits('agents.representative_disabled') });
  },
} satisfies CrashCase;
