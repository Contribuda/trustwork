import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance } from '@trustwork/data';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import type { BuyerAgreementView, SellerAgreementView, SellerQuoteView } from '../../packages/contracts/src/deals.js';
import type { AwardDecision, BidLevelSheetPayload, BidLevelSheetVersion, BidOutcomeNotice } from '../../packages/contracts/src/supply/sourcing.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { noPrequalificationEvidence } from '../../apps/api/src/modules/sourcing/eligibility.js';
import { AllowListSourcingMandates, NoSourcingMandates } from '../../apps/api/src/modules/sourcing/mandates.js';
import { SourcingService } from '../../apps/api/src/modules/sourcing/sourcing.service.js';
import { sanctionsScreening } from '../../apps/api/src/modules/supplier-base/screening.js';
import { NoDealMandates } from '../../apps/api/src/modules/sales/mandates.js';
import { ConfiguredElectronicRecords } from '../../apps/api/src/modules/transactions/electronic-records.js';
import { TransactionsService } from '../../apps/api/src/modules/transactions/transactions.service.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { amendRfq, as, company, count, fails, grant, ok, PERSON, publishRfq, quotePayload, refused, rfqPayload, seedWorld, sendQuote, signIn, usd, type Party } from './helpers.js';

/**
 * PRC-004 awards and outcome notices through HTTP on real PostgreSQL under the runtime role: an award goes through the
 * company's approval route bound to its digest, every outcome of the request reaches it, it executes only through the
 * COM-002 commands with a budget reservation, all selected quotes or none, and direct acceptance cannot walk around it.
 * Notices carry no other bidder's identity or price; bands appear only after award with the buyer's opt-in. Concurrent
 * decisions, proposals, executions and notices resolve once.
 */
const h = await startHarness('sourcing_awards');

const CONSENT = { consented: true as const, disclosureKey: 'trustwork.electronic-records.v1' };
type SheetView = { version: BidLevelSheetVersion; revision: number };
type Template = { payload: BidLevelSheetPayload };
type AwardView = { award: AwardDecision; digest: { value: string }; approvalOutcome: string | null; revision: number };
type RequestView = { id: string; revision: number; status: string; subjectDigest: { algorithm: string; value: string }; currentStep: string };
type Card = { request: RequestView };
type Notices = { notices: BidOutcomeNotice[] };
const REASONS = [{ category: 'price', text: 'Lowest levelled total' }];
const PRIVATE_REASON = 'PRIVATE-award-reason-text';
let keys = 0;
const send = (client: Client, url: string, body: Record<string, unknown>): Promise<Response> => {
  const key = `sourcing-award-${++keys}`;
  return client.post(url, { ...body, idempotencyKey: key }, { idempotencyKey: key });
};

test('award decisions and outcome notices', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const label = 'award';
  const w = await seedWorld(h, label);
  await grant(h.db.admin, w, 'dana', 'procurement.approval.decide');
  await grant(h.db.admin, w, 'mia', 'procurement.approval.decide');
  const [ada, rita, dana, mia, sam, tess, vera, otto] = [await signIn(h, 'ada', label), await signIn(h, 'rita', label), await signIn(h, 'dana', label), await signIn(h, 'mia', label), await signIn(h, 'sam', label), await signIn(h, 'tess', label), await signIn(h, 'vera', label), await signIn(h, 'otto', label)];
  const [a, b, c] = [company(w.supplierA), company(w.supplierB), company(w.supplierC)];
  const buyer = company(w.buyer);

  const grantBudget = (limit: string) => as(h, w, 'ada', (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'company', projectId: null, employeePersonId: null, periodFrom: '2026-01-01T00:00:00Z', periodTo: '2030-01-01T00:00:00Z', limitMinor: limit, currency: 'USD' }));
  const currentRfq = async (id: string) => ok<OwnerRfqView>(await ada.get(`/v1/rfqs/${id}`));

  /** A frozen sheet over what was sent so far. */
  const frozenSheet = async (rfq: OwnerRfqView): Promise<SheetView> => {
    const { payload } = ok<Template>(await rita.get(`/v1/sourcing/rfqs/${rfq.rfq.id}/level-sheet/template`));
    const opened = ok<SheetView>(await rita.post(`/v1/sourcing/rfqs/${rfq.rfq.id}/level-sheet/versions`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, payload }), 201);
    return ok<SheetView>(await rita.post(`/v1/sourcing/level-sheet-versions/${opened.version.id}/freeze`, { digest: opened.version.digest, expectedRevision: opened.revision }));
  };
  const sentOf = (quote: SellerQuoteView) => quote.versions.find((v) => v.status === 'sent')!;
  const pick = (quote: SellerQuoteView, lines: string[] = ['pavers', 'laying'], share = '1') => ({ quoteVersionId: sentOf(quote).id, rfqLineKeys: lines, share });
  const proposalBody = async (rfqId: string, sheet: SheetView, selection: ReturnType<typeof pick>[], reasons: { category: string; text: string }[] = REASONS) =>
    ({ rfqId, bidLevelSheetVersionId: sheet.version.id, selection, reasons, expectedRevision: (await currentRfq(rfqId)).rfq.revision });
  const propose = async (client: Client, rfqId: string, sheet: SheetView, selection: ReturnType<typeof pick>[], reasons?: { category: string; text: string }[]) => send(client, `/v1/sourcing/rfqs/${rfqId}/awards`, await proposalBody(rfqId, sheet, selection, reasons));
  const decide = async (client: Client, requestId: string, decision: 'approve' | 'reject' | 'return') => {
    const { request } = ok<Card>(await client.get(`/v1/approvals/requests/${requestId}`));
    return send(client, `/v1/approvals/requests/${requestId}/decide`, { approvalRequestId: requestId, step: request.currentStep, decision, subjectDigest: request.subjectDigest, reason: decision === 'approve' ? null : 'Not this time', expectedRevision: request.revision });
  };
  const award = async (client: Client, id: string) => ok<AwardView>(await client.get(`/v1/sourcing/awards/${id}`));
  const execute = (client: Client, view: AwardView, budget: string, over: Record<string, unknown> = {}) => send(client, `/v1/sourcing/awards/${view.award.id}/execute`, { awardDecisionId: view.award.id, transactionBudgetId: budget, expectedRevision: view.revision, electronicRecords: CONSENT, ...over });
  const notify = async (client: Client, rfqId: string, awardDecisionId: string | null, includeFeedbackBands = false) => send(client, `/v1/sourcing/rfqs/${rfqId}/outcome-notices`, { rfqId, awardDecisionId, includeFeedbackBands, expectedRevision: (await currentRfq(rfqId)).rfq.revision });
  const whole = async (invitees: readonly Party[] = [a, b, c]) => {
    const rfq = await publishRfq(ada, buyer, rfqPayload(), invitees);
    const [qa, qb] = [await sendQuote(sam, rfq, a, quotePayload('3000')), await sendQuote(tess, rfq, b, quotePayload('3100'))];
    return { rfq, qa, qb, sheet: await frozenSheet(rfq) };
  };
  const proposed = async (e: Awaited<ReturnType<typeof whole>>) => ok<AwardView>(await propose(rita, e.rfq.rfq.id, e.sheet, [pick(e.qa)]), 201);
  const approved = async (e: Awaited<ReturnType<typeof whole>>) => {
    const view = await proposed(e);
    ok(await decide(dana, view.award.approvalRequestId as string, 'approve'));
    return award(rita, view.award.id);
  };

  await t.test('without an active award route nothing is proposed, and a direct acceptance still works', async () => {
    const e = await whole();
    refused(await propose(rita, e.rfq.rfq.id, e.sheet, [pick(e.qa)]), 422, 'validation.schema', 'no_active_route');
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.award_decision WHERE rfq_id = $1', [e.rfq.rfq.id]), 0, 'the refusal rolled the award back');
    const sent = sentOf(e.qa);
    const current = e.rfq.versions.find((v) => v.id === e.rfq.rfq.currentVersionId)!;
    ok<BuyerAgreementView>(await ada.post('/v1/agreements', { rfqId: e.rfq.rfq.id, quoteVersion: { id: sent.id, version: sent.version, digest: sent.digest }, rfqVersion: { id: current.id, version: current.version, digest: current.digest }, expectedRevision: e.qa.quote.revision, electronicRecords: CONSENT, actor: PERSON }), 201);
  });

  const route = { receiverSoleApprovalThreshold: null, steps: [{ key: 'approve', order: 1, conditions: [], selector: { kind: 'permission_holders', permission: 'procurement.approval.decide', scope: 'company' }, quorum: 1, timeoutHours: 48, escalation: { kind: 'route_owner' } }] };
  const drafted = ok<{ id: string; digest: unknown }>(await ada.post('/v1/approvals/routes', { owner: buyer, subjectKind: 'award', payload: route, templateKey: null }), 201);
  ok(await send(ada, `/v1/approvals/routes/${drafted.id}/activate`, { routeVersionId: drafted.id, digest: drafted.digest, expectedRevision: 1 }));

  await t.test('negative authorization on proposals; the selection is checked; a partial award is refused at proposal', async () => {
    const e = await whole();
    const url = `/v1/sourcing/rfqs/${e.rfq.rfq.id}/awards`;
    const body = await proposalBody(e.rfq.rfq.id, e.sheet, [pick(e.qa)]);
    for (const outsider of [sam, tess, otto, mia]) refused(await send(outsider, url, body), 404, 'access.not_found');
    refused(await send(dana, url, body), 403, 'access.forbidden', 'not_authorised');
    refused(await send(rita, url, { ...body, actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
    refused(await send(rita, url, { ...body, expectedRevision: body.expectedRevision + 1 }), 409, 'validation.revision_conflict', 'revision_conflict');
    refused(await propose(rita, e.rfq.rfq.id, e.sheet, [pick(e.qa, ['pavers'])]), 422, 'validation.schema', 'partial_award_unavailable');
    refused(await propose(rita, e.rfq.rfq.id, e.sheet, [pick(e.qa, ['pavers', 'laying'], '0.5')]), 422, 'validation.schema', 'partial_award_unavailable');
    refused(await propose(rita, e.rfq.rfq.id, e.sheet, [pick(e.qa), pick(e.qa)]), 422, 'validation.schema', 'selection_duplicate');
    refused(await propose(rita, e.rfq.rfq.id, e.sheet, [pick(e.qa), pick(e.qb)]), 422, 'validation.schema', 'line_awarded_twice');

    const person = await publishRfq(otto, { kind: 'person', id: w.people.otto }, rfqPayload(), [a]);
    const quote = await sendQuote(sam, person, a, quotePayload('3000'));
    const { payload } = ok<Template>(await otto.get(`/v1/sourcing/rfqs/${person.rfq.id}/level-sheet/template`));
    const sheet = ok<SheetView>(await otto.post(`/v1/sourcing/rfqs/${person.rfq.id}/level-sheet/versions`, { rfqId: person.rfq.id, rfqVersionId: person.rfq.currentVersionId, payload }), 201);
    refused(await send(otto, `/v1/sourcing/rfqs/${person.rfq.id}/awards`, { rfqId: person.rfq.id, bidLevelSheetVersionId: sheet.version.id, selection: [pick(quote)], reasons: REASONS, expectedRevision: person.rfq.revision }), 422, 'validation.schema', 'company_buyer_required');
  });

  await t.test('an award rests on a frozen sheet and on comparable columns', async () => {
    const rfq = await publishRfq(ada, buyer, rfqPayload(), [a, b]);
    const qa = await sendQuote(sam, rfq, a, quotePayload('3000'));
    const { payload } = ok<Template>(await rita.get(`/v1/sourcing/rfqs/${rfq.rfq.id}/level-sheet/template`));
    const draft = ok<SheetView>(await rita.post(`/v1/sourcing/rfqs/${rfq.rfq.id}/level-sheet/versions`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, payload }), 201);
    refused(await propose(rita, rfq.rfq.id, draft, [pick(qa)]), 422, 'validation.schema', 'sheet_not_frozen');
    const sheet = ok<SheetView>(await rita.post(`/v1/sourcing/level-sheet-versions/${draft.version.id}/freeze`, { digest: draft.version.digest, expectedRevision: draft.revision }));
    const qb = await sendQuote(tess, rfq, b, quotePayload('2900'));
    refused(await propose(rita, rfq.rfq.id, sheet, [pick(qb)]), 409, 'commercial.stale_version', 'not_comparable');
    await amendRfq(ada, rfq, rfqPayload({ quantity: '100' }));
    refused(await propose(rita, rfq.rfq.id, sheet, [pick(qa)]), 409, 'commercial.rfq_version_not_current', 'rfq_version_not_current');
  });

  let split: { rfq: OwnerRfqView; qa: SellerQuoteView; qb: SellerQuoteView; view: AwardView; budget: string };
  await t.test('a split award: approval bound to the digest, then both quotes through the COM-002 commands in one commit', async () => {
    const rfq = await publishRfq(ada, buyer, rfqPayload(), [a, b, c]);
    const [qa, qb] = [await sendQuote(sam, rfq, a, quotePayload('3000', { lines: ['pavers'] })), await sendQuote(tess, rfq, b, quotePayload('3000', { lines: ['laying'] }))];
    const sheet = await frozenSheet(rfq);
    const view = ok<AwardView>(await propose(rita, rfq.rfq.id, sheet, [pick(qa, ['pavers']), pick(qb, ['laying'])], [{ category: 'price', text: PRIVATE_REASON }]), 201);
    assert.equal(view.award.status, 'in_approval');
    assert.equal(view.award.bidLevelSheetVersionId, sheet.version.id);
    const requestId = view.award.approvalRequestId as string;

    const card = ok<Card>(await dana.get(`/v1/approvals/requests/${requestId}`));
    assert.equal(card.request.subjectDigest.value, view.digest.value, 'the approval binds the award digest');
    refused(await decide(rita, requestId, 'approve'), 403, 'access.forbidden', 'requester_cannot_decide');
    refused(await send(dana, `/v1/approvals/requests/${requestId}/decide`, { approvalRequestId: requestId, step: 'approve', decision: 'approve', subjectDigest: { ...card.request.subjectDigest, value: 'a'.repeat(64) }, reason: null, expectedRevision: card.request.revision }), 409, 'access.approval_digest_mismatch');
    refused(await send(dana, `/v1/approvals/requests/${requestId}/decide`, { approvalRequestId: requestId, step: 'approve', decision: 'approve', subjectDigest: card.request.subjectDigest, reason: null, expectedRevision: card.request.revision, actor: { via: 'agent', mandateId: 'mandate-any' } }), 403, 'access.mandate_scope');

    const budget = await grantBudget('10000000');
    refused(await execute(ada, view, budget), 403, 'access.forbidden', 'award_not_approved');

    // An approver without any deal right reads the award and the frozen sheet it rests on, and nothing else of the event.
    assert.equal((await award(mia, view.award.id)).award.id, view.award.id);
    ok(await mia.get(`/v1/sourcing/level-sheet-versions/${sheet.version.id}`));
    refused(await mia.get(`/v1/sourcing/rfqs/${rfq.rfq.id}`), 404, 'access.not_found');

    ok(await decide(dana, requestId, 'approve'));
    const decided = await award(rita, view.award.id);
    assert.deepEqual([decided.award.status, decided.approvalOutcome], ['approved', 'approved']);
    split = { rfq, qa, qb, view: decided, budget };
  });

  await t.test('direct acceptance cannot walk around the award, and execution needs authority', async () => {
    const { rfq, qa, view, budget } = split;
    const sent = sentOf(qa);
    const current = rfq.versions.find((v) => v.id === rfq.rfq.currentVersionId)!;
    const accept = { rfqId: rfq.rfq.id, quoteVersion: { id: sent.id, version: sent.version, digest: sent.digest }, rfqVersion: { id: current.id, version: current.version, digest: current.digest }, expectedRevision: qa.quote.revision, electronicRecords: CONSENT, actor: PERSON };
    refused(await ada.post('/v1/agreements', accept), 403, 'access.forbidden', 'award_required');

    refused(await execute(rita, view, budget), 403, 'access.forbidden', 'not_authorised');
    for (const outsider of [sam, tess, otto, mia]) refused(await execute(outsider, view, budget), 404, 'access.not_found');
    refused(await execute(ada, view, budget, { expectedRevision: view.revision + 1 }), 409, 'validation.revision_conflict', 'revision_conflict');
    refused(await execute(ada, view, budget, { actor: { via: 'agent', mandateId: 'mandate-without-store' } }), 403, 'access.mandate_scope');
    refused(await execute(ada, view, budget, { electronicRecords: null }), 422, 'validation.schema', 'electronic_records_consent_required');
  });

  await t.test('all selected quotes or none: a budget too small for the second order leaves nothing behind', async () => {
    const { rfq, view } = split;
    const small = await grantBudget('31000');
    refused(await execute(ada, view, small), 409, 'commercial.budget_insufficient');
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.agreement WHERE rfq_id = $1', [rfq.rfq.id]), 0);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.reservation WHERE budget_id = $1', [small]), 0);
    assert.equal((await award(ada, view.award.id)).award.status, 'approved');
  });

  await t.test('execution: one agreement and one order per quote, reserved on the budget, sellers then accept as usual', async () => {
    const { rfq, qa, qb, view, budget } = split;
    const done = ok<AwardView>(await execute(ada, view, budget));
    assert.equal(done.award.status, 'executed');
    assert.equal(done.award.agreementIds.length, 2);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.commercial_order o JOIN trustwork.agreement a ON a.id = o.agreement_id WHERE a.rfq_id = $1 AND o.status = 'placed' AND o.reservation_id IS NOT NULL", [rfq.rfq.id]), 2);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.agreement WHERE rfq_id = $1 AND award_decision_id = $2', [rfq.rfq.id, view.award.id]), 2);
    refused(await execute(ada, { ...done }, budget), 403, 'access.forbidden', 'award_not_approved');

    for (const [client, quote] of [[sam, qa], [tess, qb]] as const) {
      const list = ok<{ agreements: { id: string; rfqId: string }[] }>(await client.get('/v1/agreements')).agreements.filter((x) => x.rfqId === rfq.rfq.id);
      assert.equal(list.length, 1, 'a seller sees only its own agreement');
      const seller = ok<SellerAgreementView>(await client.get(`/v1/agreements/${list[0]!.id}`));
      assert.equal(seller.quoteId, quote.quote.id);
      const json = JSON.stringify(seller);
      for (const secret of [view.award.id, PRIVATE_REASON, 'award_decision', 'bidLevelSheetVersionId']) assert.ok(!json.includes(secret), `${secret} reached a seller`);
      ok<SellerAgreementView>(await client.post(`/v1/agreements/${list[0]!.id}/accept`, { expectedRevision: seller.agreement.revision, acceptedTermsDigest: seller.agreement.acceptedTerms.digest, electronicRecords: CONSENT, actor: PERSON }));
    }
    await fails(withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.agreement SET award_decision_id = NULL WHERE award_decision_id = ${view.award.id}::uuid`.execute(trx)), 'commerce.version_frozen');
    await fails(withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.award_decision SET selection = '[]'::jsonb WHERE id = ${view.award.id}::uuid`.execute(trx)), 'sourcing.frozen');
    await fails(withMaintenance(h.db.admin, (trx) => sql`DELETE FROM trustwork.award_decision WHERE id = ${view.award.id}::uuid`.execute(trx)), 'commerce.retained');
    await fails(as(h, w, 'ada', (trx) => sql`UPDATE trustwork.award_decision SET status = 'cancelled' WHERE id = ${view.award.id}::uuid`.execute(trx)), '42501');
    const proposal = await proposalBody(rfq.rfq.id, { version: { id: view.award.bidLevelSheetVersionId } } as SheetView, [pick(qa, ['pavers'])]);
    refused(await send(rita, `/v1/sourcing/rfqs/${rfq.rfq.id}/awards`, proposal), 409, 'validation.revision_conflict', 'award_exists');
  });

  await t.test('an order change keeps the agreement inside its award, so the other supplier of a split award is untouched', async () => {
    const { rfq, qa, view, budget } = split;
    let quote = ok<SellerQuoteView>(await sam.get(`/v1/quotes/${qa.quote.id}`));
    quote = ok<SellerQuoteView>(await sam.post(`/v1/quotes/${qa.quote.id}/versions`, { expectedRevision: quote.quote.revision, rfqVersionId: rfq.rfq.currentVersionId, payload: quotePayload('2900', { lines: ['pavers'] }), answersAmendmentRequestId: null, actor: PERSON }), 201);
    const next = quote.versions.at(-1)!;
    quote = ok<SellerQuoteView>(await sam.post(`/v1/quotes/${qa.quote.id}/send`, { quoteId: qa.quote.id, version: next.version, expectedRevision: quote.quote.revision, actor: PERSON }));
    const sent = quote.versions.at(-1)!;
    const id = ok<{ agreements: { id: string; rfqId: string }[] }>(await sam.get('/v1/agreements')).agreements.find((x) => x.rfqId === rfq.rfq.id)!.id;
    const seller = ok<SellerAgreementView>(await sam.get(`/v1/agreements/${id}`));
    const order = seller.orders[0]!;
    const changing = ok<SellerAgreementView>(await sam.post(`/v1/orders/${order.id}/changes`, { expectedRevision: order.revision, quoteVersion: { id: sent.id, version: sent.version, digest: sent.digest }, transactionBudgetId: null, actor: PERSON }), 201);
    const change = changing.orderChanges.at(-1)!;
    ok<BuyerAgreementView>(await ada.post(`/v1/orders/${order.id}/changes/${change.id}`, { expectedRevision: change.revision, decision: 'accept', transactionBudgetId: budget, reason: null, actor: PERSON }));
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.agreement WHERE rfq_id = $1 AND award_decision_id = $2 AND status = 'accepted_by_both'", [rfq.rfq.id, view.award.id]), 2, 'the new agreement stays in the award, the other supplier keeps its own');
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.agreement WHERE rfq_id = $1 AND award_decision_id IS NULL', [rfq.rfq.id]), 0);
  });

  await t.test('forbidden fields: an award never reaches a seller, a table read or an outbox event', async () => {
    const { rfq, view } = split;
    for (const outsider of [sam, tess, vera, otto]) {
      refused(await outsider.get(`/v1/sourcing/awards/${view.award.id}`), 404, 'access.not_found');
      refused(await outsider.get(`/v1/sourcing/rfqs/${rfq.rfq.id}`), 404, 'access.not_found');
    }
    for (const person of ['sam', 'tess', 'vera', 'otto'] as const) {
      const rows: number = await as(h, w, person, async (trx): Promise<number> => (await trx.selectFrom('award_decision').select('id').execute()).length);
      assert.equal(rows, 0, person);
    }
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.outbox_event WHERE payload::text LIKE '%' || $1 || '%'", [PRIVATE_REASON]), 0);
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.audit_event WHERE action LIKE 'sourcing.%' AND basis::text LIKE '%' || $1 || '%'", [PRIVATE_REASON]), 0);
  });

  await t.test('notices: only after an executed award, once, to every invitee, with no other bidder and no price', async () => {
    const { rfq, view, qa } = split;
    const pendingEvent = await whole();
    const pending = await proposed(pendingEvent);
    refused(await notify(rita, pendingEvent.rfq.rfq.id, pending.award.id), 422, 'validation.schema', 'award_not_executed');
    refused(await notify(rita, pendingEvent.rfq.rfq.id, null), 422, 'validation.schema', 'rfq_not_closed');
    refused(await notify(dana, rfq.rfq.id, view.award.id), 403, 'access.forbidden', 'not_authorised');
    for (const outsider of [sam, otto, mia]) refused(await notify(outsider, rfq.rfq.id, view.award.id), 404, 'access.not_found');

    const sent = ok<Notices>(await notify(rita, rfq.rfq.id, view.award.id), 201);
    assert.equal(sent.notices.length, 3, 'every invitee, also the one who never answered');
    const outcomes = new Map(sent.notices.map((n) => [n.recipient.id, n]));
    assert.deepEqual([outcomes.get(w.supplierA)?.outcome, outcomes.get(w.supplierB)?.outcome, outcomes.get(w.supplierC)?.outcome], ['awarded', 'awarded', 'not_awarded']);
    assert.ok(sent.notices.every((n) => n.feedbackBand === null && n.reasonCategory === null), 'no band without the opt-in');
    refused(await notify(rita, rfq.rfq.id, view.award.id), 409, 'validation.revision_conflict', 'already_notified');

    const mine = ok<Notices>(await vera.get('/v1/sourcing/outcome-notices'));
    assert.equal(mine.notices.length, 1);
    assert.deepEqual(Object.keys(mine.notices[0]!).sort(), ['buyerOptedInToFeedback', 'feedbackBand', 'id', 'outcome', 'reasonCategory', 'recipient', 'rfqId', 'sentAt']);
    const json = JSON.stringify(mine);
    for (const secret of [w.supplierA, w.supplierB, qa.quote.id, view.award.id, '30000', '50000']) assert.ok(!json.includes(secret), `${secret} reached a not-awarded bidder`);
    assert.deepEqual(ok<Notices>(await otto.get('/v1/sourcing/outcome-notices')).notices, []);
    assert.deepEqual(ok<Notices>(await mia.get('/v1/sourcing/outcome-notices')).notices, []);
    await fails(withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.bid_outcome_notice SET feedback_band = 'within_5pct' WHERE rfq_id = ${rfq.rfq.id}::uuid`.execute(trx)), 'audit.append_only');
    await fails(withMaintenance(h.db.admin, (trx) => sql`INSERT INTO trustwork.bid_outcome_notice (rfq_id, recipient_company_id, outcome, feedback_band, buyer_opted_in_to_feedback) VALUES (${rfq.rfq.id}::uuid, ${w.otherBuyer}::uuid, 'awarded', 'within_5pct', true)`.execute(trx)), '23514');
    await fails(withMaintenance(h.db.admin, (trx) => sql`INSERT INTO trustwork.bid_outcome_notice (rfq_id, recipient_company_id, outcome, feedback_band, buyer_opted_in_to_feedback) VALUES (${rfq.rfq.id}::uuid, ${w.otherBuyer}::uuid, 'not_awarded', 'within_5pct', false)`.execute(trx)), '23514');
    const events = await h.db.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM trustwork.outbox_event WHERE type = 'sourcing.outcome_notice_sent'");
    assert.ok(events.rows.length >= 3 && events.rows.every((e) => Object.keys(e.payload).sort().join() === 'noticeId,rfqId'), 'identifiers only');
  });

  await t.test('a cancelled event tells every invitee so, and never with a band', async () => {
    const e = await whole();
    const view = await currentRfq(e.rfq.rfq.id);
    ok(await ada.post(`/v1/rfqs/${e.rfq.rfq.id}/close`, { outcome: 'cancelled', expectedRevision: view.rfq.revision, reason: 'Project on hold' }));
    const sent = ok<Notices>(await notify(rita, e.rfq.rfq.id, null), 201);
    assert.deepEqual(sent.notices.map((n) => n.outcome), ['cancelled', 'cancelled', 'cancelled']);
  });

  await t.test('bands: with the hub allowing and the buyer opting in, after award, only a not-awarded bidder gets its own band', async () => {
    const services = h.services();
    const ctx = h.created.ctx!;
    const transactions = new TransactionsService(ctx, services.principals, services.participations, new NoDealMandates(), new ConfiguredElectronicRecords());
    const service = (feedbackBandsAllowed: boolean) => new SourcingService(ctx, services.principals, new NoSourcingMandates(), sanctionsScreening, noPrequalificationEvidence, transactions, feedbackBandsAllowed);
    const allowed = service(true);
    const token = rita.sessionCookie as string;
    const resolved = await services.principals.resolve(token);
    assert.ok(resolved);
    const state: RequestState = { requestId: 'sourcing-bands', principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };

    const rfq = await publishRfq(ada, buyer, rfqPayload(), [a, b, c]);
    // Totals: A 80,000 wins; B 82,000 is within 5 %; C 100,000 is above 15 %.
    const qa = await sendQuote(sam, rfq, a, quotePayload('3000'));
    await sendQuote(tess, rfq, b, quotePayload('3200'));
    await sendQuote(vera, rfq, c, quotePayload('5000'));
    const sheet = await frozenSheet(rfq);
    const view = ok<AwardView>(await propose(rita, rfq.rfq.id, sheet, [pick(qa)]), 201);
    ok(await decide(dana, view.award.approvalRequestId as string, 'approve'));
    const budget = await grantBudget('10000000');
    const before = await currentRfq(rfq.rfq.id);
    await assert.rejects(allowed.notifyOutcomes(state, rfq.rfq.id, { rfqId: rfq.rfq.id, awardDecisionId: view.award.id, includeFeedbackBands: true, expectedRevision: before.rfq.revision, idempotencyKey: randomUUID(), actor: PERSON }), (e: { code?: string }) => { assert.equal(e.code, 'validation.schema'); return true; }, 'never before the award is executed');
    ok(await execute(ada, await award(ada, view.award.id), budget));

    const after = await currentRfq(rfq.rfq.id);
    await assert.rejects(service(false).notifyOutcomes(state, rfq.rfq.id, { rfqId: rfq.rfq.id, awardDecisionId: view.award.id, includeFeedbackBands: true, expectedRevision: after.rfq.revision, idempotencyKey: randomUUID(), actor: PERSON }), (e: { code?: string; details?: { reason?: string } }) => { assert.equal(e.details?.reason, 'feedback_bands_not_allowed'); return true; }, 'a hub may switch the opt-in off');
    const sent = await allowed.notifyOutcomes(state, rfq.rfq.id, { rfqId: rfq.rfq.id, awardDecisionId: view.award.id, includeFeedbackBands: true, expectedRevision: after.rfq.revision, idempotencyKey: randomUUID(), actor: PERSON });
    const by = new Map(sent.notices.map((n) => [n.recipient.id, n]));
    assert.deepEqual([by.get(w.supplierA)?.outcome, by.get(w.supplierA)?.feedbackBand, by.get(w.supplierA)?.reasonCategory], ['awarded', null, null]);
    assert.deepEqual([by.get(w.supplierB)?.outcome, by.get(w.supplierB)?.feedbackBand, by.get(w.supplierB)?.reasonCategory], ['not_awarded', 'within_5pct', 'price']);
    assert.deepEqual([by.get(w.supplierC)?.outcome, by.get(w.supplierC)?.feedbackBand, by.get(w.supplierC)?.reasonCategory], ['not_awarded', 'above_15pct', 'price']);
    const theirs = ok<Notices>(await tess.get('/v1/sourcing/outcome-notices')).notices.find((n) => n.rfqId === rfq.rfq.id)!;
    assert.equal(theirs.feedbackBand, 'within_5pct');
    const json = JSON.stringify(theirs);
    for (const secret of [w.supplierA, w.supplierC, '80000', '82000', '100000']) assert.ok(!json.includes(secret), `${secret} reached a bidder`);
  });

  await t.test('an agent proposes under a prepare mandate and a person decides; another action of the same mandate does not stretch', async () => {
    const services = h.services();
    const ctx = h.created.ctx!;
    const transactions = new TransactionsService(ctx, services.principals, services.participations, new NoDealMandates(), new ConfiguredElectronicRecords());
    const mandates = new AllowListSourcingMandates([{ personId: w.people.rita, mandateId: 'mandate-demo-sourcing', action: 'prepare' }]);
    const service = new SourcingService(ctx, services.principals, mandates, sanctionsScreening, noPrequalificationEvidence, transactions, true);
    const token = rita.sessionCookie as string;
    const resolved = await services.principals.resolve(token);
    assert.ok(resolved);
    const state: RequestState = { requestId: 'sourcing-agent', principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    const agent = { via: 'agent' as const, mandateId: 'mandate-demo-sourcing' };
    const e = await whole();
    const body = await proposalBody(e.rfq.rfq.id, e.sheet, [pick(e.qa)]);
    const view = await service.proposeAward(state, e.rfq.rfq.id, { ...body, idempotencyKey: randomUUID(), actor: agent, reasons: REASONS as never });
    assert.equal(view.award.status, 'in_approval');
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.award_decision WHERE id = $1 AND proposed_via = 'agent' AND proposed_mandate_id = 'mandate-demo-sourcing'", [view.award.id]), 1);
    await assert.rejects(service.notifyOutcomes(state, e.rfq.rfq.id, { rfqId: e.rfq.rfq.id, awardDecisionId: view.award.id, includeFeedbackBands: false, expectedRevision: body.expectedRevision, idempotencyKey: randomUUID(), actor: agent }), (error: { code?: string }) => { assert.equal(error.code, 'access.mandate_scope'); return true; }, 'prepare does not send notices');
    refused(await decide(rita, view.award.approvalRequestId as string, 'approve'), 403, 'access.forbidden', 'requester_cannot_decide');

    // An award is voided only by a person: not by freezing a newer sheet while it waits, not by cancelling it once approved.
    const humanOnly = (error: { code?: string; details?: { reason?: string } }) => { assert.deepEqual([error.code, error.details?.reason], ['access.mandate_scope', 'human_only']); return true; };
    const next = ok<SheetView>(await rita.post(`/v1/sourcing/rfqs/${e.rfq.rfq.id}/level-sheet/versions`, { rfqId: e.rfq.rfq.id, rfqVersionId: e.rfq.rfq.currentVersionId, payload: e.sheet.version.payload }), 201);
    await assert.rejects(service.freezeSheet(state, next.version.id, { digest: next.version.digest, expectedRevision: next.revision, actor: agent }), humanOnly);
    assert.equal((await award(rita, view.award.id)).award.status, 'in_approval');
    ok(await decide(dana, view.award.approvalRequestId as string, 'approve'));
    const decided = await award(rita, view.award.id);
    await assert.rejects(service.cancelAward(state, view.award.id, { reason: 'The agent would rather not', expectedRevision: decided.revision, actor: agent }), humanOnly);
    await assert.rejects(service.freezeSheet(state, next.version.id, { digest: next.version.digest, expectedRevision: next.revision, actor: agent }), humanOnly);
    assert.equal((await award(rita, view.award.id)).award.status, 'approved');
    await fails(as(h, w, 'rita', (trx) => sql`SELECT trustwork.sourcing_cancel_award(${view.award.id}::uuid, 'No session', ${decided.revision}::integer, NULL::uuid)`.execute(trx)), 'approvals.first_party_required');
  });

  await t.test('every other outcome of the request ends the award as rejected and frees the RFQ for a new one', async () => {
    const outcome = async (e: Awaited<ReturnType<typeof whole>>, act: (view: AwardView) => Promise<void>, expected: string) => {
      const view = await proposed(e);
      await act(view);
      const seen = await award(rita, view.award.id);
      assert.deepEqual([seen.award.status, seen.approvalOutcome], ['rejected', expected]);
      refused(await execute(ada, seen, 'b0000000-0000-4000-8000-000000000000'), 403, 'access.forbidden', 'award_not_approved');
    };
    const e = await whole();
    await outcome(e, async (view) => { ok(await decide(dana, view.award.approvalRequestId as string, 'reject')); }, 'rejected');
    await outcome(e, async (view) => { ok(await decide(dana, view.award.approvalRequestId as string, 'return')); }, 'returned');
    await outcome(e, async (view) => {
      const { request } = ok<Card>(await rita.get(`/v1/approvals/requests/${view.award.approvalRequestId}`));
      ok(await send(rita, `/v1/approvals/requests/${request.id}/withdraw`, { expectedRevision: request.revision }));
    }, 'withdrawn');
    await outcome(e, async (view) => { await withMaintenance(h.db.admin, (trx) => sql`SELECT trustwork.approval_close(${view.award.approvalRequestId}::uuid, 'expired', now())`.execute(trx)); }, 'expired');
    const next = ok<SheetView>(await rita.post(`/v1/sourcing/rfqs/${e.rfq.rfq.id}/level-sheet/versions`, { rfqId: e.rfq.rfq.id, rfqVersionId: e.rfq.rfq.currentVersionId, payload: e.sheet.version.payload }), 201);
    await outcome(e, async () => { await Promise.resolve(); ok(await rita.post(`/v1/sourcing/level-sheet-versions/${next.version.id}/freeze`, { digest: next.version.digest, expectedRevision: next.revision })); }, 'superseded');
  });

  await t.test('an approved award that went stale does not execute: the digests of COM-002 refuse it, and the buyer cancels', async () => {
    const e = await whole();
    const view = await approved(e);
    const budget = await grantBudget('10000000');
    const seller = ok<SellerQuoteView>(await sam.get(`/v1/quotes/${e.qa.quote.id}`));
    ok(await sam.post(`/v1/quotes/${e.qa.quote.id}/withdraw`, { expectedRevision: seller.quote.revision, reason: 'Stock sold out', actor: PERSON }));
    const refusedExecution = await execute(ada, view, budget);
    assert.equal(refusedExecution.status, 409, JSON.stringify(refusedExecution.body));
    assert.equal((await award(rita, view.award.id)).award.status, 'approved');
    refused(await dana.post(`/v1/sourcing/awards/${view.award.id}/cancel`, { reason: 'The bid was withdrawn', expectedRevision: view.revision }), 403, 'access.forbidden', 'not_authorised');
    refused(await sam.post(`/v1/sourcing/awards/${view.award.id}/cancel`, { reason: 'The bid was withdrawn', expectedRevision: view.revision }), 404, 'access.not_found');
    const cancelled = ok<AwardView>(await rita.post(`/v1/sourcing/awards/${view.award.id}/cancel`, { reason: 'The bid was withdrawn', expectedRevision: view.revision }));
    assert.equal(cancelled.award.status, 'cancelled');
  });

  await t.test('an award on a superseded sheet does not execute', async () => {
    const e = await whole();
    const view = await approved(e);
    const next = ok<SheetView>(await rita.post(`/v1/sourcing/rfqs/${e.rfq.rfq.id}/level-sheet/versions`, { rfqId: e.rfq.rfq.id, rfqVersionId: e.rfq.rfq.currentVersionId, payload: e.sheet.version.payload }), 201);
    ok(await rita.post(`/v1/sourcing/level-sheet-versions/${next.version.id}/freeze`, { digest: next.version.digest, expectedRevision: next.revision }));
    refused(await execute(ada, view, await grantBudget('10000000')), 409, 'validation.revision_conflict', 'sheet_superseded');
  });

  await t.test('concurrency: proposals, decisions, executions, execution against cancellation and notices each resolve once', async () => {
    const first = await whole();
    const body = await proposalBody(first.rfq.rfq.id, first.sheet, [pick(first.qa)]);
    const proposals = await Promise.all([send(rita, `/v1/sourcing/rfqs/${first.rfq.rfq.id}/awards`, body), send(ada, `/v1/sourcing/rfqs/${first.rfq.rfq.id}/awards`, body)]);
    assert.deepEqual(proposals.map((r) => r.status).sort(), [201, 409], JSON.stringify(proposals.map((r) => r.body)));
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.award_decision WHERE rfq_id = $1 AND status = 'in_approval'", [first.rfq.rfq.id]), 1);

    const view = proposals.find((r) => r.status === 201)!.body as AwardView;
    const requestId = view.award.approvalRequestId as string;
    const { request } = ok<Card>(await dana.get(`/v1/approvals/requests/${requestId}`));
    const decision = { approvalRequestId: requestId, step: request.currentStep, subjectDigest: request.subjectDigest, reason: null, expectedRevision: request.revision };
    const decisions = await Promise.all([send(dana, `/v1/approvals/requests/${requestId}/decide`, { ...decision, decision: 'approve' }), send(mia, `/v1/approvals/requests/${requestId}/decide`, { ...decision, decision: 'approve' })]);
    assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409], JSON.stringify(decisions.map((r) => r.body)));
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.approval_decision WHERE approval_request_id = $1', [requestId]), 1);
    const decided = await award(ada, view.award.id);
    assert.equal(decided.award.status, 'approved');

    const budget = await grantBudget('10000000');
    const executions = await Promise.all([execute(ada, decided, budget), execute(ada, decided, budget)]);
    assert.deepEqual(executions.map((r) => r.status).sort(), [200, 409], JSON.stringify(executions.map((r) => r.body)));
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.agreement WHERE award_decision_id = $1', [view.award.id]), 1);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.commercial_order o JOIN trustwork.agreement a ON a.id = o.agreement_id WHERE a.award_decision_id = $1', [view.award.id]), 1);

    const race = await whole();
    const pendingCancel = await approved(race);
    const results = await Promise.all([execute(ada, pendingCancel, budget), rita.post(`/v1/sourcing/awards/${pendingCancel.award.id}/cancel`, { reason: 'Changed our mind', expectedRevision: pendingCancel.revision })]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body)));
    const final = await award(ada, pendingCancel.award.id);
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.agreement WHERE award_decision_id = $1', [pendingCancel.award.id]), final.award.status === 'executed' ? 1 : 0);

    const notices = await Promise.all([notify(rita, first.rfq.rfq.id, view.award.id), notify(ada, first.rfq.rfq.id, view.award.id)]);
    assert.deepEqual(notices.map((r) => r.status).sort(), [201, 409], JSON.stringify(notices.map((r) => r.body)));
    assert.equal(await count(h.db.admin, 'SELECT 1 FROM trustwork.bid_outcome_notice WHERE rfq_id = $1', [first.rfq.rfq.id]), 3);
  });

  /* ---------- What a route weighs (kept last: it activates another route) ---------- */
  const holders = { kind: 'permission_holders', permission: 'procurement.approval.decide', scope: 'company' };
  const step = (key: string, order: number, conditions: unknown[]) => ({ key, order, conditions, selector: holders, quorum: 1, timeoutHours: 48, escalation: { kind: 'route_owner' } });
  const next = { receiverSoleApprovalThreshold: null, steps: [step('manager', 1, []), step('commercial_director', 2, [{ kind: 'amount_above', amount: usd('100000') }]), step('risk_review', 3, [{ kind: 'supplier_status_in', statuses: ['on_hold', 'prospect'] }])] };
  const steps = async (view: AwardView) => (await h.db.admin.query<{ step_key: string }>('SELECT step_key FROM trustwork.approval_request_step WHERE request_id = $1 ORDER BY step_order', [view.award.approvalRequestId])).rows.map((r) => r.step_key);

  await t.test('a self-chosen exchange rate never reaches the route: the required approver stays, on the native gross', async () => {
    const draft = ok<{ id: string; digest: unknown }>(await ada.post('/v1/approvals/routes', { owner: buyer, subjectKind: 'award', payload: next, templateKey: null }), 201);
    ok(await send(ada, `/v1/approvals/routes/${draft.id}/activate`, { routeVersionId: draft.id, digest: draft.digest, expectedRevision: 1 }));
    const rfq = await publishRfq(ada, buyer, rfqPayload(), [a]);
    // 5,000,000.00 EUR, levelled at a rate the buyer typed in: 0.0001 makes it 500.00 USD.
    const quote = await sendQuote(sam, rfq, a, quotePayload('40000000', { laying: '100000000', currency: 'EUR' }));
    const { payload } = ok<Template>(await rita.get(`/v1/sourcing/rfqs/${rfq.rfq.id}/level-sheet/template`));
    const tiny = (m: { minorUnits: string }) => usd((BigInt(m.minorUnits) / 10000n).toString());
    const prices: Record<string, [string, string]> = { pavers: ['40000000', '400000000'], laying: ['100000000', '100000000'] };
    const claimed: BidLevelSheetPayload = {
      ...payload, exchangeRateSnapshot: { base: 'EUR', quote: 'USD', rate: '0.0001', source: 'Typed in by the buyer', observedAt: '2026-11-03T12:00:00.000Z' },
      cells: payload.cells.map((c) => ({ ...c, unitPrice: tiny({ minorUnits: prices[c.rfqLineKey]![0] }), lineTotal: tiny({ minorUnits: prices[c.rfqLineKey]![1] }) })),
    };
    const opened = ok<SheetView>(await rita.post(`/v1/sourcing/rfqs/${rfq.rfq.id}/level-sheet/versions`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, payload: claimed }), 201);
    assert.ok(opened.version.payload.columns.every((col) => col.comparable), 'the rate serves the display');
    const sheet = ok<SheetView>(await rita.post(`/v1/sourcing/level-sheet-versions/${opened.version.id}/freeze`, { digest: opened.version.digest, expectedRevision: opened.revision }));
    const view = ok<AwardView>(await propose(rita, rfq.rfq.id, sheet, [pick(quote)]), 201);
    assert.ok((await steps(view)).includes('commercial_director'), 'a foreign amount fails closed');
    assert.equal(await count(h.db.admin, "SELECT 1 FROM trustwork.approval_request WHERE id = $1 AND amount_minor = 500000000 AND currency = 'EUR'", [view.award.approvalRequestId]), 1, 'the route saw the native gross');
  });

  await t.test('the amount still routes in its own currency, and a supplier missing from the base makes a status step apply', async () => {
    const e = await whole([a, b]);
    const small = ok<AwardView>(await propose(rita, e.rfq.rfq.id, e.sheet, [pick(e.qa)]), 201);
    assert.deepEqual(await steps(small), ['manager', 'risk_review'], '80,000 minor units are below the director, and nobody knows this supplier');
    const known = await whole([a, b]);
    const key = randomUUID();
    ok(await ada.post('/v1/supplier-base/suppliers', { supplierRecordId: null, link: { kind: 'company', id: w.supplierA }, status: 'approved', regions: [], expectedRevision: 1, idempotencyKey: key }, { idempotencyKey: key }));
    assert.deepEqual(await steps(ok<AwardView>(await propose(rita, known.rfq.rfq.id, known.sheet, [pick(known.qa)]), 201)), ['manager'], 'a known, approved supplier skips the status step');
  });

  await t.test('a split across different statuses cannot skip a status step that names only one of them', async () => {
    for (const [id, status] of [[w.supplierB, 'prospect'], [w.supplierC, 'blocked']] as const) {
      const key = randomUUID();
      ok(await ada.post('/v1/supplier-base/suppliers', { supplierRecordId: null, link: { kind: 'company', id }, status, regions: [], expectedRevision: 1, idempotencyKey: key }, { idempotencyKey: key }));
    }
    const rfq = await publishRfq(ada, buyer, rfqPayload(), [b, c]);
    const [qb, qc] = [await sendQuote(tess, rfq, b, quotePayload('3000', { lines: ['pavers'] })), await sendQuote(vera, rfq, c, quotePayload('3000', { lines: ['laying'] }))];
    const sheet = await frozenSheet(rfq);
    // The step names `prospect`. The blocked supplier is the riskier one, and must not hide the other from the step.
    const view = ok<AwardView>(await propose(rita, rfq.rfq.id, sheet, [pick(qb, ['pavers']), pick(qc, ['laying'])]), 201);
    assert.ok((await steps(view)).includes('risk_review'));
  });
});
