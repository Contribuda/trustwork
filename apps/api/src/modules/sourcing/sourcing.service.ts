import type { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import { DIGEST_ALGORITHM, type Principal, type RfqVersionPayload } from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { submitForApproval, supersedePendingApprovals } from '../approval-routes/port.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import type { SupplierScreeningPort } from '../supplier-base/screening.js';
import type { TransactionsService } from '../transactions/transactions.service.js';
import { awardAmount, awardDigest, checkSelection, outcomeFeedback, sharedStatus } from './awards.js';
import {
  awardDecisions, eligibilityRules, levelSheets, outcomeNotices, quotes, quoteVersions, rfqInvitations, rfqs, rfqVersions, sourcingAccess, supplierRecords, type AwardDecision, type AwardDecisionRow, type BidLevelSheetPayload, type BidLevelSheetVersionRow, type QuoteVersionRow,
  type RfqRow, type RfqVersionRow, type SupplierStatus,
} from './deps.js';
import { evaluateRules, orderCandidates, overall, type PrequalificationEvidencePort } from './eligibility.js';
import { sourcingRefusal } from './errors.js';
import { checkedPayload, sheetDigest, sheetTemplate } from './levelling.js';
import type { SourcingMandateCheck, SourcingMandatePort } from './mandates.js';
import {
  EligibilityRuleSchema, type CancelAwardBodySchema, type DraftSheetBodySchema, type ExecuteAwardBodySchema, type FreezeSheetBodySchema, type NotifyOutcomesBodySchema, type ProposeAwardBodySchema,
  type SaveEligibilityBodySchema, type SaveSheetBodySchema,
} from './schemas.js';
import { awardView, noticeContract, partyOfOwner, privateView, sheetVersionContract, sheetVersionView } from './views.js';

type In<T extends z.ZodType> = z.infer<T>;
type Actor = { via: 'person' } | { via: 'agent'; mandateId: string };
const iso = (value: Date | string): string => new Date(value).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many supplier records one candidate list reads; a longer base is filtered in the supplier base first. */
const MAX_CANDIDATES = 200;
/** How many records of the buyer's base an award's status check reads; the import caps a file at 1,000 rows. */
const MAX_SUPPLIER_RECORDS = 5000;

/**
 * Sourcing events (PRC-004): buyer-private levelling sheets over pinned quote versions, eligibility rules, award
 * decisions and outcome notices. A sourcing event is an RFQ with its invitations, quotes, levelling and award; no new
 * top-level object exists. Every mutation runs in one principal transaction with its audit row and completes its
 * idempotency record there (BE-005). The database repeats every rule (`sourcing_*` commands, row-level security): only
 * the buyer side reads, the people holding procurement.sourcing.run write, pins are checked against the stored versions,
 * and a frozen version never changes.
 *
 * Deciding an award is the human verb `approve` of the approval routes (PRC-001); nothing here decides one. An approved
 * award executes only through the COM-002 agreement and order commands, every selected quote or none. The only outbox
 * event is an identifier-only one per outcome notice, so a sheet or an award cannot reach a notification, an index, a
 * federation feed or a statistic. Audit rows carry identifiers only, never a price or an estimate.
 */
export class SourcingService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: SourcingMandatePort,
    private readonly screening: SupplierScreeningPort,
    private readonly prequalification: PrequalificationEvidencePort,
    private readonly transactions: TransactionsService,
    /** Hub setting: whether a buyer may opt in to feedback bands at all. Bands stay off until the buyer opts in per event. */
    private readonly feedbackBandsAllowed: boolean,
  ) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(sourcingRefusal);
  }

  private sameKey(body: { idempotencyKey?: string | undefined }, header: string | undefined): void {
    if (body.idempotencyKey !== undefined && header !== undefined && header !== body.idempotencyKey) {
      throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key' });
    }
  }

  private requirePerson(actor: Actor): void {
    if (actor.via !== 'person') throw new ApiError('access.mandate_scope', 'voiding an award needs a person', { reason: 'human_only' });
  }

  private async mandate(principal: Principal, actor: Actor, action: SourcingMandateCheck['action'], rfqId: string): Promise<string | null> {
    if (actor.via === 'person') return null;
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: actor.mandateId, action, context: { kind: 'rfq', id: rfqId }, amount: null, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this RFQ`, { reason: 'mandate_scope' });
    return actor.mandateId;
  }

  private audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: Record<string, unknown>, rfq: RfqRow): Promise<void> {
    return auditEvents.append(trx, {
      actor_person_id: principal.personId, on_behalf_of_company_id: rfq.owner_company_id, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId,
      authz_epoch: principal.authzEpoch, basis,
    });
  }

  /** The RFQ for the buyer side; everybody else, the seller included, does not find it. */
  private async buyerRfq(trx: Transaction, rfqId: string): Promise<RfqRow> {
    if (!UUID.test(rfqId) || !(await sourcingAccess.reader(trx, rfqId))) throw new ApiError('access.not_found');
    const row = await rfqs.get(trx, rfqId);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  private async currentVersion(trx: Transaction, rfq: RfqRow): Promise<RfqVersionRow> {
    if (rfq.current_version_id === null) throw new ApiError('validation.schema', 'the RFQ has no published version yet', { reason: 'not_published' });
    const row = await rfqVersions.get(trx, rfq.current_version_id);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  /** Sent versions the principal may read on this RFQ, by id. During the seal the buyer side reads none. */
  private async storedVersions(trx: Transaction, rfqId: string): Promise<Map<string, QuoteVersionRow>> {
    const rows = await quoteVersions.listForRfq(trx, rfqId);
    return new Map(rows.filter((r) => r.status !== 'draft').map((r) => [r.id, r]));
  }

  private async requireOpen(trx: Transaction, rfqId: string): Promise<void> {
    if (await sourcingAccess.sealed(trx, rfqId)) throw new ApiError('access.forbidden', 'quotes stay sealed until the response deadline', { reason: 'sealed_until_deadline' });
  }

  private async sheetVersionRow(trx: Transaction, versionId: string): Promise<BidLevelSheetVersionRow> {
    const row = UUID.test(versionId) ? await levelSheets.version(trx, versionId) : undefined;
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  /* ---------- The event ---------- */

  /** What the buyer side reads about its event: the seal, the eligibility rules and the sheet's versions. */
  getEvent(state: RequestState, rfqId: string) {
    return this.run(state, async (trx) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      const [until, sealed, rules, sheet, awards, notices] = await Promise.all([
        sourcingAccess.sealedUntil(trx, rfq.id), sourcingAccess.sealed(trx, rfq.id), eligibilityRules.get(trx, rfq.id), levelSheets.forRfq(trx, rfq.id), awardDecisions.forRfq(trx, rfq.id), outcomeNotices.forRfq(trx, rfq.id),
      ]);
      const versions = sheet ? await levelSheets.versions(trx, sheet.id) : [];
      const stored = await this.storedVersions(trx, rfq.id);
      const now = this.now();
      return privateView({
        rfqId: rfq.id, owner: partyOfOwner(rfq), rfqStatus: rfq.status,
        seal: { sealedUntil: until ? iso(until) : null, sealed },
        eligibility: rules ? { rules: EligibilityRuleSchema.array().parse(rules.rules), revision: rules.revision } : null,
        sheet: sheet ? { id: sheet.id, currentVersionId: sheet.current_version_id, versions: versions.map((v) => sheetVersionView(v, stored, now)) } : null,
        awards: awards.map(awardView), notices: notices.map(noticeContract),
      });
    });
  }

  /* ---------- Eligibility and invitation candidates ---------- */

  saveEligibility(state: RequestState, rfqId: string, body: In<typeof SaveEligibilityBodySchema>) {
    return this.run(state, async (trx, p) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      await this.mandate(p, body.actor, 'prepare', rfq.id);
      const row = await eligibilityRules.save(trx, { rfqId: rfq.id, rules: body.rules, expectedRevision: body.expectedRevision });
      await this.audit(trx, p, state, 'sourcing.eligibility_saved', 'rfq', rfq.id, { rules: body.rules.length, via: body.actor.via }, rfq);
      return privateView({ rules: EligibilityRuleSchema.array().parse(row.rules), revision: row.revision });
    });
  }

  /**
   * Suppliers of the buyer's own base to invite, with pass, fail or unknown per rule. Blocked and archived suppliers are
   * not offered. The order is `orderCandidates`: it reads no plan, entitlement or sponsorship.
   */
  listCandidates(state: RequestState, rfqId: string) {
    return this.run(state, async (trx) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      const company = rfq.owner_company_id;
      if (company === null) throw new ApiError('validation.schema', 'the supplier base belongs to a company', { reason: 'company_buyer_required' });
      const rules = EligibilityRuleSchema.array().parse((await eligibilityRules.get(trx, rfq.id))?.rules ?? []);
      const [records, invitations] = await Promise.all([supplierRecords.list(trx, { companyId: company, status: null, limit: MAX_CANDIDATES }), rfqInvitations.listForRfq(trx, rfq.id)]);
      const invited = new Set(invitations.filter((i) => i.rfq_version_id === rfq.current_version_id && i.party_company_id !== null).map((i) => i.party_company_id));
      const now = this.now();
      const items = [];
      for (const record of records) {
        if (record.status === 'blocked' || record.status === 'archived') continue;
        const evaluations = await evaluateRules(trx, { rules, record, buyerCompanyId: company, screening: this.screening, prequalification: this.prequalification, now });
        items.push({
          supplierRecordId: record.id, party: record.linked_company_id ? { kind: 'company' as const, id: record.linked_company_id } : null, invitable: record.linked_company_id !== null,
          invited: record.linked_company_id !== null && invited.has(record.linked_company_id), status: record.status, createdAt: iso(record.created_at),
          eligibility: overall(evaluations.map((e) => e.result)), rules: evaluations,
        });
      }
      return privateView({ rfqId: rfq.id, candidates: orderCandidates(items) });
    });
  }

  /* ---------- Levelling ---------- */

  /** A payload to start from: every sent version with the cells its quote states, and no estimates. Nothing is stored. */
  sheetTemplate(state: RequestState, rfqId: string) {
    return this.run(state, async (trx) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      await this.requireOpen(trx, rfq.id);
      const current = await this.currentVersion(trx, rfq);
      const stored = [...(await this.storedVersions(trx, rfq.id)).values()].filter((v) => v.status === 'sent' || v.status === 'accepted');
      if (stored.length === 0) throw new ApiError('validation.schema', 'no quote to level yet', { reason: 'no_quotes' });
      return privateView({ rfqVersionId: current.id, payload: sheetTemplate(current.id, current.payload as RfqVersionPayload, stored, this.now()) });
    });
  }

  private async validated(trx: Transaction, rfqId: string, rfqVersion: RfqVersionRow, payload: BidLevelSheetPayload): Promise<{ payload: BidLevelSheetPayload; stored: Map<string, QuoteVersionRow> }> {
    await this.requireOpen(trx, rfqId);
    const stored = await this.storedVersions(trx, rfqId);
    return { payload: checkedPayload(payload, rfqVersion.id, rfqVersion.payload as RfqVersionPayload, stored, this.now()), stored };
  }

  openSheetDraft(state: RequestState, rfqId: string, body: In<typeof DraftSheetBodySchema>) {
    return this.run(state, async (trx, p) => {
      if (body.rfqId !== rfqId) throw new ApiError('validation.schema', 'the body names another RFQ', { reason: 'rfq_mismatch' });
      const rfq = await this.buyerRfq(trx, rfqId);
      const mandateId = await this.mandate(p, body.actor, 'prepare', rfq.id);
      const rfqVersion = await rfqVersions.get(trx, body.rfqVersionId);
      if (!rfqVersion || rfqVersion.rfq_id !== rfq.id) throw new ApiError('access.not_found');
      const { payload, stored } = await this.validated(trx, rfq.id, rfqVersion, body.payload);
      const row = await levelSheets.openDraft(trx, { rfqId: rfq.id, rfqVersionId: rfqVersion.id, payload, digest: sheetDigest(rfqVersion.id, payload).value, mandateId });
      await this.audit(trx, p, state, 'sourcing.sheet_drafted', 'bid_level_sheet_version', row.id, { rfqId: rfq.id, version: row.version, via: body.actor.via, mandateId }, rfq);
      return sheetVersionView(row, stored, this.now());
    });
  }

  getSheetVersion(state: RequestState, versionId: string) {
    return this.run(state, async (trx) => {
      const row = await this.sheetVersionRow(trx, versionId);
      return sheetVersionView(row, await this.storedVersions(trx, row.rfq_id), this.now());
    });
  }

  saveSheetDraft(state: RequestState, versionId: string, body: In<typeof SaveSheetBodySchema>) {
    return this.run(state, async (trx, p) => {
      const current = await this.sheetVersionRow(trx, versionId);
      const rfq = await this.buyerRfq(trx, current.rfq_id);
      const mandateId = await this.mandate(p, body.actor, 'prepare', rfq.id);
      const rfqVersion = await rfqVersions.get(trx, current.rfq_version_id);
      if (!rfqVersion) throw new ApiError('access.not_found');
      const { payload, stored } = await this.validated(trx, rfq.id, rfqVersion, body.payload);
      const row = await levelSheets.saveDraft(trx, { versionId, payload, digest: sheetDigest(rfqVersion.id, payload).value, expectedRevision: body.expectedRevision, mandateId });
      await this.audit(trx, p, state, 'sourcing.sheet_saved', 'bid_level_sheet_version', row.id, { rfqId: rfq.id, version: row.version, via: body.actor.via, mandateId }, rfq);
      return sheetVersionView(row, stored, this.now());
    });
  }

  /** Freezes the draft the caller reviewed. A column whose quote changed since the last save is refused: save first. */
  freezeSheet(state: RequestState, versionId: string, body: In<typeof FreezeSheetBodySchema>) {
    return this.run(state, async (trx, p) => {
      const current = await this.sheetVersionRow(trx, versionId);
      const rfq = await this.buyerRfq(trx, current.rfq_id);
      await this.mandate(p, body.actor, 'prepare', rfq.id);
      // A newer sheet voids an award in approval and stops an approved one from executing: a person's act, as a cancellation is.
      if (body.actor.via === 'agent' && (await awardDecisions.forRfq(trx, rfq.id)).some((a) => a.status === 'in_approval' || a.status === 'approved')) this.requirePerson(body.actor);
      const version = sheetVersionContract(current);
      if (sheetDigest(version.rfqVersionId, version.payload).value !== current.digest) throw new ApiError('commercial.digest_mismatch', 'the stored sheet no longer reproduces its digest', { reason: 'digest_mismatch' });
      const row = await levelSheets.freeze(trx, { versionId, digest: body.digest.value, expectedRevision: body.expectedRevision });
      await this.audit(trx, p, state, 'sourcing.sheet_frozen', 'bid_level_sheet_version', row.id, { rfqId: rfq.id, version: row.version, digest: row.digest, via: body.actor.via }, rfq);
      // A new sheet is a material change: the award in approval on the old one is voided (it ends as `rejected`).
      const pending = await awardDecisions.inApproval(trx, rfq.id);
      if (pending) await supersedePendingApprovals(trx, { subject: { kind: 'award', id: pending.id }, newVersionId: row.id }, this.now());
      return sheetVersionView(row, await this.storedVersions(trx, rfq.id), this.now());
    });
  }

  /* ---------- Awards ---------- */

  /**
   * Proposes an award on a frozen sheet and submits it to the company's `award` route in one transaction. The digest
   * binds the sheet, the selection and the reasons, so a decision approves exactly this. Person-owned RFQs have no route
   * and accept a quote directly. A company without an active route is refused (`no_active_route`).
   */
  proposeAward(state: RequestState, rfqId: string, body: In<typeof ProposeAwardBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      if (body.rfqId !== rfqId) throw new ApiError('validation.schema', 'the body names another RFQ', { reason: 'rfq_mismatch' });
      const rfq = await this.buyerRfq(trx, rfqId);
      if (rfq.owner_company_id === null) throw new ApiError('validation.schema', 'awards go through a company approval route; a person accepts a quote directly', { reason: 'company_buyer_required' });
      if (rfq.revision !== body.expectedRevision) throw new ApiError('validation.revision_conflict', 'the RFQ changed meanwhile', { reason: 'revision_conflict' });
      const mandateId = await this.mandate(p, body.actor, 'prepare', rfq.id);
      const sheetRow = await this.sheetVersionRow(trx, body.bidLevelSheetVersionId);
      if (sheetRow.rfq_id !== rfq.id) throw new ApiError('access.not_found');
      const sheet = sheetVersionContract(sheetRow);
      const stored = await this.storedVersions(trx, rfq.id);
      checkSelection(body.selection, stored);
      const digest = awardDigest({ rfqId: rfq.id, sheetVersionId: sheet.id, sheetDigest: sheetRow.digest, selection: body.selection, reasons: body.reasons });
      const row = await awardDecisions.propose(trx, { rfqId: rfq.id, sheetVersionId: sheet.id, selection: body.selection, reasons: body.reasons, digest: digest.value, via: body.actor.via, mandateId });
      const request = await submitForApproval(trx, {
        companyId: rfq.owner_company_id, subject: { kind: 'award', id: row.id }, subjectVersionId: sheet.id, subjectDigest: digest, amount: awardAmount(body.selection, stored),
        facts: { categories: rfq.category ? [rfq.category] : [], projectId: rfq.project_id, supplierStatus: await this.selectedStatus(trx, rfq.owner_company_id, body.selection, stored) },
      }, this.now());
      const award = await awardDecisions.enterApproval(trx, row.id, request.id);
      await this.audit(trx, p, state, 'sourcing.award_proposed', 'award_decision', award.id, { rfqId: rfq.id, sheetVersionId: sheet.id, digest: digest.value, requestId: request.id, via: body.actor.via, mandateId }, rfq);
      return awardView(award);
    });
  }

  /** The status the buyer's own base holds for all selected sellers; null when they differ or a seller is not in the base, which makes `supplier_status_in` steps apply. */
  private async selectedStatus(trx: Transaction, company: string, selection: AwardDecision['selection'], stored: ReadonlyMap<string, QuoteVersionRow>) {
    const records = await supplierRecords.list(trx, { companyId: company, status: null, limit: MAX_SUPPLIER_RECORDS });
    const statuses: (SupplierStatus | null)[] = [];
    for (const item of selection) {
      const quote = await quotes.get(trx, (stored.get(item.quoteVersionId) as QuoteVersionRow).quote_id);
      statuses.push(records.find((r) => r.linked_company_id !== null && r.linked_company_id === quote?.seller_company_id)?.status as SupplierStatus | undefined ?? null);
    }
    return sharedStatus(statuses);
  }

  private async awardRow(trx: Transaction, awardId: string): Promise<AwardDecisionRow> {
    const row = UUID.test(awardId) ? await awardDecisions.get(trx, awardId) : undefined;
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  getAward(state: RequestState, awardId: string) {
    return this.run(state, async (trx) => awardView(await this.awardRow(trx, awardId)));
  }

  /**
   * Executes an approved award through the COM-002 commands, in one transaction: for every selected version the buyer
   * accepts the terms (digests rechecked, parties screened, electronic-records consent) and places the order (authority
   * and an atomic budget reservation). Any refusal rolls every agreement and reservation back, and the award stays
   * approved. The sellers accept or decline afterwards, as for any order.
   */
  executeAward(state: RequestState, awardId: string, body: In<typeof ExecuteAwardBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      if (body.awardDecisionId !== awardId) throw new ApiError('validation.schema', 'the body names another award', { reason: 'award_mismatch' });
      if (!UUID.test(awardId)) throw new ApiError('access.not_found');
      const award = await awardDecisions.beginExecution(trx, awardId, body.expectedRevision);
      const rfq = await this.buyerRfq(trx, award.rfq_id);
      const selection = awardView(award).award.selection;
      const reasons = awardView(award).award.reasons;
      const sheetRow = await this.sheetVersionRow(trx, award.bid_level_sheet_version_id);
      if (awardDigest({ rfqId: rfq.id, sheetVersionId: sheetRow.id, sheetDigest: sheetRow.digest, selection, reasons }).value !== award.digest) {
        throw new ApiError('access.approval_digest_mismatch', 'the award differs from what was approved', { reason: 'digest_mismatch' });
      }
      const current = await this.currentVersion(trx, rfq);
      const rfqVersion = { id: current.id, version: current.version, digest: { algorithm: DIGEST_ALGORITHM, value: current.digest as string } };
      const agreementIds: string[] = [];
      for (const [index, item] of selection.entries()) {
        const version = await quoteVersions.get(trx, item.quoteVersionId);
        const quote = version ? await quotes.get(trx, version.quote_id) : undefined;
        if (!version || !quote || version.digest === null) throw new ApiError('commercial.digest_mismatch', 'a selected version is not readable', { reason: 'pin_mismatch' });
        const quoteVersion = { id: version.id, version: version.version, digest: { algorithm: DIGEST_ALGORITHM, value: version.digest } };
        const accepted = await this.transactions.acceptTermsIn(trx, p, { rfqId: rfq.id, quoteVersion, rfqVersion, expectedRevision: quote.revision, electronicRecords: body.electronicRecords, actor: body.actor }, `award-${award.id}-terms-${index}`, state, award.id);
        const agreement = accepted.agreement;
        await this.transactions.placeOrderIn(trx, p, agreement.id, {
          action: 'place_order', context: { kind: 'rfq', id: rfq.id }, agreementId: agreement.id, quoteVersion, rfqVersion, expectedRevision: agreement.revision, transactionBudgetId: body.transactionBudgetId,
          platformBudgetId: null, externalReference: null, actor: body.actor,
        }, `award-${award.id}-order-${index}`, state);
        agreementIds.push(agreement.id);
      }
      const done = await awardDecisions.completeExecution(trx, award.id, agreementIds);
      await this.audit(trx, p, state, 'sourcing.award_executed', 'award_decision', done.id, { rfqId: rfq.id, agreementIds, budgetId: body.transactionBudgetId, via: body.actor.via }, rfq);
      return awardView(done);
    });
  }

  /**
   * An approved award that will not execute, for example because a quote went stale. People approved it, so voiding it
   * needs a person in their own first-party session; no mandate reaches this. An award in approval is withdrawn on its request.
   */
  cancelAward(state: RequestState, awardId: string, body: In<typeof CancelAwardBodySchema>) {
    return this.run(state, async (trx, p) => {
      this.requirePerson(body.actor);
      const current = await this.awardRow(trx, awardId);
      const rfq = await this.buyerRfq(trx, current.rfq_id);
      const row = await awardDecisions.cancel(trx, awardId, body.reason, body.expectedRevision, state.session?.id ?? null);
      await this.audit(trx, p, state, 'sourcing.award_cancelled', 'award_decision', row.id, { rfqId: rfq.id, via: body.actor.via }, rfq);
      return awardView(row);
    });
  }

  /* ---------- Outcome notices ---------- */

  /**
   * One notice per invitee, once. With an executed award the database decides who was awarded; without one the RFQ must
   * be closed and everybody gets `cancelled`. Bands are computed here from the frozen sheet, only when the hub allows the
   * opt-in and the buyer chose it for this event; the totals never leave this function.
   */
  notifyOutcomes(state: RequestState, rfqId: string, body: In<typeof NotifyOutcomesBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      if (body.rfqId !== rfqId) throw new ApiError('validation.schema', 'the body names another RFQ', { reason: 'rfq_mismatch' });
      const rfq = await this.buyerRfq(trx, rfqId);
      await this.mandate(p, body.actor, 'communicate', rfq.id);
      if (body.includeFeedbackBands && !this.feedbackBandsAllowed) throw new ApiError('access.forbidden', 'this hub does not allow feedback bands', { reason: 'feedback_bands_not_allowed' });
      const feedback = body.includeFeedbackBands && body.awardDecisionId ? await this.feedback(trx, rfq.id, body.awardDecisionId) : {};
      const rows = await outcomeNotices.send(trx, { rfqId: rfq.id, awardId: body.awardDecisionId, optedIn: body.includeFeedbackBands, feedback, expectedRevision: body.expectedRevision });
      for (const row of rows) await outbox.append(trx, { aggregate_kind: 'bid_outcome_notice', aggregate_id: row.id, revision: 1, type: 'sourcing.outcome_notice_sent', payload: { noticeId: row.id, rfqId: rfq.id } });
      await this.audit(trx, p, state, 'sourcing.outcomes_sent', 'rfq', rfq.id, { awardId: body.awardDecisionId, notices: rows.length, optedIn: body.includeFeedbackBands, via: body.actor.via }, rfq);
      return privateView({ rfqId: rfq.id, notices: rows.map(noticeContract) });
    });
  }

  private async feedback(trx: Transaction, rfqId: string, awardId: string) {
    const award = await this.awardRow(trx, awardId);
    if (award.rfq_id !== rfqId) throw new ApiError('access.not_found');
    const { selection, reasons } = awardView(award).award;
    const sheet = sheetVersionContract(await this.sheetVersionRow(trx, award.bid_level_sheet_version_id));
    const [stored, quoteRows] = await Promise.all([this.storedVersions(trx, rfqId), quotes.listForRfq(trx, rfqId)]);
    const sellers = new Map(quoteRows.map((q) => [q.id, q.seller_company_id ?? q.seller_person_id ?? undefined]));
    return outcomeFeedback({ sheet: sheet.payload, awardedVersionIds: selection.map((s) => s.quoteVersionId), versions: stored, sellerOf: (row) => sellers.get(row.quote_id), reasons });
  }

  /** The recipient's own notices: nothing else is addressed to a bidder. */
  listMyNotices(state: RequestState) {
    return this.run(state, async (trx, p) => {
      const rows = await outcomeNotices.forRecipient(trx, { personId: p.personId, companyId: p.membership?.permissions.includes('company.deals.manage') ? p.membership.companyId : null });
      return { audience: 'shared_party' as const, notices: rows.map(noticeContract) };
    });
  }
}
