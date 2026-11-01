import { ArticleFormatSchema, TreatmentSchema, LicenceSchema, SourceKindSchema, ContentSourceViewSchema as SourceViewSchema, PublicPublicationSchema, PublicVersionViewSchema, FeedSchema, PublicIssueSchema, ArchiveSchema, WallSchema, CommentsSchema, PublicDigestSchema, type PublicPublication } from '../../../../../packages/contracts/src/content-reader.js';
export { ArticleFormatSchema, TreatmentSchema, LicenceSchema, SourceKindSchema, SourceViewSchema, PublicPublicationSchema, PublicVersionViewSchema, FeedSchema, PublicIssueSchema, ArchiveSchema, WallSchema, CommentsSchema, PublicDigestSchema, type PublicPublication };
import { z } from 'zod';
import {
  AllowedUsesSchema, AuthorshipSchema, consoleCommand, CorrectionSchema, IdSchema, NameSchema, PartySchema, PublicationFormatSchema, PublicationSchema,
  PublicationStatusSchema, PublicationVersionSchema, ShortTextSchema, TextSchema, TimestampSchema,
} from '../../deps/contracts.js';

/**
 * Request and view schemas of the content API (CNT-001). The frozen content contracts (`PublicationSchema`,
 * `PublicationVersionSchema`, `IssueSchema`, `CorrectionSchema`) are reused unchanged; what they do not carry (the cited
 * source's name, kind and licence flags, drafts, the public projection) is added here as strict schemas. Strict objects
 * reject unknown fields, so no view can carry a readership count, a price or a paywall flag, and no command can smuggle
 * one in.
 */
const Uuid = z.uuid();
const Language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, 'BCP 47 language tag');
const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Revision = z.int().min(1);
const TopicCode = z.string().regex(/^[a-z]+(\.[a-z0-9_]+)*$/).max(200);
/**
 * A cited source: the contract's `{ uri, sourceTime, observedAt, license }` plus the name and type shown to readers and
 * the licence's allowed uses (hub-console `AllowedUsesSchema`). Own reporting carries no third-party licence.
 */
export const SourceRefInputSchema = z.strictObject({
  uri: z.url().max(2000),
  name: NameSchema,
  kind: SourceKindSchema,
  sourceTime: TimestampSchema.nullable(),
  observedAt: TimestampSchema,
  license: z.string().min(1).max(100).nullable(),
  allowedUses: AllowedUsesSchema.optional(),
}).refine((s) => s.kind === 'own_reporting' || (s.license !== null && s.allowedUses !== undefined), { message: 'a third-party source names its licence and allowed uses', path: ['license'] });
export type SourceRefInput = z.infer<typeof SourceRefInputSchema>;

export const DraftSchema = z.strictObject({
  title: NameSchema,
  body: TextSchema,
  language: Language,
  sourceRefs: z.array(SourceRefInputSchema).max(50),
  treatment: TreatmentSchema,
  eventTime: TimestampSchema.nullable(),
  assistantAssisted: z.boolean(),
});
export type DraftBody = z.infer<typeof DraftSchema>;
export const AuthorshipInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), id: Uuid, credit: ShortTextSchema, assistantAssisted: z.boolean() }),
  z.strictObject({ kind: z.literal('company'), id: Uuid, credit: ShortTextSchema, assistantAssisted: z.boolean() }),
  z.strictObject({ kind: z.literal('editorial'), credit: ShortTextSchema, assistantAssisted: z.boolean() }),
]);
/** Staff acting on a publication (editorial office, reviewers, link fixes): the reason recorded in the staff audit. */
export const StaffActSchema = z.strictObject({ reason: ShortTextSchema, reasonCode: ReasonCode.optional() });
const staff = { staff: StaffActSchema.optional() };

export const CreatePublicationCommandSchema = z.strictObject({
  owner: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('person') }), z.strictObject({ kind: z.literal('company'), id: Uuid }), z.strictObject({ kind: z.literal('editorial') })]),
  format: PublicationFormatSchema,
  articleFormat: ArticleFormatSchema.nullable(),
  originalLanguage: Language,
  licence: LicenceSchema,
  draft: DraftSchema,
  authorship: z.array(AuthorshipInputSchema).min(1).max(20),
  ...staff,
}).refine((c) => c.draft.language === c.originalLanguage, { message: 'the first version is written in the original language', path: ['draft', 'language'] });
export const SaveDraftCommandSchema = z.strictObject({ expectedRevision: Revision, draft: DraftSchema.nullable(), authorship: z.array(AuthorshipInputSchema).min(1).max(20).nullable(), ...staff });
export const RevisionCommandSchema = z.strictObject({ expectedRevision: Revision, ...staff });
export const PublishCommandSchema = z.strictObject({ expectedRevision: Revision, scheduledFor: TimestampSchema.nullable(), ...staff });
export const CorrectCommandSchema = z.strictObject({ expectedRevision: Revision, draft: DraftSchema, note: ShortTextSchema, reason: ShortTextSchema, ...staff });
export const RetractCommandSchema = z.strictObject({ expectedRevision: Revision, note: ShortTextSchema, ...staff });
export const SetLinksCommandSchema = z.strictObject({
  expectedRevision: Revision,
  topics: z.array(TopicCode).max(20).nullable(),
  entityLinks: z.array(z.strictObject({ party: z.strictObject({ kind: z.enum(['person', 'company']), id: Uuid }), relation: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) })).max(50).nullable(),
  ...staff,
});
export const GrantEditorCommandSchema = z.strictObject({ personId: Uuid, rights: z.enum(['edit', 'publish']) });
export const EmptyCommandSchema = z.strictObject({});
export const LinkEditionCommandSchema = z.strictObject({ translationId: Uuid, machineAssisted: z.boolean(), ...staff });
export const ReviewEditionCommandSchema = z.strictObject({ ...staff });
export const CommentCommandSchema = z.strictObject({ parentId: Uuid.nullable(), body: z.string().min(1).max(4000) });
export const AddWallCommandSchema = z.strictObject({
  wall: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('person') }), z.strictObject({ kind: z.literal('company'), id: Uuid })]),
  publicationId: Uuid,
  /** null follows the current version. */
  publicationVersion: z.int().min(1).nullable(),
  pinned: z.boolean(),
});

/* ---------- Staff (console) commands: contract version, idempotency key equal to the header, reason ---------- */
const command = <T extends z.ZodRawShape>(shape: T) => consoleCommand({ reasonCode: ReasonCode.optional(), ...shape });
const IssueItemInputSchema = z.strictObject({ position: z.int().min(1).max(500), section: ShortTextSchema, publicationId: Uuid, publicationVersion: z.int().min(1) });
export const CreateIssueCommandSchema = command({ number: z.int().min(1), date: z.iso.date(), theme: NameSchema.nullable(), coverAssetId: Uuid.nullable(), editorLetterPublicationId: Uuid.nullable() });
export const CurateIssueCommandSchema = command({
  expectedRevision: Revision, items: z.array(IssueItemInputSchema).max(500).nullable(), theme: NameSchema.nullable(), coverAssetId: Uuid.nullable(), editorLetterPublicationId: Uuid.nullable(),
}).refine((c) => !c.items || new Set(c.items.map((i) => i.position)).size === c.items.length, { message: 'positions are unique', path: ['items'] });
export const IssueStatusCommandSchema = command({ expectedRevision: Revision, status: z.enum(['draft', 'curated', 'review']) });
export const IssueRevisionCommandSchema = command({ expectedRevision: Revision });
export const CorrectIssueCommandSchema = command({ expectedRevision: Revision, note: ShortTextSchema });
export const RequestRenderCommandSchema = command({ edition: z.int().min(1), format: z.enum(['web', 'pdf']) });
export const RecordRenderCommandSchema = command({
  outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('rendered'), artifactId: Uuid.nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/), rendererVersion: z.string().min(1).max(60) }),
    z.strictObject({ status: z.literal('failed'), failureReason: ShortTextSchema }),
  ]),
});
export const CreateDigestCommandSchema = command({ title: NameSchema, period: z.string().regex(/^[0-9]{4}(-[0-9]{2}){0,2}$|^[0-9]{4}-W[0-9]{2}$/), publicationIds: z.array(Uuid).min(1).max(200) });
export const DigestReleaseCommandSchema = command({ expectedRevision: Revision });

/* ---------- Queries and params ---------- */
export const IdParams = z.strictObject({ id: Uuid });
export const EditorParams = z.strictObject({ id: Uuid, personId: Uuid });
export const VersionParams = z.strictObject({ id: Uuid, version: z.coerce.number().int().min(1) });
export const IssueNumberParams = z.strictObject({ number: z.coerce.number().int().min(1) });
export const WallParams = z.strictObject({ kind: z.enum(['person', 'company']), id: Uuid });
export const FeedQuerySchema = z.strictObject({
  format: PublicationFormatSchema.optional(), topic: TopicCode.optional(), before: TimestampSchema.optional(), beforeId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const IssueQuerySchema = z.strictObject({ edition: z.coerce.number().int().min(1).optional() });
export const ArchiveQuerySchema = z.strictObject({ year: z.coerce.number().int().min(2000).max(2200).optional() });
export const BoardQuerySchema = z.strictObject({ status: PublicationStatusSchema.optional() });

/* ---------- Views ---------- */
const Iso = TimestampSchema;
export const DraftViewSchema = z.strictObject({
  version: z.int().min(1), title: z.string(), body: z.string(), language: Language, sources: z.array(SourceViewSchema), treatment: TreatmentSchema, eventTime: Iso.nullable(),
  assistantAssisted: z.boolean(), draftedBy: IdSchema, updatedAt: Iso,
});
export const ManagedVersionSchema = z.strictObject({
  contract: PublicationVersionSchema, language: Language, treatment: TreatmentSchema, sources: z.array(SourceViewSchema), assistantAssisted: z.boolean(), publishedBy: IdSchema,
});
export const ManagePublicationViewSchema = z.strictObject({
  projection: z.literal('working'),
  publication: PublicationSchema,
  ownerKind: z.enum(['person', 'company', 'editorial']),
  owner: PartySchema.nullable(),
  articleFormat: ArticleFormatSchema.nullable(),
  originalLanguage: Language,
  licence: LicenceSchema,
  requiresReview: z.boolean(),
  scheduledFor: Iso.nullable(),
  firstPublishedAt: Iso.nullable(),
  moderation: z.enum(['none', 'held', 'removed']),
  retraction: z.strictObject({ note: z.string(), retractedAt: Iso }).nullable(),
  myRight: z.enum(['owner', 'publish', 'edit', 'staff']),
  draft: DraftViewSchema.nullable(),
  versions: z.array(ManagedVersionSchema),
  corrections: z.array(CorrectionSchema),
  editorRights: z.array(z.strictObject({ personId: IdSchema, rights: z.enum(['edit', 'publish']), grantedAt: Iso })),
  editions: z.array(z.strictObject({ id: IdSchema, originalId: IdSchema, translationId: IdSchema, language: Language, machineAssisted: z.boolean(), reviewed: z.boolean() })),
});
export type ManagePublicationView = z.infer<typeof ManagePublicationViewSchema>;
export const PublicationListSchema = z.strictObject({ items: z.array(PublicationSchema) });

/* Staff views */
export const StaffIssueViewSchema = z.strictObject({
  projection: z.literal('staff'),
  issue: z.strictObject({
    id: IdSchema, hubId: IdSchema, number: z.int(), date: z.iso.date(), theme: z.string().nullable(), status: z.enum(['draft', 'curated', 'review', 'released', 'corrected']),
    currentEdition: z.int().nullable(), coverAssetId: IdSchema.nullable(), editorLetterPublicationId: IdSchema.nullable(), revision: Revision,
  }),
  revisions: z.array(z.strictObject({
    id: IdSchema, edition: z.int(), status: z.enum(['draft', 'released']), digest: z.string().nullable(), correctionNote: z.string().nullable(), releasedAt: Iso.nullable(),
    items: z.array(z.strictObject({ position: z.int(), section: z.string(), publicationId: IdSchema, publicationVersion: z.int() })),
    renders: z.array(z.strictObject({ id: IdSchema, format: z.enum(['web', 'pdf']), status: z.enum(['queued', 'rendered', 'failed']), sha256: z.string().nullable(),
      rendererVersion: z.string().nullable(), failureReason: z.string().nullable() })),
  })),
});
export const StaffDigestViewSchema = z.strictObject({
  projection: z.literal('staff'),
  digest: z.strictObject({ id: IdSchema, title: z.string(), period: z.string(), status: z.enum(['draft', 'released']), releasedAt: Iso.nullable(), revision: Revision }),
  items: z.array(z.strictObject({ position: z.int(), homeNode: z.string(), globalId: z.string(), version: z.int(), licence: LicenceSchema, display: z.enum(['full', 'headline_link']), title: z.string() })),
});
export { AuthorshipSchema };
