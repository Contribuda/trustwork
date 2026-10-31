import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  AgreementBuyerPrivateSchema, AgreementSchema, AgreementSellerPrivateSchema, checkAcceptance, computeAgreementDigest, DIGEST_ALGORITHM, digestEquals, OrderSchema, RfqVersionSchema,
  toBuyerAgreement, toSellerAgreement, verifyQuoteVersionDigest, verifyRfqVersionDigest, type Digest, type Money, type Party, type Principal, type QuoteVersionPayload, type VersionRef,
} from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { DealService, iso, partyOf, UUID, type BuyerSide, type ResolvedActor } from '../sales/common.js';
import {
  acceptanceEvents, agreementBuyerPrivate, agreements, agreementSellerPrivate, AgreementListSchema, BuyerAgreementViewSchema, deriveObligations, electronicRecordsSatisfied, obligations,
  OrderChangeSchema, orderChanges, orders, quotes, quoteVersions, reservations, rfqVersions, SellerAgreementViewSchema, SharedAcceptanceEventSchema, toSellerOrder,
  type AcceptanceEventRow, type AcceptTermsRequestSchema, type AgreementRow, type BuyerAgreementView, type CancelOrderRequestSchema, type CommercialOrderRow,
  type DecideOrderChangeRequestSchema, type ElectronicRecordsConsent, type ObligationRow, type OrderChangeRow, type PlaceOrderRequestSchema, type ProposeOrderChangeRequestSchema,
  type QuoteVersionRow, type RfqVersionRow, type SaveAgreementPrivateCommandSchema, type SellerAcceptRequestSchema, type SellerAgreementView, type SellerDeclineRequestSchema,
  type WithdrawAgreementRequestSchema,
} from '../sales/deps.js';
import type { DealMandatePort } from '../sales/mandates.js';
import { quoteVersionContract } from '../sales/serializers.js';
import type { ElectronicRecordsPolicySource } from './electronic-records.js';

type In<T extends z.ZodType> = z.infer<T>;
type Side = 'buyer' | 'seller';
type AgreementView = BuyerAgreementView | SellerAgreementView;
const digestOf = (value: string): Digest => ({ algorithm: DIGEST_ALGORITHM, value });
const partyOfColumns = (person: string | null, company: string | null): Party => (person ? { kind: 'person', id: person } : { kind: 'company', id: company as string });
const columnsOf = (party: Party) => (party.kind === 'person' ? { person: party.id, company: null } : { person: null, company: party.id });
const sameRef = (a: VersionRef, b: VersionRef) => a.id === b.id && a.version === b.version && digestEquals(a.digest, b.digest);
/** Reservations last as long as billing allows (30 days); unspent holds expire and are released by the worker. */
const RESERVATION_TTL_SECONDS = 30 * 24 * 3600;

function rfqVersionContract(row: RfqVersionRow) {
  return RfqVersionSchema.parse({
    id: row.id, rfqId: row.rfq_id, version: row.version, status: row.status, payload: row.payload, digest: row.digest ? digestOf(row.digest) : null,
    publishedAt: row.published_at ? iso(row.published_at) : null, publishedBy: row.published_by_person_id, supersededBy: row.superseded_by, amendmentReason: row.amendment_reason,
  });
}
const CHECK_CODES = {
  'commercial.stale_version': 'the quote answers an earlier RFQ version; it cannot be accepted as the current one',
  'commercial.quote_not_acceptable': 'only a sent quote version is accepted',
  'commercial.quote_expired': 'the quote validity has passed',
  'commercial.digest_mismatch': 'the accepted terms do not match the stored versions',
  'commercial.rfq_version_mismatch': 'the RFQ version is not the current published one',
} as const;

/**
 * Agreements, acceptance, orders and order changes (COM-002). The buyer side accepts a sent quote version pinned to the
 * current published RFQ version (`checkAcceptance` recomputes both stored digests); the agreement digest covers
 * `{ termsKind, quoteVersion, rfqVersion }` and every acceptance event repeats it (database trigger). The buyer places
 * the order under `commit_order` with an atomic transaction-budget reservation for the gross total taken from the
 * immutable quote; the seller accepts or declines; changes append a superseding agreement agreed by both. Electronic
 * acceptance records consent to electronic records as the hub requires. Trustwork never holds money: orders are
 * instructions and reservations are authority.
 */
export class TransactionsService extends DealService {
  constructor(ctx: AppContext, principals: PrincipalService, policy: ParticipationService, mandates: DealMandatePort, private readonly records: ElectronicRecordsPolicySource) {
    super(ctx, principals, policy, mandates);
  }

  /* ---------- Sides ---------- */

  private async agreementOf(trx: Transaction, agreementId: string): Promise<AgreementRow> {
    if (!UUID.test(agreementId)) throw new ApiError('access.not_found');
    const row = await agreements.get(trx, agreementId);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }
  private seller(row: AgreementRow): Party {
    return partyOfColumns(row.seller_person_id, row.seller_company_id);
  }
  private buyer(row: AgreementRow): Party {
    return partyOfColumns(row.buyer_person_id, row.buyer_company_id);
  }
  /** 'seller' when the principal acts for the seller; 'buyer' when it is on the RFQ owner side; otherwise not found. */
  private async sideOf(trx: Transaction, p: Principal, row: AgreementRow): Promise<{ side: Side; rfq: BuyerSide | null }> {
    if (this.actsFor(p, this.seller(row))) return { side: 'seller', rfq: null };
    const rfq = row.rfq_id ? await this.loadRfq(trx, row.rfq_id) : null;
    if (this.actsFor(p, this.buyer(row)) || this.isBuyerSide(p, rfq)) return { side: 'buyer', rfq };
    throw new ApiError('access.not_found');
  }
  private async requireSide(trx: Transaction, p: Principal, row: AgreementRow, want: Side): Promise<{ side: Side; rfq: BuyerSide | null }> {
    const resolved = await this.sideOf(trx, p, row);
    if (resolved.side !== want) throw new ApiError('access.forbidden', `only the ${want} side may do this`, { reason: `not_${want}` });
    return resolved;
  }

  private consent(input: ElectronicRecordsConsent | null): { required: boolean; disclosureKey: string | null; basis: string[]; at: Date | null } {
    const policy = this.records.current();
    if (!electronicRecordsSatisfied(policy, input)) {
      throw new ApiError('validation.schema', 'acceptance needs consent to electronic records for the current disclosure', { reason: 'electronic_records_consent_required', disclosureKey: policy.disclosureKey });
    }
    return input ? { required: policy.required, disclosureKey: input.disclosureKey, basis: [...policy.basis], at: this.now() } : { required: false, disclosureKey: null, basis: [], at: null };
  }

  /** Stored versions, both digests recomputed from their payloads, and the agreement digest recomputed from the refs. */
  private async verifiedTerms(trx: Transaction, row: AgreementRow): Promise<{ quoteVersion: QuoteVersionRow; quoteRef: VersionRef; rfqRef: VersionRef; digest: Digest }> {
    const [qv, rv] = await Promise.all([quoteVersions.get(trx, row.quote_version_id as string), rfqVersions.get(trx, row.rfq_version_id as string)]);
    if (!qv || !rv || qv.digest === null || rv.digest === null) throw new ApiError('commercial.digest_mismatch', 'the pinned versions are not readable', { reason: 'digest_mismatch' });
    if (!verifyQuoteVersionDigest(quoteVersionContract(qv)) || !verifyRfqVersionDigest(rfqVersionContract(rv))) throw new ApiError('commercial.digest_mismatch', 'a stored version no longer reproduces its digest', { reason: 'digest_mismatch' });
    const quoteRef = { id: qv.id, version: qv.version, digest: digestOf(qv.digest) };
    const rfqRef = { id: rv.id, version: rv.version, digest: digestOf(rv.digest) };
    const digest = computeAgreementDigest(quoteRef, rfqRef, row.terms_kind);
    if (digest.value !== row.accepted_terms_digest || qv.digest !== row.offer_digest || rv.digest !== row.request_digest) throw new ApiError('commercial.digest_mismatch', 'the agreement digest does not match the stored versions', { reason: 'digest_mismatch' });
    return { quoteVersion: qv, quoteRef, rfqRef, digest };
  }

  private async recordEvent(trx: Transaction, p: Principal, row: AgreementRow, kind: AcceptanceEventRow['kind'], party: Party, actor: ResolvedActor, key: string, extra: {
    consent?: ReturnType<TransactionsService['consent']>; budgetId?: string | null; reservationId?: string | null; reason?: string | null;
  } = {}): Promise<AcceptanceEventRow> {
    const cols = columnsOf(party);
    return acceptanceEvents.insert(trx, {
      agreement_id: row.id, kind, terms_kind: row.terms_kind, quote_version_id: row.quote_version_id, rfq_version_id: row.rfq_version_id, offer_version: row.offer_version,
      offer_digest: row.offer_digest, request_version: row.request_version, request_digest: row.request_digest, accepted_terms_digest: row.accepted_terms_digest,
      actor_person_id: p.personId, on_behalf_person_id: cols.person, on_behalf_company_id: cols.company, via: actor.via, mandate_id: actor.mandateId,
      transaction_budget_id: extra.budgetId ?? null, reservation_id: extra.reservationId ?? null, platform_budget_id: null,
      e_records_required: extra.consent?.required ?? false, e_records_disclosure_key: extra.consent?.disclosureKey ?? null, e_records_basis: extra.consent?.basis ?? [],
      e_records_consented_at: extra.consent?.at ?? null, reason: extra.reason ?? null, idempotency_key: key,
    });
  }

  /* ---------- Views ---------- */

  private async view(trx: Transaction, row: AgreementRow, side: Side): Promise<AgreementView> {
    const [events, obligationRows, changes] = await Promise.all([acceptanceEvents.listFor(trx, row.id), obligations.listFor(trx, row.id), orderChanges.listForAgreement(trx, row.id)]);
    const orderRows = await orders.listForAgreement(trx, row.id, [...new Set(changes.map((c) => c.order_id))]);
    const changeVersions = new Map<string, QuoteVersionRow>();
    for (const c of changes) {
      const v = await quoteVersions.get(trx, c.new_quote_version_id);
      if (v) changeVersions.set(c.id, v);
    }
    const agreement = AgreementSchema.parse({
      id: row.id, parties: { buyer: this.buyer(row), seller: this.seller(row) }, termsKind: row.terms_kind,
      acceptedTerms: {
        quoteVersion: { id: row.quote_version_id, version: row.offer_version, digest: digestOf(row.offer_digest) },
        rfqVersion: { id: row.rfq_version_id, version: row.request_version, digest: digestOf(row.request_digest) },
        digest: digestOf(row.accepted_terms_digest),
      },
      acceptanceEventIds: events.map((e) => e.id), status: row.status, supersededBy: row.superseded_by, obligations: obligationRows.map(obligationContract), revision: row.revision,
      createdAt: iso(row.created_at),
    });
    const shared = {
      rfqId: row.rfq_id as string, quoteId: row.quote_id as string, events: events.map(eventContract), orderChanges: changes.map((c) => orderChangeContract(c, changeVersions.get(c.id))),
    };
    if (side === 'buyer') {
      const own = await agreementBuyerPrivate.get(trx, row.id);
      const order = orderRows.find((o) => o.agreement_id === row.id);
      const buyerPrivate = AgreementBuyerPrivateSchema.parse({
        agreementId: row.id, ownerParty: this.buyer(row), transactionBudgetId: own?.transaction_budget_id ?? order?.transaction_budget_id ?? null, approvalRefs: own?.approval_refs ?? [],
        notes: own?.notes ?? null, revision: own?.revision ?? 1,
      });
      return BuyerAgreementViewSchema.parse({ projection: 'party_private', side: 'buyer', agreement: toBuyerAgreement({ agreement, buyerPrivate }), privateRevision: buyerPrivate.revision, ...shared, orders: orderRows.map(orderContract) });
    }
    const own = await agreementSellerPrivate.get(trx, row.id);
    const sellerPrivate = AgreementSellerPrivateSchema.parse({ agreementId: row.id, ownerParty: this.seller(row), fulfilmentPlan: own?.fulfilment_plan ?? [], notes: own?.notes ?? null, revision: own?.revision ?? 1 });
    return SellerAgreementViewSchema.parse({ projection: 'party_private', side: 'seller', agreement: toSellerAgreement({ agreement, sellerPrivate }), privateRevision: sellerPrivate.revision, ...shared, orders: orderRows.map((o) => toSellerOrder(orderContract(o))) });
  }

  async getAgreement(agreementId: string, state: RequestState): Promise<AgreementView> {
    if (!state.principal || !UUID.test(agreementId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const row = await this.agreementOf(trx, agreementId);
      const { side } = await this.sideOf(trx, p, row);
      return this.view(trx, row, side);
    });
  }

  async listAgreements(state: RequestState): Promise<z.infer<typeof AgreementListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await agreements.listForParties(trx, this.scope(p));
      return AgreementListSchema.parse({
        agreements: rows.map((row) => {
          const side: Side = this.actsFor(p, this.seller(row)) ? 'seller' : 'buyer';
          return { id: row.id, side, termsKind: row.terms_kind, rfqId: row.rfq_id, counterparty: side === 'seller' ? this.buyer(row) : this.seller(row), status: row.status, revision: row.revision, createdAt: iso(row.created_at) };
        }),
      });
    });
  }

  /* ---------- Buyer: accept terms ---------- */

  /**
   * The buyer side accepts the exact quote version and the current RFQ version by id and digest. The RFQ row is locked
   * and the database allows one live agreement per RFQ, so two concurrent acceptances (of the same or of different
   * quotes) cannot both commit; a quote that answers an earlier RFQ version is refused as stale.
   */
  async acceptTerms(input: In<typeof AcceptTermsRequestSchema>, key: string, state: RequestState): Promise<BuyerAgreementView> {
    return this.run(state, async (trx, p) => {
      const qv = UUID.test(input.quoteVersion.id) ? await quoteVersions.get(trx, input.quoteVersion.id) : undefined;
      const quote = qv ? await quotes.get(trx, qv.quote_id) : undefined;
      const sellerReads = quote ? this.actsFor(p, partyOfColumns(quote.seller_person_id, quote.seller_company_id)) : false;
      const loaded = this.requireBuyer(p, await this.loadRfq(trx, input.rfqId, true), 'accept', sellerReads);
      const rfq = loaded.row;
      if (!qv || !quote || quote.rfq_id !== rfq.id) throw new ApiError('access.not_found');
      if (quote.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (await agreements.liveForRfq(trx, rfq.id)) throw new ApiError('validation.revision_conflict', 'this RFQ already has a live agreement', { reason: 'agreement_exists' });
      const payload = qv.payload as QuoteVersionPayload;
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'quote', id: quote.id }, payload.totals.gross);
      const consent = this.consent(input.electronicRecords);
      if (rfq.current_version_id === null) throw new ApiError('commercial.rfq_version_mismatch', CHECK_CODES['commercial.rfq_version_mismatch']);
      const current = await rfqVersions.get(trx, rfq.current_version_id);
      if (!current) throw new ApiError('access.not_found');
      const currentContract = rfqVersionContract(current);
      const check = checkAcceptance({ quoteVersion: quoteVersionContract(qv), quoteRef: input.quoteVersion, currentRfqVersion: currentContract, now: this.now() });
      if (check !== 'ok') throw new ApiError(check, CHECK_CODES[check], { reason: check.slice('commercial.'.length) });
      const rfqRef = { id: current.id, version: current.version, digest: digestOf(current.digest as string) };
      if (!sameRef(input.rfqVersion, rfqRef)) throw new ApiError('commercial.rfq_version_mismatch', CHECK_CODES['commercial.rfq_version_mismatch'], { reason: 'rfq_version_mismatch', currentRfqVersionId: current.id });
      const quoteRef = { id: qv.id, version: qv.version, digest: digestOf(qv.digest as string) };
      const digest = computeAgreementDigest(quoteRef, rfqRef, 'rfq_quote');
      const buyer = columnsOf(partyOf(rfq));
      const seller = { person: quote.seller_person_id, company: quote.seller_company_id };
      const row = await agreements.insert(trx, {
        buyer_person_id: buyer.person, buyer_company_id: buyer.company, seller_person_id: seller.person, seller_company_id: seller.company, rfq_id: rfq.id, quote_id: quote.id,
        quote_version_id: qv.id, rfq_version_id: current.id, offer_version: qv.version, offer_digest: qv.digest as string, request_version: current.version, request_digest: current.digest as string,
        accepted_terms_digest: digest.value, status: 'accepted_by_buyer', supersedes_id: null, created_by_person_id: p.personId,
      });
      await agreementBuyerPrivate.insert(trx, { agreement_id: row.id, owner_person_id: buyer.person, owner_company_id: buyer.company, transaction_budget_id: null, approval_refs: [], notes: null, updated_by_person_id: p.personId });
      const event = await this.recordEvent(trx, p, row, 'buyer_accepts_terms', partyOf(rfq), actor, key, { consent });
      await this.audit(trx, p, state, 'agreement.accepted_by_buyer', 'agreement', row.id, { rfqId: rfq.id, quoteId: quote.id, versionId: qv.id, digest: digest.value, eventId: event.id, via: actor.via, mandateId: actor.mandateId, electronicRecords: consent.disclosureKey });
      await this.event(trx, 'agreement', row.id, row.revision, 'agreement.accepted_by_buyer', { agreementId: row.id, rfqId: rfq.id, quoteId: quote.id, versionId: qv.id, eventKind: 'buyer_accepts_terms', termsKind: 'rfq_quote', via: actor.via });
      return this.view(trx, row, 'buyer') as Promise<BuyerAgreementView>;
    });
  }

  /* ---------- Buyer: orders ---------- */

  /**
   * Places the order on terms the buyer accepted: `commit_order` on the RFQ, the money taken from the immutable quote
   * (never from the client), an atomic reservation of the gross total from the named transaction budget, and no platform
   * charge in this slice. The order is an instruction; no money moves (ADR 010 decision 20).
   */
  async placeOrder(agreementId: string, input: In<typeof PlaceOrderRequestSchema>, key: string, state: RequestState): Promise<BuyerAgreementView> {
    return this.run(state, async (trx, p) => {
      const read = await this.agreementOf(trx, agreementId);
      const { rfq } = await this.requireSide(trx, p, read, 'buyer');
      this.requireBuyer(p, rfq, 'commit_order', true);
      const row = await agreements.lock(trx, read.id);
      if (!row) throw new ApiError('access.not_found');
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `an order is placed on terms the buyer accepted, not on a ${row.status} agreement`, { reason: 'invalid_transition' });
      const terms = await this.verifiedTerms(trx, row);
      if (!sameRef(input.quoteVersion, terms.quoteRef) || !sameRef(input.rfqVersion, terms.rfqRef)) throw new ApiError('commercial.digest_mismatch', CHECK_CODES['commercial.digest_mismatch'], { reason: 'digest_mismatch' });
      const rfqRow = rfq?.row;
      if (!rfqRow || (input.context.kind === 'rfq' ? input.context.id !== rfqRow.id : input.context.id !== rfqRow.project_id)) throw new ApiError('validation.schema', 'the order context is the RFQ or its project', { reason: 'context_mismatch' });
      if (input.platformBudgetId !== null) throw new ApiError('validation.schema', 'no platform charge occurs for an order in this hub', { reason: 'no_platform_charge' });
      if (await orders.liveForAgreement(trx, row.id)) throw new ApiError('validation.revision_conflict', 'the agreement already has an order', { reason: 'order_exists' });
      const gross: Money = (terms.quoteVersion.payload as QuoteVersionPayload).totals.gross;
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'agreement', id: row.id }, gross);
      if (!UUID.test(input.transactionBudgetId)) throw new ApiError('commercial.authority_missing', 'a transaction budget is needed', { reason: 'budget_unknown' });
      const amount = BigInt(gross.minorUnits);
      if (amount < 0n) throw new ApiError('validation.schema', 'a negative total is not ordered', { reason: 'negative_total' });
      const reservation = amount === 0n ? null : await reservations.reserve(trx, {
        budgetId: input.transactionBudgetId, kind: 'transaction', amountMinor: gross.minorUnits, currency: gross.currency, actionIntentId: row.id, correlationKey: `order:${row.id}:${key}`,
        projectId: rfqRow.project_id, ttlSeconds: RESERVATION_TTL_SECONDS,
      });
      const order = await orders.insert(trx, {
        agreement_id: row.id, accepted_terms_digest: row.accepted_terms_digest, context_kind: input.context.kind, context_id: input.context.id, external_reference: input.externalReference,
        amount_minor: gross.minorUnits, currency: gross.currency, transaction_budget_id: input.transactionBudgetId, reservation_id: reservation?.id ?? null, placed_by_person_id: p.personId,
        placed_via: actor.via, placed_mandate_id: actor.mandateId,
      });
      if (!(await agreementBuyerPrivate.update(trx, row.id, null, { transaction_budget_id: input.transactionBudgetId, updated_by_person_id: p.personId }))) {
        const buyer = columnsOf(this.buyer(row));
        await agreementBuyerPrivate.insert(trx, { agreement_id: row.id, owner_person_id: buyer.person, owner_company_id: buyer.company, transaction_budget_id: input.transactionBudgetId, approval_refs: [], notes: null, updated_by_person_id: p.personId });
      }
      // Audit names the authority (budget and reservation ids, digest), never a budget limit or balance.
      await this.audit(trx, p, state, 'order.placed', 'order', order.id, { agreementId: row.id, digest: row.accepted_terms_digest, budgetId: input.transactionBudgetId, reservationId: reservation?.id ?? null, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'order', order.id, order.revision, 'order.placed', { orderId: order.id, agreementId: row.id, status: 'placed', via: actor.via });
      return this.view(trx, row, 'buyer') as Promise<BuyerAgreementView>;
    });
  }

  /* ---------- Seller: accept or decline ---------- */

  /** The seller states the digest it accepts; it must equal the agreement digest recomputed from the stored versions. */
  async sellerAccept(agreementId: string, input: In<typeof SellerAcceptRequestSchema>, key: string, state: RequestState): Promise<SellerAgreementView> {
    return this.run(state, async (trx, p) => {
      const read = await this.agreementOf(trx, agreementId);
      await this.requireSide(trx, p, read, 'seller');
      const row = await agreements.lock(trx, read.id);
      if (!row) throw new ApiError('access.not_found');
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${row.status} agreement is not accepted`, { reason: 'invalid_transition' });
      const order = await orders.liveForAgreement(trx, row.id);
      if (!order || order.status !== 'placed') throw new ApiError('validation.schema', 'the seller accepts a placed order', { reason: 'order_missing' });
      const terms = await this.verifiedTerms(trx, row);
      if (!digestEquals(input.acceptedTermsDigest, terms.digest)) throw new ApiError('commercial.digest_mismatch', CHECK_CODES['commercial.digest_mismatch'], { reason: 'digest_mismatch' });
      const payload = terms.quoteVersion.payload as QuoteVersionPayload;
      const actor = await this.actor(p, input.actor, 'accept_order', { kind: 'agreement', id: row.id }, payload.totals.gross);
      const consent = this.consent(input.electronicRecords);
      const event = await this.recordEvent(trx, p, row, 'seller_accepts_order', this.seller(row), actor, key, { consent });
      const accepted = await agreements.setStatus(trx, row.id, row.revision, { status: 'accepted_by_both' });
      if (!accepted) throw new ApiError('validation.revision_conflict');
      const acceptedOrder = await orders.setStatus(trx, order.id, order.revision, { status: 'accepted' });
      if (!acceptedOrder) throw new ApiError('validation.revision_conflict');
      if (!(await quoteVersions.setStatus(trx, terms.quoteVersion.id, 'sent', 'accepted'))) throw new ApiError('validation.revision_conflict', 'the accepted version is no longer the sent one', { reason: 'version_changed' });
      const quote = await quotes.get(trx, row.quote_id as string);
      if (quote && quote.status === 'sent') await quotes.setStatus(trx, quote.id, null, { status: 'accepted', withdrawn_reason: null });
      await this.insertObligations(trx, accepted, payload);
      if (!(await agreementSellerPrivate.get(trx, row.id))) {
        const seller = columnsOf(this.seller(row));
        await agreementSellerPrivate.insert(trx, { agreement_id: row.id, owner_person_id: seller.person, owner_company_id: seller.company, fulfilment_plan: [], notes: null, updated_by_person_id: p.personId });
      }
      await this.audit(trx, p, state, 'agreement.accepted_by_both', 'agreement', row.id, { orderId: order.id, digest: row.accepted_terms_digest, eventId: event.id, via: actor.via, mandateId: actor.mandateId, electronicRecords: consent.disclosureKey });
      await this.event(trx, 'agreement', row.id, accepted.revision, 'agreement.accepted_by_both', { agreementId: row.id, orderId: order.id, eventKind: 'seller_accepts_order', status: 'accepted_by_both', via: actor.via });
      await this.event(trx, 'order', order.id, acceptedOrder.revision, 'order.accepted', { orderId: order.id, agreementId: row.id, status: 'accepted', via: actor.via });
      return this.view(trx, accepted, 'seller') as Promise<SellerAgreementView>;
    });
  }

  private async insertObligations(trx: Transaction, row: AgreementRow, payload: QuoteVersionPayload): Promise<void> {
    const derived = deriveObligations({ buyer: this.buyer(row), seller: this.seller(row) }, payload);
    await obligations.insertMany(trx, row.id, derived.map((o, position) => {
      const party = columnsOf(o.party);
      return {
        position, obligor_person_id: party.person, obligor_company_id: party.company, kind: o.kind, due: o.due, amount_minor: o.amount?.minorUnits ?? null, currency: o.amount?.currency ?? null,
        scope_value: o.scope?.value ?? null, scope_unit: o.scope?.unit ?? null,
      };
    }));
  }

  /** The seller declines: the agreement is declined and the placed order cancelled; the buyer releases its reservation (or it expires). */
  async sellerDecline(agreementId: string, input: In<typeof SellerDeclineRequestSchema>, key: string, state: RequestState): Promise<SellerAgreementView> {
    return this.run(state, async (trx, p) => {
      const read = await this.agreementOf(trx, agreementId);
      await this.requireSide(trx, p, read, 'seller');
      const row = await agreements.lock(trx, read.id);
      if (!row) throw new ApiError('access.not_found');
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${row.status} agreement is not declined`, { reason: 'invalid_transition' });
      const actor = await this.actor(p, input.actor, 'accept_order', { kind: 'agreement', id: row.id });
      await this.recordEvent(trx, p, row, 'seller_declines', this.seller(row), actor, key, { reason: input.reason });
      const declined = await agreements.setStatus(trx, row.id, row.revision, { status: 'declined', closed_reason: input.reason });
      if (!declined) throw new ApiError('validation.revision_conflict');
      const order = await orders.liveForAgreement(trx, row.id);
      if (order) await orders.setStatus(trx, order.id, order.revision, { status: 'cancelled', cancelled_reason: 'declined by the seller' });
      await this.audit(trx, p, state, 'agreement.declined', 'agreement', row.id, { orderId: order?.id ?? null, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'agreement', row.id, declined.revision, 'agreement.declined', { agreementId: row.id, orderId: order?.id ?? null, eventKind: 'seller_declines', status: 'declined', via: actor.via });
      return this.view(trx, declined, 'seller') as Promise<SellerAgreementView>;
    });
  }

  /* ---------- Buyer: withdraw and cancel ---------- */

  private async withdrawLocked(trx: Transaction, p: Principal, state: RequestState, row: AgreementRow, reason: string, actor: ResolvedActor, key: string): Promise<AgreementRow> {
    await this.recordEvent(trx, p, row, 'withdrawn', this.buyer(row), actor, key, { reason });
    const withdrawn = await agreements.setStatus(trx, row.id, row.revision, { status: 'withdrawn', closed_reason: reason });
    if (!withdrawn) throw new ApiError('validation.revision_conflict');
    const order = await orders.liveForAgreement(trx, row.id);
    if (order) {
      await orders.setStatus(trx, order.id, order.revision, { status: 'cancelled', cancelled_reason: reason });
      if (order.reservation_id) await reservations.release(trx, order.reservation_id, `order:${order.id}:withdrawn`);
    }
    await this.audit(trx, p, state, 'agreement.withdrawn', 'agreement', row.id, { orderId: order?.id ?? null, reason, via: actor.via, mandateId: actor.mandateId });
    await this.event(trx, 'agreement', row.id, withdrawn.revision, 'agreement.withdrawn', { agreementId: row.id, orderId: order?.id ?? null, eventKind: 'withdrawn', status: 'withdrawn', via: actor.via });
    return withdrawn;
  }

  /** Before the seller accepts, the buyer withdraws its acceptance; a placed order is cancelled and its reservation released. */
  async withdraw(agreementId: string, input: In<typeof WithdrawAgreementRequestSchema>, key: string, state: RequestState): Promise<BuyerAgreementView> {
    return this.run(state, async (trx, p) => {
      const read = await this.agreementOf(trx, agreementId);
      const { rfq } = await this.requireSide(trx, p, read, 'buyer');
      this.requireBuyer(p, rfq, 'accept', true);
      const row = await agreements.lock(trx, read.id);
      if (!row) throw new ApiError('access.not_found');
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'proposed' && row.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${row.status} agreement is not withdrawn; cancellation after acceptance depends on what happened`, { reason: 'invalid_transition' });
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'agreement', id: row.id });
      return this.view(trx, await this.withdrawLocked(trx, p, state, row, input.reason, actor, key), 'buyer') as Promise<BuyerAgreementView>;
    });
  }

  /**
   * The buyer cancels a placed order (withdrawing its acceptance), or, after the seller declined, releases the
   * reservation the cancelled order still holds. An accepted order is not cancelled here: what happens then depends on
   * what actually happened externally (execution and disputes, EXE-001).
   */
  async cancelOrder(orderId: string, input: In<typeof CancelOrderRequestSchema>, key: string, state: RequestState): Promise<BuyerAgreementView> {
    return this.run(state, async (trx, p) => {
      const order = UUID.test(orderId) ? await orders.get(trx, orderId) : undefined;
      if (!order) throw new ApiError('access.not_found');
      const read = await this.agreementOf(trx, order.agreement_id);
      const { rfq } = await this.requireSide(trx, p, read, 'buyer');
      this.requireBuyer(p, rfq, 'commit_order', true);
      if (order.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'order', id: order.id });
      if (order.status === 'cancelled') {
        if (order.reservation_id) await reservations.release(trx, order.reservation_id, `order:${order.id}:cancelled`);
        await this.audit(trx, p, state, 'order.reservation_released', 'order', order.id, { reservationId: order.reservation_id, via: actor.via, mandateId: actor.mandateId });
        return this.view(trx, read, 'buyer') as Promise<BuyerAgreementView>;
      }
      if (order.status !== 'placed') throw new ApiError('validation.schema', `a ${order.status} order is not cancelled here`, { reason: 'invalid_transition' });
      const row = await agreements.lock(trx, read.id);
      if (!row || (row.status !== 'proposed' && row.status !== 'accepted_by_buyer')) throw new ApiError('validation.revision_conflict');
      return this.view(trx, await this.withdrawLocked(trx, p, state, row, input.reason, actor, key), 'buyer') as Promise<BuyerAgreementView>;
    });
  }

  /* ---------- Private halves ---------- */

  async savePrivate(agreementId: string, input: In<typeof SaveAgreementPrivateCommandSchema>, state: RequestState): Promise<AgreementView> {
    return this.run(state, async (trx, p) => {
      const row = await this.agreementOf(trx, agreementId);
      await this.requireSide(trx, p, row, input.side);
      if (input.side === 'buyer') {
        const existing = await agreementBuyerPrivate.get(trx, row.id);
        if ((existing?.revision ?? 1) !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
        if (existing) {
          if (!(await agreementBuyerPrivate.update(trx, row.id, input.expectedRevision, { approval_refs: [...input.approvalRefs], notes: input.notes, updated_by_person_id: p.personId }))) throw new ApiError('validation.revision_conflict');
        } else {
          const buyer = columnsOf(this.buyer(row));
          await agreementBuyerPrivate.insert(trx, { agreement_id: row.id, owner_person_id: buyer.person, owner_company_id: buyer.company, transaction_budget_id: null, approval_refs: [...input.approvalRefs], notes: input.notes, updated_by_person_id: p.personId });
        }
      } else {
        const existing = await agreementSellerPrivate.get(trx, row.id);
        if ((existing?.revision ?? 1) !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
        if (existing) {
          if (!(await agreementSellerPrivate.update(trx, row.id, input.expectedRevision, { fulfilment_plan: input.fulfilmentPlan, notes: input.notes, updated_by_person_id: p.personId }))) throw new ApiError('validation.revision_conflict');
        } else {
          const seller = columnsOf(this.seller(row));
          await agreementSellerPrivate.insert(trx, { agreement_id: row.id, owner_person_id: seller.person, owner_company_id: seller.company, fulfilment_plan: input.fulfilmentPlan, notes: input.notes, updated_by_person_id: p.personId });
        }
      }
      // Audit names the change only; private values never enter audit, outbox or logs.
      await this.audit(trx, p, state, `agreement.${input.side}_private_saved`, 'agreement', row.id, {});
      return this.view(trx, row, input.side);
    });
  }

  /* ---------- Order changes ---------- */

  private async orderSide(trx: Transaction, p: Principal, orderId: string): Promise<{ order: CommercialOrderRow; agreement: AgreementRow; side: Side; rfq: BuyerSide | null }> {
    const order = UUID.test(orderId) ? await orders.get(trx, orderId) : undefined;
    if (!order) throw new ApiError('access.not_found');
    const agreement = await this.agreementOf(trx, order.agreement_id);
    const { side, rfq } = await this.sideOf(trx, p, agreement);
    return { order, agreement, side, rfq };
  }

  /** Reserves the increase of the gross total from the buyer's transaction budget (a decrease reserves nothing). */
  private async reserveIncrease(trx: Transaction, agreement: AgreementRow, delta: bigint, currency: string, budgetId: string | null, key: string, projectId: string | null): Promise<string | null> {
    if (delta <= 0n) return null;
    if (budgetId === null || !UUID.test(budgetId)) throw new ApiError('commercial.authority_missing', 'a higher total needs a transaction budget for the difference', { reason: 'budget_required' });
    const reservation = await reservations.reserve(trx, { budgetId, kind: 'transaction', amountMinor: delta.toString(), currency, actionIntentId: agreement.id, correlationKey: `order-change:${agreement.id}:${key}`, projectId, ttlSeconds: RESERVATION_TTL_SECONDS });
    return reservation.id;
  }

  /** Either party proposes a newer sent version of the same quote as the new terms of an accepted order. */
  async proposeChange(orderId: string, input: In<typeof ProposeOrderChangeRequestSchema>, key: string, state: RequestState): Promise<AgreementView> {
    return this.run(state, async (trx, p) => {
      const { order, agreement, side, rfq } = await this.orderSide(trx, p, orderId);
      if (side === 'buyer') this.requireBuyer(p, rfq, 'negotiate', true);
      const locked = await orders.lock(trx, order.id);
      if (!locked || locked.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if ((locked.status !== 'accepted' && locked.status !== 'changed') || agreement.status !== 'accepted_by_both') throw new ApiError('validation.schema', 'changes apply to an accepted order', { reason: 'invalid_transition' });
      const actor = await this.actor(p, input.actor, 'negotiate', { kind: 'order', id: order.id });
      const { newQuote, newRfq, gross, digest } = await this.newTerms(trx, agreement, input.quoteVersion);
      const proposer = side === 'buyer' ? this.buyer(agreement) : this.seller(agreement);
      const delta = BigInt(gross.minorUnits) - BigInt(locked.amount_minor);
      if (gross.currency !== locked.currency) throw new ApiError('commercial.currency_mismatch', 'a change keeps the order currency');
      const deltaReservation = side === 'buyer' ? await this.reserveIncrease(trx, agreement, delta, gross.currency, input.transactionBudgetId, key, rfq?.row.project_id ?? null) : null;
      const cols = columnsOf(proposer);
      const change = await orderChanges.insert(trx, {
        order_id: order.id, previous_agreement_id: agreement.id, previous_terms_digest: agreement.accepted_terms_digest, new_quote_version_id: newQuote.id, new_rfq_version_id: newRfq.id,
        new_terms_digest: digest.value, proposer_person_id: cols.person, proposer_company_id: cols.company, proposed_by_person_id: p.personId, proposed_via: actor.via,
        proposed_mandate_id: actor.mandateId, consents: [{ party: proposer, at: this.now().toISOString() }], delta_reservation_id: deltaReservation,
      });
      if (deltaReservation) await this.audit(trx, p, state, 'order.change_reserved', 'order', order.id, { changeId: change.id, reservationId: deltaReservation });
      await this.audit(trx, p, state, 'order.change_proposed', 'order', order.id, { changeId: change.id, newVersionId: newQuote.id, newDigest: digest.value, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'order', order.id, locked.revision, 'order.change_proposed', { orderId: order.id, agreementId: agreement.id, orderChangeId: change.id, versionId: newQuote.id, status: 'proposed', via: actor.via });
      return this.view(trx, agreement, side);
    });
  }

  private async newTerms(trx: Transaction, agreement: AgreementRow, ref: VersionRef): Promise<{ newQuote: QuoteVersionRow; newRfq: RfqVersionRow; gross: Money; digest: Digest }> {
    const newQuote = UUID.test(ref.id) ? await quoteVersions.get(trx, ref.id) : undefined;
    if (!newQuote || newQuote.quote_id !== agreement.quote_id || newQuote.status !== 'sent' || newQuote.digest === null) throw new ApiError('commercial.quote_not_acceptable', 'a change names a newer sent version of the same quote', { reason: 'quote_not_acceptable' });
    const quoteRef = { id: newQuote.id, version: newQuote.version, digest: digestOf(newQuote.digest) };
    if (!sameRef(ref, quoteRef)) throw new ApiError('commercial.digest_mismatch', CHECK_CODES['commercial.digest_mismatch'], { reason: 'digest_mismatch' });
    const newRfq = await rfqVersions.get(trx, newQuote.rfq_version_id);
    if (!newRfq || newRfq.digest === null) throw new ApiError('access.not_found');
    if (!verifyQuoteVersionDigest(quoteVersionContract(newQuote)) || !verifyRfqVersionDigest(rfqVersionContract(newRfq))) throw new ApiError('commercial.digest_mismatch', CHECK_CODES['commercial.digest_mismatch'], { reason: 'digest_mismatch' });
    if (newQuote.stale_reason === 'rfq_amended') throw new ApiError('commercial.stale_version', CHECK_CODES['commercial.stale_version'], { reason: 'stale_version' });
    if (Date.parse((newQuote.payload as QuoteVersionPayload).validity.until) <= this.now().getTime()) throw new ApiError('commercial.quote_expired', CHECK_CODES['commercial.quote_expired']);
    const digest = computeAgreementDigest(quoteRef, { id: newRfq.id, version: newRfq.version, digest: digestOf(newRfq.digest) }, 'rfq_quote');
    return { newQuote, newRfq, gross: (newQuote.payload as QuoteVersionPayload).totals.gross, digest };
  }

  /**
   * The counterparty accepts or rejects, the proposer withdraws. Acceptance supersedes the agreement with a new one
   * pinned to the newer quote version (accepted by both through the change's consents), moves the order to it, waives
   * the old obligations and derives the new ones; a higher total accepted by the buyer reserves the difference.
   */
  async decideChange(orderId: string, changeId: string, input: In<typeof DecideOrderChangeRequestSchema>, key: string, state: RequestState): Promise<AgreementView> {
    return this.run(state, async (trx, p) => {
      const { order, agreement, side, rfq } = await this.orderSide(trx, p, orderId);
      const change = UUID.test(changeId) ? await orderChanges.lock(trx, changeId) : undefined;
      if (!change || change.order_id !== order.id) throw new ApiError('access.not_found');
      if (change.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (change.status !== 'proposed') throw new ApiError('validation.schema', `a ${change.status} change is decided already`, { reason: 'invalid_transition' });
      const proposerSide: Side = (change.proposer_person_id ?? change.proposer_company_id) === (agreement.buyer_person_id ?? agreement.buyer_company_id) ? 'buyer' : 'seller';
      if (input.decision === 'withdraw' ? side !== proposerSide : side === proposerSide) throw new ApiError('access.forbidden', 'the counterparty decides; the proposer withdraws', { reason: 'not_counterparty' });
      if (side === 'buyer') this.requireBuyer(p, rfq, input.decision === 'accept' ? 'commit_order' : 'negotiate', true);
      const action = input.decision === 'accept' ? (side === 'buyer' ? 'place_order' : 'accept_order') : 'negotiate';
      if (input.decision !== 'accept') {
        const actor = await this.actor(p, input.actor, action, { kind: 'order', id: order.id });
        const status = input.decision === 'reject' ? 'rejected' : 'withdrawn';
        const decided = await orderChanges.decide(trx, change.id, change.revision, { status, decided_by_person_id: p.personId, decided_reason: input.reason });
        if (!decided) throw new ApiError('validation.revision_conflict');
        // A buyer's reservation for a proposed increase is released when the buyer withdraws; after a seller's rejection
        // the buyer releases it or it expires (the seller has no authority over the buyer's budget).
        if (change.delta_reservation_id && side === 'buyer') await reservations.release(trx, change.delta_reservation_id, `order-change:${change.id}:${status}`);
        await this.audit(trx, p, state, `order.change_${status}`, 'order', order.id, { changeId: change.id, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
        await this.event(trx, 'order', order.id, order.revision, `order.change_${status}`, { orderId: order.id, orderChangeId: change.id, status, via: actor.via });
        return this.view(trx, agreement, side);
      }
      if (change.previous_agreement_id !== agreement.id || agreement.status !== 'accepted_by_both') throw new ApiError('validation.revision_conflict', 'the order moved on since the change was proposed', { reason: 'terms_changed' });
      const newQuote = await quoteVersions.get(trx, change.new_quote_version_id);
      if (!newQuote || newQuote.digest === null) throw new ApiError('commercial.quote_not_acceptable', CHECK_CODES['commercial.quote_not_acceptable']);
      const { newRfq, gross, digest } = await this.newTerms(trx, agreement, { id: newQuote.id, version: newQuote.version, digest: digestOf(newQuote.digest) });
      if (digest.value !== change.new_terms_digest) throw new ApiError('commercial.digest_mismatch', CHECK_CODES['commercial.digest_mismatch'], { reason: 'digest_mismatch' });
      const actor = await this.actor(p, input.actor, action, { kind: 'order', id: order.id }, gross);
      const delta = BigInt(gross.minorUnits) - BigInt(order.amount_minor);
      const deltaReservation = side === 'buyer' ? await this.reserveIncrease(trx, agreement, delta, gross.currency, input.transactionBudgetId, key, rfq?.row.project_id ?? null) : change.delta_reservation_id;
      if (side === 'seller' && delta > 0n && deltaReservation === null) throw new ApiError('commercial.authority_missing', 'a higher total proposed by the buyer must come with its reservation', { reason: 'budget_required' });
      const lockedAgreement = await agreements.lock(trx, agreement.id);
      if (!lockedAgreement || lockedAgreement.status !== 'accepted_by_both') throw new ApiError('validation.revision_conflict');
      const newId = randomUUID();
      const superseded = await agreements.setStatus(trx, agreement.id, lockedAgreement.revision, { status: 'superseded', superseded_by: newId });
      if (!superseded) throw new ApiError('validation.revision_conflict');
      const next = await agreements.insert(trx, {
        id: newId, buyer_person_id: agreement.buyer_person_id, buyer_company_id: agreement.buyer_company_id, seller_person_id: agreement.seller_person_id, seller_company_id: agreement.seller_company_id,
        rfq_id: agreement.rfq_id as string, quote_id: agreement.quote_id as string, quote_version_id: newQuote.id, rfq_version_id: newRfq.id, offer_version: newQuote.version, offer_digest: newQuote.digest,
        request_version: newRfq.version, request_digest: newRfq.digest as string, accepted_terms_digest: digest.value, status: 'accepted_by_both', supersedes_id: agreement.id, created_by_person_id: p.personId,
      });
      const consents = [...(change.consents as unknown[]), { party: side === 'buyer' ? this.buyer(agreement) : this.seller(agreement), at: this.now().toISOString() }];
      const decided = await orderChanges.decide(trx, change.id, change.revision, { status: 'accepted', consents, new_agreement_id: next.id, delta_reservation_id: deltaReservation, decided_by_person_id: p.personId, decided_reason: input.reason });
      if (!decided) throw new ApiError('validation.revision_conflict');
      const moved = await orders.moveToAgreement(trx, order.id, { agreement_id: next.id, accepted_terms_digest: digest.value, amount_minor: gross.minorUnits, currency: gross.currency });
      await obligations.waiveOpen(trx, agreement.id);
      await this.insertObligations(trx, next, newQuote.payload as QuoteVersionPayload);
      await quoteVersions.setStatus(trx, newQuote.id, 'sent', 'accepted');
      await this.audit(trx, p, state, 'order.change_accepted', 'order', order.id, { changeId: change.id, previousAgreementId: agreement.id, agreementId: next.id, digest: digest.value, reservationId: deltaReservation, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'order', order.id, moved.revision, 'order.change_accepted', { orderId: order.id, orderChangeId: change.id, agreementId: next.id, status: 'changed', via: actor.via });
      return this.view(trx, next, side);
    });
  }
}

function obligationContract(row: ObligationRow) {
  return {
    party: partyOfColumns(row.obligor_person_id, row.obligor_company_id), kind: row.kind, due: row.due ? iso(row.due) : null,
    amount: row.amount_minor !== null && row.currency !== null ? { minorUnits: String(row.amount_minor), currency: row.currency } : null,
    scope: row.scope_value !== null && row.scope_unit !== null ? { value: row.scope_value, unit: row.scope_unit } : null,
  };
}
function eventContract(row: AcceptanceEventRow) {
  return SharedAcceptanceEventSchema.parse({
    id: row.id, kind: row.kind, termsKind: row.terms_kind,
    quoteVersion: { id: row.quote_version_id, version: row.offer_version, digest: digestOf(row.offer_digest) },
    rfqVersion: { id: row.rfq_version_id, version: row.request_version, digest: digestOf(row.request_digest) },
    acceptedTermsDigest: digestOf(row.accepted_terms_digest), onBehalfOf: partyOfColumns(row.on_behalf_person_id, row.on_behalf_company_id),
    electronicRecords: row.e_records_disclosure_key ? { disclosureKey: row.e_records_disclosure_key, basis: row.e_records_basis } : null, occurredAt: iso(row.occurred_at),
  });
}
function orderContract(row: CommercialOrderRow) {
  return OrderSchema.parse({
    id: row.id, agreementId: row.agreement_id, acceptedTermsDigest: digestOf(row.accepted_terms_digest), status: row.status, externalReference: row.external_reference,
    reservationId: row.reservation_id, revision: row.revision, createdAt: iso(row.created_at),
  });
}
function orderChangeContract(row: OrderChangeRow, version: QuoteVersionRow | undefined) {
  return OrderChangeSchema.parse({
    id: row.id, orderId: row.order_id, previousTermsDigest: digestOf(row.previous_terms_digest), newTermsDigest: digestOf(row.new_terms_digest),
    newQuoteVersion: { id: row.new_quote_version_id, version: version?.version ?? 1, digest: digestOf(version?.digest ?? row.new_terms_digest) },
    proposer: partyOfColumns(row.proposer_person_id, row.proposer_company_id), status: row.status, consents: row.consents, revision: row.revision, createdAt: iso(row.created_at),
  });
}
