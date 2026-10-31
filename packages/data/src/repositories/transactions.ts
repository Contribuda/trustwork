import type { Transaction } from '../pool.js';
import type {
  AcceptanceEventKindValue, AcceptanceEventRow, AgreementBuyerPrivateRow, AgreementRow, AgreementSellerPrivateRow, AgreementStatusValue, AmendmentRequestRow, CommercialOrderRow, DealVia,
  NegotiationRoundRow, ObligationKindValue, ObligationRow, OrderChangeRow, OrderChangeStatusValue, OrderStatusValue, QuoteLineRow, QuotePrivateConstraintRow, QuoteRow, QuoteStatusValue,
  QuoteVersionRow, TaxabilityValue, TaxDeterminationRow, TaxProviderValue,
} from '../schema/transactions.js';
// The RFQ tables the quote and agreement guards read (procurement, COM-001).
import '../schema/commerce.js';

/**
 * Transactions repository (COM-002). Thin typed access under `withPrincipal`: RLS scopes every read and write (the seller
 * side of a quote, the RFQ owner side for sent versions, either side of an agreement or order, each private half to its
 * own side), and the guards in packages/data/migrations/transactions freeze sent versions and agreed terms, pin quotes to
 * the current RFQ version, check the digest equality of acceptance events and keep everything retained. Mutable
 * envelopes change with an expected revision.
 */
type Party = { person: string | null; company: string | null };
const json = (value: unknown): string => JSON.stringify(value);
export type PartyScope = { personId: string; companyId: string | null };

/* ---------- Quotes ---------- */

export const quotes = {
  insert(trx: Transaction, row: { rfq_id: string; seller_person_id: string | null; seller_company_id: string | null; invitation_id: string; creator_person_id: string }): Promise<QuoteRow> {
    return trx.insertInto('quote').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<QuoteRow | undefined> {
    return trx.selectFrom('quote').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Seller side only (the update policy): serializes versions and sends of one quote. */
  lock(trx: Transaction, id: string): Promise<QuoteRow | undefined> {
    return trx.selectFrom('quote').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  forSeller(trx: Transaction, rfqId: string, seller: Party): Promise<QuoteRow | undefined> {
    let q = trx.selectFrom('quote').selectAll().where('rfq_id', '=', rfqId);
    q = seller.person ? q.where('seller_person_id', '=', seller.person) : q.where('seller_company_id', '=', seller.company as string);
    return q.executeTakeFirst();
  },
  /** Quotes where the principal (or the company it acts for) is the seller, newest first. */
  listForSeller(trx: Transaction, scope: PartyScope): Promise<QuoteRow[]> {
    return trx.selectFrom('quote').selectAll()
      .where((eb) => (scope.companyId ? eb.or([eb('seller_person_id', '=', scope.personId), eb('seller_company_id', '=', scope.companyId)]) : eb('seller_person_id', '=', scope.personId)))
      .orderBy('updated_at', 'desc').orderBy('id').execute();
  },
  listForRfq(trx: Transaction, rfqId: string): Promise<QuoteRow[]> {
    return trx.selectFrom('quote').selectAll().where('rfq_id', '=', rfqId).orderBy('created_at').orderBy('id').execute();
  },
  /** Records a change of the aggregate on its envelope (revision + 1) when the expected revision still holds. */
  bump(trx: Transaction, id: string, expectedRevision: number): Promise<QuoteRow | undefined> {
    return trx.updateTable('quote').set((eb) => ({ status: eb.ref('status') })).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  setCurrent(trx: Transaction, id: string, input: { status: QuoteStatusValue; current_version: number; current_version_id: string; invitation_id: string; clearStale: boolean }): Promise<QuoteRow> {
    return trx.updateTable('quote')
      .set({
        status: input.status, current_version: input.current_version, current_version_id: input.current_version_id, invitation_id: input.invitation_id, withdrawn_reason: null,
        ...(input.clearStale ? { stale_reason: null, stale_at: null } : {}),
      })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  setStatus(trx: Transaction, id: string, expectedRevision: number | null, input: { status: QuoteStatusValue; withdrawn_reason: string | null }): Promise<QuoteRow | undefined> {
    let q = trx.updateTable('quote').set(input).where('id', '=', id);
    if (expectedRevision !== null) q = q.where('revision', '=', expectedRevision);
    return q.returningAll().executeTakeFirst();
  },
};

export const quoteVersions = {
  insertDraft(trx: Transaction, row: { quote_id: string; version: number; rfq_id: string; rfq_version_id: string; rfq_version: number; rfq_version_digest: string; payload: unknown; drafted_by_person_id: string; revalidated_from: number | null; answers_amendment_request_id: string | null }): Promise<QuoteVersionRow> {
    return trx.insertInto('quote_version').values({ ...row, payload: json(row.payload) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<QuoteVersionRow | undefined> {
    return trx.selectFrom('quote_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, quoteId: string): Promise<QuoteVersionRow[]> {
    return trx.selectFrom('quote_version').selectAll().where('quote_id', '=', quoteId).orderBy('version').execute();
  },
  /** Versions of every quote on an RFQ the principal may read (the buyer side never sees drafts). */
  listForRfq(trx: Transaction, rfqId: string): Promise<QuoteVersionRow[]> {
    return trx.selectFrom('quote_version').selectAll().where('rfq_id', '=', rfqId).orderBy('quote_id').orderBy('version').execute();
  },
  inStatus(trx: Transaction, quoteId: string, status: QuoteStatusValue): Promise<QuoteVersionRow | undefined> {
    return trx.selectFrom('quote_version').selectAll().where('quote_id', '=', quoteId).where('status', '=', status).executeTakeFirst();
  },
  saveDraft(trx: Transaction, id: string, payload: unknown): Promise<QuoteVersionRow | undefined> {
    return trx.updateTable('quote_version').set({ payload: json(payload) }).where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  send(trx: Transaction, id: string, input: { digest: string; personId: string; via: DealVia; mandateId: string | null; validUntil: string; at: Date }): Promise<QuoteVersionRow | undefined> {
    return trx.updateTable('quote_version')
      .set({ status: 'sent', digest: input.digest, sent_at: input.at, sent_by_person_id: input.personId, sent_via: input.via, sent_by_mandate_id: input.mandateId, valid_until: input.validUntil })
      .where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  supersede(trx: Transaction, id: string, at: Date): Promise<QuoteVersionRow | undefined> {
    return trx.updateTable('quote_version').set({ status: 'superseded', superseded_at: at }).where('id', '=', id).where('status', '=', 'sent').returningAll().executeTakeFirst();
  },
  setStatus(trx: Transaction, id: string, from: QuoteStatusValue, to: QuoteStatusValue): Promise<QuoteVersionRow | undefined> {
    return trx.updateTable('quote_version').set({ status: to }).where('id', '=', id).where('status', '=', from).returningAll().executeTakeFirst();
  },
};

export interface TaxDeterminationInsert {
  line_id: string; jurisdiction: string | null; rule_ref: string; rate: string | null; included: boolean; taxability: TaxabilityValue; exemption_ref: string | null; provider: TaxProviderValue;
}
export const taxDeterminations = {
  async insertMany(trx: Transaction, quoteId: string, versionId: string, personId: string, rows: readonly TaxDeterminationInsert[]): Promise<TaxDeterminationRow[]> {
    if (rows.length === 0) return [];
    return trx.insertInto('tax_determination').values(rows.map((r) => ({ ...r, quote_id: quoteId, quote_version_id: versionId, determined_by_person_id: personId }))).returningAll().execute();
  },
  listFor(trx: Transaction, versionId: string): Promise<TaxDeterminationRow[]> {
    return trx.selectFrom('tax_determination').selectAll().where('quote_version_id', '=', versionId).orderBy('line_id').execute();
  },
};

export interface QuoteLineInsert {
  position: number; line_id: string; rfq_line_id: string | null; kind: 'goods' | 'works' | 'services'; spec_snapshot: Record<string, string>; offering_ref: string | null; offering_version: number | null;
  quantity_value: string; quantity_unit: string; currency: string; unit_price_minor: string; tax_determination_id: string; tax_amount_minor: string; line_total_minor: string;
}
export const quoteLines = {
  async insertMany(trx: Transaction, quoteId: string, versionId: string, rows: readonly QuoteLineInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await trx.insertInto('quote_line').values(rows.map((r) => ({ ...r, spec_snapshot: json(r.spec_snapshot), quote_id: quoteId, quote_version_id: versionId }))).execute();
  },
  listFor(trx: Transaction, versionId: string): Promise<QuoteLineRow[]> {
    return trx.selectFrom('quote_line').selectAll().where('quote_version_id', '=', versionId).orderBy('position').execute();
  },
};

export interface QuotePrivateColumns { floor_prices: unknown; margin_targets: unknown; cost_basis: unknown; negotiation_notes: string }
export const quotePrivate = {
  insert(trx: Transaction, row: QuotePrivateColumns & { quote_id: string; owner_person_id: string | null; owner_company_id: string | null; updated_by_person_id: string }): Promise<QuotePrivateConstraintRow> {
    return trx.insertInto('quote_private_constraint')
      .values({ ...row, floor_prices: json(row.floor_prices), margin_targets: json(row.margin_targets), cost_basis: json(row.cost_basis) })
      .returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, quoteId: string): Promise<QuotePrivateConstraintRow | undefined> {
    return trx.selectFrom('quote_private_constraint').selectAll().where('quote_id', '=', quoteId).executeTakeFirst();
  },
  update(trx: Transaction, quoteId: string, expectedRevision: number, row: QuotePrivateColumns & { updated_by_person_id: string }): Promise<QuotePrivateConstraintRow | undefined> {
    return trx.updateTable('quote_private_constraint')
      .set({ ...row, floor_prices: json(row.floor_prices), margin_targets: json(row.margin_targets), cost_basis: json(row.cost_basis) })
      .where('quote_id', '=', quoteId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

/* ---------- Negotiation ---------- */

export const amendmentRequests = {
  insert(trx: Transaction, row: {
    quote_id: string; quote_version_id: string; requester_person_id: string | null; requester_company_id: string | null; requested_by_person_id: string; requested_via: DealVia;
    requested_mandate_id: string | null; line_refs: string[]; changes: unknown; target_total_minor: string | null; target_total_currency: string | null;
  }): Promise<AmendmentRequestRow> {
    return trx.insertInto('amendment_request').values({ ...row, changes: json(row.changes) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<AmendmentRequestRow | undefined> {
    return trx.selectFrom('amendment_request').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, quoteId: string): Promise<AmendmentRequestRow[]> {
    return trx.selectFrom('amendment_request').selectAll().where('quote_id', '=', quoteId).orderBy('created_at').orderBy('id').execute();
  },
  answer(trx: Transaction, id: string, versionId: string): Promise<AmendmentRequestRow | undefined> {
    return trx.updateTable('amendment_request').set({ status: 'answered', answered_by_version_id: versionId }).where('id', '=', id).where('status', '=', 'open').returningAll().executeTakeFirst();
  },
  withdraw(trx: Transaction, id: string, reason: string): Promise<AmendmentRequestRow | undefined> {
    return trx.updateTable('amendment_request').set({ status: 'withdrawn', withdrawn_reason: reason }).where('id', '=', id).where('status', '=', 'open').returningAll().executeTakeFirst();
  },
};

export const negotiationRounds = {
  /** The next round number of the quote (a concurrent round with the same number fails the unique constraint). */
  async append(trx: Transaction, row: {
    rfq_id: string; quote_id: string; proposal_kind: 'quote_version' | 'amendment_request'; proposal_id: string; proposer_person_id: string | null; proposer_company_id: string | null;
    proposed_by_person_id: string; proposed_via: DealVia; proposed_mandate_id: string | null;
  }): Promise<NegotiationRoundRow> {
    const last = await trx.selectFrom('negotiation_round').select((eb) => eb.fn.max('round_no').as('max')).where('quote_id', '=', row.quote_id).executeTakeFirst();
    return trx.insertInto('negotiation_round').values({ ...row, round_no: (last?.max ?? 0) + 1 }).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, quoteId: string): Promise<NegotiationRoundRow[]> {
    return trx.selectFrom('negotiation_round').selectAll().where('quote_id', '=', quoteId).orderBy('round_no').execute();
  },
};

/* ---------- Agreements ---------- */

export interface AgreementInsert {
  id?: string; buyer_person_id: string | null; buyer_company_id: string | null; seller_person_id: string | null; seller_company_id: string | null; rfq_id: string; quote_id: string;
  quote_version_id: string; rfq_version_id: string; offer_version: number; offer_digest: string; request_version: number; request_digest: string; accepted_terms_digest: string;
  status: AgreementStatusValue; supersedes_id: string | null; created_by_person_id: string;
}
export const agreements = {
  insert(trx: Transaction, row: AgreementInsert): Promise<AgreementRow> {
    return trx.insertInto('agreement').values({ ...row, terms_kind: 'rfq_quote' }).returningAll().executeTakeFirstOrThrow();
  },
  // RFQ-quote agreements only: task agreements (TASK-001) are read and moved through the tasks module.
  get(trx: Transaction, id: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('id', '=', id).where('terms_kind', '=', 'rfq_quote').executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('id', '=', id).where('terms_kind', '=', 'rfq_quote').forUpdate().executeTakeFirst();
  },
  liveForRfq(trx: Transaction, rfqId: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('rfq_id', '=', rfqId).where('status', 'in', ['proposed', 'accepted_by_buyer', 'accepted_by_both']).executeTakeFirst();
  },
  /** RFQ-quote agreements where the principal (or the company it acts for) is a party, newest first. */
  listForParties(trx: Transaction, scope: PartyScope): Promise<AgreementRow[]> {
    return trx.selectFrom('agreement').selectAll().where('terms_kind', '=', 'rfq_quote')
      .where((eb) => {
        const clauses = [eb('buyer_person_id', '=', scope.personId), eb('seller_person_id', '=', scope.personId)];
        if (scope.companyId) clauses.push(eb('buyer_company_id', '=', scope.companyId), eb('seller_company_id', '=', scope.companyId));
        return eb.or(clauses);
      })
      .orderBy('created_at', 'desc').orderBy('id').execute();
  },
  setStatus(trx: Transaction, id: string, expectedRevision: number, input: { status: AgreementStatusValue; closed_reason?: string | null; superseded_by?: string | null }): Promise<AgreementRow | undefined> {
    return trx.updateTable('agreement').set(input).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const agreementBuyerPrivate = {
  insert(trx: Transaction, row: { agreement_id: string; owner_person_id: string | null; owner_company_id: string | null; transaction_budget_id: string | null; approval_refs: string[]; notes: string | null; updated_by_person_id: string }): Promise<AgreementBuyerPrivateRow> {
    return trx.insertInto('agreement_buyer_private').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, agreementId: string): Promise<AgreementBuyerPrivateRow | undefined> {
    return trx.selectFrom('agreement_buyer_private').selectAll().where('agreement_id', '=', agreementId).executeTakeFirst();
  },
  update(trx: Transaction, agreementId: string, expectedRevision: number | null, row: { transaction_budget_id?: string | null; approval_refs?: string[]; notes?: string | null; updated_by_person_id: string }): Promise<AgreementBuyerPrivateRow | undefined> {
    let q = trx.updateTable('agreement_buyer_private').set(row).where('agreement_id', '=', agreementId);
    if (expectedRevision !== null) q = q.where('revision', '=', expectedRevision);
    return q.returningAll().executeTakeFirst();
  },
};

export const agreementSellerPrivate = {
  insert(trx: Transaction, row: { agreement_id: string; owner_person_id: string | null; owner_company_id: string | null; fulfilment_plan: unknown; notes: string | null; updated_by_person_id: string }): Promise<AgreementSellerPrivateRow> {
    return trx.insertInto('agreement_seller_private').values({ ...row, fulfilment_plan: json(row.fulfilment_plan) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, agreementId: string): Promise<AgreementSellerPrivateRow | undefined> {
    return trx.selectFrom('agreement_seller_private').selectAll().where('agreement_id', '=', agreementId).executeTakeFirst();
  },
  update(trx: Transaction, agreementId: string, expectedRevision: number, row: { fulfilment_plan: unknown; notes: string | null; updated_by_person_id: string }): Promise<AgreementSellerPrivateRow | undefined> {
    return trx.updateTable('agreement_seller_private').set({ ...row, fulfilment_plan: json(row.fulfilment_plan) }).where('agreement_id', '=', agreementId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export interface AcceptanceEventInsert {
  agreement_id: string; kind: AcceptanceEventKindValue; terms_kind: 'rfq_quote' | 'task' | 'consultation'; quote_version_id: string | null; rfq_version_id: string | null; offer_version: number;
  offer_digest: string; request_version: number; request_digest: string; accepted_terms_digest: string; actor_person_id: string; on_behalf_person_id: string | null;
  on_behalf_company_id: string | null; via: DealVia; mandate_id: string | null; transaction_budget_id: string | null; reservation_id: string | null; platform_budget_id: string | null;
  e_records_required: boolean; e_records_disclosure_key: string | null; e_records_basis: string[]; e_records_consented_at: Date | null; reason: string | null; idempotency_key: string;
}
export const acceptanceEvents = {
  insert(trx: Transaction, row: AcceptanceEventInsert): Promise<AcceptanceEventRow> {
    return trx.insertInto('acceptance_event').values(row).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, agreementId: string): Promise<AcceptanceEventRow[]> {
    return trx.selectFrom('acceptance_event').selectAll().where('agreement_id', '=', agreementId).orderBy('occurred_at').orderBy('id').execute();
  },
};

/* ---------- Orders, changes, obligations ---------- */

export const orders = {
  insert(trx: Transaction, row: {
    agreement_id: string; accepted_terms_digest: string; context_kind: 'project' | 'rfq'; context_id: string; external_reference: string | null; amount_minor: string; currency: string;
    transaction_budget_id: string; reservation_id: string | null; placed_by_person_id: string; placed_via: DealVia; placed_mandate_id: string | null;
  }): Promise<CommercialOrderRow> {
    return trx.insertInto('commercial_order').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<CommercialOrderRow | undefined> {
    return trx.selectFrom('commercial_order').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<CommercialOrderRow | undefined> {
    return trx.selectFrom('commercial_order').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** Orders of an agreement chain: the orders placed on it and orders moved to it by accepted changes. */
  /** Orders placed on an agreement, plus the given orders (moved along a chain of superseding agreements). */
  listForAgreement(trx: Transaction, agreementId: string, alsoIds: readonly string[] = []): Promise<CommercialOrderRow[]> {
    return trx.selectFrom('commercial_order').selectAll()
      .where((eb) => (alsoIds.length > 0 ? eb.or([eb('agreement_id', '=', agreementId), eb('id', 'in', [...alsoIds])]) : eb('agreement_id', '=', agreementId)))
      .orderBy('created_at').orderBy('id').execute();
  },
  liveForAgreement(trx: Transaction, agreementId: string): Promise<CommercialOrderRow | undefined> {
    return trx.selectFrom('commercial_order').selectAll().where('agreement_id', '=', agreementId).where('status', '<>', 'cancelled').executeTakeFirst();
  },
  setStatus(trx: Transaction, id: string, expectedRevision: number | null, input: { status: OrderStatusValue; cancelled_reason?: string | null }): Promise<CommercialOrderRow | undefined> {
    let q = trx.updateTable('commercial_order').set(input).where('id', '=', id);
    if (expectedRevision !== null) q = q.where('revision', '=', expectedRevision);
    return q.returningAll().executeTakeFirst();
  },
  moveToAgreement(trx: Transaction, id: string, input: { agreement_id: string; accepted_terms_digest: string; amount_minor: string; currency: string }): Promise<CommercialOrderRow> {
    return trx.updateTable('commercial_order').set({ ...input, status: 'changed' }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
};

export const orderChanges = {
  insert(trx: Transaction, row: {
    order_id: string; previous_agreement_id: string; previous_terms_digest: string; new_quote_version_id: string; new_rfq_version_id: string; new_terms_digest: string;
    proposer_person_id: string | null; proposer_company_id: string | null; proposed_by_person_id: string; proposed_via: DealVia; proposed_mandate_id: string | null; consents: unknown;
    delta_reservation_id: string | null;
  }): Promise<OrderChangeRow> {
    return trx.insertInto('order_change').values({ ...row, consents: json(row.consents) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<OrderChangeRow | undefined> {
    return trx.selectFrom('order_change').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<OrderChangeRow | undefined> {
    return trx.selectFrom('order_change').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** Changes that left from or arrived at an agreement (an order moves along the chain of superseding agreements). */
  listForAgreement(trx: Transaction, agreementId: string): Promise<OrderChangeRow[]> {
    return trx.selectFrom('order_change').selectAll().where((eb) => eb.or([eb('previous_agreement_id', '=', agreementId), eb('new_agreement_id', '=', agreementId)])).orderBy('created_at').orderBy('id').execute();
  },
  listForOrders(trx: Transaction, orderIds: readonly string[]): Promise<OrderChangeRow[]> {
    if (orderIds.length === 0) return Promise.resolve([]);
    return trx.selectFrom('order_change').selectAll().where('order_id', 'in', orderIds).orderBy('created_at').orderBy('id').execute();
  },
  decide(trx: Transaction, id: string, expectedRevision: number, input: { status: OrderChangeStatusValue; consents?: unknown; new_agreement_id?: string | null; delta_reservation_id?: string | null; decided_by_person_id: string; decided_reason: string | null }): Promise<OrderChangeRow | undefined> {
    const { consents, ...rest } = input;
    return trx.updateTable('order_change').set({ ...rest, ...(consents !== undefined ? { consents: json(consents) } : {}) })
      .where('id', '=', id).where('revision', '=', expectedRevision).where('status', '=', 'proposed').returningAll().executeTakeFirst();
  },
};

export interface ObligationInsert {
  position: number; obligor_person_id: string | null; obligor_company_id: string | null; kind: ObligationKindValue; due: string | null; amount_minor: string | null; currency: string | null;
  scope_value: string | null; scope_unit: string | null;
}
export const obligations = {
  async insertMany(trx: Transaction, agreementId: string, rows: readonly ObligationInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await trx.insertInto('obligation').values(rows.map((r) => ({ ...r, agreement_id: agreementId }))).execute();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ObligationRow[]> {
    return trx.selectFrom('obligation').selectAll().where('agreement_id', '=', agreementId).orderBy('position').execute();
  },
  waiveOpen(trx: Transaction, agreementId: string): Promise<ObligationRow[]> {
    return trx.updateTable('obligation').set({ status: 'waived' }).where('agreement_id', '=', agreementId).where('status', '=', 'open').returningAll().execute();
  },
};
