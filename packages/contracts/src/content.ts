import { z } from 'zod';
import { PartySchema } from './access.js';
import { DigestSchema } from './common/digest-schema.js';
import { IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { VersionNumberSchema } from './common/version.js';

export const PublicationFormatSchema = z.enum(['news', 'article', 'magazine_piece', 'company_post', 'personal_post']);
export const PublicationStatusSchema = z.enum(['draft', 'in_review', 'scheduled', 'published', 'corrected', 'retracted']);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;

/** Authorship credit is independent from editing rights. */
export const AuthorshipSchema = z.strictObject({
  author: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('person'), id: IdSchema }),
    z.strictObject({ kind: z.literal('company'), id: IdSchema }),
    z.strictObject({ kind: z.literal('editorial') }),
  ]),
  credit: ShortTextSchema,
  assistantAssisted: z.boolean(),
});
export const PublicationSchema = z.strictObject({
  id: IdSchema,
  format: PublicationFormatSchema,
  status: PublicationStatusSchema,
  authorship: z.array(AuthorshipSchema).min(1),
  editors: z.array(IdSchema),
  topicIds: z.array(IdSchema),
  entityLinks: z.array(z.strictObject({ party: PartySchema, relation: z.string().min(1).max(40) })),
  currentVersion: VersionNumberSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type Publication = z.infer<typeof PublicationSchema>;

export const PublicationVersionSchema = z.strictObject({
  publicationId: IdSchema,
  version: VersionNumberSchema,
  title: NameSchema,
  body: TextSchema,
  sourceRefs: z.array(z.strictObject({ uri: z.string().max(2000), sourceTime: TimestampSchema.nullable(), observedAt: TimestampSchema, license: z.string().max(100).nullable() })),
  eventTime: TimestampSchema.nullable(),
  publishedAt: TimestampSchema.nullable(),
  correctionOf: VersionNumberSchema.nullable(),
  correctionNote: ShortTextSchema.nullable(),
  contentDigest: DigestSchema,
}).refine((v) => (v.correctionOf === null) === (v.correctionNote === null), { message: 'a correction carries a note', path: ['correctionNote'] });
export type PublicationVersion = z.infer<typeof PublicationVersionSchema>;

const PUBLICATION_TRANSITIONS: Record<PublicationStatus, readonly PublicationStatus[]> = {
  draft: ['in_review', 'scheduled', 'published'],
  in_review: ['draft', 'scheduled', 'published'],
  scheduled: ['draft', 'published'],
  published: ['corrected', 'retracted'],
  corrected: ['corrected', 'retracted'],
  retracted: [],
};
export function publicationTransitionAllowed(from: PublicationStatus, to: PublicationStatus): boolean {
  return PUBLICATION_TRANSITIONS[from].includes(to);
}

export const IssueStatusSchema = z.enum(['draft', 'curated', 'review', 'released', 'corrected']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export const IssueItemSchema = z.strictObject({ position: z.int().min(1), publicationId: IdSchema, publicationVersion: VersionNumberSchema, section: ShortTextSchema });
export const IssueSchema = z.strictObject({
  id: IdSchema,
  number: z.int().min(1),
  date: z.iso.date(),
  status: IssueStatusSchema,
  edition: z.int().min(1),
  items: z.array(IssueItemSchema),
  renderArtifacts: z.array(z.strictObject({ format: z.enum(['web', 'pdf']), hash: z.string().min(1), sourceEdition: z.int().min(1) })),
  revision: RevisionSchema,
}).refine((i) => new Set(i.items.map((x) => x.position)).size === i.items.length, { message: 'positions are unique', path: ['items'] });
export type Issue = z.infer<typeof IssueSchema>;
const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = { draft: ['curated'], curated: ['review', 'draft'], review: ['released', 'curated'], released: ['corrected'], corrected: ['corrected'] };
export function issueTransitionAllowed(from: IssueStatus, to: IssueStatus): boolean {
  return ISSUE_TRANSITIONS[from].includes(to);
}
/** Released items are frozen; a correction is a new edition, never an in-place edit. */
export function issueItemsFrozen(issue: Pick<Issue, 'status'>): boolean {
  return issue.status === 'released' || issue.status === 'corrected';
}
export const CorrectionSchema = z.strictObject({
  id: IdSchema,
  subject: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('publication'), id: IdSchema, fromVersion: VersionNumberSchema, toVersion: VersionNumberSchema }),
    z.strictObject({ kind: z.literal('issue'), id: IdSchema, fromEdition: z.int().min(1), toEdition: z.int().min(1) }),
  ]),
  reason: ShortTextSchema,
  correctedBy: IdSchema,
  correctedAt: TimestampSchema,
});
export type Correction = z.infer<typeof CorrectionSchema>;
