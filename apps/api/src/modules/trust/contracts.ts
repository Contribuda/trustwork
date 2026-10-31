import { z } from 'zod';
import { IdSchema, PartySchema, TimestampSchema } from '../../deps/contracts.js';

/**
 * Reviews, appeals and reputation snapshots (EXE-001). Beside the module because the package owns no
 * `packages/contracts` file; promoting them is integrator bookkeeping. Storage: packages/data/migrations/execution.
 *
 * Reviews are opinions, tied to a completed agreement, written by a person acting for one party about the other, once
 * per side (a correction appends); the reviewed party may respond once and may appeal, never remove. Snapshots are
 * explainable evidence summaries with a method version; there is no public numeric score (O07).
 */

const TextSchema = (max: number) => z.string().trim().min(1).max(max);
const Stars = z.int().min(1).max(5);

export const ReviewRatingsSchema = z.strictObject({ overall: Stars, timing: Stars.optional(), quality: Stars.optional(), payment: Stars.optional(), cooperation: Stars.optional() });
export type ReviewRatingsInput = z.infer<typeof ReviewRatingsSchema>;

/** No actor field: a review is the person's own statement, confirmed each time (reputation signal). */
export const SubmitReviewCommandSchema = z.strictObject({
  author: PartySchema,
  ratings: ReviewRatingsSchema,
  text: TextSchema(4000).nullable(),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).nullable(),
  /** A correction of this side's earlier review (appended; the original stays, marked corrected). */
  correctsReviewId: IdSchema.nullable(),
});
export const RespondToReviewCommandSchema = z.strictObject({ responder: PartySchema, text: TextSchema(2000) });
export const FileAppealCommandSchema = z.strictObject({
  subject: z.strictObject({ kind: z.enum(['review', 'performance_observation']), id: IdSchema }),
  reason: TextSchema(4000),
});
export const ComputeSnapshotCommandSchema = z.strictObject({ subject: PartySchema });

export const AppealStatusSchema = z.enum(['submitted', 'in_review', 'upheld', 'overturned', 'partially_overturned', 'withdrawn']);
export const ReviewViewSchema = z.strictObject({
  id: IdSchema, agreementId: IdSchema, authorSide: z.enum(['buyer', 'seller']), author: PartySchema, subject: PartySchema, ratings: ReviewRatingsSchema, text: z.string().nullable(),
  language: z.string().nullable(), correctsReviewId: IdSchema.nullable(), correctedBy: IdSchema.nullable(), appeal: AppealStatusSchema.nullable(),
  response: z.strictObject({ id: IdSchema, responder: PartySchema, text: z.string(), createdAt: TimestampSchema }).nullable(), createdAt: TimestampSchema,
});
export const AgreementReviewsViewSchema = z.strictObject({
  projection: z.literal('shared_party'), agreementId: IdSchema, side: z.enum(['buyer', 'seller']), completed: z.boolean(), reviews: z.array(ReviewViewSchema),
});
export type AgreementReviewsView = z.infer<typeof AgreementReviewsViewSchema>;
export const AppealViewSchema = z.strictObject({ id: IdSchema, subject: z.strictObject({ kind: z.enum(['review', 'performance_observation']), id: IdSchema }), status: AppealStatusSchema, filedAt: TimestampSchema });

/* ---------- Snapshot shapes ---------- */

const Status = z.enum(['ok', 'not_enough_data']);
const Count = z.int().min(0);
const Distribution = z.strictObject({ 1: Count, 2: Count, 3: Count, 4: Count, 5: Count });
const NotEnough = z.strictObject({ status: z.literal('not_enough_data') });
const MethodRef = z.strictObject({ version: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
const Timing = z.strictObject({ samples: Count, onTime: Count, late: Count, lateDays: Count, status: Status });
const Quality = z.strictObject({ samples: Count, accepted: Count, partiallyAccepted: Count, rejected: Count, status: Status });
const Defects = z.strictObject({ samples: Count, open: Count, resolved: Count, minor: Count, major: Count, critical: Count, status: Status });
const ReviewsShape = { samples: Count, overall: Distribution, timing: Distribution, quality: Distribution, payment: Distribution, cooperation: Distribution, status: Status };
const Exclusions = z.record(z.string(), Count);
export const ReputationSummarySchema = z.strictObject({
  method: MethodRef,
  facts: z.strictObject({ timing: Timing, payment: Timing, quality: Quality, defects: Defects }),
  opinions: z.strictObject({ reviews: z.strictObject({ ...ReviewsShape, withText: Count }) }),
  exclusions: Exclusions,
  unknown: z.strictObject({ obligationsWithoutRecord: Count }),
  publicScore: z.null(),
});
export const PublicReputationSummarySchema = z.strictObject({
  method: MethodRef,
  facts: z.strictObject({ timing: z.union([Timing, NotEnough]), payment: z.union([Timing, NotEnough]), quality: z.union([Quality, NotEnough]), defects: z.union([Defects, NotEnough]) }),
  opinions: z.strictObject({ reviews: z.union([z.strictObject(ReviewsShape), NotEnough]) }),
  exclusions: Exclusions,
  unknown: z.strictObject({ obligationsWithoutRecord: Count }),
  /** Always null until the owner decides weights (O07) and a method with weights is released. */
  publicScore: z.null(),
});
const ExplanationItem = z.strictObject({ id: IdSchema, counted: z.boolean(), reason: z.string().nullable(), dimension: z.string(), outcome: z.string() });
export const ReputationExplanationSchema = z.strictObject({
  observations: z.array(ExplanationItem), defects: z.array(ExplanationItem), reviews: z.array(ExplanationItem), obligationsWithoutRecord: z.array(IdSchema),
});

/** owner_private: the subject's own snapshot with the explanation behind every count. */
export const OwnSnapshotViewSchema = z.strictObject({
  projection: z.literal('owner_private'), id: IdSchema, subject: PartySchema, method: MethodRef, summary: ReputationSummarySchema, explanation: ReputationExplanationSchema,
  inputsDigest: z.string().regex(/^[a-f0-9]{64}$/), computedAt: TimestampSchema,
});
export type OwnSnapshotView = z.infer<typeof OwnSnapshotViewSchema>;
/** public: the masked summary only; never ids, evidence, counterparties or review text. */
export const PublicSnapshotViewSchema = z.strictObject({
  projection: z.literal('public'), subject: PartySchema,
  snapshot: z.strictObject({ method: MethodRef, summary: PublicReputationSummarySchema, computedAt: TimestampSchema, newerEvidence: z.boolean() }).nullable(),
});
export type PublicSnapshotView = z.infer<typeof PublicSnapshotViewSchema>;

export const TRUST_EVENT_PAYLOAD_KEYS = ['agreementId', 'reviewId', 'responseId', 'appealId', 'snapshotId', 'subjectKind', 'subjectId'] as const;
