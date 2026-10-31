import { z } from 'zod';
import { DigestSchema, Sha256HexSchema } from './common/digest-schema.js';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { DecimalSchema, UnitCodeSchema } from './common/quantity.js';

/** Frozen retrieval vocabulary (R31). Runtime validators here; ports stay interfaces implemented behind BE-001/RAG-201/RAG-301. */
export const SourceKindSchema = z.enum(['company', 'person', 'catalogue', 'rfq', 'quote', 'project', 'publication', 'file', 'message', 'execution', 'conversation']);
export type SourceKind = z.infer<typeof SourceKindSchema>;
export const AudienceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('public') }),
  z.strictObject({ kind: z.literal('person'), scopeId: IdSchema }),
  z.strictObject({ kind: z.literal('company'), scopeId: IdSchema }),
  z.strictObject({ kind: z.literal('project'), scopeId: IdSchema }),
  z.strictObject({ kind: z.literal('deal_party'), scopeId: IdSchema }),
]);
export type Audience = z.infer<typeof AudienceSchema>;
export const EvidenceStateSchema = z.enum(['asserted', 'confirmed', 'disputed', 'superseded']);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;
export const SourceRefSchema = z.strictObject({ sourceId: IdSchema, versionId: IdSchema, projectionId: IdSchema, contentHash: z.string().min(1).max(128) });
export type SourceRef = z.infer<typeof SourceRefSchema>;
/** Locator points to an immutable extraction; an edited document creates new citations, never moved anchors. */
export const LocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), extractionId: IdSchema, page: z.int().min(1), boundingBox: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional() }),
  z.strictObject({ kind: z.literal('table'), extractionId: IdSchema, page: z.int().min(1), table: z.string().min(1).max(100), row: z.string().min(1).max(50), columns: z.array(z.string().min(1).max(100)).min(1) }),
  z.strictObject({ kind: z.literal('text'), extractionId: IdSchema, start: z.int().min(0), end: z.int().min(1), headingPath: z.array(z.string().max(200)).optional() }).refine((l) => l.end > l.start, { message: 'end after start', path: ['end'] }),
]);
export type Locator = z.infer<typeof LocatorSchema>;
export const CitationSchema = z.strictObject({ id: IdSchema, source: SourceRefSchema, locator: LocatorSchema, evidence: EvidenceStateSchema });
export type Citation = z.infer<typeof CitationSchema>;
export const TemporalModeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('versions'), versionIds: z.array(IdSchema).min(1), asOf: TimestampSchema }),
]);
export type TemporalMode = z.infer<typeof TemporalModeSchema>;
export const DataClassSchema = z.enum(['public', 'person_private', 'company_private', 'project_restricted', 'deal_party_private']);
export type DataClass = z.infer<typeof DataClassSchema>;

/* ---------- Immutable embedding configuration (RAG-101 proposal, frozen) ---------- */
export const EmbeddingHostingSchema = z.enum(['self_hosted', 'hosted_provider']);
export const EmbeddingConfigStatusSchema = z.enum(['proposed', 'approved', 'deprecated', 'revoked']);
const InputContractSchema = z.strictObject({ prefix: z.string().max(200), instructionTemplate: z.string().max(2000).nullable(), instruction: z.string().max(2000).nullable() });
export const HNSW_VECTOR_MAX_DIMENSIONS = 2000;
export const HNSW_HALFVEC_MAX_DIMENSIONS = 4000;
/** Any field change is a new config id; equal dimensions never imply a compatible model space. */
export const EmbeddingConfigSchema = z.strictObject({
  id: IdSchema,
  schemaVersion: z.literal(1),
  hosting: EmbeddingHostingSchema,
  providerId: z.string().min(1).max(100),
  providerPolicyId: IdSchema,
  providerPolicyRevision: z.string().min(1).max(40),
  modelId: z.string().min(1).max(200),
  modelRevision: z.string().min(1).max(200),
  queryModelId: z.string().min(1).max(200).nullable(),
  queryModelRevision: z.string().min(1).max(200).nullable(),
  tokenizerId: z.string().min(1).max(200),
  tokenizerRevision: z.string().min(1).max(200),
  maxInputTokens: z.int().min(1),
  truncation: z.enum(['error', 'truncate_tail', 'reject_chunk']),
  pooling: z.enum(['mean', 'cls', 'last_token', 'provider_opaque']),
  dimensions: z.int().min(1),
  nativeDimensions: z.int().min(1),
  dimensionReduction: z.enum(['none', 'matryoshka_truncate', 'provider_dimensions_param', 'pca_projection']),
  metric: z.enum(['cosine', 'inner_product', 'l2']),
  normalization: z.enum(['unit', 'none']),
  precision: z.enum(['fp32', 'fp16', 'bf16']),
  storageType: z.enum(['vector', 'halfvec']),
  inputContracts: z.strictObject({ query: InputContractSchema, document: InputContractSchema.omit({ instruction: true }), adapter: z.string().max(100).nullable() }),
  servingStack: z.string().max(200).nullable(),
  weightsDigest: z.string().max(200).nullable(),
  fingerprint: z.strictObject({ probeSetId: IdSchema, hash: z.string().min(1).max(200) }),
  licenseSpdx: z.string().min(1).max(100),
  licenseTextHash: z.string().min(1).max(200),
  allowedDataClasses: z.array(DataClassSchema),
  allowedQueryDataClasses: z.array(DataClassSchema),
  costModel: z.strictObject({ unit: z.enum(['token', 'request', 'gpu_second']), amountMinorUnits: z.string().regex(/^(0|[1-9]\d*)$/), currency: z.string().regex(/^[A-Z]{3}$/), priceVersion: z.string().min(1).max(40) }).nullable(),
  status: EmbeddingConfigStatusSchema,
})
  .refine((c) => c.dimensions <= c.nativeDimensions, { message: 'dimensions <= nativeDimensions', path: ['dimensions'] })
  .refine((c) => c.dimensions !== c.nativeDimensions || c.dimensionReduction === 'none', { message: 'equal widths require dimensionReduction none', path: ['dimensionReduction'] })
  .refine((c) => c.metric !== 'cosine' || c.normalization === 'unit', { message: 'cosine requires unit normalization in approved configs', path: ['normalization'] })
  .refine((c) => c.hosting !== 'self_hosted' || c.weightsDigest !== null, { message: 'self-hosted configs record weightsDigest', path: ['weightsDigest'] })
  .refine((c) => c.providerId !== 'fixture' || (c.costModel === null && c.status !== 'approved'), { message: 'fixture configs have no cost model and cannot be approved', path: ['status'] });
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export function annEligible(config: Pick<EmbeddingConfig, 'dimensions' | 'storageType'>): boolean {
  return config.dimensions <= (config.storageType === 'halfvec' ? HNSW_HALFVEC_MAX_DIMENSIONS : HNSW_VECTOR_MAX_DIMENSIONS);
}

export const VectorRecordSchema = z.strictObject({
  configId: IdSchema,
  generationId: IdSchema,
  /** Query vectors are never persisted as chunk embeddings and vice versa. */
  inputKind: z.enum(['query', 'document']),
  values: z.array(z.number()).min(1),
  producedAt: TimestampSchema.optional(),
});
export type VectorRecord = z.infer<typeof VectorRecordSchema>;

/* ---------- Index generation lifecycle ---------- */
export const GENERATION_STATES = ['building', 'validated', 'active', 'draining', 'retired', 'failed', 'tainted'] as const;
export const GenerationStateSchema = z.enum(GENERATION_STATES);
export type GenerationState = z.infer<typeof GenerationStateSchema>;
export const TaintReasonSchema = z.enum(['public_to_private', 'config_revoked', 'fingerprint_drift', 'erasure_replay_pending']);
const WatermarkSchema = z.strictObject({ canonicalRevision: z.string().min(1).max(100), policyEpoch: z.int().min(0), erasureSequence: z.int().min(0) });
export const IndexGenerationSchema = z.strictObject({
  generationId: IdSchema,
  configId: IdSchema,
  scope: z.strictObject({ cohort: z.enum(['public', 'private_exact', 'private_cohort']), cohortDescriptor: z.string().min(1).max(200) }),
  projectionFieldSetRevision: z.string().min(1).max(100),
  chunkerRevision: z.string().min(1).max(100),
  extractorRevision: z.string().min(1).max(100),
  lexicalDictionaryRevision: z.string().min(1).max(100),
  schemaRevision: z.string().min(1).max(100),
  annEligible: z.boolean(),
  indexSpec: z.strictObject({ type: z.enum(['hnsw', 'none']), m: z.int().min(1).nullable(), efConstruction: z.int().min(1).nullable(), opclass: z.string().max(100).nullable() }).nullable(),
  buildWatermark: WatermarkSchema,
  activationWatermark: WatermarkSchema.nullable(),
  fingerprintHashAtBuild: z.string().min(1).max(200),
  fingerprintHashAtActivation: z.string().min(1).max(200).nullable(),
  manifestHash: z.string().min(1).max(200),
  status: GenerationStateSchema,
  taintReason: TaintReasonSchema.nullable(),
  rollbackWindowUntil: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  validatedAt: TimestampSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  drainingAt: TimestampSchema.nullable(),
  retiredAt: TimestampSchema.nullable(),
})
  .refine((g) => (g.status === 'tainted') === (g.taintReason !== null), { message: 'tainted iff taintReason set', path: ['taintReason'] })
  .refine((g) => g.status !== 'active' || (g.activationWatermark !== null && g.fingerprintHashAtActivation !== null), { message: 'active generations record activation watermark and fingerprint', path: ['activationWatermark'] });
export type IndexGeneration = z.infer<typeof IndexGenerationSchema>;
const GENERATION_TRANSITIONS: Record<GenerationState, readonly GenerationState[]> = {
  building: ['validated', 'failed'],
  validated: ['active', 'failed'],
  active: ['draining', 'tainted'],
  draining: ['retired', 'active', 'tainted'],
  tainted: ['retired'],
  retired: [],
  failed: [],
};
/** Only `validated` may become `active`; a tainted generation can only retire (never active, directly or via draining); rollback from draining needs an open window. */
export function generationTransitionAllowed(from: GenerationState, to: GenerationState, context: { now?: Date; rollbackWindowUntil?: string | null; fingerprintMatches?: boolean } = {}): boolean {
  if (!GENERATION_TRANSITIONS[from].includes(to)) return false;
  if (to === 'active' && from === 'validated') return context.fingerprintMatches === true;
  if (to === 'active' && from === 'draining') {
    if (!context.now || !context.rollbackWindowUntil) return false;
    return Date.parse(context.rollbackWindowUntil) > context.now.getTime() && context.fingerprintMatches === true;
  }
  return true;
}

/* ---------- Search, facts, answers ---------- */
export const SEARCH_TOP_K_MAX = 20;
export const SearchRequestSchema = z.strictObject({
  query: z.string().min(1).max(1000),
  kinds: z.array(SourceKindSchema).min(1),
  temporal: TemporalModeSchema,
  topK: z.int().min(1).max(SEARCH_TOP_K_MAX),
  filters: z.strictObject({ regionId: IdSchema.optional(), exactIdentifier: z.string().max(100).optional(), rfqVersionId: IdSchema.optional(), requiredStandardIds: z.array(IdSchema).optional() }),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
/** Server-derived; callers cannot manufacture broader authority by submitting this object. */
export const PolicyContextSchema = z.strictObject({ principalId: IdSchema, scopeFingerprint: z.string().min(1).max(200), policyEpoch: z.string().min(1).max(40) });
export type PolicyContext = z.infer<typeof PolicyContextSchema>;
export const AuthorizedEvidenceSchema = z.strictObject({ source: SourceRefSchema, citation: CitationSchema, text: z.string().max(20_000), audience: AudienceSchema, policy: PolicyContextSchema });
export type AuthorizedEvidence = z.infer<typeof AuthorizedEvidenceSchema>;
export const RetrievalStatusSchema = z.enum(['complete', 'partial', 'no_answer', 'unavailable']);
export const RetrievalResultSchema = z.strictObject({ status: RetrievalStatusSchema, evidence: z.array(AuthorizedEvidenceSchema), generationId: IdSchema, observedAt: TimestampSchema });
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;
/** Canonical typed fact. `domain.complete` means the fact was computed over the whole authorized domain, never over top-k. */
export const StructuredFactSchema = z.strictObject({
  source: SourceRefSchema,
  field: z.string().min(1).max(100),
  value: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('money'), minorUnits: z.string().regex(/^-?(0|[1-9]\d*)$/), currency: z.string().regex(/^[A-Z]{3}$/) }),
    z.strictObject({ kind: z.literal('quantity'), value: DecimalSchema, unit: UnitCodeSchema }),
    z.strictObject({ kind: z.literal('text'), text: z.string().max(2000) }),
    z.strictObject({ kind: z.literal('identifier'), id: IdSchema }),
    z.strictObject({ kind: z.literal('timestamp'), at: TimestampSchema }),
    z.strictObject({ kind: z.literal('unknown') }),
  ]),
  asOf: TimestampSchema,
  authority: z.literal('canonical'),
  domain: z.strictObject({ scopeFingerprint: z.string().min(1).max(200), complete: z.boolean(), pinnedVersionIds: z.array(IdSchema), aggregate: z.enum(['none', 'sum', 'count', 'min', 'max']) }),
});
export type StructuredFact = z.infer<typeof StructuredFactSchema>;
export const DerivedAnswerSchema = z.strictObject({
  id: IdSchema,
  text: z.string().max(20_000),
  dependencies: z.array(SourceRefSchema),
  citations: z.array(CitationSchema),
  policy: PolicyContextSchema,
  status: z.enum(['supported', 'qualified', 'abstain']),
  /** Intersection of the dependencies' audiences; recomputed and rechecked at every delivery. */
  audience: z.array(AudienceSchema),
});
export type DerivedAnswer = z.infer<typeof DerivedAnswerSchema>;
export const AdmissionTargetSchema = z.enum(['embedding_provider', 'rerank_provider', 'answer_provider', 'answer_delivery', 'citation_delivery']);
export type AdmissionTarget = z.infer<typeof AdmissionTargetSchema>;

/**
 * A derived artifact may be seen only by principals inside every source audience. `public` is the universal set:
 * it never restricts and never widens; the result is public only when every source is public.
 */
export function intersectAudiences(audiences: readonly (readonly Audience[])[]): readonly Audience[] {
  if (audiences.length === 0) return [];
  const key = (a: Audience) => (a.kind === 'public' ? 'public' : `${a.kind}:${a.scopeId}`);
  const dedupe = (list: readonly Audience[]) => list.filter((a, i, arr) => arr.findIndex((b) => key(b) === key(a)) === i);
  const isUniversal = (list: readonly Audience[]) => list.some((a) => a.kind === 'public');
  let result = dedupe(audiences[0]!);
  for (const next of audiences.slice(1)) {
    if (isUniversal(next)) continue;
    if (isUniversal(result)) {
      result = dedupe(next);
      continue;
    }
    const keys = new Set(next.map(key));
    result = result.filter((a) => keys.has(key(a)));
  }
  return result;
}

export const QuestionInputSchema = z.strictObject({ text: z.string().min(1).max(4000), dataClass: DataClassSchema, context: PolicyContextSchema, dependencies: z.array(SourceRefSchema) });
export type QuestionInput = z.infer<typeof QuestionInputSchema>;
export const QueryEmbeddingInputSchema = z.strictObject({ kind: z.literal('query'), question: QuestionInputSchema });
export type QueryEmbeddingInput = z.infer<typeof QueryEmbeddingInputSchema>;
/** Each batch has one permitted audience and sensitivity, before any vector is created. */
export const DocumentEmbeddingInputSchema = z.strictObject({ kind: z.literal('documents'), documents: z.array(AuthorizedEvidenceSchema).min(1), dataClass: DataClassSchema, audience: AudienceSchema })
  .refine((d) => d.documents.every((doc) => JSON.stringify(doc.audience) === JSON.stringify(d.audience)), { message: 'no mixed-audience batches', path: ['documents'] });
export type DocumentEmbeddingInput = z.infer<typeof DocumentEmbeddingInputSchema>;

const BindingBase = { providerId: z.string().min(1).max(100), policyId: IdSchema, policyRevision: z.string().min(1).max(40), modelId: z.string().min(1).max(200), modelRevision: z.string().min(1).max(200), configId: IdSchema, dataClass: DataClassSchema, fingerprintHash: z.string().max(200).optional(), maxInputTokens: z.int().min(1).optional() };
export const ProviderBindingSchema = z.discriminatedUnion('target', [
  z.strictObject({ ...BindingBase, target: z.literal('embedding_provider'), purpose: z.enum(['query_embedding', 'document_embedding']) }),
  z.strictObject({ ...BindingBase, target: z.literal('rerank_provider'), purpose: z.literal('rerank') }),
  z.strictObject({ ...BindingBase, target: z.literal('answer_provider'), purpose: z.literal('answer') }),
]);
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;
/** Trusted service computes digest over exact payload, dependencies and operation identity. */
export const EgressRequestSchema = z.strictObject({ binding: ProviderBindingSchema, payloadDigest: z.string().min(1).max(200), context: PolicyContextSchema, dependencies: z.array(SourceRefSchema) });
export type EgressRequest = z.infer<typeof EgressRequestSchema>;
/** Serialized one-use permit; authenticity, expiry and one-use enforcement are server responsibilities (BE-001). */
export const EgressPermitSchema = EgressRequestSchema.extend({ permitId: IdSchema, expiresAt: TimestampSchema, issuedAt: TimestampSchema.optional(), signature: Sha256HexSchema.optional() });
export type EgressPermit = z.infer<typeof EgressPermitSchema>;
/** Delivery policy evaluated inside the serialized admission gate for every target. */
export const DeliveryPolicySchema = z.strictObject({
  policyId: IdSchema,
  revision: z.string().min(1).max(40),
  targets: z.array(AdmissionTargetSchema).min(1),
  requireCurrentRights: z.literal(true),
  requireEpochMatch: z.literal(true),
  maxDependencyAge: z.strictObject({ seconds: z.int().min(0) }).nullable(),
  budget: z.strictObject({ maxDurationMs: z.int().min(0), maxTokens: z.int().min(0), cost: z.strictObject({ minorUnits: z.string().regex(/^(0|[1-9]\d*)$/), currency: z.string().regex(/^[A-Z]{3}$/) }), providerPolicyId: IdSchema }),
  onRevocation: z.literal('deny_and_invalidate_pending'),
  onPolicyUnavailable: z.literal('fail_closed'),
  payloadDigest: DigestSchema.optional(),
});
export type DeliveryPolicy = z.infer<typeof DeliveryPolicySchema>;

/* ---------- Ports (interfaces, implemented later) ---------- */
export interface SourceProjectionPort { read(ref: SourceRef, context: PolicyContext): Promise<AuthorizedEvidence | null> }
export interface AuthorizationPort {
  current(principalId: string): Promise<PolicyContext>;
  allowed(ref: SourceRef, context: PolicyContext, temporal: TemporalMode): Promise<boolean>;
}
/** Must serialize the callback's bounded admission with revocation, not merely preflight it. */
export interface DeliveryGate {
  admit<T>(context: PolicyContext, dependencies: readonly SourceRef[], target: AdmissionTarget, dispatch: () => Promise<T>): Promise<{ admitted: true; value: T } | { admitted: false }>;
}
export interface StructuredResolverPort { resolve(request: SearchRequest, context: PolicyContext): Promise<readonly StructuredFact[]> }
export interface RetrievalPort { search(request: SearchRequest, context: PolicyContext): Promise<RetrievalResult> }
export interface EgressAdmissionPort {
  issue(request: EgressRequest): Promise<EgressPermit | null>;
  admit<T>(request: EgressRequest, permit: EgressPermit, dispatch: () => Promise<T>): Promise<{ admitted: true; value: T } | { admitted: false }>;
}
/** Adapters execute only inside EgressAdmissionPort; possession of a structural permit is insufficient. */
export interface EmbeddingPort {
  embedQuery(input: QueryEmbeddingInput, config: EmbeddingConfig, generationId: string, permit: EgressPermit): Promise<VectorRecord>;
  embedDocuments(input: DocumentEmbeddingInput, config: EmbeddingConfig, generationId: string, permit: EgressPermit): Promise<readonly VectorRecord[]>;
}
export interface ContextAssemblyPort { assemble(evidence: readonly AuthorizedEvidence[], facts: readonly StructuredFact[], context: PolicyContext): Promise<{ evidence: readonly AuthorizedEvidence[]; facts: readonly StructuredFact[] }> }
export interface RerankPort { rank(question: QuestionInput, evidence: readonly AuthorizedEvidence[], permit: EgressPermit): Promise<readonly string[]> }
export interface AnswerPort { answer(question: QuestionInput, evidence: readonly AuthorizedEvidence[], facts: readonly StructuredFact[], context: PolicyContext, permit: EgressPermit): Promise<DerivedAnswer> }
export interface CitationResolverPort { resolve(id: string, context: PolicyContext): Promise<Citation | null> }

/** Pure representation guard; does not establish model quality, provenance or authorization. */
export function compatibleVector(record: Pick<VectorRecord, 'configId' | 'generationId' | 'values'>, config: Pick<EmbeddingConfig, 'id' | 'dimensions' | 'normalization'>, generationId: string): boolean {
  if (!Number.isInteger(config.dimensions) || config.dimensions < 1 || !config.id || !generationId) return false;
  if (record.configId !== config.id || record.generationId !== generationId || record.values.length !== config.dimensions) return false;
  if (!record.values.every(Number.isFinite)) return false;
  const norm = Math.hypot(...record.values);
  if (!Number.isFinite(norm) || norm === 0) return false;
  return config.normalization !== 'unit' || Math.abs(norm - 1) < 1e-6;
}

/** Negative representation check only; not permit authentication, current authorization or replay protection. */
export function matchesEgressBinding(permit: EgressPermit, request: EgressRequest, now: Date): boolean {
  if (!permit.permitId || !request.payloadDigest || !Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= now.getTime()) return false;
  const keys = ['providerId', 'policyId', 'policyRevision', 'modelId', 'modelRevision', 'configId', 'dataClass', 'target', 'purpose'] as const;
  if (keys.some((key) => !request.binding[key] || permit.binding[key] !== request.binding[key])) return false;
  if (permit.binding.fingerprintHash !== request.binding.fingerprintHash) return false;
  if (permit.payloadDigest !== request.payloadDigest) return false;
  if ((['principalId', 'scopeFingerprint', 'policyEpoch'] as const).some((key) => !request.context[key] || permit.context[key] !== request.context[key])) return false;
  // Dependency order is canonicalized by the trusted issuer. Fail closed on any differing representation.
  return JSON.stringify(permit.dependencies) === JSON.stringify(request.dependencies);
}
