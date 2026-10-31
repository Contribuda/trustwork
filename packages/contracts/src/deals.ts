import { z } from 'zod';
import { PartySchema, type Party } from './access.js';
import { AgentCapabilitySchema, type AgentCapability, type CapabilityConfirmation, type CapabilityKind, type ContextKindV2, type MandateActionV2, type PrivateDataClass, type SideEffect } from './agent-catalog.js';
import type { BudgetKind } from './billing.js';
import { LineKindSchema } from './catalogue.js';
import { CommerceActorInputSchema } from './commerce.js';
import { DigestSchema } from './common/digest-schema.js';
import { BusinessDateSchema, IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { addMoney, CurrencySchema, MoneySchema, sumMoney, type Money } from './common/money.js';
import { pickFields } from './common/projection.js';
import { compareDecimal, QuantitySchema } from './common/quantity.js';
import { isKnownUnit } from './common/units.js';
import { VersionNumberSchema, VersionRefSchema, type VersionRef } from './common/version.js';
import { RfqVersionPayloadSchema, StaleReasonSchema } from './procurement.js';
import {
  ComparisonModeSchema, CreateQuoteDraftCommandSchema, QuotePrivateConstraintSchema, QuoteSchema, QuoteStatusSchema, QuoteVersionPayloadSchema, QuoteVersionSchema,
  SendQuoteVersionCommandSchema, SharedQuoteVersionSchema, type QuoteVersionPayload,
} from './sales.js';
import {
  AcceptanceEventKindSchema, AcceptTermsCommandSchema, AgreementTermsKindSchema, BuyerAgreementSchema, ObligationSchema, OrderSchema, PlaceOrderCommandSchema, SellerAgreementSchema,
  type AgreementTermsKind,
} from './transactions.js';

/**
 * Commerce slice 2 (COM-002): the API and capability layer over the frozen sales and transactions contracts
 * (`sales.ts`, `transactions.ts`; the latter extended only by ADR 012 decision 19, `termsKind` in the agreement digest).
 * It adds what the frozen files do not define: request and view shapes for quotes, negotiation rounds, amendment
 * requests, comparison, agreements, orders and order changes, the electronic-records consent, the identifiers-only event
 * payloads and the capability registry entries (ADR 010 decision 23).
 *
 * Invariants restated here and enforced again by packages/data/migrations/transactions:
 * - a quote version is drafted and sent only against the current published RFQ version; a sent version never changes;
 *   an RFQ amendment flags earlier sent versions `stale_reason: rfq_amended` (a flag, never a status) in the same
 *   transaction, and revalidation is a new quote version pinned to the current RFQ version;
 * - only versions pinned to the current RFQ version are compared; lines whose quantity or unit differ from the RFQ line
 *   are explicit exclusions and are never totalled as if they matched (no automatic upgrade from v1 to v2 scope);
 * - an agreement pins exact quote and RFQ versions by id and digest; its digest covers `{ termsKind, quoteVersion,
 *   rfqVersion }`; buyer and seller acceptance are separate events that carry the same digest;
 * - at most one live agreement per RFQ (proposed, accepted by the buyer or by both);
 * - seller floors, margins, cost basis and negotiation notes never reach the buyer; budget ceilings, weights, notes,
 *   shortlist, budget and reservation identifiers never reach the seller;
 * - orders record instructions and a transaction-budget reservation (authority, not money): Trustwork never holds
 *   participants' money (ADR 010 decision 20); payments go through licensed providers (PAY-001).
 */

/* ---------- Who acts ---------- */

/** A person acts on their own authority; their agent only under a structured mandate. Chat text never authorizes. */
export const DealActorInputSchema = CommerceActorInputSchema;
export type DealActorInput = z.infer<typeof DealActorInputSchema>;

/* ---------- Quotes ---------- */

/**
 * A quote payload as the seller sends it: the frozen payload (totals recomputed exactly) plus catalogue units, distinct
 * line ids, at most one quote line per RFQ line (substitutions name the RFQ line they replace) and no tax amount on an
 * untaxed line.
 */
export const QuotePayloadWithKnownUnitsSchema = QuoteVersionPayloadSchema
  .refine((p) => p.lines.every((l) => isKnownUnit(l.quantity.unit)), { message: 'every line quantity names a unit from the measurement-unit catalogue', path: ['lines'] })
  .refine((p) => new Set(p.lines.map((l) => l.lineId)).size === p.lines.length, { message: 'line ids are distinct', path: ['lines'] })
  .refine((p) => {
    const answered = p.lines.map((l) => l.rfqLineId ?? l.substitution?.forRfqLineId ?? null).filter((id): id is string => id !== null);
    return new Set(answered).size === answered.length;
  }, { message: 'each RFQ line is answered at most once', path: ['lines'] })
  .refine((p) => p.lines.every((l) => l.tax.kind !== 'none' || BigInt(l.taxAmount.minorUnits) === 0n), { message: 'an untaxed line carries no tax amount', path: ['lines'] });

export const QuotePrivateInputSchema = z.strictObject({
  floorPrices: QuotePrivateConstraintSchema.shape.floorPrices,
  marginTargets: QuotePrivateConstraintSchema.shape.marginTargets,
  costBasis: QuotePrivateConstraintSchema.shape.costBasis,
  negotiationNotes: QuotePrivateConstraintSchema.shape.negotiationNotes,
});
export type QuotePrivateInput = z.infer<typeof QuotePrivateInputSchema>;
export const EMPTY_QUOTE_PRIVATE: QuotePrivateInput = { floorPrices: {}, marginTargets: {}, costBasis: {}, negotiationNotes: '' };

/** A quote answers the RFQ version the seller's current invitation pins; `revalidatedFrom` is set by the server. */
export const CreateQuoteCommandSchema = CreateQuoteDraftCommandSchema.omit({ revalidatedFrom: true }).extend({
  payload: QuotePayloadWithKnownUnitsSchema,
  privateConstraint: QuotePrivateInputSchema.nullable(),
  actor: DealActorInputSchema,
});
/** `expectedRevision` is the quote envelope revision: every change of the aggregate bumps it. */
export const OpenQuoteVersionCommandSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  rfqVersionId: IdSchema,
  payload: QuotePayloadWithKnownUnitsSchema,
  /** The buyer's open amendment request this version answers (a negotiation round), if any. */
  answersAmendmentRequestId: IdSchema.nullable(),
  actor: DealActorInputSchema,
});
export const SaveQuoteDraftCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, payload: QuotePayloadWithKnownUnitsSchema, actor: DealActorInputSchema });
export const SendQuoteCommandSchema = SendQuoteVersionCommandSchema.extend({ actor: DealActorInputSchema });
export const SaveQuotePrivateCommandSchema = QuotePrivateInputSchema.extend({ expectedRevision: RevisionSchema });
export const WithdrawQuoteCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: DealActorInputSchema });

/* ---------- Negotiation: rounds and amendment requests ---------- */

/** One structured change the buyer asks for on an exact line of an exact quote version; never chat prose. */
export const RequestedLineChangeSchema = z.strictObject({
  lineId: IdSchema,
  quantity: QuantitySchema.nullable(),
  targetUnitPrice: MoneySchema.nullable(),
  reason: ShortTextSchema.nullable(),
}).refine((c) => c.quantity !== null || c.targetUnitPrice !== null || c.reason !== null, { message: 'a change names a quantity, a price or a reason', path: ['lineId'] })
  .refine((c) => c.quantity === null || isKnownUnit(c.quantity.unit), { message: 'units come from the measurement-unit catalogue', path: ['quantity'] });
export const AmendmentRequestStatusSchema = z.enum(['open', 'answered', 'withdrawn']);
export const CreateAmendmentRequestCommandSchema = z.strictObject({
  quoteVersionId: IdSchema,
  changes: z.array(RequestedLineChangeSchema).min(1).max(200),
  /** What the buyer proposes as the new gross total, if anything. An agent may never propose more than the buyer's private ceiling. */
  targetTotal: MoneySchema.nullable(),
  actor: DealActorInputSchema,
}).refine((c) => new Set(c.changes.map((x) => x.lineId)).size === c.changes.length, { message: 'each line is named once', path: ['changes'] });
export const WithdrawAmendmentRequestCommandSchema = z.strictObject({ reason: ShortTextSchema });

/** Shared by both parties: what was asked, on which exact version, and whether a new version answered it. */
export const AmendmentRequestSchema = z.strictObject({
  id: IdSchema,
  quoteId: IdSchema,
  quoteVersionId: IdSchema,
  requester: PartySchema,
  changes: z.array(RequestedLineChangeSchema),
  targetTotal: MoneySchema.nullable(),
  status: AmendmentRequestStatusSchema,
  answeredByVersion: VersionNumberSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type AmendmentRequest = z.infer<typeof AmendmentRequestSchema>;

/** A negotiation round is one structured proposal (a quote version or an amendment request) by one party. Mandates and persons are not shown to the counterparty. */
export const NegotiationRoundSchema = z.strictObject({
  roundNo: z.int().min(1),
  proposal: z.strictObject({ kind: z.enum(['quote_version', 'amendment_request']), id: IdSchema }),
  proposer: PartySchema,
  createdAt: TimestampSchema,
});
export type NegotiationRound = z.infer<typeof NegotiationRoundSchema>;

/* ---------- Quote views ---------- */

export const QuoteEnvelopeSchema = QuoteSchema.extend({ invitationId: IdSchema.nullable(), updatedAt: TimestampSchema });
/** Seller side: the envelope, every version (drafts included), its private constraint, rounds and requests. */
export const SellerQuoteViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  quote: QuoteEnvelopeSchema,
  versions: z.array(QuoteVersionSchema),
  privateConstraint: QuotePrivateConstraintSchema,
  rounds: z.array(NegotiationRoundSchema),
  amendmentRequests: z.array(AmendmentRequestSchema),
});
export type SellerQuoteView = z.infer<typeof SellerQuoteViewSchema>;
/** Buyer side: sent versions as shared projections only; never drafts, the seller's private constraint, catalogue provenance or who sent them. */
export const BuyerQuoteViewSchema = z.strictObject({
  projection: z.literal('shared_party'),
  quote: QuoteSchema.omit({ createdAt: true }),
  versions: z.array(SharedQuoteVersionSchema),
  rounds: z.array(NegotiationRoundSchema),
  amendmentRequests: z.array(AmendmentRequestSchema),
});
export type BuyerQuoteView = z.infer<typeof BuyerQuoteViewSchema>;
export const QuoteListItemSchema = z.strictObject({
  id: IdSchema, rfqId: IdSchema, buyer: PartySchema, seller: PartySchema, status: QuoteStatusSchema, staleReason: StaleReasonSchema.nullable(), currentVersion: VersionNumberSchema.nullable(),
  draftVersion: VersionNumberSchema.nullable(), revision: RevisionSchema, updatedAt: TimestampSchema,
});
export const QuoteListSchema = z.strictObject({ quotes: z.array(QuoteListItemSchema) });

/* ---------- Comparison: normalization with explicit exclusions ---------- */

export const LineMatchSchema = z.enum(['matched', 'quantity_differs', 'unit_differs', 'substitution', 'missing']);
export type LineMatch = z.infer<typeof LineMatchSchema>;
export const ComparisonLineSchema = z.strictObject({
  rfqLineId: IdSchema,
  match: LineMatchSchema,
  quoteLineId: IdSchema.nullable(),
  requested: QuantitySchema,
  offered: QuantitySchema.nullable(),
  unitPrice: MoneySchema.nullable(),
  lineTotal: MoneySchema.nullable(),
  taxAmount: MoneySchema.nullable(),
});
export const NotTotalledReasonSchema = z.enum(['scope_mismatch', 'currency_differs', 'expired']);
export const ComparisonEntrySchema = z.strictObject({
  quoteId: IdSchema,
  seller: PartySchema,
  version: VersionRefSchema,
  currency: CurrencySchema,
  validUntil: TimestampSchema,
  lines: z.array(ComparisonLineSchema),
  /** Unsolicited lines: shown, never part of a comparable total. */
  extras: z.array(z.strictObject({ quoteLineId: IdSchema, kind: LineKindSchema, lineTotal: MoneySchema })),
  exclusions: z.array(ShortTextSchema),
  /** Only when every RFQ line matched exactly, in the RFQ currency, and the quote is still valid; otherwise null with reasons. */
  comparableTotal: z.strictObject({ net: MoneySchema, tax: MoneySchema, gross: MoneySchema }).nullable(),
  notTotalledBecause: z.array(NotTotalledReasonSchema),
});
export type ComparisonEntry = z.infer<typeof ComparisonEntrySchema>;
/** Historical mode: versions pinned to earlier RFQ versions or no longer sent; identity and status only, no totals and no ranking. */
export const HistoricalEntrySchema = z.strictObject({
  quoteId: IdSchema,
  seller: PartySchema,
  version: VersionRefSchema,
  rfqVersion: VersionRefSchema,
  status: QuoteStatusSchema,
  staleReason: StaleReasonSchema.nullable(),
});
export const QuoteComparisonSchema = z.strictObject({
  rfqId: IdSchema,
  mode: ComparisonModeSchema,
  currentRfqVersion: VersionRefSchema,
  entries: z.array(ComparisonEntrySchema),
  historical: z.array(HistoricalEntrySchema),
});
export type QuoteComparison = z.infer<typeof QuoteComparisonSchema>;
export const ComparisonQuerySchema = z.strictObject({ mode: ComparisonModeSchema.default('current') });

type RfqLines = z.infer<typeof RfqVersionPayloadSchema>['lines'];
interface ComparableInput { quoteId: string; seller: Party; version: VersionRef; rfqVersion: VersionRef; status: z.infer<typeof QuoteStatusSchema>; payload: QuoteVersionPayload }

/** Line-by-line normalization of one quote version against the RFQ lines it answers: no unit conversion, no quantity scaling. */
export function normalizeQuoteLines(rfqLines: RfqLines, payload: QuoteVersionPayload): Pick<ComparisonEntry, 'lines' | 'extras'> {
  const lines = rfqLines.map((rl) => {
    const direct = payload.lines.find((l) => l.rfqLineId === rl.lineId);
    const substitute = direct ? undefined : payload.lines.find((l) => l.substitution?.forRfqLineId === rl.lineId);
    const ql = direct ?? substitute;
    if (!ql) return { rfqLineId: rl.lineId, match: 'missing' as const, quoteLineId: null, requested: rl.quantity, offered: null, unitPrice: null, lineTotal: null, taxAmount: null };
    let match: LineMatch = 'matched';
    if (substitute) match = 'substitution';
    else if (ql.quantity.unit !== rl.quantity.unit) match = 'unit_differs';
    else if (compareDecimal(ql.quantity.value, rl.quantity.value) !== 0) match = 'quantity_differs';
    return { rfqLineId: rl.lineId, match, quoteLineId: ql.lineId, requested: rl.quantity, offered: ql.quantity, unitPrice: ql.unitPrice, lineTotal: ql.lineTotal, taxAmount: ql.taxAmount };
  });
  const answered = new Set(rfqLines.map((l) => l.lineId));
  const extras = payload.lines.filter((l) => !(l.rfqLineId !== null && answered.has(l.rfqLineId)) && !(l.substitution !== null && answered.has(l.substitution.forRfqLineId))).map((l) => ({ quoteLineId: l.lineId, kind: l.kind, lineTotal: l.lineTotal }));
  return { lines, extras };
}

/**
 * Comparison of quote versions for one RFQ. `current` compares only sent versions pinned to the current RFQ version
 * (`comparableQuoteVersions` semantics); everything else is listed under `historical` without totals or ranking.
 * Entries keep the input order (newest first by the caller); there is no payment input, so payment cannot reorder them.
 */
export function compareQuotes(input: { rfqId: string; mode: z.infer<typeof ComparisonModeSchema>; currentRfqVersion: VersionRef & { payload: z.infer<typeof RfqVersionPayloadSchema> }; versions: readonly ComparableInput[]; now: Date }): QuoteComparison {
  const { currentRfqVersion: rfq, now } = input;
  const entries: ComparisonEntry[] = [];
  const historical: z.infer<typeof HistoricalEntrySchema>[] = [];
  for (const v of input.versions) {
    const comparable = v.status === 'sent' && v.rfqVersion.id === rfq.id;
    if (!comparable || input.mode === 'historical') {
      historical.push({ quoteId: v.quoteId, seller: v.seller, version: { id: v.version.id, version: v.version.version, digest: v.version.digest }, rfqVersion: { id: v.rfqVersion.id, version: v.rfqVersion.version, digest: v.rfqVersion.digest }, status: v.status, staleReason: v.rfqVersion.id === rfq.id ? null : 'rfq_amended' });
      continue;
    }
    const { lines, extras } = normalizeQuoteLines(rfq.payload.lines, v.payload);
    const reasons = new Set<z.infer<typeof NotTotalledReasonSchema>>();
    if (lines.some((l) => l.match !== 'matched')) reasons.add('scope_mismatch');
    if (v.payload.currency !== rfq.payload.currency) reasons.add('currency_differs');
    if (Date.parse(v.payload.validity.until) <= now.getTime()) reasons.add('expired');
    let comparableTotal: ComparisonEntry['comparableTotal'] = null;
    if (reasons.size === 0) {
      const net = sumMoney(lines.map((l) => l.lineTotal as Money), v.payload.currency);
      const tax = sumMoney(lines.map((l) => l.taxAmount as Money), v.payload.currency);
      comparableTotal = { net, tax, gross: addMoney(net, tax) };
    }
    entries.push({ quoteId: v.quoteId, seller: v.seller, version: { id: v.version.id, version: v.version.version, digest: v.version.digest }, currency: v.payload.currency, validUntil: v.payload.validity.until, lines, extras, exclusions: v.payload.exclusions, comparableTotal, notTotalledBecause: [...reasons] });
  }
  return QuoteComparisonSchema.parse({ rfqId: input.rfqId, mode: input.mode, currentRfqVersion: { id: rfq.id, version: rfq.version, digest: rfq.digest }, entries, historical });
}

/* ---------- Private constraints bind agents ---------- */

/**
 * The seller's agent may not offer below the seller's own floor prices (unit price per quote line id, same currency);
 * a person acting on their own authority decides for themself. Returns the offending line ids (never the floors).
 */
export function linesBelowFloor(payload: QuoteVersionPayload, floors: Record<string, Money>): string[] {
  return payload.lines.filter((l) => {
    const floor = floors[l.lineId] ?? (l.rfqLineId ? floors[l.rfqLineId] : undefined);
    if (!floor) return false;
    return floor.currency !== l.unitPrice.currency || BigInt(l.unitPrice.minorUnits) < BigInt(floor.minorUnits);
  }).map((l) => l.lineId);
}
/** The buyer's agent may not propose a total above the buyer's private ceiling (a different currency is refused too). */
export function aboveCeiling(target: Money | null, ceiling: Money | null): boolean {
  if (target === null || ceiling === null) return false;
  return target.currency !== ceiling.currency || BigInt(target.minorUnits) > BigInt(ceiling.minorUnits);
}

/* ---------- Agreements: electronic records, acceptance, private halves ---------- */

/**
 * The hub's electronic-records policy (configured per hub; US defaults cite ESIGN 15 U.S.C. 7001 and the state UETA
 * enactments from the US country pack). When required, an acceptance must carry the participant's affirmative consent
 * to electronic records for the named disclosure; the acceptance event records it.
 */
export const ElectronicRecordsPolicySchema = z.strictObject({
  required: z.boolean(),
  disclosureKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/),
  /** Country-pack facts the disclosure relies on, as `<PACK>:<facet>/<id>` references (for example `US:eSignature/esign-act`). */
  basis: z.array(z.string().regex(/^[A-Z]{2}:[A-Za-z]+\/[a-z0-9-]{1,80}$/)).max(20),
});
export type ElectronicRecordsPolicy = z.infer<typeof ElectronicRecordsPolicySchema>;
export const ElectronicRecordsConsentSchema = z.strictObject({ consented: z.literal(true), disclosureKey: ElectronicRecordsPolicySchema.shape.disclosureKey });
export type ElectronicRecordsConsent = z.infer<typeof ElectronicRecordsConsentSchema>;
/** Whether a supplied consent satisfies the policy: required consent names the current disclosure. */
export function electronicRecordsSatisfied(policy: ElectronicRecordsPolicy, consent: ElectronicRecordsConsent | null): boolean {
  if (!policy.required) return true;
  return consent !== null && consent.consented && consent.disclosureKey === policy.disclosureKey;
}

/** Buyer acceptance of terms: the frozen command (the idempotency key travels in the `Idempotency-Key` header). `expectedRevision` is the quote envelope revision. */
export const AcceptTermsRequestSchema = AcceptTermsCommandSchema.omit({ idempotencyKey: true }).extend({
  electronicRecords: ElectronicRecordsConsentSchema.nullable(),
  actor: DealActorInputSchema,
});
/** Seller acceptance of the placed order: the seller states the digest it accepts, which must equal the agreement digest. */
export const SellerAcceptRequestSchema = z.strictObject({ expectedRevision: RevisionSchema, acceptedTermsDigest: DigestSchema, electronicRecords: ElectronicRecordsConsentSchema.nullable(), actor: DealActorInputSchema });
export const SellerDeclineRequestSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: DealActorInputSchema });
export const WithdrawAgreementRequestSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: DealActorInputSchema });
/** Each side writes only its own private half. */
export const SaveAgreementPrivateCommandSchema = z.discriminatedUnion('side', [
  z.strictObject({ side: z.literal('buyer'), expectedRevision: RevisionSchema, approvalRefs: z.array(IdSchema).max(50), notes: ShortTextSchema.nullable() }),
  z.strictObject({ side: z.literal('seller'), expectedRevision: RevisionSchema, fulfilmentPlan: z.array(z.strictObject({ step: ShortTextSchema, internalOwnerPersonId: IdSchema })).max(100), notes: ShortTextSchema.nullable() }),
]);

/** An acceptance event as both parties see it: no mandate, approval, budget or reservation identifiers. */
export const SharedAcceptanceEventSchema = z.strictObject({
  id: IdSchema,
  kind: AcceptanceEventKindSchema,
  termsKind: AgreementTermsKindSchema,
  quoteVersion: VersionRefSchema,
  rfqVersion: VersionRefSchema,
  acceptedTermsDigest: DigestSchema,
  onBehalfOf: PartySchema,
  electronicRecords: z.strictObject({ disclosureKey: ElectronicRecordsPolicySchema.shape.disclosureKey, basis: ElectronicRecordsPolicySchema.shape.basis }).nullable(),
  occurredAt: TimestampSchema,
});
export type SharedAcceptanceEvent = z.infer<typeof SharedAcceptanceEventSchema>;

/** The seller never sees the buyer's reservation. */
export const SellerOrderSchema = OrderSchema.omit({ reservationId: true });
export const OrderChangeStatusSchema = z.enum(['proposed', 'accepted', 'rejected', 'withdrawn']);
export const OrderChangeSchema = z.strictObject({
  id: IdSchema,
  orderId: IdSchema,
  previousTermsDigest: DigestSchema,
  newTermsDigest: DigestSchema,
  newQuoteVersion: VersionRefSchema,
  proposer: PartySchema,
  status: OrderChangeStatusSchema,
  consents: z.array(z.strictObject({ party: PartySchema, at: TimestampSchema })),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type OrderChange = z.infer<typeof OrderChangeSchema>;

export const BuyerAgreementViewSchema = z.strictObject({
  projection: z.literal('party_private'),
  side: z.literal('buyer'),
  agreement: BuyerAgreementSchema,
  /** Revision of the buyer's own private half (the frozen projection omits it); `SaveAgreementPrivateCommand` expects it. */
  privateRevision: RevisionSchema,
  rfqId: IdSchema,
  quoteId: IdSchema,
  events: z.array(SharedAcceptanceEventSchema),
  orders: z.array(OrderSchema),
  orderChanges: z.array(OrderChangeSchema),
});
export const SellerAgreementViewSchema = z.strictObject({
  projection: z.literal('party_private'),
  side: z.literal('seller'),
  agreement: SellerAgreementSchema,
  /** Revision of the seller's own private half (1 until first saved). */
  privateRevision: RevisionSchema,
  rfqId: IdSchema,
  quoteId: IdSchema,
  events: z.array(SharedAcceptanceEventSchema),
  orders: z.array(SellerOrderSchema),
  orderChanges: z.array(OrderChangeSchema),
});
export type BuyerAgreementView = z.infer<typeof BuyerAgreementViewSchema>;
export type SellerAgreementView = z.infer<typeof SellerAgreementViewSchema>;
export const AgreementListItemSchema = z.strictObject({
  id: IdSchema, side: z.enum(['buyer', 'seller']), termsKind: AgreementTermsKindSchema, rfqId: IdSchema, counterparty: PartySchema, status: BuyerAgreementSchema.shape.status, revision: RevisionSchema, createdAt: TimestampSchema,
});
export const AgreementListSchema = z.strictObject({ agreements: z.array(AgreementListItemSchema) });

/* ---------- Orders and order changes ---------- */

/** The frozen command without the body idempotency key and mandate fields: the header carries the key and `actor` names the mandate. */
export const PlaceOrderRequestSchema = PlaceOrderCommandSchema.omit({ idempotencyKey: true, mandateId: true, mandateRevision: true }).extend({
  /** The buyer's own purchase-order number, if it keeps one. */
  externalReference: z.string().min(1).max(200).nullable(),
  actor: DealActorInputSchema,
});
export const CancelOrderRequestSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: DealActorInputSchema });
/** A change proposes a newer sent version of the same quote as the new terms; history is appended, never rewritten. */
export const ProposeOrderChangeRequestSchema = z.strictObject({ expectedRevision: RevisionSchema, quoteVersion: VersionRefSchema, transactionBudgetId: IdSchema.nullable(), actor: DealActorInputSchema });
export const DecideOrderChangeRequestSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  decision: z.enum(['accept', 'reject', 'withdraw']),
  /** Needed when the buyer consents to a higher gross total: the difference is reserved from this transaction budget. */
  transactionBudgetId: IdSchema.nullable(),
  reason: ShortTextSchema.nullable(),
  actor: DealActorInputSchema,
});

/**
 * Obligations derived from accepted terms: the seller delivers goods and performs works or services by each
 * milestone; the buyer pays the gross total (outside the platform, through licensed providers) and accepts the work.
 * Due times are the start of the milestone's local business day.
 */
export function deriveObligations(parties: { buyer: Party; seller: Party }, payload: QuoteVersionPayload): z.infer<typeof ObligationSchema>[] {
  const kinds = new Set(payload.lines.map((l) => l.kind));
  const out: z.infer<typeof ObligationSchema>[] = [];
  const milestones = payload.deliveryTerms.milestones;
  for (const m of milestones) {
    const due = zonedStartOfDay(m.due.date, m.due.timeZone);
    if (kinds.has('goods')) out.push({ party: parties.seller, kind: 'deliver', due, amount: null, scope: null });
    if (kinds.has('works') || kinds.has('services')) out.push({ party: parties.seller, kind: 'perform', due, amount: null, scope: null });
  }
  if (milestones.length === 0) out.push({ party: parties.seller, kind: kinds.has('goods') ? 'deliver' : 'perform', due: null, amount: null, scope: null });
  const last = milestones.at(-1);
  out.push({ party: parties.buyer, kind: 'pay', due: null, amount: payload.totals.gross, scope: null });
  out.push({ party: parties.buyer, kind: 'accept', due: last ? zonedStartOfDay(last.due.date, last.due.timeZone) : null, amount: null, scope: null });
  return out.map((o) => ObligationSchema.parse(o));
}
/** UTC instant of 00:00 local time on a business date (IANA zone, DST-aware, no dependency). */
export function zonedStartOfDay(date: string, timeZone: string): string {
  BusinessDateSchema.parse({ date, timeZone });
  const offsetMinutes = (at: Date): number => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  };
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
  const first = utcMidnight - offsetMinutes(new Date(utcMidnight)) * 60_000;
  return new Date(utcMidnight - offsetMinutes(new Date(first)) * 60_000).toISOString();
}

/* ---------- Where deal data may go ---------- */

/** Keys that must never reach the buyer side (seller-private and catalogue provenance). */
export const BUYER_FORBIDDEN_KEYS = ['floorPrices', 'marginTargets', 'costBasis', 'negotiationNotes', 'privateConstraint', 'offeringVersionRef', 'fulfilmentPlan', 'sellerPrivate', 'sentBy'] as const;
/** Keys that must never reach the seller side (buyer-private and budget authority). */
export const SELLER_FORBIDDEN_KEYS = ['budgetCeiling', 'evaluationWeights', 'internalNotes', 'shortlist', 'transactionBudgetId', 'approvalRefs', 'buyerPrivate', 'reservationId', 'platformBudgetId'] as const;
/** Outbox payloads carry identifiers only; the notification consumer (MAIL-001) reads projections under the recipient's authority. */
export const DEAL_EVENT_PAYLOAD_KEYS = [
  'quoteId', 'versionId', 'version', 'rfqId', 'rfqVersionId', 'agreementId', 'orderId', 'orderChangeId', 'amendmentRequestId', 'roundNo', 'status', 'eventKind', 'termsKind', 'via',
] as const;
export const DEAL_EGRESS = {
  quotePrivateConstraint: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  agreementBuyerPrivate: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  agreementSellerPrivate: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  quote: { search: false, publicProjection: false },
  agreement: { search: false, publicProjection: false },
  notificationPayload: 'identifiers_only',
} as const;

/** Inputs of the read capabilities. */
export const QuoteQuerySchema = z.strictObject({ quoteId: IdSchema });
export const QuoteListQuerySchema = z.strictObject({});
export const AgreementQuerySchema = z.strictObject({ agreementId: IdSchema });
export const AgreementListQuerySchema = z.strictObject({});
export const RfqComparisonQuerySchema = z.strictObject({ rfqId: IdSchema, mode: ComparisonModeSchema });

/** Helper for views: the terms a version ref names. */
export function termsRef(kind: AgreementTermsKind, quoteVersion: VersionRef, rfqVersion: VersionRef) {
  return { termsKind: kind, quoteVersion: VersionRefSchema.parse(quoteVersion), rfqVersion: VersionRefSchema.parse(rfqVersion) };
}

/* ---------- Capability registry entries (ADR 010 decision 23, AGT-002 shape) ---------- */

export interface DealCapabilityEntry {
  capability: AgentCapability;
  apiRoute: string;
}
interface Spec {
  id: string;
  kind: CapabilityKind;
  action: MandateActionV2 | null;
  confirmation?: CapabilityConfirmation;
  budget?: BudgetKind;
  input: string;
  output: string;
  contexts: ContextKindV2[];
  reads: AgentCapability['reads'];
  privateData?: PrivateDataClass[];
  effects: SideEffect[];
  untrusted?: boolean;
  route: string;
}
const FROZEN: Record<string, string> = { QuoteSchema: 'sales', SharedQuoteVersionSchema: 'sales', OrderSchema: 'transactions' };
const camel = (s: string) => s.replace(/[._]([a-z])/g, (_, ch: string) => ch.toUpperCase());
function entry(s: Spec): DealCapabilityEntry {
  const [moduleKey] = s.id.split('.') as [string];
  const contract = (schema: string) => ({ contract: FROZEN[schema] ?? 'deals', schema, version: 1 });
  const capability: AgentCapability = AgentCapabilitySchema.parse({
    id: s.id,
    version: 1,
    source: { kind: 'module', moduleKey, moduleVersion: '1.0.0' },
    kind: s.kind,
    input: contract(s.input),
    output: contract(s.output),
    mandateAction: s.action,
    contextKinds: s.contexts,
    confirmation: s.confirmation ?? (s.kind === 'commit' ? 'mandate' : 'none'),
    budgetKind: s.budget ?? null,
    reads: s.reads,
    privateDataClasses: s.privateData ?? [],
    sideEffects: s.effects,
    acceptsUntrustedText: s.untrusted ?? false,
    meters: s.kind === 'commit' ? ['agent_actions'] : s.kind === 'draft' ? ['model_tokens'] : [],
    surfaces: ['ui', 'agent', 'mcp'],
    status: 'live',
    labelKey: `deals.capability.${camel(s.id)}`,
  });
  return { capability, apiRoute: s.route };
}
const SELLER: AgentCapability['reads'] = ['owner_private'];
const BUYER: AgentCapability['reads'] = ['party_private'];
const SHARED: AgentCapability['reads'] = ['shared_party'];

/**
 * Every COM-002 operation, defined once for the interface, the person's agent and connections. `quoting.*` is the
 * seller's quoting desk, `sourcing_desk.*` the buyer's, `deal_desk.*` the agreement and order desk of either side.
 * Money actions name the transaction budget; nothing here charges a platform budget.
 */
export const DEAL_CAPABILITIES: readonly DealCapabilityEntry[] = [
  // Seller: quotes
  entry({ id: 'quoting.list_quotes', kind: 'read', action: null, input: 'QuoteListQuerySchema', output: 'QuoteListSchema', contexts: ['quote'], reads: SELLER, privateData: ['drafts'], effects: ['none'], route: 'GET /v1/quotes' }),
  entry({ id: 'quoting.get_quote', kind: 'read', action: null, input: 'QuoteQuerySchema', output: 'SellerQuoteViewSchema', contexts: ['quote'], reads: SELLER, privateData: ['negotiation_constraints', 'drafts'], effects: ['none'], route: 'GET /v1/quotes/:id' }),
  entry({ id: 'quoting.draft_quote', kind: 'draft', action: 'prepare', input: 'CreateQuoteCommandSchema', output: 'SellerQuoteViewSchema', contexts: ['rfq', 'quote'], reads: SELLER, privateData: ['negotiation_constraints'], effects: ['draft_state'], untrusted: true, route: 'POST /v1/quotes' }),
  entry({ id: 'quoting.open_quote_version', kind: 'draft', action: 'prepare', input: 'OpenQuoteVersionCommandSchema', output: 'SellerQuoteViewSchema', contexts: ['quote'], reads: SELLER, effects: ['draft_state'], untrusted: true, route: 'POST /v1/quotes/:id/versions' }),
  entry({ id: 'quoting.save_quote_draft', kind: 'draft', action: 'prepare', input: 'SaveQuoteDraftCommandSchema', output: 'SellerQuoteViewSchema', contexts: ['quote'], reads: SELLER, effects: ['draft_state'], untrusted: true, route: 'POST /v1/quotes/:id/versions/:versionId' }),
  entry({ id: 'quoting.set_quote_private_constraints', kind: 'draft', action: 'prepare', input: 'SaveQuotePrivateCommandSchema', output: 'SellerQuoteViewSchema', contexts: ['quote'], reads: SELLER, privateData: ['negotiation_constraints'], effects: ['draft_state'], route: 'POST /v1/quotes/:id/private' }),
  entry({ id: 'quoting.send_quote', kind: 'commit', action: 'send_quote', input: 'SendQuoteCommandSchema', output: 'SellerQuoteViewSchema', contexts: ['quote', 'rfq'], reads: SELLER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/quotes/:id/send' }),
  entry({ id: 'quoting.withdraw_quote', kind: 'commit', action: 'send_quote', input: 'WithdrawQuoteCommandSchema', output: 'SellerQuoteViewSchema', contexts: ['quote'], reads: SELLER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/quotes/:id/withdraw' }),
  // Buyer: comparison and negotiation
  entry({ id: 'sourcing_desk.compare_quotes', kind: 'read', action: null, input: 'RfqComparisonQuerySchema', output: 'QuoteComparisonSchema', contexts: ['rfq'], reads: BUYER, effects: ['none'], route: 'GET /v1/rfqs/:id/comparison' }),
  entry({ id: 'sourcing_desk.get_quote', kind: 'read', action: null, input: 'QuoteQuerySchema', output: 'BuyerQuoteViewSchema', contexts: ['quote', 'rfq'], reads: SHARED, effects: ['none'], route: 'GET /v1/quotes/:id' }),
  entry({ id: 'sourcing_desk.request_amendment', kind: 'commit', action: 'negotiate', input: 'CreateAmendmentRequestCommandSchema', output: 'BuyerQuoteViewSchema', contexts: ['quote', 'rfq'], reads: BUYER, privateData: ['budgets'], effects: ['state_change', 'outbound_message'], route: 'POST /v1/quotes/:id/amendment-requests' }),
  entry({ id: 'sourcing_desk.withdraw_amendment_request', kind: 'commit', action: 'negotiate', input: 'WithdrawAmendmentRequestCommandSchema', output: 'BuyerQuoteViewSchema', contexts: ['quote'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/quotes/:id/amendment-requests/:requestId/withdraw' }),
  // Agreements and orders
  entry({ id: 'deal_desk.list_agreements', kind: 'read', action: null, input: 'AgreementListQuerySchema', output: 'AgreementListSchema', contexts: ['agreement'], reads: BUYER, effects: ['none'], route: 'GET /v1/agreements' }),
  entry({ id: 'deal_desk.get_agreement', kind: 'read', action: null, input: 'AgreementQuerySchema', output: 'BuyerAgreementViewSchema', contexts: ['agreement', 'order'], reads: BUYER, privateData: ['budgets'], effects: ['none'], route: 'GET /v1/agreements/:id' }),
  entry({ id: 'deal_desk.accept_terms', kind: 'commit', action: 'place_order', budget: 'transaction', confirmation: 'person_each', input: 'AcceptTermsRequestSchema', output: 'BuyerAgreementViewSchema', contexts: ['rfq', 'quote'], reads: BUYER, privateData: ['budgets'], effects: ['state_change', 'outbound_message'], route: 'POST /v1/agreements' }),
  entry({ id: 'deal_desk.place_order', kind: 'commit', action: 'place_order', budget: 'transaction', confirmation: 'person_each', input: 'PlaceOrderRequestSchema', output: 'BuyerAgreementViewSchema', contexts: ['agreement', 'order', 'rfq', 'project'], reads: BUYER, privateData: ['budgets'], effects: ['state_change', 'money_commitment', 'outbound_message'], route: 'POST /v1/agreements/:id/orders' }),
  entry({ id: 'deal_desk.accept_order', kind: 'commit', action: 'accept_order', budget: 'transaction', confirmation: 'person_each', input: 'SellerAcceptRequestSchema', output: 'SellerAgreementViewSchema', contexts: ['agreement', 'order'], reads: SELLER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/agreements/:id/accept' }),
  entry({ id: 'deal_desk.decline_order', kind: 'commit', action: 'accept_order', budget: 'transaction', confirmation: 'person_each', input: 'SellerDeclineRequestSchema', output: 'SellerAgreementViewSchema', contexts: ['agreement', 'order'], reads: SELLER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/agreements/:id/decline' }),
  entry({ id: 'deal_desk.withdraw_agreement', kind: 'commit', action: 'place_order', budget: 'transaction', confirmation: 'person_each', input: 'WithdrawAgreementRequestSchema', output: 'BuyerAgreementViewSchema', contexts: ['agreement'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/agreements/:id/withdraw' }),
  entry({ id: 'deal_desk.save_private_half', kind: 'draft', action: 'prepare', input: 'SaveAgreementPrivateCommandSchema', output: 'BuyerAgreementViewSchema', contexts: ['agreement'], reads: BUYER, privateData: ['budgets'], effects: ['draft_state'], route: 'POST /v1/agreements/:id/private' }),
  entry({ id: 'deal_desk.cancel_order', kind: 'commit', action: 'place_order', budget: 'transaction', confirmation: 'person_each', input: 'CancelOrderRequestSchema', output: 'BuyerAgreementViewSchema', contexts: ['order', 'agreement'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/orders/:id/cancel' }),
  entry({ id: 'deal_desk.propose_order_change', kind: 'commit', action: 'negotiate', input: 'ProposeOrderChangeRequestSchema', output: 'BuyerAgreementViewSchema', contexts: ['order', 'agreement'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/orders/:id/changes' }),
  entry({ id: 'deal_desk.decide_order_change', kind: 'commit', action: 'place_order', budget: 'transaction', confirmation: 'person_each', input: 'DecideOrderChangeRequestSchema', output: 'BuyerAgreementViewSchema', contexts: ['order', 'agreement'], reads: BUYER, privateData: ['budgets'], effects: ['state_change', 'money_commitment', 'outbound_message'], route: 'POST /v1/orders/:id/changes/:changeId' }),
];

/** Shared projection of an order for the seller (strips the buyer's reservation). */
export function toSellerOrder(order: z.infer<typeof OrderSchema>) {
  return SellerOrderSchema.parse(pickFields(order, ['id', 'agreementId', 'acceptedTermsDigest', 'status', 'externalReference', 'revision', 'createdAt']));
}
