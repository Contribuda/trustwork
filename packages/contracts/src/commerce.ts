import { z } from 'zod';
import { PartySchema, type Party } from './access.js';
import { AgentCapabilitySchema, type AgentCapability, type CapabilityConfirmation, type CapabilityKind, type ContextKindV2, type MandateActionV2, type PrivateDataClass, type SideEffect } from './agent-catalog.js';
import { LineKindSchema, OfferingKindSchema, OfferingSchema, OfferingVersionPayloadSchema, OfferingVersionSchema, PublicOfferingVersionSchema } from './catalogue.js';
import { DigestSchema } from './common/digest-schema.js';
import { AttachmentRefSchema, BusinessDateSchema, IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema } from './common/money.js';
import { pickFields } from './common/projection.js';
import { QuantitySchema } from './common/quantity.js';
import { isKnownUnit } from './common/units.js';
import { VersionNumberSchema } from './common/version.js';
import { PlanItemKeySchema } from './plans.js';
import {
  CreateRfqDraftCommandSchema, InviteSupplierCommandSchema, PublishRfqVersionCommandSchema, RfqInvitationSchema, RfqPrivateConstraintSchema, RfqSchema, RfqVersionPayloadSchema,
  RfqVersionSchema, SharedRfqVersionSchema, type RfqVersionPayload,
} from './procurement.js';

/**
 * Commerce slice 1 (COM-001): the API and capability layer over the frozen catalogue and procurement contracts
 * (`catalogue.ts`, `procurement.ts`, which stay untouched). It adds what the frozen files do not define: needs and
 * their clarification, the request and view shapes of the catalogue, need and RFQ routes, the supplier view of an
 * invitation, the identifiers-only event payloads, and the capability registry entries (ADR 010 decision 23).
 *
 * Invariants restated here and enforced again by packages/data/migrations/commerce:
 * - a published offering version and a published RFQ version are immutable; edits open a new version;
 * - private commercial knowledge (cost basis, margin target, notes) and buyer-private constraints (budget ceiling,
 *   evaluation weights, internal notes, shortlist) are separate records and never reach another party;
 * - invitations pin the exact `rfq_version_id`; an amendment flags earlier invitations `stale_reason: rfq_amended`
 *   (a flag, never a status) and revalidation is a new invitation pinned to the current version;
 * - every quantity names a unit from the measurement-unit catalogue; lines may mix goods, works and services;
 * - payment, subscriptions and sponsorship never change listing order or invitation order (no such input exists).
 */

type OfferingVersionPayload = z.infer<typeof OfferingVersionPayloadSchema>;

/* ---------- Who acts ---------- */

/** A person acts on their own authority; their agent only under a structured mandate (checked by the API's mandate port). */
export const CommerceActorInputSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
export type CommerceActorInput = z.infer<typeof CommerceActorInputSchema>;

const knownUnit = (q: { unit: string } | null) => q === null || isKnownUnit(q.unit);
/** Every quantity of an RFQ payload names a catalogue unit; lines of different kinds may be mixed freely. */
export const RfqPayloadWithKnownUnitsSchema = RfqVersionPayloadSchema.refine((p) => p.lines.every((l) => knownUnit(l.quantity)), { message: 'every line quantity names a unit from the measurement-unit catalogue', path: ['lines'] })
  .refine((p) => new Set(p.lines.map((l) => l.lineId)).size === p.lines.length, { message: 'line ids are distinct', path: ['lines'] })
  .refine((p) => p.deliveryTerms.window.from.date <= p.deliveryTerms.window.to.date, { message: 'the delivery window ends after it starts', path: ['deliveryTerms', 'window'] });

/* ---------- Catalogue (offerings) ---------- */

export const OFFERING_PUBLIC_FIELDS = ['title', 'description', 'specification', 'unit', 'listPrice', 'options', 'availability'] as const;
export const OfferingPublicFieldSchema = z.enum(OFFERING_PUBLIC_FIELDS);
export const OfferingPrivateKnowledgeSchema = OfferingVersionSchema.shape.privateKnowledge;
export type OfferingPrivateKnowledge = z.infer<typeof OfferingPrivateKnowledgeSchema>;

/** A draft as the owner edits it. Bundles list exact published component versions; other kinds list none. */
export const OfferingDraftInputSchema = z.strictObject({
  payload: OfferingVersionPayloadSchema,
  publicFields: z.array(OfferingPublicFieldSchema).max(OFFERING_PUBLIC_FIELDS.length),
  privateKnowledge: OfferingPrivateKnowledgeSchema,
})
  .refine((d) => new Set(d.publicFields).size === d.publicFields.length, { message: 'public fields are distinct', path: ['publicFields'] })
  .refine((d) => isKnownUnit(d.payload.unit) && d.payload.components.every((c) => knownUnit(c.quantity)) && knownUnit(d.payload.availability.capacity), { message: 'units come from the measurement-unit catalogue', path: ['payload', 'unit'] })
  .refine((d) => {
    const currency = d.payload.listPrice?.currency ?? null;
    return d.payload.options.every((o) => currency === null || o.priceDelta.currency === currency);
  }, { message: 'option price deltas use the list price currency', path: ['payload', 'options'] });
export type OfferingDraftInput = z.infer<typeof OfferingDraftInputSchema>;

/** Kind and components must agree: a bundle has at least one component, other kinds have none. */
export function offeringDraftViolations(kind: z.infer<typeof OfferingKindSchema>, draft: Pick<OfferingDraftInput, 'payload'>): string[] {
  const out: string[] = [];
  if (kind === 'bundle' && draft.payload.components.length === 0) out.push('a bundle lists at least one component');
  if (kind !== 'bundle' && draft.payload.components.length > 0) out.push('only a bundle lists components');
  const seen = new Set<string>();
  for (const c of draft.payload.components) {
    const key = `${c.offeringId}@${c.version}`;
    if (seen.has(key)) out.push(`component ${key} is listed twice`);
    seen.add(key);
  }
  return out;
}

export const CreateOfferingCommandSchema = z.strictObject({ owner: PartySchema, kind: OfferingKindSchema, draft: OfferingDraftInputSchema, actor: CommerceActorInputSchema });
/** `expectedRevision` is the offering envelope revision: every change of the aggregate bumps it. */
export const SaveOfferingDraftCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, draft: OfferingDraftInputSchema, actor: CommerceActorInputSchema });
export const OpenOfferingDraftCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, actor: CommerceActorInputSchema });
export const PublishOfferingVersionCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, actor: CommerceActorInputSchema });
export const SetOfferingPrivateKnowledgeCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, privateKnowledge: OfferingPrivateKnowledgeSchema });
export const ArchiveOfferingCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema });

/** The frozen `OfferingVersion` plus its row identity and digest (`trustwork-digest-1` over `{ payload }`, set at publication). */
export const OwnerOfferingVersionSchema = OfferingVersionSchema.extend({ id: IdSchema, digest: DigestSchema.nullable() });
export type OwnerOfferingVersion = z.infer<typeof OwnerOfferingVersionSchema>;
export const OwnerOfferingViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  offering: OfferingSchema.extend({ currentVersionId: IdSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema }),
  versions: z.array(OwnerOfferingVersionSchema),
});
export type OwnerOfferingView = z.infer<typeof OwnerOfferingViewSchema>;
/** Digest input of an offering version: the payload alone (components included). */
export function offeringVersionDigestInput(payload: OfferingVersionPayload) {
  return { payload: OfferingVersionPayloadSchema.parse(payload) };
}

/** Public catalogue entry: owner, kind and only the allowlisted fields of one published version. */
export const PublicOfferingSchema = PublicOfferingVersionSchema.extend({ owner: PartySchema, kind: OfferingKindSchema, publishedAt: TimestampSchema, current: z.boolean() });
export type PublicOffering = z.infer<typeof PublicOfferingSchema>;
export const PublicCatalogueSchema = z.strictObject({ owner: PartySchema, offerings: z.array(PublicOfferingSchema) });
export const PublicCatalogueQuerySchema = z.strictObject({ ownerKind: z.enum(['person', 'company']), ownerId: IdSchema });

/**
 * Public listing order: newest publication first, then by offering id. The input has no entitlement, subscription,
 * sponsorship or payment field, so payment cannot reorder a catalogue (model invariant 10).
 */
export function orderPublicOfferings<T extends { offeringId: string; publishedAt: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.publishedAt === b.publishedAt ? (a.offeringId < b.offeringId ? -1 : a.offeringId > b.offeringId ? 1 : 0) : a.publishedAt < b.publishedAt ? 1 : -1));
}

/**
 * Embedded snapshot a quote line keeps when it cites a catalogue offering (R06): the specification is copied and the
 * version is provenance only. Later catalogue versions never rewrite a snapshot that was taken (COM-002 uses this).
 */
export const OfferingQuoteSnapshotSchema = z.strictObject({
  kind: LineKindSchema,
  specSnapshot: z.record(z.string().max(100), z.string().max(2000)),
  unit: z.string(),
  offeringVersionRef: z.strictObject({ offeringId: IdSchema, version: VersionNumberSchema }),
});
export function offeringQuoteSnapshot(offering: { kind: z.infer<typeof OfferingKindSchema> }, version: Pick<OwnerOfferingVersion, 'offeringId' | 'version' | 'status' | 'payload'>, kind: z.infer<typeof LineKindSchema>): z.infer<typeof OfferingQuoteSnapshotSchema> {
  if (version.status === 'draft') throw new Error('only published offering versions can be cited');
  if (offering.kind !== 'bundle' && offering.kind !== kind) throw new Error('the line kind matches the offering kind');
  return OfferingQuoteSnapshotSchema.parse({ kind, specSnapshot: structuredClone(version.payload.specification), unit: version.payload.unit, offeringVersionRef: { offeringId: version.offeringId, version: version.version } });
}

/* ---------- Needs: from a vague request to a clear one ---------- */

export const NeedSourceSchema = z.enum(['manual', 'file', 'email', 'assistant']);
export const NeedStatusSchema = z.enum(['draft', 'clarifying', 'ready', 'converted']);
export type NeedStatus = z.infer<typeof NeedStatusSchema>;
/** Where a line was extracted from (a cell, a sentence, a photo region). Evidence only: it never grants authority. */
export const ExtractionEvidenceSchema = z.strictObject({
  source: z.enum(['file', 'email', 'message', 'spreadsheet', 'photo']),
  ref: IdSchema,
  locator: z.string().min(1).max(200),
});
export const NeedLineInputSchema = z.strictObject({
  kind: LineKindSchema.nullable(),
  description: ShortTextSchema,
  quantity: QuantitySchema.nullable(),
  specification: z.record(z.string().max(100), z.string().max(2000)),
  alternativesAllowed: z.boolean(),
  evidence: ExtractionEvidenceSchema.nullable(),
}).refine((l) => knownUnit(l.quantity), { message: 'the unit comes from the measurement-unit catalogue', path: ['quantity', 'unit'] });
export type NeedLineInput = z.infer<typeof NeedLineInputSchema>;

/** A region of delivery or work: free text, or a place code that must not be a restricted place (checked server side). */
export const NeedRegionSchema = z.string().min(1).max(100);
export const NeedFieldsSchema = z.strictObject({
  title: NameSchema,
  description: TextSchema.nullable(),
  region: NeedRegionSchema.nullable(),
  window: z.strictObject({ from: BusinessDateSchema, to: BusinessDateSchema }).nullable(),
  acceptanceCriteria: z.string().overwrite((s) => s.normalize('NFC')).min(1).max(20_000).nullable(),
  lines: z.array(NeedLineInputSchema).max(200),
}).refine((f) => f.window === null || f.window.from.date <= f.window.to.date, { message: 'the window ends after it starts', path: ['window'] });
export type NeedFields = z.infer<typeof NeedFieldsSchema>;

/** What is still missing before a need can become an RFQ: scope, quantity, unit, location, schedule, acceptance. */
export function needMissingFields(fields: Pick<NeedFields, 'region' | 'window' | 'acceptanceCriteria' | 'lines'>): string[] {
  const out: string[] = [];
  if (fields.lines.length === 0) out.push('lines');
  fields.lines.forEach((line, i) => {
    if (line.kind === null) out.push(`lines.${i}.kind`);
    if (line.quantity === null) out.push(`lines.${i}.quantity`);
  });
  if (fields.region === null) out.push('region');
  if (fields.window === null) out.push('window');
  if (fields.acceptanceCriteria === null) out.push('acceptanceCriteria');
  return out;
}
/** `draft` without lines, `clarifying` while something is missing, `ready` when nothing is; `converted` is set once by conversion. */
export function needStatusFor(fields: Pick<NeedFields, 'region' | 'window' | 'acceptanceCriteria' | 'lines'>): Exclude<NeedStatus, 'converted'> {
  if (fields.lines.length === 0) return 'draft';
  return needMissingFields(fields).length === 0 ? 'ready' : 'clarifying';
}

export const CreateNeedCommandSchema = z.strictObject({ owner: PartySchema, projectId: IdSchema.nullable(), source: NeedSourceSchema, fields: NeedFieldsSchema, actor: CommerceActorInputSchema });
export const SaveNeedCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, fields: NeedFieldsSchema, actor: CommerceActorInputSchema });
export const RfqPrivateConstraintInputSchema = z.strictObject({
  budgetCeiling: RfqPrivateConstraintSchema.shape.budgetCeiling,
  evaluationWeights: RfqPrivateConstraintSchema.shape.evaluationWeights,
  internalNotes: RfqPrivateConstraintSchema.shape.internalNotes,
  shortlist: RfqPrivateConstraintSchema.shape.shortlist,
});
export type RfqPrivateConstraintInput = z.infer<typeof RfqPrivateConstraintInputSchema>;
export const EMPTY_PRIVATE_CONSTRAINT: RfqPrivateConstraintInput = { budgetCeiling: null, evaluationWeights: {}, internalNotes: '', shortlist: [] };
/** Terms the need does not carry: currency, response deadline, requested payment terms, attachments, category. */
export const ConvertNeedCommandSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  rfq: z.strictObject({
    currency: CurrencySchema,
    responseDeadline: TimestampSchema,
    paymentTermsRequested: TextSchema.nullable(),
    attachments: z.array(AttachmentRefSchema).max(50),
    category: z.string().min(1).max(100).nullable(),
  }),
  privateConstraint: RfqPrivateConstraintInputSchema.nullable(),
  actor: CommerceActorInputSchema,
});

export const NeedLineSchema = z.strictObject({
  lineId: IdSchema,
  position: z.int().min(0),
  kind: LineKindSchema.nullable(),
  description: ShortTextSchema,
  quantity: QuantitySchema.nullable(),
  specification: z.record(z.string().max(100), z.string().max(2000)),
  alternativesAllowed: z.boolean(),
  evidence: ExtractionEvidenceSchema.nullable(),
});
export type NeedLine = z.infer<typeof NeedLineSchema>;
/** Owner-private: a need is intake and never reaches another party, search, notifications or federation. */
export const NeedSchema = z.strictObject({
  projection: z.literal('owner_private'),
  id: IdSchema,
  owner: PartySchema,
  projectId: IdSchema.nullable(),
  source: NeedSourceSchema,
  status: NeedStatusSchema,
  title: NameSchema,
  description: TextSchema.nullable(),
  region: NeedRegionSchema.nullable(),
  window: z.strictObject({ from: BusinessDateSchema, to: BusinessDateSchema }).nullable(),
  acceptanceCriteria: z.string().nullable(),
  lines: z.array(NeedLineSchema),
  missingFields: z.array(z.string().max(60)),
  rfqId: IdSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Need = z.infer<typeof NeedSchema>;
export const NeedListSchema = z.strictObject({ needs: z.array(NeedSchema.omit({ lines: true })) });

/** The first RFQ version drafted from a ready need: its lines keep the need line ids, kinds, quantities and specifications. */
export function needToRfqPayload(need: Pick<Need, 'status' | 'title' | 'region' | 'window' | 'acceptanceCriteria' | 'lines'>, terms: z.infer<typeof ConvertNeedCommandSchema>['rfq']): RfqVersionPayload {
  if (need.status !== 'ready' || need.region === null || need.window === null || need.acceptanceCriteria === null) throw new Error('only a ready need converts');
  return RfqPayloadWithKnownUnitsSchema.parse({
    title: need.title,
    lines: need.lines.map((l) => ({ lineId: l.lineId, kind: l.kind, description: l.description, specification: l.specification, quantity: l.quantity, alternativesAllowed: l.alternativesAllowed })),
    deliveryTerms: { location: { region: need.region }, window: need.window },
    acceptanceCriteria: need.acceptanceCriteria,
    paymentTermsRequested: terms.paymentTermsRequested,
    currency: terms.currency,
    responseDeadline: terms.responseDeadline,
    attachments: terms.attachments,
  });
}

/* ---------- RFQs: drafts, immutable versions, invitations ---------- */

export const RFQ_PUBLIC_FIELDS = ['title', 'category', 'region', 'publishedAt', 'openUntil', 'lineSummary'] as const;
export const RfqPublicProjectionSchema = z.strictObject({ enabled: z.boolean(), fields: z.array(z.enum(RFQ_PUBLIC_FIELDS)).max(RFQ_PUBLIC_FIELDS.length) })
  .refine((p) => new Set(p.fields).size === p.fields.length, { message: 'fields are distinct', path: ['fields'] });
/** A consumer's or small owner's plan item of kind purchase or material becomes an RFQ (ADR 012 decision 37). */
export const RfqPlanItemSourceSchema = z.strictObject({ kind: z.literal('plan_item'), projectId: IdSchema, itemKey: PlanItemKeySchema });
export const PLAN_ITEM_RFQ_KINDS = ['purchase', 'material'] as const;

export const CreateRfqCommandSchema = CreateRfqDraftCommandSchema.extend({
  payload: RfqPayloadWithKnownUnitsSchema,
  category: z.string().min(1).max(100).nullable(),
  publicProjection: RfqPublicProjectionSchema,
  privateConstraint: RfqPrivateConstraintInputSchema.nullable(),
  source: RfqPlanItemSourceSchema.nullable(),
  actor: CommerceActorInputSchema,
});
/** `expectedRevision` is the RFQ envelope revision: every change of the aggregate (draft saves included) bumps it. */
export const SaveRfqDraftCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, payload: RfqPayloadWithKnownUnitsSchema, actor: CommerceActorInputSchema });
export const OpenRfqAmendmentCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, amendmentReason: ShortTextSchema, actor: CommerceActorInputSchema });
export const PublishRfqCommandSchema = PublishRfqVersionCommandSchema.extend({ actor: CommerceActorInputSchema });
export const SaveRfqPrivateConstraintCommandSchema = RfqPrivateConstraintInputSchema.extend({ expectedRevision: RevisionSchema });
export const InviteSupplierRequestSchema = InviteSupplierCommandSchema.extend({ actor: CommerceActorInputSchema });
export const RevalidateInvitationCommandSchema = z.strictObject({ actor: CommerceActorInputSchema });
/** Invitation changes are guarded by the transition table under a row lock (the frozen invitation shape carries no revision). */
export const WithdrawInvitationCommandSchema = z.strictObject({ reason: ShortTextSchema });
/** What an invited supplier may record on its own invitation; `responded` comes from sending a quote (COM-002). */
export const RespondToInvitationCommandSchema = z.strictObject({ status: z.enum(['viewed', 'declined']) });
export const CloseRfqCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, outcome: z.enum(['closed', 'cancelled']), reason: ShortTextSchema });
export const SetRfqProjectionCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, publicProjection: RfqPublicProjectionSchema, category: z.string().min(1).max(100).nullable() });

/** Invitation transitions; staleness is a separate flag and never a status. */
export const INVITATION_TRANSITIONS: Readonly<Record<z.infer<typeof RfqInvitationSchema>['status'], readonly z.infer<typeof RfqInvitationSchema>['status'][]>> = {
  sent: ['viewed', 'declined', 'responded', 'withdrawn'],
  viewed: ['declined', 'responded', 'withdrawn'],
  responded: ['withdrawn'],
  declined: [],
  withdrawn: [],
};

/** Owner side: the envelope, every version (drafts included), the buyer-private record and every invitation. */
export const OwnerRfqViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  rfq: RfqSchema,
  versions: z.array(RfqVersionSchema),
  privateConstraint: RfqPrivateConstraintSchema,
  invitations: z.array(RfqInvitationSchema),
  origin: z.strictObject({ needId: IdSchema.nullable(), planItem: z.strictObject({ projectId: IdSchema, itemKey: PlanItemKeySchema }).nullable() }),
});
export type OwnerRfqView = z.infer<typeof OwnerRfqViewSchema>;

/** An invitation as its invitee sees it: the pin, status and stale flag, never who on the buyer side sent it or under which mandate. */
export const SupplierInvitationSchema = RfqInvitationSchema.omit({ sentBy: true });
export type SupplierInvitation = z.infer<typeof SupplierInvitationSchema>;
export function toSupplierInvitation(invitation: z.infer<typeof RfqInvitationSchema>): SupplierInvitation {
  return SupplierInvitationSchema.parse(pickFields(invitation, ['id', 'rfqId', 'rfqVersion', 'party', 'channel', 'status', 'staleReason', 'sentAt']));
}

/**
 * shared_party for an invited supplier: who buys, the RFQ status, the versions its own invitations pin (shared
 * projection only) and its own invitations. Never the private constraint, other invitations, drafts, the origin or
 * versions it was not invited to.
 */
export const SupplierRfqViewSchema = z.strictObject({
  projection: z.literal('shared_party'),
  rfq: z.strictObject({ id: IdSchema, buyer: PartySchema, status: RfqSchema.shape.status, category: z.string().nullable() }),
  versions: z.array(SharedRfqVersionSchema),
  invitations: z.array(SupplierInvitationSchema),
});
export type SupplierRfqView = z.infer<typeof SupplierRfqViewSchema>;
/** Keys that must never appear in anything a supplier, the public or an outbox payload receives (forbidden-field tests). */
export const SUPPLIER_FORBIDDEN_KEYS = ['budgetCeiling', 'evaluationWeights', 'internalNotes', 'shortlist', 'privateConstraint', 'privateKnowledge', 'costBasis', 'marginTarget', 'creatorPersonId', 'origin', 'needId', 'sentBy', 'publishedBy'] as const;

export const RfqListItemSchema = z.strictObject({
  id: IdSchema, owner: PartySchema, status: RfqSchema.shape.status, title: NameSchema, currentVersion: VersionNumberSchema.nullable(), draftVersion: VersionNumberSchema.nullable(),
  category: z.string().nullable(), invitations: z.int().min(0), staleInvitations: z.int().min(0), revision: RevisionSchema, updatedAt: TimestampSchema,
});
export const RfqListSchema = z.strictObject({ rfqs: z.array(RfqListItemSchema) });
export const SupplierInvitationItemSchema = z.strictObject({
  invitation: SupplierInvitationSchema,
  rfq: z.strictObject({ id: IdSchema, buyer: PartySchema, status: RfqSchema.shape.status }),
  title: NameSchema,
  responseDeadline: TimestampSchema,
});
export const SupplierInvitationListSchema = z.strictObject({ invitations: z.array(SupplierInvitationItemSchema) });
/**
 * Invitation order for both sides: newest first, then by id. Like the catalogue order it has no payment input, so a
 * paying supplier is never listed earlier and a paying buyer's invitation is never shown first.
 */
export function orderInvitations<T extends { id: string; sentAt: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.sentAt === b.sentAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.sentAt < b.sentAt ? 1 : -1));
}

/** Whether an invited party is the buyer itself (a person never invites itself; a company never invites itself). */
export function isSelfInvitation(owner: Party, party: Party): boolean {
  return owner.kind === party.kind && owner.id === party.id;
}

/* ---------- Where commerce data may go ---------- */

/**
 * Needs, drafts and private records are owner-side only. Outbox events (the source of notifications, MAIL-001) carry
 * identifiers only; the notification consumer reads the projection under the recipient's own authority.
 */
export const COMMERCE_EVENT_PAYLOAD_KEYS = ['offeringId', 'versionId', 'version', 'needId', 'rfqId', 'invitationId', 'inviteeKind', 'inviteeId', 'status', 'staleCount', 'via', 'mandateId', 'previousInvitationId'] as const;
export const COMMERCE_EGRESS = {
  need: { search: false, retrieval: false, federation: false, publicProjection: false },
  rfqPrivateConstraint: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  offeringPrivateKnowledge: { search: false, retrieval: false, federation: false, publicProjection: false, sharedProjection: false },
  notificationPayload: 'identifiers_only',
} as const;

/** Inputs of the read capabilities (path parameters as objects, so the agent and the interface share one shape). */
export const OfferingQuerySchema = z.strictObject({ offeringId: IdSchema });
export const NeedQuerySchema = z.strictObject({ needId: IdSchema });
export const RfqQuerySchema = z.strictObject({ rfqId: IdSchema });
export const InvitationListQuerySchema = z.strictObject({});

/* ---------- Capability registry entries (ADR 010 decision 23, AGT-002 shape) ---------- */

/**
 * Every COM-001 operation, defined once for the interface, the person's agent and connections. Ids follow
 * `<agent module key>.<operation>` (ADR 012 decision 36). `sourcing_desk.draft_rfq` and `sourcing_desk.publish_rfq`
 * are declared by the procurement suite (`supply/capabilities.ts`, PRC-000) and implemented here
 * (`COMMERCE_IMPLEMENTED_SUPPLY_CAPABILITIES`); they are not declared twice.
 */
export const COMMERCE_IMPLEMENTED_SUPPLY_CAPABILITIES = { 'sourcing_desk.draft_rfq': 'POST /v1/rfqs', 'sourcing_desk.publish_rfq': 'POST /v1/rfqs/:id/publish' } as const;

export interface CommerceCapabilityEntry {
  capability: AgentCapability;
  /** API route that performs the same use case (the interface and the agent call it). */
  apiRoute: string;
}

interface Spec {
  id: string;
  kind: CapabilityKind;
  action: MandateActionV2 | null;
  confirmation?: CapabilityConfirmation;
  input: string;
  output: string;
  contexts: ContextKindV2[];
  reads: AgentCapability['reads'];
  privateData?: PrivateDataClass[];
  effects: SideEffect[];
  untrusted?: boolean;
  route: string;
}
const camel = (s: string) => s.replace(/[._]([a-z])/g, (_, ch: string) => ch.toUpperCase());
function entry(s: Spec): CommerceCapabilityEntry {
  const [moduleKey] = s.id.split('.') as [string];
  const contract = (schema: string) => ({ contract: ['RfqSchema', 'RfqVersionSchema', 'RfqInvitationSchema', 'SharedRfqVersionSchema', 'PublishRfqVersionCommandSchema', 'InviteSupplierCommandSchema'].includes(schema) ? 'procurement' : 'commerce', schema, version: 1 });
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
    budgetKind: null,
    reads: s.reads,
    privateDataClasses: s.privateData ?? [],
    sideEffects: s.effects,
    acceptsUntrustedText: s.untrusted ?? false,
    meters: s.kind === 'commit' ? ['agent_actions'] : s.kind === 'draft' ? ['model_tokens'] : [],
    surfaces: ['ui', 'agent', 'mcp'],
    status: 'live',
    labelKey: `commerce.capability.${camel(s.id)}`,
  });
  return { capability, apiRoute: s.route };
}
const OWNER: AgentCapability['reads'] = ['owner_private'];
const BUYER: AgentCapability['reads'] = ['party_private'];
const SHARED: AgentCapability['reads'] = ['shared_party'];

export const COMMERCE_CAPABILITIES: readonly CommerceCapabilityEntry[] = [
  // Catalogue
  entry({ id: 'discovery.search_catalogue', kind: 'read', action: null, input: 'PublicCatalogueQuerySchema', output: 'PublicCatalogueSchema', contexts: ['company', 'catalogue_offering'], reads: ['public'], effects: ['none'], route: 'GET /v1/catalogue' }),
  entry({ id: 'profile_keeper.get_offering', kind: 'read', action: null, input: 'OfferingQuerySchema', output: 'OwnerOfferingViewSchema', contexts: ['catalogue_offering'], reads: OWNER, effects: ['none'], route: 'GET /v1/catalogue/:id' }),
  entry({ id: 'profile_keeper.draft_offering', kind: 'draft', action: 'prepare', input: 'SaveOfferingDraftCommandSchema', output: 'OwnerOfferingViewSchema', contexts: ['company', 'catalogue_offering'], reads: OWNER, effects: ['draft_state'], untrusted: true, route: 'POST /v1/catalogue/:id/versions/:versionId' }),
  entry({ id: 'profile_keeper.set_offering_private_knowledge', kind: 'draft', action: 'prepare', input: 'SetOfferingPrivateKnowledgeCommandSchema', output: 'OwnerOfferingViewSchema', contexts: ['catalogue_offering'], reads: OWNER, privateData: ['negotiation_constraints'], effects: ['draft_state'], route: 'POST /v1/catalogue/:id/versions/:versionId/private' }),
  entry({ id: 'profile_keeper.publish_offering_version', kind: 'commit', action: 'publish', input: 'PublishOfferingVersionCommandSchema', output: 'OwnerOfferingViewSchema', contexts: ['catalogue_offering'], reads: OWNER, effects: ['state_change', 'publication'], route: 'POST /v1/catalogue/:id/versions/:versionId/publish' }),
  entry({ id: 'profile_keeper.archive_offering', kind: 'commit', action: 'maintain_profile', input: 'ArchiveOfferingCommandSchema', output: 'OwnerOfferingViewSchema', contexts: ['catalogue_offering'], reads: OWNER, effects: ['state_change', 'publication'], route: 'POST /v1/catalogue/:id/archive' }),
  // Needs
  entry({ id: 'need_intake.get_need', kind: 'read', action: null, input: 'NeedQuerySchema', output: 'NeedSchema', contexts: ['project'], reads: OWNER, privateData: ['private_projects'], effects: ['none'], route: 'GET /v1/needs/:id' }),
  entry({ id: 'need_intake.draft_need', kind: 'draft', action: 'prepare', input: 'CreateNeedCommandSchema', output: 'NeedSchema', contexts: ['project'], reads: OWNER, privateData: ['private_projects'], effects: ['draft_state'], untrusted: true, route: 'POST /v1/needs' }),
  entry({ id: 'need_intake.clarify_need', kind: 'draft', action: 'prepare', input: 'SaveNeedCommandSchema', output: 'NeedSchema', contexts: ['project'], reads: OWNER, privateData: ['private_projects'], effects: ['draft_state'], untrusted: true, route: 'POST /v1/needs/:id' }),
  entry({ id: 'need_intake.convert_need', kind: 'draft', action: 'prepare', input: 'ConvertNeedCommandSchema', output: 'OwnerRfqViewSchema', contexts: ['project', 'rfq'], reads: OWNER, privateData: ['budgets', 'negotiation_constraints'], effects: ['draft_state'], route: 'POST /v1/needs/:id/convert' }),
  // RFQs (buyer side)
  entry({ id: 'sourcing_desk.get_rfq', kind: 'read', action: null, input: 'RfqQuerySchema', output: 'OwnerRfqViewSchema', contexts: ['rfq'], reads: BUYER, privateData: ['budgets', 'negotiation_constraints'], effects: ['none'], route: 'GET /v1/rfqs/:id' }),
  entry({ id: 'sourcing_desk.save_rfq_draft', kind: 'draft', action: 'prepare', input: 'SaveRfqDraftCommandSchema', output: 'OwnerRfqViewSchema', contexts: ['rfq'], reads: BUYER, effects: ['draft_state'], untrusted: true, route: 'POST /v1/rfqs/:id/versions/:versionId' }),
  entry({ id: 'sourcing_desk.open_amendment', kind: 'draft', action: 'prepare', input: 'OpenRfqAmendmentCommandSchema', output: 'OwnerRfqViewSchema', contexts: ['rfq'], reads: BUYER, effects: ['draft_state'], route: 'POST /v1/rfqs/:id/versions' }),
  entry({ id: 'sourcing_desk.set_private_constraints', kind: 'draft', action: 'prepare', input: 'SaveRfqPrivateConstraintCommandSchema', output: 'OwnerRfqViewSchema', contexts: ['rfq'], reads: BUYER, privateData: ['budgets', 'negotiation_constraints'], effects: ['draft_state'], route: 'POST /v1/rfqs/:id/private' }),
  entry({ id: 'sourcing_desk.invite_supplier', kind: 'commit', action: 'communicate', input: 'InviteSupplierRequestSchema', output: 'RfqInvitationSchema', contexts: ['rfq'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/rfqs/:id/invitations' }),
  entry({ id: 'sourcing_desk.revalidate_invitation', kind: 'commit', action: 'communicate', input: 'RevalidateInvitationCommandSchema', output: 'RfqInvitationSchema', contexts: ['rfq'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/rfqs/:id/invitations/:invitationId/revalidate' }),
  entry({ id: 'sourcing_desk.withdraw_invitation', kind: 'commit', action: 'communicate', input: 'WithdrawInvitationCommandSchema', output: 'RfqInvitationSchema', contexts: ['rfq'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/rfqs/:id/invitations/:invitationId/withdraw' }),
  entry({ id: 'sourcing_desk.close_rfq', kind: 'commit', action: 'publish', input: 'CloseRfqCommandSchema', output: 'OwnerRfqViewSchema', contexts: ['rfq'], reads: BUYER, effects: ['state_change', 'outbound_message'], route: 'POST /v1/rfqs/:id/close' }),
  entry({ id: 'sourcing_desk.set_public_projection', kind: 'commit', action: 'publish', input: 'SetRfqProjectionCommandSchema', output: 'OwnerRfqViewSchema', contexts: ['rfq'], reads: BUYER, effects: ['state_change', 'publication'], route: 'POST /v1/rfqs/:id/projection' }),
  // Invitations (supplier side)
  entry({ id: 'quoting.list_invitations', kind: 'read', action: null, input: 'InvitationListQuerySchema', output: 'SupplierInvitationListSchema', contexts: ['rfq'], reads: SHARED, effects: ['none'], route: 'GET /v1/rfq-invitations' }),
  entry({ id: 'quoting.get_invited_rfq', kind: 'read', action: null, input: 'RfqQuerySchema', output: 'SupplierRfqViewSchema', contexts: ['rfq'], reads: SHARED, effects: ['none'], route: 'GET /v1/rfqs/:id' }),
  entry({ id: 'quoting.respond_to_invitation', kind: 'commit', action: 'communicate', input: 'RespondToInvitationCommandSchema', output: 'SupplierInvitationSchema', contexts: ['rfq'], reads: SHARED, effects: ['state_change', 'outbound_message'], route: 'POST /v1/rfq-invitations/:invitationId/respond' }),
];
