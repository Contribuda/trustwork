# Retrieval operations, deletion and generation lifecycle

Design/runbook only. No vector service, extension, model or production ingestion is deployed. Every node operates its retrieval runtime independently under its operator's control. [Architecture](../architecture/retrieval.md) defines the trusted boundary and delivery linearization.

## Ingest state and reliable work

Source mutation -> outbox -> eligibility check -> extraction/quarantine -> allowed field projection -> chunking -> embedding -> generation staging -> validation -> active publication. Persist source/config/generation job identity and checkpoint before work. Idempotent UPSERT uniqueness is `(source_version, projection, extractor_revision, chunker_revision, embedding_config, generation)`; chunk/vector manifests reconcile after crash. A stale job may finish expensive computation but must recheck source revision, epoch, consent and tombstone before publishing. Bounded retries with backoff and reason codes; unsupported format/rights/conflicting metadata quarantined, not endlessly retried. Dead-letter review never grants broader access.

Transactional outbox may deliver duplicates/out of order. Never let older source/ACL events overwrite a newer deny sequence or current pointer. A missing event is found by watermark reconciliation against canonical version/eligibility tables. Track extraction failures/OCR confidence and orphaned artifacts separately from embedding failures. Provider retries require stable request identity and cost reconciliation; bulk reindex is not a free invisible operation.

## Lifecycle matrix

| Change | Immediate authoritative action | Asynchronous work / test |
|---|---|---|
| Employer exit or grant expiry/revocation | Revoke company-derived grants, increment policy epoch, fence future delivery/provider egress/citations | Evict private caches and source-dependent assistant memory; index cleanup cannot extend access; test in-flight reply |
| Public -> private | Change allowed projection, bump epoch and mark impacted ANN generation tainted | Remove public lexical/vector/edge entries and rebuild/certify before public ANN reuse; exact permitted fallback during lag |
| Person consent/source-rights withdrawal | Deny affected source/purpose/projection immediately | Purge embeddings/text/caches/export artifacts per policy; retain minimal tombstone and audit; no private-profile autocomplete |
| Delete source/file | Transactional tombstone + deny, clear current pointers, invalidate answer dependencies | Delete extracted text/chunks/vectors/lexical rows/edges and derivative files; handle object-store versions/backups under retention policy |
| Source/attachment version change | Update canonical current pointer and freshness watermark; old immutable record stays labelled historical if permitted | Re-extract/rechunk/re-embed new version; do not mutate old locator or silently substitute attachments |
| RFQ amendment / quote supersession | Mark responses stale for current requirement; exact canonical RFQ/quote relation checked on read | New projections/version references; tests for qty10-v1 versus qty100-v2; historical mode explicit |
| Restore/republication | Restore keeps deny until latest external erasure/rights watermark replayed; republication is a new authorized version/consent event | Old tombstone not removed; complete reconciliation/ACL/citation tests before activation; no resurrection by old embedding cache |
| ACL/field-policy change with same text | Epoch/field-set revision invalidates eligibility and delivery stamps | Reproject/repartition affected data even if content hash unchanged; no cross-audience content-dedup shortcut |

Deletion is not accomplished by removing vectors alone: include original/extracted artifacts, lexical indexes, relations, answers, prompts retained under policy, provider-held data subject to actual contract, object versions and backups. Retention exceptions/legal holds require separately authorized policy and must not keep material queryable. No promise of instantaneous physical erasure from immutable backups; prevent serving it immediately and replay erasure before restored access. Deletion-control records must live outside the snapshot being restored and have owner-controlled backups.

## Reindex/model migration and rollback

Freeze a generation manifest: source corpus/rights scope, canonical watermark, projection/chunker revisions, model revision/tokenizer/prefixes/pooling/dimensions/metric/normalization/precision, lexical dictionaries and index build settings. Never compare/query vectors across incompatible generations. Build new generation separately with quotas, idempotent checkpoints and current denial checks. Dual-read only within authorized scope; evaluate against frozen gold and concurrent-churn scenarios. Reconcile canonical/erasure/policy watermarks, then atomically activate the pointer with expected revision and audit.

Keep old generation read-disabled/draining for a bounded owner-approved rollback window. Rollback must replay current tombstones, epochs and source pointers; it cannot restore old rights or knowingly stale current facts. Block a tainted generation even if it previously passed quality tests. A crash before activation leaves active pointer unchanged; crash after activation uses manifest/reconciliation, not guessed completion. Retire expired text/vector caches and delete old embeddings according to retention policy.

Private exact subsets and separate public indexes are the initial strategy. Any new private ANN cohort must prove policy homogeneity, physical pruning, current-epoch gating and cross-cohort inference tests before activation. Replicas can serve candidates only with a primary authoritative final gate; replica policy lag must never grant access.

## Capacity, cost and observability

Separate embedding/OCR/backfill workers from transaction-critical API pools; quotas by owner and purpose, bounded parallelism/memory, advisory migration ownership and independent cancellation. Measure CPU/RAM/index size/WAL, vacuum bloat, cache pressure, replication lag, database transaction latency and provider batch cost before increasing concurrency. Track outbox age, source-to-index freshness, denied-stale candidates, tainted generation duration, exact fallback rate, underfilled ANN, citation failures, reindex completeness, deletion backlog, quarantine/dead-letter counts and provider cost per approved scope.

Logs/metrics use pseudonymous request/scope IDs, model/generation hashes, timing and reason codes. No raw private query, document, chunk, vector, prompt, floor, counterpart count or answer by default. Debug sampling requires explicit permitted redaction, short retention and audited access; observability backend has independent egress approval. Avoid per-sensitive-entity metric labels. Separate internal security counters from caller-visible status to avoid existence leaks.

## Incident / restore acceptance

If unauthorized context/citation/egress is suspected: stop affected retrieval/generation egress, fence generation/policy scope, preserve minimal evidence and access logs, revoke provider grants when authorized, investigate disclosure and owner notification under policy. Do not simply rerank until bad text disappears. Recover through permitted exact/structured retrieval, then revalidate authorization/races/deletion before re-enabling ANN or answers.

Restore drill: recover canonical DB/files/config and current erasure/control log into isolated services with providers disabled; replay tombstones/rights changes; rebuild or reconcile derived generations; compare allowed-source counts/hashes and denied-source absence; run revoked employee/public-private/deleted-citation tests; only then enable serving. Record recovery time/data-loss window against owner-approved RPO/RTO (currently UNKNOWN). Full benchmark/reindex/restore evidence is required by RAG-401 and QA-001; current deterministic fixtures do not establish it.
