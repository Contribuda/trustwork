import { z } from 'zod';
import { PartySchema } from './access.js';
import { AgentModuleManifestSchema, type AgentCapability, type AgentModuleManifest, type ContractRef } from './agent-catalog.js';
import { AttachmentRefSchema, IanaTimeZoneSchema, IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { DigestSchema } from './common/digest-schema.js';
import { MoneySchema, NonNegativeMoneySchema, type Money } from './common/money.js';
import { QuantitySchema } from './common/quantity.js';
import { VersionRefSchema, type VersionRef } from './common/version.js';
import { DealActorInputSchema, ElectronicRecordsConsentSchema, ElectronicRecordsPolicySchema, zonedStartOfDay } from './deals.js';
import {
  DurationRangeSchema, PlaceCodeSchema, PlanDateSchema, PlanItemKeySchema, ProjectPlanItemKindSchema, ScheduleWindowSchema, StepTermSchema, TaxonomyCodeSchema,
  type PlanItem, type ProjectLocation, type ProjectPlanItemKind,
} from './plans.js';
import { CredentialStatusSchema } from './reputation-builder.js';
import { AcceptanceEventKindSchema, AgreementStatusSchema, ObligationSchema } from './transactions.js';

/**
 * Consultations and mentoring from plan items (CONS-001; ADR 010 decision 17, data model section 8, lifecycles
 * "Consultations, tasks and mentoring").
 *
 * A plan item (or a direct question) becomes a **consultation request** to one expert's consultation offering: an
 * advice session, a review of drawings or quotes, a site visit, or a mentoring session inside a mentoring
 * relationship. The commercial kernel is reused rather than rebuilt:
 *
 * | Consultation object | Kernel counterpart | Shared rule |
 * |---|---|---|
 * | `consultation_offering` | catalogue `offering` of kind `services` | price and options live in the immutable published `offering_version`; a proposal pins it by id and digest |
 * | `consultation_request` | `rfq_version` | the brief is built field by field from the plan item and frozen with its digest when sent |
 * | `consultation_request_private` | `rfq_private_constraint` | the requester's budget ceiling and notes; never in an expert view |
 * | `consultation_booking` (a proposal, then the booking) | `quote_version` | frozen and digest-bound from the moment it is proposed; price, commission, slot and cancellation terms inside |
 * | agreement `terms_kind = consultation` | COM-002 `agreement` | digest over `{ termsKind: 'consultation', quoteVersion: booking, rfqVersion: request }`; two acceptance events |
 * | `consultation_deliverable` | EXE-001 `execution_claim` + `execution_confirmation` | delivery and acceptance are separate records; acceptance is the client's own decision |
 *
 * Money: Trustwork never holds money (ADR 010 decision 20). A priced booking records the client's `pay` obligation;
 * charging through a licensed provider is CONS-002. The hub commission (ADR 010 decision 21) comes from a hub price
 * setting through a port (BILL-003); it is shown to both sides before booking and is part of the booked digest.
 */
export const CONSULTATIONS_CONTRACT_VERSION = 1;

/* ---------- Vocabulary ---------- */

export const CONSULTATION_KINDS = ['session', 'drawing_review', 'quote_review', 'site_visit', 'mentoring'] as const;
export const ConsultationKindSchema = z.enum(CONSULTATION_KINDS);
export type ConsultationKind = z.infer<typeof ConsultationKindSchema>;
export const CONSULTATION_MODES = ['video', 'chat', 'phone', 'in_person', 'async'] as const;
export const ConsultationModeSchema = z.enum(CONSULTATION_MODES);
export type ConsultationMode = z.infer<typeof ConsultationModeSchema>;
/** Modes that meet at a time (a slot inside an availability window); `async` reviews have a deliverable due date instead. */
export const SYNC_MODES = ['video', 'chat', 'phone', 'in_person'] as const satisfies readonly ConsultationMode[];
export function isSyncMode(mode: ConsultationMode): boolean {
  return (SYNC_MODES as readonly string[]).includes(mode);
}
/** How each kind may be delivered (agent catalogue, "Consultation"). */
export const KIND_MODES: Readonly<Record<ConsultationKind, readonly ConsultationMode[]>> = {
  session: ['video', 'chat', 'phone', 'in_person'],
  drawing_review: ['async', 'video'],
  quote_review: ['async', 'video'],
  site_visit: ['in_person'],
  mentoring: ['video', 'chat', 'phone', 'in_person'],
};
export const DELIVERABLE_KINDS = ['written_advice', 'marked_up_document', 'site_report', 'checklist', 'recording'] as const;
export const DeliverableKindSchema = z.enum(DELIVERABLE_KINDS);
export type DeliverableKind = z.infer<typeof DeliverableKindSchema>;
export const PRICING_MODES = ['free', 'fixed', 'hourly'] as const;
export const PricingModeSchema = z.enum(PRICING_MODES);
export type PricingMode = z.infer<typeof PricingModeSchema>;
export const OfferingStatusSchema = z.enum(['active', 'paused', 'retired']);
export const RequestStatusSchema = z.enum(['requested', 'offered', 'booked', 'withdrawn', 'expired', 'declined']);
export type ConsultationRequestStatus = z.infer<typeof RequestStatusSchema>;
export const BOOKING_STATUSES = ['proposed', 'booked', 'held', 'delivered', 'accepted', 'cancelled', 'declined', 'withdrawn', 'disputed'] as const;
export const BookingStatusSchema = z.enum(BOOKING_STATUSES);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;
/** Bookings that hold capacity in their availability window and block the expert's time. */
export const LIVE_BOOKING_STATUSES = ['booked', 'held', 'delivered', 'accepted'] as const satisfies readonly BookingStatus[];
export const CancellationKindSchema = z.enum(['client', 'expert', 'no_show']);
export type CancellationKind = z.infer<typeof CancellationKindSchema>;
export const MentoringStatusSchema = z.enum(['proposed', 'active', 'paused', 'declined', 'ended']);
export type MentoringStatus = z.infer<typeof MentoringStatusSchema>;
export const MentoringTermsSchema = z.enum(['free', 'paid']);
export const WindowStatusSchema = z.enum(['open', 'closed']);
export const LanguageTagSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/, 'language tag');

/** A person acts on their own authority; their agent only under a structured mandate. Chat text never authorizes. */
export const ConsultationActorInputSchema = DealActorInputSchema;
export type ConsultationActorInput = z.infer<typeof ConsultationActorInputSchema>;

/** Plan item kinds that may become a consultation request (works, decisions, permits, purchases: advice on any of them). */
export const CONSULTATION_PLAN_ITEM_KINDS = ['consultation', 'task', 'phase', 'decision', 'permit', 'inspection', 'purchase', 'material'] as const satisfies readonly ProjectPlanItemKind[];
/** Plan fields a requester may share with the expert. Never the budget, the address or the contact (the site reaches a site-visit expert only after booking). */
export const CONSULTATION_SHARE_FIELDS = ['scope', 'trade', 'locality', 'drawings', 'quantities', 'schedule'] as const;
export const ConsultationShareFieldSchema = z.enum(CONSULTATION_SHARE_FIELDS);
export type ConsultationShareField = z.infer<typeof ConsultationShareFieldSchema>;

const distinct = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;
const SlotSchema = z.strictObject({ start: TimestampSchema, end: TimestampSchema }).refine((s) => s.start < s.end, { message: 'a slot ends after it starts', path: ['end'] });
export type Slot = z.infer<typeof SlotSchema>;
export { SlotSchema };

/* ---------- Offerings ---------- */

export const CancellationPolicySchema = z.strictObject({
  /** Free cancellation by the client until this many hours before the start. */
  freeUntilHours: z.int().min(0).max(720),
  /** Share of the price the client owes for a later cancellation, in basis points. */
  lateShareBps: z.int().min(0).max(10_000),
  /** Share of the price the client owes when it does not show up. */
  noShowShareBps: z.int().min(0).max(10_000),
});
export type CancellationPolicy = z.infer<typeof CancellationPolicySchema>;

/** What the expert declares about an offering, beside the catalogue offering version that carries the price. */
export const ConsultationOfferingTermsSchema = z.strictObject({
  kind: ConsultationKindSchema,
  modes: z.array(ConsultationModeSchema).min(1).max(CONSULTATION_MODES.length),
  topics: z.array(TaxonomyCodeSchema).max(20),
  /** Places served (ISO 3166-2 or finer); a site visit names at least one. */
  regions: z.array(PlaceCodeSchema).max(50),
  languages: z.array(LanguageTagSchema).min(1).max(10),
  durationMinutes: z.int().min(15).max(480),
  deliverableKind: DeliverableKindSchema,
  pricing: PricingModeSchema,
  cancellation: CancellationPolicySchema,
  /** Advice that legally needs a licence names the expert's recorded licence (REP-001 credential). */
  licence: z.strictObject({ required: z.boolean(), credentialId: IdSchema.nullable() }),
  /** Recording is offered for video sessions only, and happens only with the client's consent at booking. */
  recordingOffered: z.boolean(),
})
  .refine((t) => distinct(t.modes) && distinct(t.topics) && distinct(t.regions) && distinct(t.languages), { message: 'distinct values', path: ['modes'] })
  .refine((t) => t.modes.every((m) => KIND_MODES[t.kind].includes(m)), { message: 'a mode this kind cannot be delivered in', path: ['modes'] })
  .refine((t) => t.kind !== 'site_visit' || t.regions.length > 0, { message: 'a site visit names the places it serves', path: ['regions'] })
  .refine((t) => !t.licence.required || t.licence.credentialId !== null, { message: 'licence-requiring advice names the recorded licence', path: ['licence'] })
  .refine((t) => !t.recordingOffered || t.modes.includes('video'), { message: 'recording is offered for video sessions only', path: ['recordingOffered'] });
export type ConsultationOfferingTerms = z.infer<typeof ConsultationOfferingTermsSchema>;

/**
 * How a licence is shown: `checked` only when a hub check recorded a match (REP-001 `credential_check`, CLM-001 recipes
 * later); otherwise `self_declared`, labelled so. Never the licence number.
 */
export const CredentialLabelSchema = z.strictObject({
  credentialId: IdSchema,
  status: CredentialStatusSchema,
  jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/),
  credentialType: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
  checkedOn: PlanDateSchema.nullable(),
});
export type CredentialLabel = z.infer<typeof CredentialLabelSchema>;
/** A licence may back an offering while it is checked or self-declared; expired, suspended and revoked ones never do. */
export function licenceUsable(label: Pick<CredentialLabel, 'status'> | null): boolean {
  return label !== null && (label.status === 'checked' || label.status === 'self_declared');
}

/* ---------- Price and hub commission ---------- */

export const ConsultationPriceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('free') }),
  z.strictObject({ mode: z.literal('fixed'), unitPrice: NonNegativeMoneySchema, price: NonNegativeMoneySchema }),
  z.strictObject({ mode: z.literal('hourly'), unitPrice: NonNegativeMoneySchema, minutes: z.int().min(1), price: NonNegativeMoneySchema }),
]);
export type ConsultationPrice = z.infer<typeof ConsultationPriceSchema>;
export class ConsultationPriceError extends Error {
  constructor(readonly reason: 'price_missing' | 'unit_not_hours' | 'free_has_price') {
    super(reason);
  }
}
/** Rounds half up (non-negative values only). */
function scale(minorUnits: string, numerator: bigint, denominator: bigint): string {
  return ((BigInt(minorUnits) * numerator * 2n + denominator) / (denominator * 2n)).toString();
}
/**
 * The price of one booking from the pinned catalogue version: free (no list price, or zero), fixed (the list price per
 * booking) or hourly (the list price per hour, unit `h`, times the booked minutes, rounded half up to minor units).
 */
export function consultationPrice(input: { pricing: PricingMode; listPrice: Money | null; unit: string; minutes: number }): ConsultationPrice {
  const { pricing, listPrice, unit, minutes } = input;
  if (pricing === 'free') {
    if (listPrice !== null && listPrice.minorUnits !== '0') throw new ConsultationPriceError('free_has_price');
    return { mode: 'free' };
  }
  if (listPrice === null || BigInt(listPrice.minorUnits) < 0n) throw new ConsultationPriceError('price_missing');
  const unitPrice = NonNegativeMoneySchema.parse(listPrice);
  if (pricing === 'fixed') return { mode: 'fixed', unitPrice, price: unitPrice };
  if (unit !== 'h') throw new ConsultationPriceError('unit_not_hours');
  return { mode: 'hourly', unitPrice, minutes, price: { minorUnits: scale(unitPrice.minorUnits, BigInt(minutes), 60n), currency: unitPrice.currency } };
}
export function priceAmount(price: ConsultationPrice): Money | null {
  return price.mode === 'free' ? null : price.price;
}

/**
 * The hub's commission for one booking, as the hub's versioned price setting states it (BILL-003). Until a hub publishes
 * one, the answer is `none_published` and nothing is added: there are no hidden fees.
 */
export const CommissionQuoteSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none_published') }),
  z.strictObject({
    status: z.literal('published'),
    setting: z.strictObject({ id: IdSchema, version: z.int().min(1) }),
    rateBps: z.int().min(0).max(10_000),
    fixedFee: NonNegativeMoneySchema.nullable(),
    /** Who carries the commission: added to the client's total, or deducted from the expert's amount. */
    payer: z.enum(['client', 'expert']),
    amount: NonNegativeMoneySchema,
  }),
]);
export type CommissionQuote = z.infer<typeof CommissionQuoteSchema>;
/** A published commission on a price: the rate (half up) plus the fixed fee, in the price currency. */
export function commissionOn(price: Money, setting: { id: string; version: number; rateBps: number; fixedFee: Money | null; payer: 'client' | 'expert' }): CommissionQuote {
  if (setting.fixedFee && setting.fixedFee.currency !== price.currency) throw new RangeError('the commission currency differs from the price currency');
  const amount = BigInt(scale(price.minorUnits, BigInt(setting.rateBps), 10_000n)) + BigInt(setting.fixedFee?.minorUnits ?? '0');
  return CommissionQuoteSchema.parse({
    status: 'published', setting: { id: setting.id, version: setting.version }, rateBps: setting.rateBps, fixedFee: setting.fixedFee, payer: setting.payer,
    amount: { minorUnits: amount.toString(), currency: price.currency },
  });
}
/** What each side sees before booking: the full price, the commission and the resulting totals. */
export const PricingSummarySchema = z.strictObject({
  price: ConsultationPriceSchema,
  commission: CommissionQuoteSchema,
  clientTotal: NonNegativeMoneySchema.nullable(),
  expertAmount: NonNegativeMoneySchema.nullable(),
});
export type PricingSummary = z.infer<typeof PricingSummarySchema>;
export function pricingSummary(price: ConsultationPrice, commission: CommissionQuote): PricingSummary {
  const amount = priceAmount(price);
  if (amount === null) return { price, commission: { status: 'none_published' }, clientTotal: null, expertAmount: null };
  const fee = commission.status === 'published' ? BigInt(commission.amount.minorUnits) : 0n;
  const payer = commission.status === 'published' ? commission.payer : 'client';
  const base = BigInt(amount.minorUnits);
  const clientTotal = payer === 'client' ? base + fee : base;
  const expertAmount = payer === 'expert' ? (base > fee ? base - fee : 0n) : base;
  return PricingSummarySchema.parse({
    price, commission, clientTotal: { minorUnits: clientTotal.toString(), currency: amount.currency }, expertAmount: { minorUnits: expertAmount.toString(), currency: amount.currency },
  });
}

/* ---------- Requests and the brief ---------- */

export const ConsultationRequestTermsSchema = z.strictObject({
  kind: ConsultationKindSchema,
  /** The requester's own question; shared with the addressed expert only. */
  question: z.string().overwrite((s) => s.normalize('NFC')).min(1).max(4000),
  fields: z.array(ConsultationShareFieldSchema).max(CONSULTATION_SHARE_FIELDS.length),
  preferredModes: z.array(ConsultationModeSchema).min(1).max(CONSULTATION_MODES.length),
  preferredTimes: z.array(SlotSchema).max(10),
  /** Materials shared with this expert only (drawings, the quotes under review). */
  sharedMaterials: z.array(AttachmentRefSchema).max(20),
  /** The requester needs a licensed professional: only an offering backed by a recorded licence may propose. */
  licenceRequired: z.boolean(),
  languages: z.array(LanguageTagSchema).max(5),
})
  .refine((t) => distinct(t.fields) && distinct(t.preferredModes) && distinct(t.languages), { message: 'distinct values', path: ['fields'] })
  .refine((t) => t.preferredModes.every((m) => KIND_MODES[t.kind].includes(m)), { message: 'a mode this kind cannot be delivered in', path: ['preferredModes'] });
export type ConsultationRequestTerms = z.infer<typeof ConsultationRequestTermsSchema>;

/** The frozen brief the expert receives. Optional keys are present only for a plan-item request and a chosen field. */
export const ConsultationBriefSchema = z.strictObject({
  kind: ConsultationKindSchema,
  question: ConsultationRequestTermsSchema.shape.question,
  fields: z.array(ConsultationShareFieldSchema),
  preferredModes: z.array(ConsultationModeSchema).min(1),
  preferredTimes: z.array(SlotSchema),
  sharedMaterials: z.array(AttachmentRefSchema),
  licenceRequired: z.boolean(),
  languages: z.array(LanguageTagSchema),
  timeZone: IanaTimeZoneSchema,
  planItem: z.strictObject({ key: PlanItemKeySchema, kind: ProjectPlanItemKindSchema, title: NameSchema }).nullable(),
  description: TextSchema.nullable().optional(),
  stepTerms: z.array(StepTermSchema).optional(),
  requiredSkills: z.array(TaxonomyCodeSchema).optional(),
  regionCode: PlaceCodeSchema.nullable().optional(),
  attachments: z.array(AttachmentRefSchema).optional(),
  quantity: QuantitySchema.nullable().optional(),
  window: ScheduleWindowSchema.nullable().optional(),
  duration: DurationRangeSchema.nullable().optional(),
});
export type ConsultationBrief = z.infer<typeof ConsultationBriefSchema>;

/**
 * Keys that never appear in a brief, a proposal, a booking or any expert-facing view: the requester's private half,
 * plan internals and (before a site-visit booking) the site.
 */
export const CONSULTATION_EXPERT_FORBIDDEN_KEYS = [
  'budgetCeiling', 'requesterNotes', 'privateNotes', 'sources', 'estimate', 'budgetRange', 'budget', 'riskLevel', 'decisionQuestion', 'summary', 'assumptions',
  'address', 'siteContact', 'siteAccessNotes', 'cadastralRef',
] as const;
/** Keys of the expert's own side that never reach the requester. */
export const CONSULTATION_CLIENT_FORBIDDEN_KEYS = ['credentialNumber', 'number', 'costBasis', 'marginTarget'] as const;

export class ConsultationBriefError extends Error {
  constructor(readonly reason: 'plan_item_kind' | 'kind_mismatch') {
    super(reason);
  }
}

/**
 * The only path from a private plan item (or a direct question) to an expert: the requester's terms and per-field picks
 * of the approved item. `locality` shares the region code only; nothing about budgets ever leaves.
 */
export function buildConsultationBrief(input: { item: PlanItem | null; location: ProjectLocation | null; terms: ConsultationRequestTerms; timeZone: string }): ConsultationBrief {
  const { item, terms } = input;
  if (item && !(CONSULTATION_PLAN_ITEM_KINDS as readonly string[]).includes(item.kind)) throw new ConsultationBriefError('plan_item_kind');
  const fields = new Set(item ? terms.fields : []);
  const out: ConsultationBrief = {
    kind: terms.kind, question: terms.question, fields: CONSULTATION_SHARE_FIELDS.filter((f) => fields.has(f)), preferredModes: terms.preferredModes,
    preferredTimes: terms.preferredTimes, sharedMaterials: terms.sharedMaterials, licenceRequired: terms.licenceRequired, languages: terms.languages, timeZone: input.timeZone,
    planItem: item ? { key: item.key, kind: item.kind, title: item.title } : null,
  };
  if (item) {
    if (fields.has('scope')) out.description = item.description;
    if (fields.has('trade')) {
      out.stepTerms = item.stepTerms;
      out.requiredSkills = item.requiredSkills;
    }
    if (fields.has('locality')) out.regionCode = input.location?.regionCode ?? null;
    if (fields.has('drawings')) out.attachments = item.attachments;
    if (fields.has('quantities')) out.quantity = item.quantity;
    if (fields.has('schedule')) {
      out.window = item.window;
      out.duration = item.duration;
    }
  }
  return ConsultationBriefSchema.parse(out);
}

/** Canonical digest input of a sent request (version 1: a request is frozen when sent). */
export function consultationRequestDigestInput(input: { requestId: string; brief: ConsultationBrief }): unknown {
  return { contract: `consultations:v${CONSULTATIONS_CONTRACT_VERSION}:request`, requestId: input.requestId, version: 1, brief: ConsultationBriefSchema.parse(input.brief) };
}

/* ---------- Proposals and bookings ---------- */

/** Everything the client accepts, frozen from the moment the expert proposes it. */
export const BookingTermsSchema = z.strictObject({
  request: VersionRefSchema,
  offering: z.strictObject({ offeringId: IdSchema, version: VersionRefSchema, title: NameSchema }),
  expert: z.strictObject({ party: PartySchema, personId: IdSchema }),
  client: PartySchema,
  kind: ConsultationKindSchema,
  mode: ConsultationModeSchema,
  slot: SlotSchema.nullable(),
  windowId: IdSchema.nullable(),
  durationMinutes: z.int().min(15).max(480),
  deliverableKind: DeliverableKindSchema,
  /** Asynchronous reviews: the business date in `timeZone` by which the deliverable is due. */
  deliverableDue: PlanDateSchema.nullable(),
  pricing: PricingSummarySchema,
  cancellation: CancellationPolicySchema,
  recordingOffered: z.boolean(),
  credential: CredentialLabelSchema.nullable(),
  timeZone: IanaTimeZoneSchema,
  validUntil: TimestampSchema,
  note: TextSchema.nullable(),
})
  .refine((t) => (t.slot === null) === !isSyncMode(t.mode) && (t.slot === null) === (t.windowId === null), { message: 'synchronous modes book a slot in a window; async reviews do not', path: ['slot'] })
  .refine((t) => (t.deliverableDue === null) === isSyncMode(t.mode), { message: 'async reviews name a due date', path: ['deliverableDue'] })
  .refine((t) => t.slot === null || Date.parse(t.slot.end) - Date.parse(t.slot.start) === t.durationMinutes * 60_000, { message: 'the slot lasts the offered duration', path: ['slot'] })
  .refine((t) => KIND_MODES[t.kind].includes(t.mode), { message: 'a mode this kind cannot be delivered in', path: ['mode'] })
  .refine((t) => t.kind !== 'site_visit' || t.mode === 'in_person', { message: 'a site visit is in person', path: ['mode'] });
export type BookingTerms = z.infer<typeof BookingTermsSchema>;

/** Canonical digest input of a proposal (version 1: a proposal never changes; a new proposal is a new booking row). */
export function bookingTermsDigestInput(input: { bookingId: string; terms: BookingTerms }): unknown {
  return { contract: `consultations:v${CONSULTATIONS_CONTRACT_VERSION}:booking`, bookingId: input.bookingId, version: 1, terms: BookingTermsSchema.parse(input.terms) };
}

/** Why a proposal does not fit the request and the offering; empty when it fits. */
export type ProposalMisfit = 'kind_mismatch' | 'mode_not_offered' | 'mode_not_requested' | 'licence_required' | 'slot_outside_window' | 'slot_in_past' | 'due_in_past' | 'region_not_served';
export function proposalMisfits(input: {
  brief: ConsultationBrief; offering: ConsultationOfferingTerms; mode: ConsultationMode; slot: Slot | null; window: { startsAt: string; endsAt: string } | null; deliverableDue: string | null;
  credential: CredentialLabel | null; now: Date;
}): ProposalMisfit[] {
  const out: ProposalMisfit[] = [];
  const { brief, offering, mode, slot, window, now } = input;
  if (brief.kind !== offering.kind) out.push('kind_mismatch');
  if (!offering.modes.includes(mode)) out.push('mode_not_offered');
  if (!brief.preferredModes.includes(mode)) out.push('mode_not_requested');
  if ((brief.licenceRequired || offering.licence.required) && !licenceUsable(input.credential)) out.push('licence_required');
  if (slot && window && (slot.start < window.startsAt || slot.end > window.endsAt)) out.push('slot_outside_window');
  if (slot && Date.parse(slot.start) <= now.getTime()) out.push('slot_in_past');
  if (input.deliverableDue !== null && input.deliverableDue < now.toISOString().slice(0, 10)) out.push('due_in_past');
  if (offering.kind === 'site_visit' && brief.regionCode !== undefined && brief.regionCode !== null
      && !offering.regions.some((r) => brief.regionCode === r || (brief.regionCode as string).startsWith(`${r}-`) || (brief.regionCode as string).startsWith(`${r}:`))) out.push('region_not_served');
  return out;
}

/** Whether a stored proposal may be accepted now, against the exact refs the client states. */
export type BookingAcceptanceCheck = 'ok' | 'commercial.quote_not_acceptable' | 'commercial.quote_expired' | 'commercial.digest_mismatch' | 'commercial.rfq_version_mismatch';
export function checkBookingAcceptance(input: {
  booking: { id: string; status: BookingStatus; digest: string; validUntil: string; agreementId: string | null }; bookingRef: VersionRef; request: { id: string; status: ConsultationRequestStatus; digest: string };
  requestRefDigest: string; now: Date;
}): BookingAcceptanceCheck {
  const { booking, bookingRef, request, now } = input;
  if (input.requestRefDigest !== request.digest || (request.status !== 'offered' && request.status !== 'requested')) return 'commercial.rfq_version_mismatch';
  if (booking.status !== 'proposed' || booking.agreementId !== null) return 'commercial.quote_not_acceptable';
  if (Date.parse(booking.validUntil) <= now.getTime()) return 'commercial.quote_expired';
  if (bookingRef.id !== booking.id || bookingRef.version !== 1 || bookingRef.digest.value !== booking.digest) return 'commercial.digest_mismatch';
  return 'ok';
}

/**
 * Obligations of booked terms: the expert performs (by the end of the slot, or by the start of the day after the due
 * date of an async review); the client pays the full price when the booking is priced (outside the platform or through
 * a licensed provider: CONS-002) and accepts the deliverable.
 */
export function deriveConsultationObligations(terms: BookingTerms): z.infer<typeof ObligationSchema>[] {
  const performDue = terms.slot ? terms.slot.end : zonedStartOfDay(nextDay(terms.deliverableDue as string), terms.timeZone);
  const out: z.infer<typeof ObligationSchema>[] = [{ party: terms.expert.party, kind: 'perform', due: performDue, amount: null, scope: null }];
  const total = terms.pricing.clientTotal;
  if (total !== null && total.minorUnits !== '0') out.push({ party: terms.client, kind: 'pay', due: terms.slot ? terms.slot.start : performDue, amount: total, scope: null });
  out.push({ party: terms.client, kind: 'accept', due: null, amount: null, scope: null });
  return out.map((o) => ObligationSchema.parse(o));
}
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * What a cancellation costs the client under the booked terms (charged by CONS-002, never held here): nothing for the
 * expert's cancellation or a timely one; the late share after `freeUntilHours`; the no-show share when the client is
 * absent. An expert's no-show costs the client nothing.
 */
export function cancellationCharge(terms: BookingTerms, input: { kind: CancellationKind; absentSide: 'client' | 'expert' | null; at: Date }): Money | null {
  const total = terms.pricing.clientTotal;
  if (total === null || total.minorUnits === '0' || terms.slot === null) return null;
  let bps = 0;
  if (input.kind === 'no_show' && input.absentSide === 'client') bps = terms.cancellation.noShowShareBps;
  else if (input.kind === 'client' && Date.parse(terms.slot.start) - input.at.getTime() < terms.cancellation.freeUntilHours * 3_600_000) bps = terms.cancellation.lateShareBps;
  if (bps === 0) return null;
  return { minorUnits: scale(total.minorUnits, BigInt(bps), 10_000n), currency: total.currency };
}

/** Reminders posted to the booking's context thread (the agreement thread of COMMS-001): a day and an hour before. */
export const REMINDER_OFFSETS_MINUTES = [1440, 60] as const;
export function reminderTimes(slot: Slot | null, now: Date): { remindAt: string; offsetMinutes: number }[] {
  if (!slot) return [];
  return REMINDER_OFFSETS_MINUTES.map((m) => ({ remindAt: new Date(Date.parse(slot.start) - m * 60_000).toISOString(), offsetMinutes: m })).filter((r) => Date.parse(r.remindAt) > now.getTime());
}

/**
 * A calendar file (RFC 5545) for one booking. It carries the offering title (the expert's own words), the times and a
 * stable identifier; never the site address, a meeting link or a price, because calendars sync to third parties.
 */
export function bookingCalendar(input: { bookingId: string; title: string; slot: Slot; sequence: number; cancelled: boolean; hubHost: string; stamp: Date }): string {
  const fmt = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const fold = (line: string) => {
    const out: string[] = [];
    for (let rest = line; rest.length > 0; rest = rest.slice(73)) out.push((out.length ? ' ' : '') + rest.slice(0, out.length ? 73 : 74));
    return out.join('\r\n');
  };
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trustwork//Consultations//EN', 'CALSCALE:GREGORIAN', `METHOD:${input.cancelled ? 'CANCEL' : 'PUBLISH'}`, 'BEGIN:VEVENT',
    `UID:consultation-${input.bookingId}@${input.hubHost}`, `SEQUENCE:${input.sequence}`, `DTSTAMP:${fmt(input.stamp.toISOString())}`, `DTSTART:${fmt(input.slot.start)}`, `DTEND:${fmt(input.slot.end)}`,
    `SUMMARY:${text(input.title)}`, `STATUS:${input.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
export const CalendarFileSchema = z.strictObject({ fileName: z.string().regex(/^[a-z0-9-]{1,100}\.ics$/), mediaType: z.literal('text/calendar'), content: z.string().min(1).max(10_000) });

/* ---------- Deliverables ---------- */

export const DeliverableDecisionSchema = z.enum(['accepted', 'rejected']);
/** The booking status a decision on the deliverable leads to (a rejection reopens the delivery). */
export function statusAfterDecision(decision: z.infer<typeof DeliverableDecisionSchema>, mode: ConsultationMode): BookingStatus {
  if (decision === 'accepted') return 'accepted';
  return isSyncMode(mode) ? 'held' : 'booked';
}
/** The public projection of a published deliverable: the author's own work, never the client, the project or attachments. */
export const PublicDeliverableSchema = z.strictObject({
  id: IdSchema, kind: DeliverableKindSchema, consultationKind: ConsultationKindSchema, title: NameSchema, body: TextSchema, author: PartySchema, publishedAt: TimestampSchema,
});
export type PublicDeliverable = z.infer<typeof PublicDeliverableSchema>;

/* ---------- Records and views ---------- */

export const ConsultationOfferingSchema = z.strictObject({
  offeringId: IdSchema,
  owner: PartySchema,
  expertPersonId: IdSchema,
  terms: ConsultationOfferingTermsSchema,
  status: OfferingStatusSchema,
  /** The live label of the recorded licence, when the offering names one. */
  credential: CredentialLabelSchema.nullable(),
  /** The catalogue version a proposal would pin now (null while the catalogue offering has none published). */
  currentVersion: z.strictObject({ id: IdSchema, version: z.int().min(1), title: NameSchema, listPrice: MoneySchema.nullable(), unit: z.string() }).nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ConsultationOffering = z.infer<typeof ConsultationOfferingSchema>;
export const PublicConsultationOfferingSchema = z.strictObject({
  offeringId: IdSchema, owner: PartySchema, kind: ConsultationKindSchema, modes: z.array(ConsultationModeSchema), topics: z.array(TaxonomyCodeSchema), regions: z.array(PlaceCodeSchema),
  languages: z.array(LanguageTagSchema), durationMinutes: z.int(), deliverableKind: DeliverableKindSchema, pricing: PricingModeSchema, title: NameSchema.nullable(),
  listPrice: MoneySchema.nullable(), credential: CredentialLabelSchema.omit({ credentialId: true }).nullable(),
});
export const PublicConsultationOfferingListSchema = z.strictObject({ offerings: z.array(PublicConsultationOfferingSchema) });

export const AvailabilityWindowSchema = z.strictObject({
  id: IdSchema, expertPersonId: IdSchema, startsAt: TimestampSchema, endsAt: TimestampSchema, timeZone: IanaTimeZoneSchema, capacity: z.int().min(1).max(50), booked: z.int().min(0),
  status: WindowStatusSchema, revision: RevisionSchema,
});
/** What a requester sees of the addressed expert's calendar: free windows and remaining capacity, nothing about other clients. */
export const FreeWindowSchema = z.strictObject({ id: IdSchema, startsAt: TimestampSchema, endsAt: TimestampSchema, timeZone: IanaTimeZoneSchema, remaining: z.int().min(1) });

export const ConsultationPlanItemRefSchema = z.strictObject({ projectId: IdSchema, planId: IdSchema, planVersionId: IdSchema, itemKey: PlanItemKeySchema });
export const ConsultationRequestSchema = z.strictObject({
  id: IdSchema,
  requester: PartySchema,
  offeringId: IdSchema,
  expert: PartySchema,
  planItem: ConsultationPlanItemRefSchema.nullable(),
  mentoringRelationshipId: IdSchema.nullable(),
  kind: ConsultationKindSchema,
  status: RequestStatusSchema,
  digest: DigestSchema,
  closedReason: ShortTextSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ConsultationRequest = z.infer<typeof ConsultationRequestSchema>;
/** party_private (requester): the budget ceiling an agent never books above, and notes. Never in an expert view. */
export const ConsultationRequestPrivateInputSchema = z.strictObject({ budgetCeiling: NonNegativeMoneySchema.nullable(), requesterNotes: ShortTextSchema.nullable() });
export type ConsultationRequestPrivateInput = z.infer<typeof ConsultationRequestPrivateInputSchema>;
export const EMPTY_REQUEST_PRIVATE: ConsultationRequestPrivateInput = { budgetCeiling: null, requesterNotes: null };
export const ConsultationRequestPrivateSchema = ConsultationRequestPrivateInputSchema.extend({ revision: RevisionSchema });

export const BookingCancellationSchema = z.strictObject({ kind: CancellationKindSchema, absentSide: z.enum(['client', 'expert']).nullable(), reason: ShortTextSchema, charge: NonNegativeMoneySchema.nullable(), at: TimestampSchema });
export const ConsultationBookingSchema = z.strictObject({
  id: IdSchema,
  requestId: IdSchema,
  terms: BookingTermsSchema,
  digest: DigestSchema,
  status: BookingStatusSchema,
  agreementId: IdSchema.nullable(),
  recordingConsent: z.boolean(),
  cancellation: BookingCancellationSchema.nullable(),
  bookedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type ConsultationBooking = z.infer<typeof ConsultationBookingSchema>;

export const ConsultationAgreementEventSchema = z.strictObject({
  id: IdSchema, kind: AcceptanceEventKindSchema, acceptedTermsDigest: DigestSchema, onBehalfOf: PartySchema,
  electronicRecords: z.strictObject({ disclosureKey: ElectronicRecordsPolicySchema.shape.disclosureKey, basis: ElectronicRecordsPolicySchema.shape.basis }).nullable(), occurredAt: TimestampSchema,
});
/** The shared agreement of a booking: both parties see the same record, events without mandates or budgets. */
export const ConsultationAgreementSchema = z.strictObject({
  id: IdSchema, termsKind: z.literal('consultation'), buyer: PartySchema, seller: PartySchema, booking: VersionRefSchema, request: VersionRefSchema, acceptedTermsDigest: DigestSchema,
  status: AgreementStatusSchema, closedReason: ShortTextSchema.nullable(), events: z.array(ConsultationAgreementEventSchema), obligations: z.array(ObligationSchema), revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type ConsultationAgreement = z.infer<typeof ConsultationAgreementSchema>;
export const ConsultationSessionSchema = z.strictObject({
  bookingId: IdSchema, startedAt: TimestampSchema.nullable(), endedAt: TimestampSchema.nullable(), siteAddressRevealedAt: TimestampSchema.nullable(), meetingLinkRef: z.string().nullable(),
});
export const ConsultationDeliverableSchema = z.strictObject({
  id: IdSchema, bookingId: IdSchema, kind: DeliverableKindSchema, title: NameSchema, body: TextSchema, attachments: z.array(AttachmentRefSchema), author: PartySchema,
  claimId: IdSchema, deliveredAt: TimestampSchema, decision: DeliverableDecisionSchema.nullable(), confirmationId: IdSchema.nullable(), decidedAt: TimestampSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
});
export type ConsultationDeliverable = z.infer<typeof ConsultationDeliverableSchema>;
export const ConsultationReminderSchema = z.strictObject({ id: IdSchema, remindAt: TimestampSchema, offsetMinutes: z.int().min(1), status: z.enum(['scheduled', 'cancelled', 'sent']) });
/** The site of a booked site visit (for the expert from the booking on; owner-private before). */
export const ConsultationSiteSchema = z.strictObject({
  regionCode: PlaceCodeSchema.nullable(), address: z.unknown().nullable(), siteContact: z.unknown().nullable(), siteAccessNotes: TextSchema.nullable(),
});

/** owner_private: the request, its brief, the private half, every proposal with its pricing, agreements and free windows. */
export const RequesterRequestViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  request: ConsultationRequestSchema,
  brief: ConsultationBriefSchema,
  privateConstraint: ConsultationRequestPrivateSchema,
  bookings: z.array(ConsultationBookingSchema),
  agreements: z.array(ConsultationAgreementSchema),
  freeWindows: z.array(FreeWindowSchema),
});
export type RequesterRequestView = z.infer<typeof RequesterRequestViewSchema>;
/** shared_party for the addressed expert: the brief and its own proposals; never the private half. */
export const ExpertRequestViewSchema = z.strictObject({
  projection: z.literal('shared_party'),
  request: ConsultationRequestSchema,
  brief: ConsultationBriefSchema,
  bookings: z.array(ConsultationBookingSchema),
  agreements: z.array(ConsultationAgreementSchema),
});
export type ExpertRequestView = z.infer<typeof ExpertRequestViewSchema>;
export const BookingViewSchema = z.strictObject({
  projection: z.literal('shared_party'),
  side: z.enum(['client', 'expert']),
  booking: ConsultationBookingSchema,
  agreement: ConsultationAgreementSchema.nullable(),
  session: ConsultationSessionSchema.nullable(),
  deliverables: z.array(ConsultationDeliverableSchema),
  reminders: z.array(ConsultationReminderSchema),
  /** The COMMS-001 thread context where both parties talk and reminders are posted. */
  threadContext: z.strictObject({ kind: z.literal('agreement'), id: IdSchema }).nullable(),
  /** A site visit's site, once booked (never before, never for other kinds). */
  site: ConsultationSiteSchema.nullable(),
});
export type BookingView = z.infer<typeof BookingViewSchema>;

export const MentoringRelationshipSchema = z.strictObject({
  id: IdSchema, mentor: PartySchema, mentee: PartySchema, proposedBy: PartySchema, topics: z.array(ShortTextSchema), terms: MentoringTermsSchema, offeringId: IdSchema.nullable(),
  status: MentoringStatusSchema, startedAt: TimestampSchema.nullable(), endedAt: TimestampSchema.nullable(), endedReason: ShortTextSchema.nullable(), revision: RevisionSchema, createdAt: TimestampSchema,
});
export type MentoringRelationship = z.infer<typeof MentoringRelationshipSchema>;
/** Who may move a relationship where: double opt-in, either side pauses, resumes or ends. */
export function mentoringTransitionAllowed(from: MentoringStatus, to: MentoringStatus, side: 'proposer' | 'other'): boolean {
  if (from === 'proposed') return (to === 'active' || to === 'declined') ? side === 'other' : to === 'ended' && side === 'proposer';
  if (from === 'active') return to === 'paused' || to === 'ended';
  if (from === 'paused') return to === 'active' || to === 'ended';
  return false;
}

export const ConsultationOfferingListSchema = z.strictObject({ offerings: z.array(ConsultationOfferingSchema) });
export const AvailabilityListSchema = z.strictObject({ windows: z.array(AvailabilityWindowSchema) });
export const ConsultationRequestListSchema = z.strictObject({
  requests: z.array(z.strictObject({ id: IdSchema, side: z.enum(['requester', 'expert']), kind: ConsultationKindSchema, status: RequestStatusSchema, counterparty: PartySchema, updatedAt: TimestampSchema })),
});
export const BookingListSchema = z.strictObject({
  bookings: z.array(z.strictObject({ id: IdSchema, side: z.enum(['client', 'expert']), kind: ConsultationKindSchema, mode: ConsultationModeSchema, status: BookingStatusSchema, slot: SlotSchema.nullable(), title: NameSchema, counterparty: PartySchema })),
});
export const MentoringListSchema = z.strictObject({ relationships: z.array(MentoringRelationshipSchema) });

/**
 * Payment-blind order for every list a party sees: newest first by the given time, then by id. No payment,
 * entitlement, sponsorship or reputation input exists.
 */
export function paymentBlindOrder<T extends { id: string; at: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? 1 : -1));
}

/* ---------- Commands ---------- */

export const ConsultationListQuerySchema = z.strictObject({});
export const ConsultationIdQuerySchema = z.strictObject({ id: IdSchema });
export const PublicOfferingQuerySchema = z.strictObject({ ownerKind: z.enum(['person', 'company']), ownerId: IdSchema });

export const RegisterConsultationOfferingCommandSchema = z.strictObject({ offeringId: IdSchema, terms: ConsultationOfferingTermsSchema, actor: ConsultationActorInputSchema });
export const UpdateConsultationOfferingCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, terms: ConsultationOfferingTermsSchema, status: OfferingStatusSchema, actor: ConsultationActorInputSchema });
export const CreateAvailabilityCommandSchema = z.strictObject({
  startsAt: TimestampSchema, endsAt: TimestampSchema, timeZone: IanaTimeZoneSchema, capacity: z.int().min(1).max(50), actor: ConsultationActorInputSchema,
}).refine((w) => w.startsAt < w.endsAt && Date.parse(w.endsAt) - Date.parse(w.startsAt) <= 14 * 86_400_000, { message: 'a window ends after it starts, within 14 days', path: ['endsAt'] });
export const CloseAvailabilityCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, actor: ConsultationActorInputSchema });

export const ConsultationSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan_item'), projectId: IdSchema, itemKey: PlanItemKeySchema }),
  z.strictObject({ kind: z.literal('direct') }),
]);
export const CreateConsultationRequestCommandSchema = z.strictObject({
  source: ConsultationSourceSchema,
  offeringId: IdSchema,
  terms: ConsultationRequestTermsSchema,
  mentoringRelationshipId: IdSchema.nullable(),
  privateConstraint: ConsultationRequestPrivateInputSchema.nullable(),
  actor: ConsultationActorInputSchema,
});
export const SaveRequestPrivateCommandSchema = ConsultationRequestPrivateInputSchema.extend({ expectedRevision: RevisionSchema });
export const WithdrawConsultationRequestCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: ConsultationActorInputSchema });
export const DeclineConsultationRequestCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: ConsultationActorInputSchema });

/** The expert proposes the exact terms: the server pins the current published catalogue version and the hub commission. */
export const ProposeConsultationCommandSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  mode: ConsultationModeSchema,
  slot: z.strictObject({ windowId: IdSchema, start: TimestampSchema }).nullable(),
  deliverableDue: PlanDateSchema.nullable(),
  validUntil: TimestampSchema,
  note: TextSchema.nullable(),
  actor: ConsultationActorInputSchema,
});
export const WithdrawProposalCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: ConsultationActorInputSchema });
/** The client accepts the exact proposal against its own request, by id and digest. */
export const AcceptProposalCommandSchema = z.strictObject({
  booking: VersionRefSchema,
  request: VersionRefSchema,
  expectedRevision: RevisionSchema,
  recordingConsent: z.boolean(),
  electronicRecords: ElectronicRecordsConsentSchema.nullable(),
  actor: ConsultationActorInputSchema,
});
export const DeclineProposalCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: ConsultationActorInputSchema });
export const WithdrawAcceptanceCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: ConsultationActorInputSchema });
/** The expert confirms the agreement, stating the digest it accepts; capacity is taken in the same transaction. */
export const ConfirmBookingCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, acceptedTermsDigest: DigestSchema, electronicRecords: ElectronicRecordsConsentSchema.nullable(), actor: ConsultationActorInputSchema });
export const DeclineAgreementCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema, actor: ConsultationActorInputSchema });
export const CancelBookingCommandSchema = z.strictObject({
  expectedRevision: RevisionSchema, kind: CancellationKindSchema, absentSide: z.enum(['client', 'expert']).nullable(), reason: ShortTextSchema, actor: ConsultationActorInputSchema,
}).refine((c) => (c.kind === 'no_show') === (c.absentSide !== null), { message: 'a no-show names the absent side', path: ['absentSide'] });
export const RecordSessionCommandSchema = z.strictObject({
  expectedRevision: RevisionSchema, startedAt: TimestampSchema, endedAt: TimestampSchema, actor: ConsultationActorInputSchema,
}).refine((s) => s.startedAt < s.endedAt, { message: 'a session ends after it starts', path: ['endedAt'] });
/** The deliverable is the expert's own work product: an agent may draft it elsewhere, the expert delivers in person. */
export const RecordDeliverableCommandSchema = z.strictObject({
  expectedRevision: RevisionSchema, kind: DeliverableKindSchema, title: NameSchema, body: z.string().overwrite((s) => s.normalize('NFC')).min(1).max(20_000),
  attachments: z.array(AttachmentRefSchema).max(20),
});
/** The client decides in person (`confirm_execution` is human-only): no actor field. */
export const DecideDeliverableCommandSchema = z.strictObject({ decision: DeliverableDecisionSchema, note: ShortTextSchema.nullable() })
  .refine((d) => d.decision === 'accepted' || d.note !== null, { message: 'a rejection states its reason', path: ['note'] });
/** The author publishes its own deliverable, confirming it holds nothing of the client. */
export const PublishDeliverableCommandSchema = z.strictObject({ confirmNoClientData: z.literal(true) });

export const ProposeMentoringCommandSchema = z.strictObject({
  counterpart: IdSchema, myRole: z.enum(['mentor', 'mentee']), topics: z.array(ShortTextSchema).min(1).max(10), terms: MentoringTermsSchema, offeringId: IdSchema.nullable(),
  actor: ConsultationActorInputSchema,
}).refine((m) => (m.terms === 'paid') === (m.offeringId !== null), { message: 'paid mentoring names the mentor\'s offering', path: ['offeringId'] });
export const RespondMentoringCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, decision: z.enum(['accept', 'decline']), actor: ConsultationActorInputSchema });
export const ChangeMentoringCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, to: z.enum(['active', 'paused', 'ended']), reason: ShortTextSchema.nullable(), actor: ConsultationActorInputSchema })
  .refine((c) => c.to !== 'ended' || c.reason !== null, { message: 'ending states a reason', path: ['reason'] });

/* ---------- Where consultation data may go ---------- */

/** Outbox payloads carry identifiers only; notifications read projections under the recipient's authority. */
export const CONSULTATION_EVENT_PAYLOAD_KEYS = [
  'offeringId', 'windowId', 'requestId', 'bookingId', 'agreementId', 'deliverableId', 'claimId', 'confirmationId', 'relationshipId', 'status', 'eventKind', 'termsKind', 'kind', 'via',
] as const;
export const CONSULTATION_EGRESS = {
  requestPrivate: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  brief: { search: false, publicProjection: false },
  booking: { search: false, publicProjection: false },
  deliverable: { search: false, publicProjection: 'author_publication_only' },
  availability: { search: false, publicProjection: false, sharedProjection: 'free_windows_to_addressed_requester' },
  notificationPayload: 'identifiers_only',
} as const;

/* ---------- Capability registry: the consultation module (ADR 010 decision 23, AGT-002 shape) ---------- */

const ref = (schema: string, contract = 'consultations'): ContractRef => ({ contract, schema, version: 1 });
const MODULE = { key: 'consultation', version: '1.0.0' } as const;
type CapabilityInput = Omit<AgentCapability, 'version' | 'status' | 'source' | 'surfaces' | 'acceptsUntrustedText' | 'meters' | 'budgetKind'> & Partial<Pick<AgentCapability, 'surfaces' | 'acceptsUntrustedText' | 'meters' | 'budgetKind'>>;
const capability = (c: CapabilityInput): AgentCapability => ({
  version: 1, status: 'live', source: { kind: 'module', moduleKey: MODULE.key, moduleVersion: MODULE.version }, budgetKind: null,
  surfaces: ['ui', 'agent', 'mcp'], acceptsUntrustedText: false, meters: c.kind === 'commit' ? ['agent_actions'] : c.kind === 'draft' ? ['model_tokens'] : [], ...c,
});
const REQUESTER: Pick<AgentCapability, 'reads' | 'privateDataClasses'> = { reads: ['owner_private'], privateDataClasses: ['private_projects', 'budgets'] };
const EXPERT: Pick<AgentCapability, 'reads' | 'privateDataClasses'> = { reads: ['party_private'], privateDataClasses: [] };
const SHARED: Pick<AgentCapability, 'reads' | 'privateDataClasses'> = { reads: ['shared_party'], privateDataClasses: [] };
const READ: Pick<AgentCapability, 'kind' | 'mandateAction' | 'confirmation' | 'sideEffects'> = { kind: 'read', mandateAction: null, confirmation: 'none', sideEffects: ['none'] };
const COMMIT = (mandateAction: AgentCapability['mandateAction'], confirmation: AgentCapability['confirmation'] = 'mandate'): Pick<AgentCapability, 'kind' | 'mandateAction' | 'confirmation' | 'sideEffects'> => ({
  kind: 'commit', mandateAction, confirmation, sideEffects: ['state_change', 'outbound_message'],
});

/**
 * Every consultation operation, defined once for the interface, the person's agent and connections. Experts publish
 * offerings and availability and propose terms within mandates; a client's booking is always the person's decision
 * (`person_each`); delivering and accepting the deliverable and publishing it are human-only. Hubs cannot widen this module.
 */
export const CONSULTATION_CAPABILITIES: readonly AgentCapability[] = [
  // Reads
  capability({ id: 'consultation.list_public_offerings', ...READ, input: ref('PublicOfferingQuerySchema'), output: ref('PublicConsultationOfferingListSchema'), contextKinds: ['catalogue_offering'], reads: ['public'], privateDataClasses: [], labelKey: 'consultations.capability.listPublicOfferings' }),
  capability({ id: 'consultation.list_offerings', ...READ, input: ref('ConsultationListQuerySchema'), output: ref('ConsultationOfferingListSchema'), contextKinds: ['catalogue_offering'], ...EXPERT, labelKey: 'consultations.capability.listOfferings' }),
  capability({ id: 'consultation.list_availability', ...READ, input: ref('ConsultationListQuerySchema'), output: ref('AvailabilityListSchema'), contextKinds: ['profile'], ...EXPERT, labelKey: 'consultations.capability.listAvailability' }),
  capability({ id: 'consultation.list_requests', ...READ, input: ref('ConsultationListQuerySchema'), output: ref('ConsultationRequestListSchema'), contextKinds: ['consultation'], ...SHARED, labelKey: 'consultations.capability.listRequests' }),
  capability({ id: 'consultation.get_request', ...READ, input: ref('ConsultationIdQuerySchema'), output: ref('RequesterRequestViewSchema'), contextKinds: ['consultation', 'plan_item'], ...REQUESTER, labelKey: 'consultations.capability.getRequest' }),
  capability({ id: 'consultation.get_brief', ...READ, input: ref('ConsultationIdQuerySchema'), output: ref('ExpertRequestViewSchema'), contextKinds: ['consultation'], ...SHARED, labelKey: 'consultations.capability.getBrief' }),
  capability({ id: 'consultation.list_bookings', ...READ, input: ref('ConsultationListQuerySchema'), output: ref('BookingListSchema'), contextKinds: ['consultation', 'agreement'], ...SHARED, labelKey: 'consultations.capability.listBookings' }),
  capability({ id: 'consultation.get_booking', ...READ, input: ref('ConsultationIdQuerySchema'), output: ref('BookingViewSchema'), contextKinds: ['consultation', 'agreement'], reads: ['party_private'], privateDataClasses: ['private_projects'], labelKey: 'consultations.capability.getBooking' }),
  capability({ id: 'consultation.get_calendar', ...READ, input: ref('ConsultationIdQuerySchema'), output: ref('CalendarFileSchema'), contextKinds: ['consultation'], ...SHARED, labelKey: 'consultations.capability.getCalendar' }),
  capability({ id: 'consultation.list_mentoring', ...READ, input: ref('ConsultationListQuerySchema'), output: ref('MentoringListSchema'), contextKinds: ['profile'], ...SHARED, labelKey: 'consultations.capability.listMentoring' }),
  // Expert: offerings and availability
  capability({ id: 'consultation.register_offering', ...COMMIT('publish', 'person_each'), sideEffects: ['state_change', 'publication'], input: ref('RegisterConsultationOfferingCommandSchema'), output: ref('ConsultationOfferingSchema'), contextKinds: ['catalogue_offering'], ...EXPERT, labelKey: 'consultations.capability.registerOffering' }),
  capability({ id: 'consultation.update_offering', ...COMMIT('publish', 'person_each'), sideEffects: ['state_change', 'publication'], input: ref('UpdateConsultationOfferingCommandSchema'), output: ref('ConsultationOfferingSchema'), contextKinds: ['catalogue_offering'], ...EXPERT, labelKey: 'consultations.capability.updateOffering' }),
  capability({ id: 'consultation.open_window', ...COMMIT('schedule'), sideEffects: ['state_change'], input: ref('CreateAvailabilityCommandSchema'), output: ref('AvailabilityWindowSchema'), contextKinds: ['profile'], ...EXPERT, labelKey: 'consultations.capability.openWindow' }),
  capability({ id: 'consultation.close_window', ...COMMIT('schedule'), sideEffects: ['state_change'], input: ref('CloseAvailabilityCommandSchema'), output: ref('AvailabilityWindowSchema'), contextKinds: ['profile'], ...EXPERT, labelKey: 'consultations.capability.closeWindow' }),
  // Requester
  capability({ id: 'consultation.request', ...COMMIT('communicate', 'person_each'), input: ref('CreateConsultationRequestCommandSchema'), output: ref('RequesterRequestViewSchema'), contextKinds: ['plan_item', 'project', 'consultation'], ...REQUESTER, labelKey: 'consultations.capability.request' }),
  capability({ id: 'consultation.set_request_private', kind: 'draft', mandateAction: 'prepare', confirmation: 'none', input: ref('SaveRequestPrivateCommandSchema'), output: ref('RequesterRequestViewSchema'), contextKinds: ['consultation'], ...REQUESTER, sideEffects: ['draft_state'], labelKey: 'consultations.capability.setRequestPrivate' }),
  capability({ id: 'consultation.withdraw_request', ...COMMIT('communicate'), input: ref('WithdrawConsultationRequestCommandSchema'), output: ref('RequesterRequestViewSchema'), contextKinds: ['consultation'], ...REQUESTER, labelKey: 'consultations.capability.withdrawRequest' }),
  // Expert: answering
  capability({ id: 'consultation.decline_request', ...COMMIT('communicate'), input: ref('DeclineConsultationRequestCommandSchema'), output: ref('ExpertRequestViewSchema'), contextKinds: ['consultation'], ...EXPERT, labelKey: 'consultations.capability.declineRequest' }),
  capability({ id: 'consultation.propose', ...COMMIT('send_quote'), input: ref('ProposeConsultationCommandSchema'), output: ref('ExpertRequestViewSchema'), contextKinds: ['consultation'], ...EXPERT, labelKey: 'consultations.capability.propose' }),
  capability({ id: 'consultation.withdraw_proposal', ...COMMIT('send_quote'), input: ref('WithdrawProposalCommandSchema'), output: ref('ExpertRequestViewSchema'), contextKinds: ['consultation'], ...EXPERT, labelKey: 'consultations.capability.withdrawProposal' }),
  // Agreement
  capability({ id: 'consultation.accept_proposal', ...COMMIT('place_order', 'person_each'), budgetKind: 'transaction', input: ref('AcceptProposalCommandSchema'), output: ref('RequesterRequestViewSchema'), contextKinds: ['consultation', 'agreement'], ...REQUESTER, labelKey: 'consultations.capability.acceptProposal' }),
  capability({ id: 'consultation.decline_proposal', ...COMMIT('communicate'), input: ref('DeclineProposalCommandSchema'), output: ref('RequesterRequestViewSchema'), contextKinds: ['consultation'], ...REQUESTER, labelKey: 'consultations.capability.declineProposal' }),
  capability({ id: 'consultation.withdraw_acceptance', ...COMMIT('place_order', 'person_each'), budgetKind: 'transaction', input: ref('WithdrawAcceptanceCommandSchema'), output: ref('RequesterRequestViewSchema'), contextKinds: ['agreement'], ...REQUESTER, labelKey: 'consultations.capability.withdrawAcceptance' }),
  capability({ id: 'consultation.confirm_booking', ...COMMIT('accept_order', 'person_each'), budgetKind: 'transaction', input: ref('ConfirmBookingCommandSchema'), output: ref('BookingViewSchema'), contextKinds: ['agreement', 'consultation'], ...EXPERT, labelKey: 'consultations.capability.confirmBooking' }),
  capability({ id: 'consultation.decline_agreement', ...COMMIT('accept_order', 'person_each'), budgetKind: 'transaction', input: ref('DeclineAgreementCommandSchema'), output: ref('BookingViewSchema'), contextKinds: ['agreement'], ...EXPERT, labelKey: 'consultations.capability.declineAgreement' }),
  // Booking life
  capability({ id: 'consultation.cancel', ...COMMIT('schedule', 'person_each'), input: ref('CancelBookingCommandSchema'), output: ref('BookingViewSchema'), contextKinds: ['consultation', 'agreement'], reads: ['party_private'], privateDataClasses: [], labelKey: 'consultations.capability.cancel' }),
  capability({ id: 'consultation.record_session', ...COMMIT('record_evidence'), input: ref('RecordSessionCommandSchema'), output: ref('BookingViewSchema'), contextKinds: ['consultation', 'agreement'], reads: ['party_private'], privateDataClasses: [], labelKey: 'consultations.capability.recordSession' }),
  capability({ id: 'consultation.deliver', ...COMMIT('record_evidence', 'person_each'), input: ref('RecordDeliverableCommandSchema'), output: ref('BookingViewSchema'), contextKinds: ['consultation', 'agreement'], ...EXPERT, surfaces: ['ui', 'agent'], labelKey: 'consultations.capability.deliver' }),
  capability({ id: 'consultation.decide_deliverable', ...COMMIT('confirm_execution', 'person_each'), sideEffects: ['state_change', 'outbound_message', 'reputation_signal'], input: ref('DecideDeliverableCommandSchema'), output: ref('BookingViewSchema'), contextKinds: ['consultation', 'agreement'], reads: ['party_private'], privateDataClasses: ['private_projects'], surfaces: ['ui', 'agent'], labelKey: 'consultations.capability.decideDeliverable' }),
  capability({ id: 'consultation.publish_deliverable', ...COMMIT('publish', 'person_each'), sideEffects: ['state_change', 'publication'], input: ref('PublishDeliverableCommandSchema'), output: ref('BookingViewSchema'), contextKinds: ['consultation'], ...EXPERT, surfaces: ['ui', 'agent'], labelKey: 'consultations.capability.publishDeliverable' }),
  // Mentoring
  capability({ id: 'consultation.propose_mentoring', ...COMMIT('communicate', 'person_each'), input: ref('ProposeMentoringCommandSchema'), output: ref('MentoringRelationshipSchema'), contextKinds: ['profile'], ...SHARED, labelKey: 'consultations.capability.proposeMentoring' }),
  capability({ id: 'consultation.respond_mentoring', ...COMMIT('communicate', 'person_each'), input: ref('RespondMentoringCommandSchema'), output: ref('MentoringRelationshipSchema'), contextKinds: ['profile'], ...SHARED, labelKey: 'consultations.capability.respondMentoring' }),
  capability({ id: 'consultation.change_mentoring', ...COMMIT('communicate', 'person_each'), input: ref('ChangeMentoringCommandSchema'), output: ref('MentoringRelationshipSchema'), contextKinds: ['profile'], ...SHARED, labelKey: 'consultations.capability.changeMentoring' }),
];

export const CONSULTATION_MANIFEST: AgentModuleManifest = AgentModuleManifestSchema.parse({
  key: MODULE.key,
  version: MODULE.version,
  family: 'plan_to_people',
  status: 'live',
  actions: ['prepare', 'publish', 'schedule', 'communicate', 'send_quote', 'place_order', 'accept_order', 'record_evidence', 'confirm_execution'],
  capabilities: CONSULTATION_CAPABILITIES,
  meters: ['model_tokens', 'agent_actions'],
  suits: ['homeowner', 'developer', 'individual_professional', 'design_office', 'editor_author_expert', 'course_author', 'small_contractor'],
  freeFloor: [{ meter: 'agent_actions', units: '50', window: 'month' }],
  safetySuite: 'tests/consultations',
});
