/**
 * @trustwork/contracts/client — schemas, types and pure guards only. No `node:` imports and no digest computation are
 * reachable from this entry (enforced by tests/contracts/client-entry.test.ts). Server-only modules
 * (`common/digest.ts`, `server/commercial.ts`) are exported from `index.ts` alone.
 */
export * from './common/ids.js';
export * from './common/money.js';
export * from './common/quantity.js';
export * from './common/units.js';
export * from './common/canonical.js';
export * from './common/encoding.js';
export * from './common/digest-schema.js';
export * from './common/version.js';
export * from './common/errors.js';
export * from './common/idempotency.js';
export * from './common/pagination.js';
export * from './common/projection.js';
export * from './identity.js';
export * from './second-factor.js';
export * from './company.js';
export * from './access.js';
export * from './projects.js';
export * from './catalogue.js';
export * from './procurement.js';
export * from './sales.js';
export * from './transactions.js';
export * from './execution.js';
export * from './content.js';
export * from './billing.js';
export * from './assistant.js';
export * from './agent-catalog.js';
export * from './admin.js';
export * from './hub.js';
export * from './api.js';
export * from './mcp.js';
export {
  // Retrieval keeps its own `EvidenceState` identical to execution's; export the rest without the duplicate name.
  SourceKindSchema, AudienceSchema, SourceRefSchema, LocatorSchema, CitationSchema, TemporalModeSchema, DataClassSchema,
  EmbeddingHostingSchema, EmbeddingConfigStatusSchema, EmbeddingConfigSchema, VectorRecordSchema, GenerationStateSchema, TaintReasonSchema, IndexGenerationSchema,
  SearchRequestSchema, PolicyContextSchema, AuthorizedEvidenceSchema, RetrievalStatusSchema, RetrievalResultSchema, StructuredFactSchema, DerivedAnswerSchema,
  AdmissionTargetSchema, QuestionInputSchema, QueryEmbeddingInputSchema, DocumentEmbeddingInputSchema, ProviderBindingSchema, EgressRequestSchema, EgressPermitSchema,
  DeliveryPolicySchema, GENERATION_STATES, SEARCH_TOP_K_MAX, HNSW_VECTOR_MAX_DIMENSIONS, HNSW_HALFVEC_MAX_DIMENSIONS,
  annEligible, generationTransitionAllowed, intersectAudiences, compatibleVector, matchesEgressBinding,
} from './retrieval.js';
export type {
  SourceKind, Audience, SourceRef, Locator, Citation, TemporalMode, DataClass, EmbeddingConfig, VectorRecord, GenerationState, IndexGeneration, SearchRequest,
  PolicyContext, AuthorizedEvidence, RetrievalResult, StructuredFact, DerivedAnswer, AdmissionTarget, QuestionInput, QueryEmbeddingInput, DocumentEmbeddingInput,
  ProviderBinding, EgressRequest, EgressPermit, DeliveryPolicy, SourceProjectionPort, AuthorizationPort, DeliveryGate, StructuredResolverPort, RetrievalPort,
  EgressAdmissionPort, EmbeddingPort, ContextAssemblyPort, RerankPort, AnswerPort, CitationResolverPort,
} from './retrieval.js';
// Directory projections, handles and pagination (BE-003); the web reads them through the live adapter (WEB-004).
export * from './directory.js';
// Minimal privacy intake and local journal shapes (PRV-001); coverage is explicitly partial.
export * from './privacy.js';
// Profiles, consent records, portraits and experience (PPL-001); the web reads public profiles through the live adapter.
export * from './profiles.js';
// Sanctions compliance: jurisdiction gate, address primitives and holds (SANC-001, ADR 014).
export * from './sanctions.js';
// Deployment-location attestation: command, record, refusal rule and status (SANC-009, ADR 014 decisions 3 to 5).
export * from './sanctions-attestation.js';
// Context threads, messages, notifications, preferences, channel grants and templates (COMMS-001).
export * from './communications.js';
// The hub's active legal texts for the legal pages and sign-up (HUB-001 legal documents, QA-002 D4); the rest of
// hub-core stays server-side.
export { LegalDocumentKindSchema, NO_ACTIVE_TERMS_VERSION, PublicLegalDocumentSchema, PublicLegalDocumentsSchema, termsAcceptanceVersion } from './hub-core.js';
export type { LegalDocumentKind, PublicLegalDocument, PublicLegalDocuments } from './hub-core.js';
