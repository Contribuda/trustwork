import { z } from 'zod';
import { PartySchema } from './access.js';
import { LineKindSchema } from './catalogue.js';
import { DigestSchema } from './common/digest-schema.js';
import { AttachmentRefSchema, BusinessDateSchema, IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema, MoneySchema } from './common/money.js';
import { pickFields } from './common/projection.js';
import { DecimalSchema, QuantitySchema } from './common/quantity.js';
import { VersionNumberSchema, VersionRefSchema } from './common/version.js';

export const RfqStatusSchema = z.enum(['draft', 'published', 'closed', 'cancelled', 'expired']);
export const RfqVersionStatusSchema = z.enum(['draft', 'published', 'superseded']);
export const StaleReasonSchema = z.enum(['rfq_amended', 'rfq_closed']);
export type StaleReason = z.infer<typeof StaleReasonSchema>;

export const RfqLineSchema = z.strictObject({
  lineId: IdSchema,
  kind: LineKindSchema,
  description: ShortTextSchema,
  specification: z.record(z.string().max(100), z.string().max(2000)),
  quantity: QuantitySchema,
  alternativesAllowed: z.boolean(),
});
export type RfqLine = z.infer<typeof RfqLineSchema>;

/** Immutable once published. Budget ceilings, internal notes and evaluation weights are NOT here (see `RfqPrivateConstraint`). */
export const RfqVersionPayloadSchema = z.strictObject({
  title: NameSchema,
  lines: z.array(RfqLineSchema).min(1),
  deliveryTerms: z.strictObject({
    location: z.strictObject({ region: z.string().min(1).max(100), address: ShortTextSchema.optional() }),
    window: z.strictObject({ from: BusinessDateSchema, to: BusinessDateSchema }),
  }),
  acceptanceCriteria: TextSchema,
  paymentTermsRequested: TextSchema.nullable(),
  currency: CurrencySchema,
  responseDeadline: TimestampSchema,
  attachments: z.array(AttachmentRefSchema),
});
export type RfqVersionPayload = z.infer<typeof RfqVersionPayloadSchema>;

export const RfqSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  projectId: IdSchema.nullable(),
  creatorPersonId: IdSchema,
  status: RfqStatusSchema,
  /** Highest published version; null before first publication. */
  currentVersion: VersionNumberSchema.nullable(),
  /** Identity of the current published version row (`rfq_version_id`); staleness compares this id. */
  currentVersionId: IdSchema.nullable(),
  revision: RevisionSchema,
  publicProjection: z.strictObject({ enabled: z.boolean(), fields: z.array(z.enum(['title', 'category', 'region', 'publishedAt', 'openUntil', 'lineSummary'])) }),
  category: z.string().min(1).max(100).nullable(),
  createdAt: TimestampSchema,
}).refine((r) => (r.currentVersion === null) === (r.currentVersionId === null) && (r.status !== 'draft' || r.currentVersion === null), { message: 'currentVersion and currentVersionId are set together and only after publication', path: ['currentVersionId'] });
export type Rfq = z.infer<typeof RfqSchema>;

export const RfqVersionSchema = z.strictObject({
  id: IdSchema,
  rfqId: IdSchema,
  version: VersionNumberSchema,
  status: RfqVersionStatusSchema,
  payload: RfqVersionPayloadSchema,
  digest: DigestSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  publishedBy: IdSchema.nullable(),
  supersededBy: VersionNumberSchema.nullable(),
  amendmentReason: ShortTextSchema.nullable(),
})
  .refine((v) => v.status === 'draft' || (v.digest !== null && v.publishedAt !== null && v.publishedBy !== null), { message: 'published versions carry digest, publishedAt and publishedBy', path: ['digest'] })
  .refine((v) => v.version === 1 || v.amendmentReason !== null, { message: 'amendments require a reason', path: ['amendmentReason'] })
  .refine((v) => (v.status === 'superseded') === (v.supersededBy !== null), { message: 'superseded iff supersededBy set', path: ['supersededBy'] });
export type RfqVersion = z.infer<typeof RfqVersionSchema>;

/** Digest input of an RFQ version is the payload alone; identifiers, status, timestamps and actors are excluded. Computation: `server/commercial.ts`. */
export function rfqVersionDigestInput(payload: RfqVersionPayload) {
  return { payload: RfqVersionPayloadSchema.parse(payload) };
}
export function rfqVersionRef(version: RfqVersion): z.infer<typeof VersionRefSchema> {
  if (version.digest === null) throw new Error('draft versions have no digest');
  return VersionRefSchema.parse({ id: version.id, version: version.version, digest: version.digest });
}
/** Published versions are immutable: payload, digest, publishedAt and publishedBy may change only while status is draft. */
export function rfqVersionMutable(version: Pick<RfqVersion, 'status'>): boolean {
  return version.status === 'draft';
}

/** party_private (buyer side): separate record, separate projection, never joined into shared views. */
export const RfqPrivateConstraintSchema = z.strictObject({
  rfqId: IdSchema,
  ownerParty: PartySchema,
  budgetCeiling: MoneySchema.nullable(),
  evaluationWeights: z.record(z.string().max(100), DecimalSchema),
  internalNotes: TextSchema,
  shortlist: z.array(PartySchema),
  revision: RevisionSchema,
});
export type RfqPrivateConstraint = z.infer<typeof RfqPrivateConstraintSchema>;

export const RfqInvitationSchema = z.strictObject({
  id: IdSchema,
  rfqId: IdSchema,
  rfqVersion: VersionRefSchema,
  party: PartySchema,
  channel: z.enum(['platform', 'email', 'assistant']),
  status: z.enum(['sent', 'viewed', 'declined', 'responded', 'withdrawn']),
  staleReason: StaleReasonSchema.nullable(),
  sentAt: TimestampSchema,
  sentBy: z.strictObject({ personId: IdSchema, mandateId: IdSchema.nullable() }),
});
export type RfqInvitation = z.infer<typeof RfqInvitationSchema>;

/** Staleness is decided by `rfq_version_id` identity, never by digest equality. */
export function isInvitationStale(invitation: RfqInvitation, currentRfqVersionId: string): boolean {
  return invitation.rfqVersion.id !== currentRfqVersionId;
}

/** Owner view = envelope + private constraint; serializers below strip by layer. */
export const RfqOwnerViewSchema = z.strictObject({ rfq: RfqSchema, version: RfqVersionSchema, privateConstraint: RfqPrivateConstraintSchema, invitations: z.array(RfqInvitationSchema) });
export type RfqOwnerView = z.infer<typeof RfqOwnerViewSchema>;

export const PublicRfqSchema = z.strictObject({
  id: IdSchema,
  title: NameSchema.optional(),
  category: z.string().nullable().optional(),
  region: z.string().optional(),
  publishedAt: TimestampSchema.optional(),
  openUntil: TimestampSchema.optional(),
  lineSummary: z.array(z.strictObject({ kind: LineKindSchema, quantity: QuantitySchema })).optional(),
});
export type PublicRfq = z.infer<typeof PublicRfqSchema>;
/** Public listing: only allowlisted fields of the current published version when the owner enabled the projection. */
export function toPublicRfq(view: Pick<RfqOwnerView, 'rfq' | 'version'>): PublicRfq | null {
  const { rfq, version } = view;
  if (rfq.status !== 'published' || !rfq.publicProjection.enabled || version.status !== 'published' || version.id !== rfq.currentVersionId) return null;
  const all = {
    title: version.payload.title,
    category: rfq.category,
    region: version.payload.deliveryTerms.location.region,
    publishedAt: version.publishedAt ?? undefined,
    openUntil: version.payload.responseDeadline,
    lineSummary: version.payload.lines.map((l) => ({ kind: l.kind, quantity: l.quantity })),
  };
  return PublicRfqSchema.parse({ id: rfq.id, ...pickFields(all, rfq.publicProjection.fields) });
}
export const SharedRfqVersionSchema = z.strictObject({
  rfqId: IdSchema,
  id: IdSchema,
  version: VersionNumberSchema,
  status: RfqVersionStatusSchema,
  payload: RfqVersionPayloadSchema,
  digest: DigestSchema,
  publishedAt: TimestampSchema,
  amendmentReason: ShortTextSchema.nullable(),
});
export type SharedRfqVersion = z.infer<typeof SharedRfqVersionSchema>;
/** shared_party for invited suppliers: requirements, lines, terms, version and digest; no budget, notes, weights, shortlist or other invitations. */
export function toSharedRfqVersion(version: RfqVersion): SharedRfqVersion | null {
  if (version.status === 'draft') return null;
  return SharedRfqVersionSchema.parse(pickFields(version, ['rfqId', 'id', 'version', 'status', 'payload', 'digest', 'publishedAt', 'amendmentReason']));
}

export const PublishRfqVersionCommandSchema = z.strictObject({ rfqId: IdSchema, version: VersionNumberSchema, expectedRevision: RevisionSchema, amendmentReason: ShortTextSchema.nullable() });
export const InviteSupplierCommandSchema = z.strictObject({ rfqId: IdSchema, rfqVersionId: IdSchema, party: PartySchema, channel: RfqInvitationSchema.shape.channel });
export const CreateRfqDraftCommandSchema = z.strictObject({ owner: PartySchema, projectId: IdSchema.nullable(), payload: RfqVersionPayloadSchema });
