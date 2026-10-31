import { z } from 'zod';
import { PartySchema } from './access.js';
import { LineKindSchema } from './catalogue.js';
import { DigestSchema } from './common/digest-schema.js';
import { AttachmentRefSchema, BusinessDateSchema, IdSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { addMoney, CurrencySchema, MoneySchema, sumMoney } from './common/money.js';
import { pickFields } from './common/projection.js';
import { DecimalSchema, QuantitySchema } from './common/quantity.js';
import { VersionNumberSchema, VersionRefSchema } from './common/version.js';
import { StaleReasonSchema } from './procurement.js';

export const QuoteStatusSchema = z.enum(['draft', 'sent', 'superseded', 'withdrawn', 'expired', 'accepted']);
export type QuoteStatus = z.infer<typeof QuoteStatusSchema>;
export const TaxTermSchema = z.strictObject({ kind: z.enum(['vat', 'none', 'other']), ratePercent: DecimalSchema.nullable(), included: z.boolean() });

export const QuoteLineSchema = z.strictObject({
  lineId: IdSchema,
  /** null for an unsolicited extra; comparison treats it as non-matching scope. */
  rfqLineId: IdSchema.nullable(),
  kind: LineKindSchema,
  /** Embedded snapshot; the catalogue version is provenance only and never rewrites it (R06). */
  specSnapshot: z.record(z.string().max(100), z.string().max(2000)),
  offeringVersionRef: z.strictObject({ offeringId: IdSchema, version: VersionNumberSchema }).nullable(),
  quantity: QuantitySchema,
  unitPrice: MoneySchema,
  tax: TaxTermSchema,
  taxAmount: MoneySchema,
  lineTotal: MoneySchema,
  substitution: z.strictObject({ forRfqLineId: IdSchema, reason: ShortTextSchema }).nullable(),
  options: z.array(z.strictObject({ label: ShortTextSchema, priceDelta: MoneySchema })),
});
export type QuoteLine = z.infer<typeof QuoteLineSchema>;

/** Immutable once sent. Floor prices, margins and cost basis are NOT here (see `QuotePrivateConstraint`). */
export const QuoteVersionPayloadSchema = z.strictObject({
  currency: CurrencySchema,
  lines: z.array(QuoteLineSchema).min(1),
  totals: z.strictObject({ net: MoneySchema, tax: MoneySchema, gross: MoneySchema }),
  deliveryTerms: z.strictObject({ milestones: z.array(z.strictObject({ description: ShortTextSchema, due: BusinessDateSchema })), location: ShortTextSchema }),
  paymentTerms: TextSchema,
  validity: z.strictObject({ until: TimestampSchema }),
  exclusions: z.array(ShortTextSchema),
  attachments: z.array(AttachmentRefSchema),
}).refine((p) => verifyQuoteTotals(p) === 'ok', { message: 'totals must equal the recomputed sum of lines in the payload currency', path: ['totals'] });
export type QuoteVersionPayload = z.infer<typeof QuoteVersionPayloadSchema>;

type Totals = { currency: string; lines: readonly Pick<QuoteLine, 'lineTotal' | 'taxAmount' | 'unitPrice'>[]; totals: { net: { minorUnits: string; currency: string }; tax: { minorUnits: string; currency: string }; gross: { minorUnits: string; currency: string } } };
/** Recomputes net/tax/gross from lines; mixed currencies and mismatched totals fail closed. */
export function verifyQuoteTotals(p: Totals): 'ok' | 'commercial.totals_mismatch' | 'commercial.currency_mismatch' {
  try {
    const amounts = [...p.lines.flatMap((l) => [l.lineTotal, l.taxAmount, l.unitPrice]), p.totals.net, p.totals.tax, p.totals.gross];
    if (amounts.some((m) => m.currency !== p.currency)) return 'commercial.currency_mismatch';
    const net = sumMoney(p.lines.map((l) => l.lineTotal), p.currency);
    const tax = sumMoney(p.lines.map((l) => l.taxAmount), p.currency);
    const gross = addMoney(net, tax);
    const same = (a: { minorUnits: string }, b: { minorUnits: string }) => BigInt(a.minorUnits) === BigInt(b.minorUnits);
    return same(net, p.totals.net) && same(tax, p.totals.tax) && same(gross, p.totals.gross) ? 'ok' : 'commercial.totals_mismatch';
  } catch {
    return 'commercial.currency_mismatch';
  }
}

export const QuoteSchema = z.strictObject({
  id: IdSchema,
  rfqId: IdSchema,
  seller: PartySchema,
  buyer: PartySchema,
  status: QuoteStatusSchema,
  /** Flag on top of status: the current sent version no longer answers the current RFQ version. */
  staleReason: StaleReasonSchema.nullable(),
  currentVersion: VersionNumberSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type Quote = z.infer<typeof QuoteSchema>;

export const QuoteVersionSchema = z.strictObject({
  id: IdSchema,
  quoteId: IdSchema,
  version: VersionNumberSchema,
  /** Exact RFQ version answered; frozen together with the payload at send. */
  rfqVersion: VersionRefSchema,
  status: QuoteStatusSchema,
  payload: QuoteVersionPayloadSchema,
  /** Over `{ rfqVersion, payload }`, computed at send. */
  digest: DigestSchema.nullable(),
  sentAt: TimestampSchema.nullable(),
  sentBy: z.strictObject({ personId: IdSchema, mandateId: IdSchema.nullable() }).nullable(),
  validUntil: TimestampSchema.nullable(),
  staleReason: StaleReasonSchema.nullable(),
  revalidatedFrom: VersionNumberSchema.nullable(),
})
  .refine((v) => v.status === 'draft' || (v.digest !== null && v.sentAt !== null && v.sentBy !== null && v.validUntil !== null), { message: 'sent versions carry digest, sentAt, sentBy and validUntil', path: ['digest'] })
  .refine((v) => v.status === 'draft' || v.validUntil === v.payload.validity.until, { message: 'validUntil mirrors the frozen payload validity', path: ['validUntil'] });
export type QuoteVersion = z.infer<typeof QuoteVersionSchema>;

/** Digest input `{ rfqVersion, payload }`: the RFQ pin is inside the digest so a quote cannot be re-pointed without changing it. Computation: `server/commercial.ts`. */
export function quoteVersionDigestInput(rfqVersion: z.infer<typeof VersionRefSchema>, payload: QuoteVersionPayload) {
  return { rfqVersion: VersionRefSchema.parse(rfqVersion), payload: QuoteVersionPayloadSchema.parse(payload) };
}
export function quoteVersionRef(version: QuoteVersion): z.infer<typeof VersionRefSchema> {
  if (version.digest === null) throw new Error('draft versions have no digest');
  return VersionRefSchema.parse({ id: version.id, version: version.version, digest: version.digest });
}
export function quoteVersionMutable(version: Pick<QuoteVersion, 'status'>): boolean {
  return version.status === 'draft';
}
/** Identity test: a quote is stale when its pinned RFQ version id is not the RFQ's current version id (digests play no role). */
export function isQuoteStale(rfqVersionId: string, currentRfqVersionId: string): boolean {
  return rfqVersionId !== currentRfqVersionId;
}
/** A draft may be created only against the current published RFQ version. */
export function canDraftAgainst(rfq: { status: string; currentVersionId: string | null }, rfqVersionId: string): 'ok' | 'commercial.rfq_version_not_current' {
  return rfq.status === 'published' && rfq.currentVersionId === rfqVersionId ? 'ok' : 'commercial.rfq_version_not_current';
}

/** party_private (seller side). */
export const QuotePrivateConstraintSchema = z.strictObject({
  quoteId: IdSchema,
  ownerParty: PartySchema,
  floorPrices: z.record(IdSchema, MoneySchema),
  marginTargets: z.record(IdSchema, DecimalSchema),
  costBasis: z.record(IdSchema, MoneySchema),
  negotiationNotes: TextSchema,
  revision: RevisionSchema,
});
export type QuotePrivateConstraint = z.infer<typeof QuotePrivateConstraintSchema>;

export const QuoteSellerViewSchema = z.strictObject({ quote: QuoteSchema, version: QuoteVersionSchema, privateConstraint: QuotePrivateConstraintSchema });
export type QuoteSellerView = z.infer<typeof QuoteSellerViewSchema>;

export const SharedQuoteLineSchema = QuoteLineSchema.omit({ offeringVersionRef: true });
export const SharedQuoteVersionSchema = z.strictObject({
  quoteId: IdSchema,
  id: IdSchema,
  version: VersionNumberSchema,
  rfqVersion: VersionRefSchema,
  status: QuoteStatusSchema,
  staleReason: StaleReasonSchema.nullable(),
  lines: z.array(SharedQuoteLineSchema),
  totals: QuoteVersionPayloadSchema.shape.totals,
  deliveryTerms: QuoteVersionPayloadSchema.shape.deliveryTerms,
  paymentTerms: TextSchema,
  validUntil: TimestampSchema,
  exclusions: z.array(ShortTextSchema),
  attachments: z.array(AttachmentRefSchema),
  digest: DigestSchema,
});
export type SharedQuoteVersion = z.infer<typeof SharedQuoteVersionSchema>;
/** shared_party after send: lines, prices, taxes, terms, validity, attachments, pin and digest; nothing from the private constraint and no catalogue provenance. */
export function toSharedQuoteVersion(view: Pick<QuoteSellerView, 'version'>): SharedQuoteVersion | null {
  const v = view.version;
  if (v.status === 'draft' || v.digest === null || v.validUntil === null) return null;
  return SharedQuoteVersionSchema.parse({
    ...pickFields(v, ['quoteId', 'id', 'version', 'rfqVersion', 'status', 'staleReason', 'digest', 'validUntil']),
    lines: v.payload.lines.map((l) => pickFields(l, ['lineId', 'rfqLineId', 'kind', 'specSnapshot', 'quantity', 'unitPrice', 'tax', 'taxAmount', 'lineTotal', 'substitution', 'options'])),
    totals: v.payload.totals,
    deliveryTerms: v.payload.deliveryTerms,
    paymentTerms: v.payload.paymentTerms,
    exclusions: v.payload.exclusions,
    attachments: v.payload.attachments,
  });
}
/** Quotes are never public. */
export function toPublicQuote(): null {
  return null;
}

export const SendQuoteVersionCommandSchema = z.strictObject({ quoteId: IdSchema, version: VersionNumberSchema, expectedRevision: RevisionSchema });
export const CreateQuoteDraftCommandSchema = z.strictObject({ rfqId: IdSchema, rfqVersionId: IdSchema, seller: PartySchema, payload: QuoteVersionPayloadSchema, revalidatedFrom: VersionNumberSchema.nullable() });
export const ComparisonModeSchema = z.enum(['current', 'historical']);
/** Only versions pinned to the current RFQ version are comparable; the rest appear under historical mode without ranking or totals. */
export function comparableQuoteVersions<T extends { rfqVersion: { id: string }; status: QuoteStatus }>(versions: readonly T[], currentRfqVersionId: string): { comparable: T[]; historical: T[] } {
  const comparable: T[] = [];
  const historical: T[] = [];
  for (const v of versions) (v.status === 'sent' && !isQuoteStale(v.rfqVersion.id, currentRfqVersionId) ? comparable : historical).push(v);
  return { comparable, historical };
}
