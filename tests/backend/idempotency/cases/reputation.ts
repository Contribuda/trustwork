import { withMaintenance, type DataPool } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import { buildAgreement, businessDate, type Fixture } from '../../../trust/helpers.js';

const auditCount = async (admin: DataPool, action: string): Promise<number> =>
  Number((await withMaintenance(admin, (trx) => trx.selectFrom('audit_event').select((eb) => eb.fn.countAll<string>().as('n')).where('action', '=', action).executeTakeFirstOrThrow())).n);

/** REP-001: every reputation builder mutation completes its idempotency record in its own transaction (BE-005). */
export default {
  name: 'REP-001: reputation builder credentials, portfolio, confirmations, relations and appeals',
  async run({ h, seed, as, exactlyOnce }) {
    const hubId = '00000000-0000-4000-8000-0000000e0f03';
    const previousHub = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = hubId;
    try {
      await withMaintenance(h.db.admin, (trx) => trx.insertInto('hub').values({ id: hubId, slug: 'synthetic-rep-crash', lifecycle: 'public' }).execute());
      const f: Fixture = { admin: h.db.admin, app: h.db.app, people: { petr: seed.people.petr, boris: seed.people.boris, carl: seed.people.carl, xenia: seed.people.xenia, anna: seed.people.anna }, supplier: seed.companies.supplier, project: seed.project };
      // Boris enrolled a second factor in the support-reset block, so a fresh password login is no longer a full
      // session; xenia (no active employer) joins the synthetic supplier with company.deals.manage instead.
      await withMaintenance(h.db.admin, (trx) => trx.insertInto('membership').values({
        person_id: seed.people.xenia, company_id: seed.companies.supplier, role: 'member', permissions: ['company.deals.manage'], status: 'active', valid_from: new Date(),
      }).execute());
      const [member, petr] = [await as('xenia'), await as('petr')];
      const supplierParty = { kind: 'company', id: seed.companies.supplier };
      const petrParty = { kind: 'person', id: seed.people.petr };
      const A = await buildAgreement(f, businessDate(-2), 'Synthetic reputation exactly once');
      type Own = { credentials: { id: string }[]; portfolio: { id: string }[]; confirmationsSent: { id: string; statementKind: string; response: { id: string } | null }[] };

      const own = (await exactlyOnce({ action: 'reputation.credential_record', client: member, url: '/v1/reputation-builder/credentials', body: {
        holder: supplierParty, kind: 'licence', jurisdiction: 'US-CA', credentialType: 'US-CA-CSLB-C8', issuer: 'Synthetic licence board', number: 'SYN-OK-1', classification: null, coverage: null,
        validFrom: null, validUntil: null, visibility: 'public', supersedesId: null,
      }, effects: () => auditCount(h.db.admin, 'reputation.credential_recorded') })).body as Own;
      await exactlyOnce({ action: 'reputation.credential_check', client: member, url: `/v1/reputation-builder/credentials/${own.credentials[0]!.id}/checks`, body: {}, effects: () => auditCount(h.db.admin, 'reputation.credential_checked') });
      const withEntry = (await exactlyOnce({ action: 'reputation.portfolio_add', client: member, url: '/v1/reputation-builder/portfolio', body: {
        holder: supplierParty, context: { kind: 'agreement', id: A.agreement.id }, externalDescription: null, title: 'Synthetic patio', role: 'Installer', period: { from: null, to: null },
        scopeSummary: null, visibility: 'private', supersedesId: null,
      }, effects: () => auditCount(h.db.admin, 'reputation.portfolio_entry_added') })).body as Own;
      const ask = (statementKind: string) => ({
        requester: supplierParty, addressedTo: petrParty, context: { kind: 'agreement', id: A.agreement.id }, portfolioEntryId: statementKind === 'delivered' ? withEntry.portfolio[0]!.id : null,
        statementKind, statement: 'Synthetic statement', attestation: { noIncentiveOffered: true, notEmployeeOrRelative: true },
      });
      const sent = (await exactlyOnce({ action: 'reputation.confirmation_request', client: member, url: '/v1/reputation-builder/confirmations', body: ask('delivered'), effects: () => auditCount(h.db.admin, 'reputation.confirmation_requested') })).body as Own;
      const requestId = sent.confirmationsSent[0]!.id;
      // A request old enough for its single reminder (seeded as three days old by the maintenance role).
      const old = await withMaintenance(h.db.admin, (trx) => trx.insertInto('confirmation_request').values({
        requester_person_id: null, requester_company_id: seed.companies.supplier, addressed_person_id: seed.people.petr, addressed_company_id: null, context_kind: 'agreement', context_id: A.agreement.id,
        portfolio_entry_id: null, statement_kind: 'on_time', statement: 'Synthetic statement', no_incentive: true, no_conflict: true, requested_by_person_id: seed.people.xenia,
        requested_at: new Date(Date.now() - 4 * 86_400_000), due_at: new Date(Date.now() + 26 * 86_400_000),
      }).returning('id').executeTakeFirstOrThrow());
      await exactlyOnce({ action: 'reputation.confirmation_remind', client: member, url: `/v1/reputation-builder/confirmations/${old.id}/reminder`, body: {}, effects: () => auditCount(h.db.admin, 'reputation.confirmation_reminded') });
      await exactlyOnce({ action: 'reputation.confirmation_withdraw', client: member, url: `/v1/reputation-builder/confirmations/${old.id}/withdraw`, body: {}, effects: () => auditCount(h.db.admin, 'reputation.confirmation_withdrawn') });
      await exactlyOnce({ action: 'reputation.confirmation_answer', client: petr, url: `/v1/reputation-builder/confirmations/${requestId}/response`, body: {
        onBehalfOf: petrParty, decision: 'partially', comment: 'Synthetic: one edge redone', consentToShow: false, attestation: { noIncentiveReceived: true, notEmployeeOrRelative: true },
      }, effects: () => auditCount(h.db.admin, 'reputation.confirmation_answered') });
      const answered = (await member.get(`/v1/reputation-builder/companies/${seed.companies.supplier}/own`)).body as Own;
      const responseId = answered.confirmationsSent.find((r) => r.id === requestId)!.response!.id;
      await exactlyOnce({ action: 'reputation.appeal_file', client: member, url: '/v1/reputation-builder/appeals', body: { subject: { kind: 'confirmation_response', id: responseId }, reason: 'Synthetic appeal' }, effects: () => auditCount(h.db.admin, 'reputation.appeal_filed') });
      await exactlyOnce({ action: 'reputation.limitation_appeal', client: member, url: '/v1/reputation-builder/limitations/appeals', body: {
        limitation: { scope: 'confirmation_request', reasonCode: 'no_recorded_relationship', requester: supplierParty, addressedTo: { kind: 'person', id: seed.people.carl }, context: { kind: 'agreement', id: A.agreement.id }, statementKind: 'delivered' },
        reason: 'Synthetic limitation appeal',
      }, effects: () => auditCount(h.db.admin, 'reputation.limitation_appealed') });
      await exactlyOnce({ action: 'reputation.relation_declare', client: petr, url: '/v1/reputation-builder/relations', body: { otherPersonId: seed.people.anna, kind: 'household' }, effects: () => auditCount(h.db.admin, 'reputation.relation_declared') });
    } finally {
      if (previousHub === undefined) delete process.env.TRUSTWORK_HUB_ID;
      else process.env.TRUSTWORK_HUB_ID = previousHub;
    }
  },
} satisfies CrashCase;
