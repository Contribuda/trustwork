import { z } from 'zod';

/** PRV-001: minimal operational contracts. Country rules are not inferred from a country code. */
export const PrivacySubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), id: z.uuid() }).strict(),
  z.object({ kind: z.literal('company'), id: z.uuid() }).strict(),
]);
export const PrivacyRequestKindSchema = z.enum(['access', 'erasure', 'correction', 'objection']);
export const PrivacyRequestCommandSchema = z.object({
  subject: PrivacySubjectSchema,
  kind: PrivacyRequestKindSchema,
  country: z.string().regex(/^[A-Z]{2}$/),
  correction: z.object({ field: z.enum(['display_name', 'profile', 'sourced_record']), proposedValue: z.string().min(1).max(2000) }).strict().nullable().default(null),
}).strict().refine((r) => (r.kind === 'correction') === (r.correction !== null), { message: 'correction payload is required only for correction requests' });
export const PrivacyPreferenceCommandSchema = z.object({
  optOutSale: z.boolean(), optOutSharing: z.boolean(), limitSensitive: z.boolean(), directMarketingObjection: z.boolean(), gpc: z.boolean(),
}).strict();
export const PrivacyIdParamsSchema = z.object({ id: z.uuid() }).strict();
export const PrivacyExportCommandSchema = z.object({ subject: PrivacySubjectSchema }).strict();
export const PrivacyHoldCommandSchema = z.object({
  requestId: z.uuid(), reasonCode: z.enum(['litigation', 'statutory_retention', 'dispute_evidence']), evidenceRef: z.uuid(),
}).strict();
export const PrivacyHoldReleaseSchema = z.object({ reasonCode: z.literal('hold_resolved') }).strict();

export const PrivacyTombstoneSchema = z.object({
  version: z.literal(1), requestId: z.uuid(), subject: PrivacySubjectSchema,
  executedBy: z.uuid(), approvedBy: z.uuid(), policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  recordedAt: z.iso.datetime(), modules: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1),
  suppressionDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
}).strict().refine((r) => r.executedBy !== r.approvedBy, { message: 'erasure requires two different people' });
export type PrivacyTombstone = z.infer<typeof PrivacyTombstoneSchema>;
export type PrivacySubject = z.infer<typeof PrivacySubjectSchema>;
export type PrivacyPreferenceCommand = z.infer<typeof PrivacyPreferenceCommandSchema>;
export type PrivacyRequestCommand = z.infer<typeof PrivacyRequestCommandSchema>;

/** No production pack is supplied here. A verified pack must carry its source and reviewed values. */
export const PrivacyPolicySchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/), version: z.string().min(1).max(100),
  review: z.enum(['UNKNOWN', 'verified']), sources: z.array(z.string().url()),
  deadlineDays: z.number().int().positive().nullable(), retentionDays: z.number().int().nonnegative().nullable(),
  registryPollHours: z.number().int().positive().nullable(), registryDeadlineDays: z.number().int().positive().nullable(),
}).strict().refine((p) => p.review !== 'verified' || (p.sources.length > 0 && p.deadlineDays !== null && p.retentionDays !== null), { message: 'verified policy requires sourced deadlines and retention' });
