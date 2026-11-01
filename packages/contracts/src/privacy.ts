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

/** Suppression never proves identity, discloses a match, or authorizes erasure. */
export const PrivacyMarketingObjectionSchema = z.object({ address: z.email().max(320) }).strict();
export const PrivacyRegistryEntrySchema = z.object({
  externalRef: z.string().min(1).max(128), contactDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const PrivacyRegistryBatchSchema = z.array(PrivacyRegistryEntrySchema).max(100);
export const PrivacySourceProofSchema = z.object({
  sourceFieldId: z.uuid(), grantId: z.uuid(), action: z.enum(['correction', 'erasure', 'objection']),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  method: z.enum(['signed_statement', 'record_control', 'verified_representative']), evidenceRef: z.uuid(),
}).strict();
export const PrivacySourceSubmissionSchema = z.object({
  proof: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['correction', 'erasure', 'objection']),
  proposedValue: z.string().min(1).max(2000).nullable().default(null),
}).strict().refine((r) => (r.action === 'correction') === (r.proposedValue !== null));
export const PrivacyPlanProposeSchema = z.object({ requestId: z.uuid(), grantId: z.uuid() }).strict();
export const PrivacyPlanApproveSchema = z.object({ grantId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const PrivacyPlanExecuteSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** No production pack is supplied here. A verified pack must carry its source and reviewed values. */
export const PrivacyPolicySchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/), version: z.string().min(1).max(100),
  review: z.enum(['UNKNOWN', 'verified']), sources: z.array(z.string().url()),
  deadlineDays: z.number().int().positive().nullable(), retentionDays: z.number().int().nonnegative().nullable(),
  registryPollHours: z.number().int().positive().nullable(), registryDeadlineDays: z.number().int().positive().nullable(),
}).strict().refine((p) => p.review !== 'verified' || (p.sources.length > 0 && p.deadlineDays !== null && p.retentionDays !== null), { message: 'verified policy requires sourced deadlines and retention' });

/** Internal delivery instruction; the owning adapter must resolve real index/federation identifiers and revisions. */
export const PrivacyPropagationSchema = z.object({
  version: z.literal(1), id: z.uuid(), requestId: z.uuid(), target: z.enum(['retrieval', 'federation']),
  subject: PrivacySubjectSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), modules: z.array(z.string()).min(1),
  operation: z.literal('apply_retained_redaction'),
}).strict();
export type PrivacyPropagation = z.infer<typeof PrivacyPropagationSchema>;

/** Every implemented API module must participate in export coverage and subject planning. */
export const PRIVACY_MODULE_INVENTORY = [
  'approval-routes', 'assistant', 'assistant-goals', 'billing', 'catalogue', 'communications', 'connections', 'consultations',
  'content', 'directory', 'execution', 'files', 'hubs', 'identity', 'jurisdiction', 'models', 'plans', 'platform-admin',
  'procurement', 'profiles', 'projects', 'providers', 'reputation', 'sales', 'screening', 'screening-gates', 'sources',
  'supplier-base', 'support', 'tasks', 'transactions', 'trust',
] as const;

/** A human attests to an exact external request; a contact address is never an identity or deletion credential. */
export const PrivacyExternalSourceCaseSchema = z.object({
  hubId: z.uuid(), sourceFieldId: z.uuid(), action: z.enum(['correction', 'erasure', 'objection']),
  proposedValue: z.string().min(1).max(2000).nullable().default(null), country: z.string().regex(/^[A-Z]{2}$/),
  method: z.enum(['signed_statement', 'record_control', 'verified_representative']), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((r) => (r.action === 'correction') === (r.proposedValue !== null));

/** Retained decision for one source field, never an assertion that a person/company was erased. */
export const PrivacySourceTombstoneSchema = z.object({
  version: z.literal(2), requestId: z.uuid(), planId: z.uuid(), sourceFieldId: z.uuid(), sourceId: z.uuid(),
  recordKind: z.string().min(1).max(80), recordId: z.uuid(), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  executedBy: z.uuid(), approvedBy: z.uuid(), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.iso.datetime(), modules: z.tuple([z.literal('sources')]),
}).strict().refine((r) => r.executedBy !== r.approvedBy);
export const PrivacyRetainedDecisionSchema = z.union([PrivacyTombstoneSchema, PrivacySourceTombstoneSchema]);
export type PrivacySourceTombstone = z.infer<typeof PrivacySourceTombstoneSchema>;
export type PrivacyRetainedDecision = z.infer<typeof PrivacyRetainedDecisionSchema>;

export const PrivacyFileParamsSchema = z.object({ id: z.uuid(), fileId: z.uuid() }).strict();
