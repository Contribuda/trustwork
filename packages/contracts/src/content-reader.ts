import { z } from 'zod';
import { PublicProvenanceSchema } from './provenance.js';
import { PartySchema } from './access.js';
import { DigestSchema } from './common/digest-schema.js';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { IssueSchema, PublicationFormatSchema } from './content.js';
import { AllowedUsesSchema } from './hub.js';

/** Existing CNT-001 public wire schemas, shared unchanged with the reader and worker (CNT-003). */
const Language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/);
const Iso = TimestampSchema;
export const ArticleFormatSchema = z.enum(['analysis', 'practice', 'overview', 'experience', 'interview', 'project_story']);
export const TreatmentSchema = z.enum(['headline_link', 'summary', 'rewrite', 'translation', 'original_reporting']);
export const LicenceSchema = z.enum(['all_rights', 'cc_by']);
/** Source types a reader sees next to a news item. */
export const SourceKindSchema = z.enum(['industry_media', 'press_release', 'official_register', 'procurement_notice', 'standards_body', 'statistics', 'company_statement', 'own_reporting', 'other']);

export const ContentSourceViewSchema = z.strictObject({
  uri: z.string().max(2000), name: z.string(), kind: SourceKindSchema, sourceTime: Iso.nullable(), observedAt: Iso, license: z.string().nullable(), allowedUses: AllowedUsesSchema.nullable(),
});
export const PublicVersionSchema = z.strictObject({
  version: z.int().min(1), title: z.string(), body: z.string().nullable(), language: Language, sourceRefs: z.array(ContentSourceViewSchema), treatment: TreatmentSchema,
  eventTime: Iso.nullable(), publishedAt: Iso, correctionOf: z.int().min(1).nullable(), correctionNote: z.string().nullable(), contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  assistantAssisted: z.boolean(), provenance: PublicProvenanceSchema.optional(),
});
/** The public projection of a publication: identical for every caller; no counts of readers, no prices, no paywall. */
export const PublicPublicationSchema = z.strictObject({
  projection: z.literal('public'),
  id: IdSchema,
  format: PublicationFormatSchema,
  articleFormat: ArticleFormatSchema.nullable(),
  status: z.enum(['published', 'corrected', 'retracted']),
  originalLanguage: Language,
  licence: LicenceSchema,
  firstPublishedAt: Iso,
  owner: z.strictObject({ kind: z.enum(['person', 'company', 'editorial']), id: IdSchema.nullable() }),
  authorship: z.array(z.strictObject({ kind: z.enum(['person', 'company', 'editorial']), id: IdSchema.nullable(), credit: z.string(), assistantAssisted: z.boolean() })),
  topics: z.array(z.string()),
  entityLinks: z.array(z.strictObject({ party: PartySchema, relation: z.string() })),
  current: PublicVersionSchema,
  versions: z.array(z.strictObject({ version: z.int().min(1), publishedAt: Iso, correctionOf: z.int().nullable(), correctionNote: z.string().nullable() })),
  corrections: z.array(z.strictObject({ fromVersion: z.int(), toVersion: z.int(), reason: z.string(), correctedAt: Iso })),
  retraction: z.strictObject({ note: z.string(), retractedAt: Iso }).nullable(),
  editions: z.array(z.strictObject({ publicationId: IdSchema, language: Language, role: z.enum(['original', 'translation']), machineAssisted: z.boolean(), reviewed: z.boolean() })),
});
export type PublicPublication = z.infer<typeof PublicPublicationSchema>;
export const PublicVersionViewSchema = PublicVersionSchema.extend({ projection: z.literal('public'), publicationId: IdSchema });
export const FeedSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: IdSchema, format: PublicationFormatSchema, articleFormat: ArticleFormatSchema.nullable(), status: z.enum(['published', 'corrected', 'retracted']), firstPublishedAt: Iso, title: z.string(),
    eventTime: Iso.nullable(), currentVersion: z.int().min(1), corrected: z.boolean(), retracted: z.boolean(),
    provenance: PublicProvenanceSchema.optional(), sources: z.array(z.strictObject({ name: z.string(), kind: SourceKindSchema, uri: z.string() })), topics: z.array(z.string()), credits: z.array(z.string()),
  })),
  next: z.strictObject({ before: Iso, beforeId: IdSchema }).nullable(),
});
const PublicIssueItemSchema = z.union([
  z.strictObject({
    position: z.int(), section: z.string(), publicationId: IdSchema, publicationVersion: z.int(), withheld: z.literal(false), title: z.string(), format: PublicationFormatSchema,
    provenance: PublicProvenanceSchema.optional(), articleFormat: ArticleFormatSchema.nullable(), currentVersion: z.int(), corrected: z.boolean(), retracted: z.boolean(),
  }),
  z.strictObject({ position: z.int(), section: z.string(), publicationId: IdSchema, publicationVersion: z.int(), withheld: z.literal(true) }),
]);
/** A released edition; `issue` is the frozen contract shape, the rest is what a reader needs around it. */
export const PublicIssueSchema = z.strictObject({
  projection: z.literal('public'),
  issue: IssueSchema,
  theme: z.string().nullable(),
  coverAssetId: IdSchema.nullable(),
  editorLetterPublicationId: IdSchema.nullable(),
  currentEdition: z.int().min(1),
  digest: DigestSchema,
  releasedAt: Iso,
  correctionNote: z.string().nullable(),
  items: z.array(PublicIssueItemSchema),
  corrections: z.array(z.strictObject({ fromEdition: z.int(), toEdition: z.int(), reason: z.string(), correctedAt: Iso })),
});
export const ArchiveSchema = z.strictObject({
  issues: z.array(z.strictObject({ id: IdSchema, number: z.int(), date: z.iso.date(), theme: z.string().nullable(), status: z.enum(['released', 'corrected']), currentEdition: z.int(),
    coverAssetId: IdSchema.nullable(), items: z.int() })),
});
export const WallSchema = z.strictObject({
  owner: PartySchema,
  items: z.array(z.strictObject({
    id: IdSchema, publicationId: IdSchema, pinned: z.boolean(), position: z.int(), version: z.int(), followsCurrent: z.boolean(), title: z.string(), format: PublicationFormatSchema,
    provenance: PublicProvenanceSchema.optional(), currentVersion: z.int(), corrected: z.boolean(), retracted: z.boolean(), correctionNote: z.string().nullable(),
  })),
});
export const CommentsSchema = z.strictObject({
  items: z.array(z.strictObject({ id: IdSchema, parentId: IdSchema.nullable(), authorId: IdSchema, body: z.string(), createdAt: Iso })),
});
export const PublicDigestSchema = z.strictObject({
  projection: z.literal('public'),
  id: IdSchema, title: z.string(), period: z.string(), releasedAt: Iso,
  items: z.array(z.union([
    z.strictObject({ position: z.int(), homeNode: z.string(), globalId: z.string(), version: z.int(), licence: LicenceSchema, display: z.enum(['full', 'headline_link']), title: z.string(),
      provenance: PublicProvenanceSchema.optional(), body: z.string().nullable(), withheld: z.literal(false) }),
    z.strictObject({ position: z.int(), homeNode: z.string(), globalId: z.string(), version: z.int(), withheld: z.literal(true) }),
  ])),
});
