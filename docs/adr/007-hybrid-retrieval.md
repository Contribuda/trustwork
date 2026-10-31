# ADR 007 — First-class RAG on PostgreSQL with governed hybrid retrieval

Date: 2026-10-26. Status: **selected initial architecture for review; not implemented or benchmarked**. Product requirement R31 is explicit. This supersedes ADR 001/overview language that postponed vector retrieval; only a separate external vector database remains evidence-dependent.

## Decision

Start with PostgreSQL 18 as transactional authority and pgvector + native full-text/exact indexes as versioned derived retrieval storage. Evaluate pgvector **0.8.7**, the tagged upstream documentation inspected for this design, against the pinned PostgreSQL 18 deployment image before installation; no extension/image change is made here. Freeze extension/build digest in the data implementation task. Keep embedding model/dimension/normalization/tokenizer and index generation explicit; do not silently mix embeddings across models even if dimensions match.

Use exact vector retrieval on materialized authorized private subsets initially. Public-only eligible generation indexes may use HNSW after selective-filter and recall testing. Future private ANN requires physical permission-cohort isolation and current-policy gating. The [design](../architecture/retrieval.md) specifies three authorization boundaries, final delivery admission, tainted-index exact fallback, source-version pinning and structured fact resolution. A dedicated vector database is not necessary to satisfy first-class vectors.

## Why this baseline

It keeps current authorization joins, immutable versions, outbox/tombstones and operational recovery within one governed data platform. Exact structured constraints and relational edges remain first-class. Public discovery and Russian semantic search can share a contract with private assistant grounding without sharing private ANN topology. Costs include vector/index RAM and WAL/maintenance pressure on PostgreSQL, specialized query tuning, and possible contention with transaction traffic; resource budgets and workload isolation are required, not optional optimism.

Alternatives: lexical-only misses a required semantic capability; global ANN plus application company filter fails the access/selectivity design; an external vector store adds authorization replication, deletion/restore, credentials, operations and egress decisions before load evidence; a graph database/GraphRAG does not replace relational permissions and exact joins. None is forbidden later, but none is required for this bootstrap.

## Models and provider independence

Initial evaluation candidates include locally operated BGE-M3 dense embeddings and multilingual-e5-large, both primary model cards available; the cards describe 1024-dimensional multilingual embeddings. BGE-M3 documents a longer context window, E5 a 512-token limit and model-specific input prefixes. These are candidate properties, not proof of Russian construction retrieval quality. Freeze exact model revision, tokenizer, prefixes, pooling, normalization, metric, precision, license and hardware/cost evidence in RAG-101. No model download, inference, keys or paid requests are authorized here. BGE-M3 sparse/multi-vector modes are not silently the same as PostgreSQL lexical ranking.

Use cosine as the first evaluated dense metric with explicit normalization metadata. Zero/nonfinite/mismatched vectors are invalid. pgvector storage and HNSW indexing have different dimensional limits; the data task verifies the tagged operator/type limits for the selected model, not just storage acceptance. Quantization/reduced dimensions require recall/citation regression tests and a new generation. Provider contracts keep query embedding, bulk embedding, reranking and generation cost/egress policies separate.

## Measurable reconsideration triggers

All numbers below are **proposed decision thresholds**, not achieved SLOs or capacity claims. Use the [benchmark protocol](../quality/retrieval-evaluation.md). After safe SQL plans, workload quotas and permitted cohort/index tuning, open a migration ADR if representative 30-minute peak runs repeatedly exceed p95 800 ms retrieval latency, fail authorized Recall@20 >= 0.95 against the exact oracle, or increase baseline transaction p95 by >20%; or if measured index/backfill/RAM/WAL/restore requirements exceed owner-approved capacity/cost/RPO/RTO. Record at least three repeat runs with hardware, scope selectivity, cache state and concurrent mutation load. Security failure is a release blocker, not a license to migrate or relax policy.

Compare PostgreSQL isolated retrieval replica (with authoritative primary revocation gate), dedicated PostgreSQL retrieval instance, and external vector candidates using the same scope/recall/security/restore/cost tests. Replica lag may reduce freshness but cannot extend permissions. Migration needs generation-specific dual-read evaluation, complete tombstone replay, owner approval and rollback. Do not claim that a particular record count alone requires migration or guarantees success.

## Evidence and consequences

Primary source register (kept in the project archive, not in this repository) distinguishes upstream facts from this project's choices. [Knowledge model](../data/knowledge-model.md), [API/ports](../architecture/retrieval-api.md), [operations](../operations/retrieval.md) and tasks are mandatory follow-through. Current repository validation uses deterministic fake vectors and policy fixtures; it cannot establish ANN recall, production authorization or real-model answer quality.
