import type { z } from 'zod';
import {
  computeQuoteVersionDigest, DIGEST_ALGORITHM, verifyQuoteTotals, type Party, type Principal, type QuoteVersionPayload,
} from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { DealService, iso, UUID, type ResolvedActor } from './common.js';
import {
  aboveCeiling, amendmentRequests, compareQuotes, EMPTY_QUOTE_PRIVATE, linesBelowFloor, negotiationRounds, QuoteListSchema, QuotePayloadWithKnownUnitsSchema, quoteLines, quotePrivate, quotes,
  quoteVersions, rfqInvitations, rfqPrivate, rfqVersions, taxDeterminations,
  type BuyerQuoteView, type ComparisonQuerySchema, type CreateAmendmentRequestCommandSchema, type CreateQuoteCommandSchema, type OpenQuoteVersionCommandSchema, type QuoteComparison,
  type QuotePrivateInput, type QuoteRow, type QuoteVersionRow, type RfqInvitationRow, type RfqRow, type RfqVersionRow, type SaveQuoteDraftCommandSchema, type SaveQuotePrivateCommandSchema,
  type SellerQuoteView, type SendQuoteCommandSchema, type WithdrawAmendmentRequestCommandSchema, type WithdrawQuoteCommandSchema,
} from './deps.js';
import type { DealMandatePort } from './mandates.js';
import { buyerOf, buyerQuoteView, sellerOf, sellerQuoteView } from './serializers.js';
import type { TaxDeterminationPort } from './tax.js';
import { ScreeningGate } from '../screening-gates/gate.js';

type In<T extends z.ZodType> = z.infer<T>;
const sameParty = (a: Party, b: Party) => a.kind === b.kind && a.id === b.id;
const partyColumns = (party: Party) => (party.kind === 'person' ? { person: party.id, company: null } : { person: null, company: party.id });
const digestOf = (value: string) => ({ algorithm: DIGEST_ALGORITHM, value });

function privateColumns(input: QuotePrivateInput) {
  return { floor_prices: { ...input.floorPrices }, margin_targets: { ...input.marginTargets }, cost_basis: { ...input.costBasis }, negotiation_notes: input.negotiationNotes };
}
/** Every RFQ line a quote line answers or substitutes exists in the pinned RFQ version. */
function unknownRfqLines(payload: QuoteVersionPayload, rfqPayload: unknown): string[] {
  const known = new Set(((rfqPayload as { lines?: { lineId: string }[] }).lines ?? []).map((l) => l.lineId));
  return payload.lines.flatMap((l) => [l.rfqLineId, l.substitution?.forRfqLineId ?? null]).filter((id): id is string => id !== null && !known.has(id));
}

/**
 * Quotes, negotiation and comparison (COM-002). A seller (the invited party) drafts quote versions against the current
 * published RFQ version and sends them; a sent version is immutable and digested over `{ rfqVersion, payload }`; an RFQ
 * amendment flags earlier versions stale in the database and a revalidated version is a new version pinned to the
 * current RFQ version. The buyer side reads sent versions as shared projections, compares only versions pinned to the
 * current RFQ version and negotiates with structured amendment requests. Agents act only under mandates, never below
 * the seller's floors or above the buyer's ceiling.
 */
export class SalesService extends DealService {
  constructor(ctx: AppContext, principals: PrincipalService, policy: ParticipationService, mandates: DealMandatePort, private readonly tax: TaxDeterminationPort, gate: ScreeningGate = new ScreeningGate(ctx.clock)) {
    super(ctx, principals, policy, mandates, gate);
  }

  /* ---------- Loading ---------- */

  private async quoteOf(trx: Transaction, quoteId: string): Promise<QuoteRow> {
    if (!UUID.test(quoteId)) throw new ApiError('access.not_found');
    const row = await quotes.get(trx, quoteId);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }
  /** Seller side for writes: the seller party acts; the buyer side is refused (it can read), everyone else does not find it. */
  private async sellerQuote(trx: Transaction, p: Principal, quoteId: string): Promise<QuoteRow> {
    const read = await this.quoteOf(trx, quoteId);
    if (!this.actsFor(p, sellerOf(read))) throw new ApiError('access.forbidden', 'only the seller changes its quote', { reason: 'not_seller' });
    const locked = await quotes.lock(trx, quoteId);
    if (!locked) throw new ApiError('access.not_found');
    return locked;
  }
  private async sellerView(trx: Transaction, quote: QuoteRow): Promise<SellerQuoteView> {
    const [versions, privateRow, rounds, requests] = await Promise.all([quoteVersions.listFor(trx, quote.id), quotePrivate.get(trx, quote.id), negotiationRounds.listFor(trx, quote.id), amendmentRequests.listFor(trx, quote.id)]);
    if (!privateRow) throw new Error(`quote ${quote.id} has no private constraint`);
    return sellerQuoteView({ quote, versions, privateRow, rounds, requests });
  }
  private async buyerView(trx: Transaction, quote: QuoteRow): Promise<BuyerQuoteView> {
    const [versions, rounds, requests] = await Promise.all([quoteVersions.listFor(trx, quote.id), negotiationRounds.listFor(trx, quote.id), amendmentRequests.listFor(trx, quote.id)]);
    return buyerQuoteView({ quote, versions, rounds, requests });
  }

  /** The seller's invitations on the RFQ, newest first. */
  private async invitationsOf(trx: Transaction, rfqId: string, seller: Party): Promise<RfqInvitationRow[]> {
    const cols = partyColumns(seller);
    return (await rfqInvitations.listForRfq(trx, rfqId)).filter((i) => i.party_person_id === cols.person && i.party_company_id === cols.company).sort((a, b) => +new Date(b.sent_at) - +new Date(a.sent_at));
  }
  /** The invitation that lets the seller answer the current RFQ version, or a precise refusal. */
  private async currentInvitation(trx: Transaction, rfq: RfqRow, seller: Party): Promise<RfqInvitationRow> {
    const own = (await this.invitationsOf(trx, rfq.id, seller)).filter((i) => i.status !== 'declined' && i.status !== 'withdrawn');
    if (own.length === 0) throw new ApiError('access.forbidden', 'the seller holds no invitation for this RFQ', { reason: 'not_invited' });
    const current = own.find((i) => i.rfq_version_id === rfq.current_version_id && i.stale_reason === null);
    if (!current) throw new ApiError('commercial.rfq_version_not_current', 'the RFQ changed; wait for a revalidated invitation', { reason: 'invitation_stale', currentRfqVersionId: rfq.current_version_id });
    return current;
  }
  /** The pin must be the current published version and the seller must hold a current invitation for it (checked in that order, before the version is read). */
  private async currentRfqVersion(trx: Transaction, rfq: RfqRow, rfqVersionId: string, seller: Party): Promise<{ version: RfqVersionRow; invitation: RfqInvitationRow }> {
    if (rfq.status !== 'published' || rfq.current_version_id === null) throw new ApiError('commercial.rfq_version_not_current', 'quotes answer a published RFQ', { reason: 'not_published' });
    if (rfqVersionId !== rfq.current_version_id) throw new ApiError('commercial.rfq_version_not_current', 'quotes answer the current published RFQ version', { reason: 'rfq_version_not_current', currentRfqVersionId: rfq.current_version_id });
    const invitation = await this.currentInvitation(trx, rfq, seller);
    const version = await rfqVersions.get(trx, rfqVersionId);
    if (!version || version.digest === null) throw new ApiError('access.not_found');
    return { version, invitation };
  }
  private checkPayloadAgainst(payload: QuoteVersionPayload, rfqVersion: RfqVersionRow): void {
    const unknown = unknownRfqLines(payload, rfqVersion.payload);
    if (unknown.length > 0) throw new ApiError('validation.schema', 'quote lines answer lines of the pinned RFQ version', { reason: 'unknown_rfq_line', lines: unknown });
  }

  /* ---------- Seller: quotes ---------- */

  async createQuote(input: In<typeof CreateQuoteCommandSchema>, state: RequestState): Promise<SellerQuoteView> {
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, input.seller)) throw new ApiError('access.forbidden', 'quotes belong to a party you act for', { reason: 'not_authorised' });
      const loaded = await this.loadRfq(trx, input.rfqId);
      if (!loaded) throw new ApiError('access.not_found');
      const rfq = loaded.row;
      if (sameParty(buyerOf({ buyer_person_id: rfq.owner_person_id, buyer_company_id: rfq.owner_company_id }), input.seller)) throw new ApiError('validation.schema', 'the buyer does not quote itself', { reason: 'self_invitation' });
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'rfq', id: rfq.id });
      const { version: rfqVersion, invitation } = await this.currentRfqVersion(trx, rfq, input.rfqVersionId, input.seller);
      this.checkPayloadAgainst(input.payload, rfqVersion);
      const cols = partyColumns(input.seller);
      if (await quotes.forSeller(trx, rfq.id, cols)) throw new ApiError('validation.revision_conflict', 'the seller already has a quote on this RFQ; open a new version', { reason: 'quote_exists' });
      const quote = await quotes.insert(trx, { rfq_id: rfq.id, seller_person_id: cols.person, seller_company_id: cols.company, invitation_id: invitation.id, creator_person_id: p.personId });
      await quotePrivate.insert(trx, { quote_id: quote.id, owner_person_id: cols.person, owner_company_id: cols.company, ...privateColumns(input.privateConstraint ?? EMPTY_QUOTE_PRIVATE), updated_by_person_id: p.personId });
      const draft = await quoteVersions.insertDraft(trx, {
        quote_id: quote.id, version: 1, rfq_id: rfq.id, rfq_version_id: rfqVersion.id, rfq_version: rfqVersion.version, rfq_version_digest: rfqVersion.digest as string, payload: input.payload,
        drafted_by_person_id: p.personId, revalidated_from: null, answers_amendment_request_id: null,
      });
      await this.audit(trx, p, state, 'quote.drafted', 'quote', quote.id, { rfqId: rfq.id, versionId: draft.id, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'quote', quote.id, quote.revision, 'quote.drafted', { quoteId: quote.id, rfqId: rfq.id, versionId: draft.id, version: 1, via: actor.via });
      return this.sellerView(trx, quote);
    });
  }

  /** A new draft version (a negotiation round or a revalidation) pinned to the current RFQ version. */
  async openVersion(quoteId: string, input: In<typeof OpenQuoteVersionCommandSchema>, state: RequestState): Promise<SellerQuoteView> {
    return this.run(state, async (trx, p) => {
      const quote = await this.sellerQuote(trx, p, quoteId);
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'quote', id: quote.id });
      if (quote.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (await quoteVersions.inStatus(trx, quote.id, 'draft')) throw new ApiError('validation.revision_conflict', 'a draft is already open', { reason: 'draft_exists' });
      const loaded = await this.loadRfq(trx, quote.rfq_id);
      if (!loaded) throw new ApiError('access.not_found');
      const { version: rfqVersion } = await this.currentRfqVersion(trx, loaded.row, input.rfqVersionId, sellerOf(quote));
      this.checkPayloadAgainst(input.payload, rfqVersion);
      if (input.answersAmendmentRequestId !== null) {
        const request = UUID.test(input.answersAmendmentRequestId) ? await amendmentRequests.get(trx, input.answersAmendmentRequestId) : undefined;
        if (!request || request.quote_id !== quote.id || request.status !== 'open') throw new ApiError('validation.schema', 'only an open request of this quote is answered', { reason: 'request_not_open' });
      }
      const versions = await quoteVersions.listFor(trx, quote.id);
      const current = versions.find((v) => v.id === quote.current_version_id);
      const revalidatedFrom = current && current.rfq_version_id !== rfqVersion.id ? current.version : null;
      const bumped = await quotes.bump(trx, quote.id, input.expectedRevision);
      if (!bumped) throw new ApiError('validation.revision_conflict');
      const next = (versions.at(-1)?.version ?? 0) + 1;
      const draft = await quoteVersions.insertDraft(trx, {
        quote_id: quote.id, version: next, rfq_id: quote.rfq_id, rfq_version_id: rfqVersion.id, rfq_version: rfqVersion.version, rfq_version_digest: rfqVersion.digest as string, payload: input.payload,
        drafted_by_person_id: p.personId, revalidated_from: revalidatedFrom, answers_amendment_request_id: input.answersAmendmentRequestId,
      });
      await this.audit(trx, p, state, 'quote.version_opened', 'quote', quote.id, { versionId: draft.id, version: next, revalidatedFrom, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'quote', quote.id, bumped.revision, 'quote.version_opened', { quoteId: quote.id, versionId: draft.id, version: next, via: actor.via });
      return this.sellerView(trx, bumped);
    });
  }

  async saveDraft(quoteId: string, versionId: string, input: In<typeof SaveQuoteDraftCommandSchema>, state: RequestState): Promise<SellerQuoteView> {
    return this.run(state, async (trx, p) => {
      const quote = await this.sellerQuote(trx, p, quoteId);
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'quote', id: quote.id });
      const version = UUID.test(versionId) ? await quoteVersions.get(trx, versionId) : undefined;
      if (!version || version.quote_id !== quote.id) throw new ApiError('access.not_found');
      if (version.status !== 'draft') throw new ApiError('commercial.version_immutable', 'a sent version never changes; open a new version', { reason: 'version_frozen' });
      if (quote.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const pinned = await rfqVersions.get(trx, version.rfq_version_id);
      if (pinned) this.checkPayloadAgainst(input.payload, pinned);
      const bumped = await quotes.bump(trx, quote.id, input.expectedRevision);
      if (!bumped) throw new ApiError('validation.revision_conflict');
      if (!(await quoteVersions.saveDraft(trx, version.id, input.payload))) throw new ApiError('commercial.version_immutable', 'a sent version never changes', { reason: 'version_frozen' });
      await this.audit(trx, p, state, 'quote.draft_saved', 'quote', quote.id, { versionId: version.id, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'quote', quote.id, bumped.revision, 'quote.draft_saved', { quoteId: quote.id, versionId: version.id, version: version.version, via: actor.via });
      return this.sellerView(trx, bumped);
    });
  }

  async setPrivate(quoteId: string, input: In<typeof SaveQuotePrivateCommandSchema>, state: RequestState): Promise<SellerQuoteView> {
    return this.run(state, async (trx, p) => {
      const quote = await this.sellerQuote(trx, p, quoteId);
      const { expectedRevision, ...fields } = input;
      const saved = await quotePrivate.update(trx, quote.id, expectedRevision, { ...privateColumns(fields), updated_by_person_id: p.personId });
      if (!saved) throw new ApiError('validation.revision_conflict');
      // Audit names the change only; floors, margins and notes never enter audit, outbox or logs.
      await this.audit(trx, p, state, 'quote.private_constraint_saved', 'quote', quote.id, { revision: saved.revision });
      return this.sellerView(trx, quote);
    });
  }

  /**
   * Sends the open draft: totals are recomputed, the pin must still be the current published RFQ version and the
   * seller's invitation for it current; the frozen line projection and tax determinations are written, the previous
   * sent version is superseded, the digest is computed over `{ rfqVersion, payload }`, the invitation records
   * `responded`, an answered request is closed and the version becomes a negotiation round, all in one transaction.
   */
  async send(quoteId: string, input: In<typeof SendQuoteCommandSchema>, state: RequestState): Promise<SellerQuoteView> {
    if (input.quoteId !== quoteId) throw new ApiError('validation.schema', 'the command names another quote', { reason: 'quote_mismatch' });
    return this.run(state, async (trx, p) => {
      const quote = await this.sellerQuote(trx, p, quoteId);
      if (quote.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const draft = await quoteVersions.inStatus(trx, quote.id, 'draft');
      if (!draft || draft.version !== input.version) throw new ApiError('commercial.version_immutable', 'only the open draft is sent', { reason: 'version_frozen' });
      const parsed = QuotePayloadWithKnownUnitsSchema.safeParse(draft.payload);
      if (!parsed.success) {
        const totals = verifyQuoteTotals(draft.payload as Parameters<typeof verifyQuoteTotals>[0]);
        if (totals !== 'ok') throw new ApiError(totals, 'totals must equal the recomputed sum of lines');
        throw new ApiError('validation.schema', 'the draft does not satisfy the quote contract', { reason: 'invalid_payload' });
      }
      const payload = parsed.data;
      const gross = payload.totals.gross;
      const actor = await this.actor(p, input.actor, 'send_quote', { kind: 'quote', id: quote.id }, gross);
      const loaded = await this.loadRfq(trx, quote.rfq_id);
      if (!loaded) throw new ApiError('access.not_found');
      const { version: rfqVersion, invitation } = await this.currentRfqVersion(trx, loaded.row, draft.rfq_version_id, sellerOf(quote));
      this.checkPayloadAgainst(payload, rfqVersion);
      const at = this.now();
      if (Date.parse(payload.validity.until) <= at.getTime()) throw new ApiError('commercial.quote_expired', 'the validity has passed; set a later validity');
      // SANC-004: the seller (and the person sending) and the buyer must be transactable before the offer goes out.
      await this.requireTransactable(trx, sellerOf(quote), buyerOf(quote), actor, 'quote_send');
      if (actor.via === 'agent') {
        const privateRow = await quotePrivate.get(trx, quote.id);
        const floors = (privateRow?.floor_prices ?? {}) as Record<string, { minorUnits: string; currency: string }>;
        if (linesBelowFloor(payload, floors).length > 0) throw new ApiError('access.mandate_scope', 'the agent may not offer below the seller\'s own floor prices', { reason: 'outside_private_constraints' });
      }
      const previous = await quoteVersions.inStatus(trx, quote.id, 'sent');
      if (previous) await quoteVersions.supersede(trx, previous.id, at);
      const region = (rfqVersion.payload as { deliveryTerms?: { location?: { region?: string } } }).deliveryTerms?.location?.region ?? null;
      const determinations = await taxDeterminations.insertMany(trx, quote.id, draft.id, p.personId, payload.lines.map((l) => this.tax.determine(l, { region })));
      const taxId = new Map(determinations.map((d) => [d.line_id, d.id]));
      await quoteLines.insertMany(trx, quote.id, draft.id, payload.lines.map((l, position) => ({
        position, line_id: l.lineId, rfq_line_id: l.rfqLineId, kind: l.kind, spec_snapshot: l.specSnapshot, offering_ref: l.offeringVersionRef?.offeringId ?? null,
        offering_version: l.offeringVersionRef?.version ?? null, quantity_value: l.quantity.value, quantity_unit: l.quantity.unit, currency: payload.currency, unit_price_minor: l.unitPrice.minorUnits,
        tax_determination_id: taxId.get(l.lineId) as string, tax_amount_minor: l.taxAmount.minorUnits, line_total_minor: l.lineTotal.minorUnits,
      })));
      const rfqRef = { id: rfqVersion.id, version: rfqVersion.version, digest: digestOf(rfqVersion.digest as string) };
      const sent = await quoteVersions.send(trx, draft.id, { digest: computeQuoteVersionDigest(rfqRef, payload).value, personId: p.personId, via: actor.via, mandateId: actor.mandateId, validUntil: payload.validity.until, at });
      if (!sent) throw new ApiError('validation.revision_conflict');
      const current = await quotes.setCurrent(trx, quote.id, { status: quote.status === 'accepted' ? 'accepted' : 'sent', current_version: sent.version, current_version_id: sent.id, invitation_id: invitation.id, clearStale: true });
      if (invitation.status === 'sent' || invitation.status === 'viewed') await rfqInvitations.setStatus(trx, invitation.id, invitation.status, { status: 'responded', withdrawn_reason: null });
      if (sent.answers_amendment_request_id) await amendmentRequests.answer(trx, sent.answers_amendment_request_id, sent.id);
      const seller = partyColumns(sellerOf(quote));
      const round = await negotiationRounds.append(trx, {
        rfq_id: quote.rfq_id, quote_id: quote.id, proposal_kind: 'quote_version', proposal_id: sent.id, proposer_person_id: seller.person, proposer_company_id: seller.company,
        proposed_by_person_id: p.personId, proposed_via: actor.via, proposed_mandate_id: actor.mandateId,
      });
      await this.audit(trx, p, state, 'quote.sent', 'quote', quote.id, { versionId: sent.id, version: sent.version, digest: sent.digest, rfqVersionId: rfqVersion.id, superseded: previous?.id ?? null, roundNo: round.round_no, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'quote', quote.id, current.revision, 'quote.sent', { quoteId: quote.id, rfqId: quote.rfq_id, versionId: sent.id, version: sent.version, rfqVersionId: rfqVersion.id, roundNo: round.round_no, via: actor.via });
      return this.sellerView(trx, current);
    });
  }

  async withdraw(quoteId: string, input: In<typeof WithdrawQuoteCommandSchema>, state: RequestState): Promise<SellerQuoteView> {
    return this.run(state, async (trx, p) => {
      const quote = await this.sellerQuote(trx, p, quoteId);
      const actor = await this.actor(p, input.actor, 'send_quote', { kind: 'quote', id: quote.id });
      if (quote.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (quote.status !== 'sent' || quote.current_version_id === null) throw new ApiError('validation.schema', `a ${quote.status} quote is not withdrawn`, { reason: 'invalid_transition' });
      if (!(await quoteVersions.setStatus(trx, quote.current_version_id, 'sent', 'withdrawn'))) throw new ApiError('validation.revision_conflict');
      const saved = await quotes.setStatus(trx, quote.id, input.expectedRevision, { status: 'withdrawn', withdrawn_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'quote.withdrawn', 'quote', quote.id, { versionId: quote.current_version_id, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'quote', quote.id, saved.revision, 'quote.withdrawn', { quoteId: quote.id, rfqId: quote.rfq_id, versionId: quote.current_version_id, status: 'withdrawn', via: actor.via });
      return this.sellerView(trx, saved);
    });
  }

  /* ---------- Reads ---------- */

  /** Seller: the seller view; buyer side: the shared projection; everyone else (anonymous included): not found. */
  async getQuote(quoteId: string, state: RequestState): Promise<SellerQuoteView | BuyerQuoteView> {
    if (!state.principal || !UUID.test(quoteId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const quote = await this.quoteOf(trx, quoteId);
      if (this.actsFor(p, sellerOf(quote))) return this.sellerView(trx, quote);
      if (this.isBuyerSide(p, await this.loadRfq(trx, quote.rfq_id))) return this.buyerView(trx, quote);
      throw new ApiError('access.not_found');
    });
  }

  async listQuotes(state: RequestState): Promise<z.infer<typeof QuoteListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await quotes.listForSeller(trx, this.scope(p));
      const items = [];
      for (const row of rows) {
        const draft = await quoteVersions.inStatus(trx, row.id, 'draft');
        items.push({
          id: row.id, rfqId: row.rfq_id, buyer: buyerOf(row), seller: sellerOf(row), status: row.status, staleReason: row.stale_reason, currentVersion: row.current_version,
          draftVersion: draft?.version ?? null, revision: row.revision, updatedAt: iso(row.updated_at),
        });
      }
      return QuoteListSchema.parse({ quotes: items });
    });
  }

  /**
   * Buyer side: comparison of the quotes on its RFQ. `current` compares sent versions pinned to the current RFQ version
   * line by line (quantity or unit differences are exclusions, never totalled); everything else is historical without
   * totals or ranking. Newest sends first; no payment input exists.
   */
  async compare(rfqId: string, query: In<typeof ComparisonQuerySchema>, state: RequestState): Promise<QuoteComparison> {
    return this.run(state, async (trx, p) => {
      const loaded = this.requireBuyer(p, await this.loadRfq(trx, rfqId), 'read.party_private');
      const rfq = loaded.row;
      if (rfq.current_version_id === null) throw new ApiError('validation.schema', 'the RFQ has no published version yet', { reason: 'not_published' });
      const current = await rfqVersions.get(trx, rfq.current_version_id);
      if (!current || current.digest === null) throw new ApiError('access.not_found');
      const [quoteRows, versionRows] = await Promise.all([quotes.listForRfq(trx, rfq.id), quoteVersions.listForRfq(trx, rfq.id)]);
      const sellers = new Map(quoteRows.map((q) => [q.id, sellerOf(q)]));
      const sent = versionRows.filter((v) => v.status !== 'draft' && v.digest !== null)
        .sort((a, b) => (+new Date(b.sent_at as Date) - +new Date(a.sent_at as Date)) || (a.id < b.id ? -1 : 1));
      return compareQuotes({
        rfqId: rfq.id, mode: query.mode, now: this.now(),
        currentRfqVersion: { id: current.id, version: current.version, digest: digestOf(current.digest), payload: current.payload as never },
        versions: sent.map((v: QuoteVersionRow) => ({
          quoteId: v.quote_id, seller: sellers.get(v.quote_id) as Party, version: { id: v.id, version: v.version, digest: digestOf(v.digest as string) },
          rfqVersion: { id: v.rfq_version_id, version: v.rfq_version, digest: digestOf(v.rfq_version_digest) }, status: v.status, payload: v.payload as QuoteVersionPayload,
        })),
      });
    });
  }

  /* ---------- Buyer: negotiation ---------- */

  private async buyerQuote(trx: Transaction, p: Principal, quoteId: string): Promise<{ quote: QuoteRow; rfq: RfqRow }> {
    const quote = await this.quoteOf(trx, quoteId);
    const seller = this.actsFor(p, sellerOf(quote));
    const loaded = await this.loadRfq(trx, quote.rfq_id);
    const buyer = this.requireBuyer(p, loaded, 'negotiate', seller);
    return { quote, rfq: buyer.row };
  }

  /** A structured request on exact lines of the current sent version; an agent never proposes above the buyer's private ceiling. */
  async requestAmendment(quoteId: string, input: In<typeof CreateAmendmentRequestCommandSchema>, state: RequestState): Promise<BuyerQuoteView> {
    return this.run(state, async (trx, p) => {
      const { quote, rfq } = await this.buyerQuote(trx, p, quoteId);
      const actor: ResolvedActor = await this.actor(p, input.actor, 'negotiate', { kind: 'quote', id: quote.id }, input.targetTotal);
      if (quote.current_version_id !== input.quoteVersionId) throw new ApiError('commercial.stale_version', 'requests answer the current sent version', { reason: 'not_current_version' });
      if (actor.via === 'agent') {
        const privateRow = await rfqPrivate.get(trx, rfq.id);
        const ceiling = privateRow?.budget_ceiling_minor !== null && privateRow?.budget_ceiling_currency ? { minorUnits: String(privateRow.budget_ceiling_minor), currency: privateRow.budget_ceiling_currency } : null;
        if (aboveCeiling(input.targetTotal, ceiling)) throw new ApiError('access.mandate_scope', 'the agent may not propose beyond the buyer\'s own constraints', { reason: 'outside_private_constraints' });
      }
      const buyer = partyColumns(buyerOf(quote));
      const request = await amendmentRequests.insert(trx, {
        quote_id: quote.id, quote_version_id: input.quoteVersionId, requester_person_id: buyer.person, requester_company_id: buyer.company, requested_by_person_id: p.personId,
        requested_via: actor.via, requested_mandate_id: actor.mandateId, line_refs: input.changes.map((c) => c.lineId), changes: input.changes,
        target_total_minor: input.targetTotal?.minorUnits ?? null, target_total_currency: input.targetTotal?.currency ?? null,
      });
      const round = await negotiationRounds.append(trx, {
        rfq_id: rfq.id, quote_id: quote.id, proposal_kind: 'amendment_request', proposal_id: request.id, proposer_person_id: buyer.person, proposer_company_id: buyer.company,
        proposed_by_person_id: p.personId, proposed_via: actor.via, proposed_mandate_id: actor.mandateId,
      });
      await this.audit(trx, p, state, 'quote.amendment_requested', 'quote', quote.id, { requestId: request.id, versionId: input.quoteVersionId, lines: request.line_refs.length, roundNo: round.round_no, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'quote', quote.id, quote.revision, 'quote.amendment_requested', { quoteId: quote.id, rfqId: rfq.id, versionId: input.quoteVersionId, amendmentRequestId: request.id, roundNo: round.round_no, via: actor.via });
      return this.buyerView(trx, quote);
    });
  }

  async withdrawAmendmentRequest(quoteId: string, requestId: string, input: In<typeof WithdrawAmendmentRequestCommandSchema>, state: RequestState): Promise<BuyerQuoteView> {
    return this.run(state, async (trx, p) => {
      const { quote, rfq } = await this.buyerQuote(trx, p, quoteId);
      const request = UUID.test(requestId) ? await amendmentRequests.get(trx, requestId) : undefined;
      if (!request || request.quote_id !== quote.id) throw new ApiError('access.not_found');
      if (request.status !== 'open') throw new ApiError('validation.schema', `a ${request.status} request is not withdrawn`, { reason: 'invalid_transition' });
      if (!(await amendmentRequests.withdraw(trx, request.id, input.reason))) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'quote.amendment_request_withdrawn', 'quote', quote.id, { requestId: request.id, reason: input.reason });
      await this.event(trx, 'quote', quote.id, quote.revision, 'quote.amendment_request_withdrawn', { quoteId: quote.id, rfqId: rfq.id, amendmentRequestId: request.id, status: 'withdrawn' });
      return this.buyerView(trx, quote);
    });
  }
}
