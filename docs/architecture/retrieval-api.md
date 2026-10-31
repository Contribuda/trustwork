# Retrieval API, typed ports and answer contract

**Proposed routes; frozen vocabulary.** No new route is implemented. The Zod schemas in [retrieval.ts](../../packages/contracts/src/retrieval.ts) are the frozen runtime contract (FND-002, [ADR 008](../adr/008-contracts-and-validation.md)): `SourceRef`, `Locator` (page / table / text union), `Citation`, `TemporalMode`, `DataClass`, `EmbeddingConfig`, `VectorRecord` (with `inputKind`), `IndexGeneration` and its lifecycle guard, `SearchRequest` (`topK` 1–20), `StructuredFact` (typed value, `authority: canonical`, `domain.complete`), `DerivedAnswer` (with the intersected `audience`), `QueryEmbeddingInput` / `DocumentEmbeddingInput` (audience-pure batches), `ProviderBinding`, `EgressRequest` / `EgressPermit` and `DeliveryPolicy`; JSON Schema is generated from them. Untrusted inputs are runtime-validated; TypeScript alone is not an authorization boundary.

## Boundaries and ownership

| Interface | Responsibility / owner | Required boundary |
|---|---|---|
| `SourceProjectionPort` / ingest command | Domain source + data indexer | Versioned allowed fields, source rights, tombstones and outbox idempotency; no arbitrary crawler URL |
| `AuthorizationPort` | Backend identity/access | Current object/party/field grants, epoch and atomic delivery admission; server-derived principal |
| `StructuredResolverPort` | Domain/API owners | Allowlisted typed entity lookup/quote comparison/availability; current facts and permission checks; no model SQL |
| `RetrievalPort` | Retrieval lane | Exact/lexical/dense candidates inside authorized scope; generation/config filtering, budgeted plans and incomplete status |
| `EmbeddingPort` | Provider adapter | Explicit model/config, batch/token limits, data-egress grant and cost policy; deterministic fake now |
| `ContextAssemblyPort` | Retrieval + assistant | Rehydrate actual versions, source status and locators; deduplicate/diversify; stop on stale epoch |
| `RerankPort` / `AnswerPort` | Assistant/provider adapter | Only authorized context, separate spend/egress budgets, no authority escalation; bounded structured output |
| `CitationResolverPort` | Backend + retrieval | Current access on every lookup, immutable source locator/hash and evidence state, no public bearer citation |
| `DeliveryGate` | Backend/API | Reauthorize all dependencies and serialize response admission with revocation fence; audit allowed metadata |

## Proposed endpoints

`POST /v1/search` accepts query text (bounded), entity kinds, typed filters, topK (1–20 initial limit), and temporal mode (`current` or explicit source versions). The server binds session/person, object/deal-party context, allowed field projection and cost policy; caller IDs cannot broaden access. Reply includes permitted result IDs/snippets, source/observation/freshness/evidence state, citeable references and `complete | partial | no_answer | unavailable`. No unrestricted total counts, raw vectors, cross-party ranks or unauthorized-source hints.

`POST /v1/assistant/answers` accepts a query and allowed context reference, not a client-provided system prompt or candidate text. Reply contains typed structured facts separately from attributed claims, each with actual evidence citations, unresolved conflicts, allowed freshness summary and answer status. Missing evidence yields a neutral no-answer; do not reveal whether a forbidden document exists. `GET /v1/citations/:opaqueId` reauthorizes exact source/version/projection/locator, checks deletion/consent and returns permitted fragment/asset access. An opaque ID or cached signed URL never bypasses current policy.

Internal ingest/reindex/cancel/activate commands are restricted operations, not public user search endpoints. Request IDs, revisions, dedup keys and generation fences follow the base API rules. HTTP idempotency does not grant source access.

## Example request and evidence

```json
{
  "query": "Facade panel suppliers with installation in Austin",
  "kinds": ["company", "catalogue"],
  "filters": {"regionId": "fixture-kazan", "requiredStandardIds": []},
  "temporal": {"kind": "current"},
  "topK": 10
}
```

Synthetic example, not a working route. Query text is data and may contain malicious instructions. Typed constraints remain mandatory regardless of expansion/translation. Server-resolved context may restrict scope further.

```json
{
  "id": "opaque-fixture-citation",
  "source": {
    "sourceId": "fixture-quote",
    "versionId": "fixture-quote-v3",
    "projectionId": "fixture-shared-terms-v3",
    "contentHash": "fixture-immutable-hash"
  },
  "locator": {"kind": "table", "extractionId": "fixture-extract-v1", "page": 2, "table": "table-1", "row": "4", "columns": ["price"]},
  "evidence": "asserted"
}
```

Before exposing a citation, resolve all values from trusted source records; the answer provider cannot invent them. A citation must support the exact sentence/structured fact, not merely mention the topic. An old quote price may be quoted as a historical claim only if permitted; current comparison/ordering resolves the exact canonical version and current authority.

## Resource and failure contract

Initial **proposed** caps: 8 typed subqueries, topK 20 delivered results, 100 candidates per eligible channel, at most 20 rerank documents, 6,000 context tokens and 1,000 output tokens; separate ingest batch quotas. Retries consume a shared request budget. Quality/latency tests may revise these reviewed limits; none is a measured service guarantee. Reject oversized input, unsafe locator or incompatible vector configuration. Do not auto-purchase credits or silently fall back to a paid model when unavailable.

A provider policy is required before any private query/text egress. Budget object carries approved max duration/tokens/cost currency/minor units and provider policy reference; zero budget permits deterministic/local free fixtures only, not assumed free commercial API. Reranking/generation may degrade to authorized lexical/structured results with honest capability status. If semantic evidence is essential and unavailable, abstain. Cancellation/revocation stops further requests and invalidates pending response; preserve receipts for already-started charges and reconcile ambiguous billing separately.

Current-source mutation -> stale-generation status -> bounded permitted fallback or no-answer. Policy service unavailable -> fail closed. Missing citation or unsupported claim -> remove/regenerate from allowed evidence or abstain. No sensitive details in errors. Counts, autocomplete, facets and preview/download endpoints use the same permission and temporal contract.

## Embedding configuration and generations

`EmbeddingConfig` is immutable: any field change is a new `id`. It carries hosting and provider policy, model and tokenizer revisions, `maxInputTokens`/`truncation`, pooling, `dimensions`/`nativeDimensions`/`dimensionReduction`, `metric` (`cosine` requires `normalization: unit`), precision and storage type, byte-exact query/document input contracts (prefix, instruction template, instruction, adapter), serving stack and `weightsDigest` (mandatory for self-hosted), a probe-set `fingerprint`, licence identity, allowed document/query data classes, optional cost model and `status` (`proposed | approved | deprecated | revoked`; `providerId: fixture` can never be approved). `annEligible` derives from dimensions and storage type (pgvector HNSW limits 2000 / 4000). `IndexGeneration` pins config, projection/chunker/extractor/lexical/schema revisions, build and activation watermarks, fingerprint at build/activation and a manifest hash; `generationTransitionAllowed` enforces `building -> validated -> active -> draining -> retired`, `failed`, `tainted` (never back to active), activation only with a matching fingerprint, and rollback from `draining` only inside `rollbackWindowUntil`. Derived artifacts carry `intersectAudiences(sources)`: `public` is the universal set and never widens a private artifact.

## Query, document and provider admission bindings

Query embedding and document embedding are explicit separate inputs/ports. A private user question remains private even when searching only public documents; never inherit the document corpus's public egress permission. AnswerPort receives the actual typed question separately from evidence and canonical facts. Document batches remain audience-separated; each binds its complete source dependency list.

A server-issued one-use egress permit (`EgressPermitSchema`) binds principal, scope and current epoch; target/purpose (query embedding, document embedding, rerank or answer); exact provider and policy ID/revision; model ID/revision/configuration and the config `fingerprintHash` (a drifted hosted model cannot reuse a permit); data class; and canonical payload digest. The delivery policy (`DeliveryPolicySchema`) is serialized with the permit: `requireCurrentRights` and `requireEpochMatch` are always true, `onRevocation` is `deny_and_invalidate_pending`, `onPolicyUnavailable` is `fail_closed`, and the budget carries approved duration/tokens/cost and the provider policy reference. The digest covers the actual question/documents/evidence/facts and operation identity, including all dependencies. Caller-supplied digests/permits confer no authority. Policy/model/config IDs are resolved server-side; equal dimensions do not imply a compatible model space. Query and document configs may share a model space only under the pinned matching revision/prefix contract, while permits remain operation-specific.

BE-001 owns implementation, authenticity/expiry/one-use validation and serialization with revocation in packages/data/admission, plus identity integration. Its tests must reject revoke between preflight and actual embedding dispatch. RAG-201 and RAG-301 consume that accepted primitive. The representation guard matches bindings only; it does not authenticate permits, consume them, check current rights or prove a distributed fence. An external callback must be admitted inside the bounded gate, never after releasing its fence. No adapter, provider registration or paid call is added by these proposed types.
