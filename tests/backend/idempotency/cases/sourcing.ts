import type { BidLevelSheetVersion } from '../../../../packages/contracts/src/supply/sourcing.js';
import { budgets } from '../../../../packages/data/src/repositories/billing.js';
import type { Client, Harness } from '../../helpers/app.js';
import { as, company, grant, ok, publishRfq, quotePayload, rfqPayload, seedWorld, sendQuote, signIn } from '../../../sourcing/helpers.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[]): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;
const key = (action: string) => `crash-${action}`;
let keys = 0;
const send = (client: Client, url: string, body: Record<string, unknown>) => {
  const idempotencyKey = `crash-sourcing-setup-${++keys}`;
  return client.post(url, { ...body, idempotencyKey }, { idempotencyKey });
};
type Sheet = { version: BidLevelSheetVersion; revision: number };
type Award = { award: { id: string; approvalRequestId: string }; revision: number };
type Card = { request: { revision: number; subjectDigest: unknown; currentStep: string } };

/**
 * PRC-004: every sourcing route that completes in its transaction, crashed before COMMIT and retried: saving eligibility
 * rules, opening, saving and freezing a levelling sheet, proposing, executing and cancelling an award (execution covers
 * the COM-002 acceptance and order in the same commit) and sending outcome notices. The companies and their people are
 * synthetic.
 */
export default {
  name: 'PRC-004: sourcing eligibility rules, levelling sheets, awards and outcome notices',
  async run({ h, exactlyOnce }) {
    const label = 'crash-sourcing';
    const w = await seedWorld(h, label);
    await grant(h.db.admin, w, 'dana', 'procurement.approval.decide');
    const [ada, rita, dana, sam] = [await signIn(h, 'ada', label), await signIn(h, 'rita', label), await signIn(h, 'dana', label), await signIn(h, 'sam', label)];
    const supplier = company(w.supplierA);
    const rfq = await publishRfq(ada, company(w.buyer), rfqPayload(), [supplier]);
    const quote = await sendQuote(sam, rfq, supplier, quotePayload('3000'));
    const id = rfq.rfq.id;

    await exactlyOnce({
      action: 'sourcing.eligibility_save', client: rita, url: `/v1/sourcing/rfqs/${id}/eligibility`, body: { rules: [{ kind: 'screening_clear' }], expectedRevision: null },
      effects: () => count(h, 'SELECT 1 FROM trustwork.sourcing_eligibility_rule_set WHERE rfq_id = $1', [id]),
    });

    const template = (await rita.get(`/v1/sourcing/rfqs/${id}/level-sheet/template`)).body as { payload: unknown };
    const opened = (await exactlyOnce({
      action: 'sourcing.sheet_draft', client: rita, url: `/v1/sourcing/rfqs/${id}/level-sheet/versions`, body: { rfqId: id, rfqVersionId: rfq.rfq.currentVersionId, payload: template.payload },
      effects: () => count(h, 'SELECT 1 FROM trustwork.bid_level_sheet_version WHERE rfq_id = $1', [id]),
    })).body as Sheet;

    const saved = (await exactlyOnce({
      action: 'sourcing.sheet_save', client: rita, url: `/v1/sourcing/level-sheet-versions/${opened.version.id}`, body: { payload: template.payload, expectedRevision: opened.revision },
      effects: () => count(h, 'SELECT 1 FROM trustwork.audit_event WHERE action = $1 AND object_id = $2', ['sourcing.sheet_saved', opened.version.id]),
    })).body as Sheet;

    await exactlyOnce({
      action: 'sourcing.sheet_freeze', client: rita, url: `/v1/sourcing/level-sheet-versions/${opened.version.id}/freeze`, body: { digest: saved.version.digest, expectedRevision: saved.revision },
      effects: () => count(h, "SELECT 1 FROM trustwork.bid_level_sheet_version WHERE id = $1 AND status = 'frozen'", [opened.version.id]),
    });

    const route = { receiverSoleApprovalThreshold: null, steps: [{ key: 'approve', order: 1, conditions: [], selector: { kind: 'permission_holders', permission: 'procurement.approval.decide', scope: 'company' }, quorum: 1, timeoutHours: 48, escalation: { kind: 'route_owner' } }] };
    const drafted = ok<{ id: string; digest: unknown }>(await ada.post('/v1/approvals/routes', { owner: company(w.buyer), subjectKind: 'award', payload: route, templateKey: null }), 201);
    ok(await send(ada, `/v1/approvals/routes/${drafted.id}/activate`, { routeVersionId: drafted.id, digest: drafted.digest, expectedRevision: 1 }));
    const budget = await as(h, w, 'ada', (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'company', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: '10000000', currency: 'USD' }));
    const sent = quote.versions.find((v) => v.status === 'sent')!;
    const proposal = async (rfqId: string, sheetVersionId: string, quoteVersionId: string) => {
      const current = ok<{ rfq: { revision: number } }>(await ada.get(`/v1/rfqs/${rfqId}`));
      return { rfqId, bidLevelSheetVersionId: sheetVersionId, selection: [{ quoteVersionId, rfqLineKeys: ['pavers', 'laying'], share: '1' }], reasons: [{ category: 'price', text: 'Lowest levelled total' }], expectedRevision: current.rfq.revision };
    };
    const approve = async (view: Award) => {
      const requestId = view.award.approvalRequestId;
      const { request } = ok<Card>(await dana.get(`/v1/approvals/requests/${requestId}`));
      ok(await send(dana, `/v1/approvals/requests/${requestId}/decide`, { approvalRequestId: requestId, step: request.currentStep, decision: 'approve', subjectDigest: request.subjectDigest, reason: null, expectedRevision: request.revision }));
      return ok<Award>(await rita.get(`/v1/sourcing/awards/${view.award.id}`));
    };

    const award = (await exactlyOnce({
      action: 'sourcing.award_propose', client: rita, url: `/v1/sourcing/rfqs/${id}/awards`, body: { ...(await proposal(id, opened.version.id, sent.id)), idempotencyKey: key('sourcing.award_propose') },
      effects: () => count(h, 'SELECT 1 FROM trustwork.award_decision WHERE rfq_id = $1', [id]),
    })).body as Award;
    const decided = await approve(award);
    await exactlyOnce({
      action: 'sourcing.award_execute', client: ada, url: `/v1/sourcing/awards/${award.award.id}/execute`,
      body: { awardDecisionId: award.award.id, transactionBudgetId: budget, expectedRevision: decided.revision, electronicRecords: { consented: true, disclosureKey: 'trustwork.electronic-records.v1' }, idempotencyKey: key('sourcing.award_execute') },
      effects: () => count(h, 'SELECT 1 FROM trustwork.commercial_order o JOIN trustwork.agreement a ON a.id = o.agreement_id WHERE a.award_decision_id = $1', [award.award.id]),
    });
    const current = ok<{ rfq: { revision: number } }>(await ada.get(`/v1/rfqs/${id}`));
    await exactlyOnce({
      action: 'sourcing.outcome_notify', client: rita, url: `/v1/sourcing/rfqs/${id}/outcome-notices`,
      body: { rfqId: id, awardDecisionId: award.award.id, includeFeedbackBands: false, expectedRevision: current.rfq.revision, idempotencyKey: key('sourcing.outcome_notify') },
      effects: () => count(h, 'SELECT 1 FROM trustwork.bid_outcome_notice WHERE rfq_id = $1', [id]),
    });

    // A second event for the award that is cancelled.
    const other = await publishRfq(ada, company(w.buyer), rfqPayload(), [supplier]);
    const otherQuote = await sendQuote(sam, other, supplier, quotePayload('3100'));
    const otherTemplate = ok<{ payload: unknown }>(await rita.get(`/v1/sourcing/rfqs/${other.rfq.id}/level-sheet/template`));
    const otherDraft = ok<Sheet>(await rita.post(`/v1/sourcing/rfqs/${other.rfq.id}/level-sheet/versions`, { rfqId: other.rfq.id, rfqVersionId: other.rfq.currentVersionId, payload: otherTemplate.payload }), 201);
    const otherSheet = ok<Sheet>(await rita.post(`/v1/sourcing/level-sheet-versions/${otherDraft.version.id}/freeze`, { digest: otherDraft.version.digest, expectedRevision: otherDraft.revision }));
    const otherAward = ok<Award>(await send(rita, `/v1/sourcing/rfqs/${other.rfq.id}/awards`, await proposal(other.rfq.id, otherSheet.version.id, otherQuote.versions.find((v) => v.status === 'sent')!.id)), 201);
    const toCancel = await approve(otherAward);
    await exactlyOnce({
      action: 'sourcing.award_cancel', client: rita, url: `/v1/sourcing/awards/${toCancel.award.id}/cancel`, body: { reason: 'Project on hold', expectedRevision: toCancel.revision },
      effects: () => count(h, "SELECT 1 FROM trustwork.award_decision WHERE id = $1 AND status = 'cancelled'", [toCancel.award.id]),
    });
  },
} satisfies CrashCase;
