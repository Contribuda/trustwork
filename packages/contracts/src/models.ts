import { z } from 'zod';
import { IdSchema, RevisionSchema } from './common/ids.js';
import { NonNegativeMoneySchema } from './common/money.js';
import { AgentModuleKeySchema, ModelJobSchema } from './hub.js';
import { DataClassSchema } from './retrieval.js';
import { CallCandidateSchema, isMovingAlias, RouteLimitsSchema } from './providers.js';

/** LLM-001. Internal commands, never authority inferred from a conversation. */
export const ModelCallSchema = z.strictObject({
  operationId: IdSchema,
  principalId: IdSchema,
  hubId: IdSchema,
  runId: IdSchema,
  mandateId: IdSchema,
  mandateRevision: RevisionSchema,
  job: ModelJobSchema,
  moduleKey: AgentModuleKeySchema,
  capabilityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  extensionId: IdSchema.nullable(),
  pipelineId: IdSchema.nullable(),
  dataClasses: z.array(DataClassSchema).min(1).max(5),
  allowedConnections: z.array(IdSchema).min(1).max(100),
  residencyCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
  requireZeroRetention: z.boolean(),
  estimatedCost: NonNegativeMoneySchema,
  /** Upper bounds verified by the trusted policy, not by token estimates from untrusted text. */
  maxInputTokens: z.int().positive().max(10_000_000),
  maxOutputTokens: z.int().positive().max(1_000_000),
  prompt: z.string().max(1_000_000),
}).refine((r) => new Set(r.dataClasses).size === r.dataClasses.length, { message: 'duplicate data class' })
  .refine((r) => r.dataClasses.every((c) => c === 'public') || r.requireZeroRetention, { message: 'private data requires zero retention' });
export type ModelCall = z.infer<typeof ModelCallSchema>;

export const PinnedCandidateSchema = CallCandidateSchema.refine((c) => c.modelRevision.trim().length > 0 && !isMovingAlias(c.modelRevision), {
  message: 'an exact provider revision is required', path: ['modelRevision'],
});
export type PinnedCandidate = z.infer<typeof PinnedCandidateSchema>;
export const ResolvedModelRouteSchema = z.strictObject({
  routeId: IdSchema,
  routeVersion: RevisionSchema,
  stage: z.enum(['current', 'canary', 'rollback']),
  candidates: z.array(PinnedCandidateSchema).min(1).max(4),
  limits: RouteLimitsSchema,
});
export type ResolvedModelRoute = z.infer<typeof ResolvedModelRouteSchema>;

export const MODEL_CALL_OUTCOMES = ['succeeded', 'failed', 'refused', 'outcome_unknown'] as const;
export const ModelCallMetadataSchema = z.strictObject({
  operationId: IdSchema,
  routeId: IdSchema,
  routeVersion: RevisionSchema,
  model: PinnedCandidateSchema,
  stage: ResolvedModelRouteSchema.shape.stage,
  fallbackUsed: z.boolean(),
  latencyMs: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cost: NonNegativeMoneySchema,
  outcome: z.enum(MODEL_CALL_OUTCOMES),
});
export type ModelCallMetadata = z.infer<typeof ModelCallMetadataSchema>;

/** All seven scopes must have an authoritative answer, including the currently external AGT-003 scopes. */
export const MODEL_KILL_SCOPES = ['node', 'provider', 'model', 'job', 'module', 'capability', 'extension'] as const;
export type ModelKillScope = (typeof MODEL_KILL_SCOPES)[number];

export const ModelUsageAggregateSchema = z.strictObject({
  routeId: IdSchema,
  routeVersion: RevisionSchema,
  connectionId: IdSchema,
  modelId: z.string(),
  modelRevision: z.string(),
  stage: ResolvedModelRouteSchema.shape.stage,
  participantType: z.string(),
  plan: z.string(),
  moduleKey: AgentModuleKeySchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  calls: z.int().min(10),
  participants: z.int().min(10),
  costMinorUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  failures: z.int().nonnegative(),
  fallbacks: z.int().nonnegative(),
  latencyP50Ms: z.int().nonnegative(),
  latencyP95Ms: z.int().nonnegative(),
});
export type ModelUsageAggregate = z.infer<typeof ModelUsageAggregateSchema>;
