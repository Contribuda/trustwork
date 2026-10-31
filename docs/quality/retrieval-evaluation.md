# Retrieval evaluation, adversarial tests and release gates

All numerical thresholds are **initial proposed targets to validate**, not achieved quality, traffic or capacity claims. This repository supplies deterministic fake-vector/authority fixtures only. They validate contract decisions and negative boundaries, not Russian language understanding, pgvector recall, real DB authorization, provider quality or production latency.

## Versioned benchmark corpus

RAG-101 owns a frozen, licensed/consented or synthetic corpus manifest with hashes, source versions, language, audience/party/field policy, time/status and table/locator maps. Separate training/tuning from held-out entities, companies, projects and time periods; avoid chunk leakage between sets. Annotate graded relevance, required exact facts/filters, valid citations, answerable vs unanswerable vs conflicting evidence, and forbidden sources. Two qualified reviewers adjudicate a sample and disagreements; keep annotation provenance. Do not use real private data in public CI or send it to a model without its specific data policy.

Proposed initial relevance set: 300 held-out queries (at least 180 Russian, 60 Russian/English cross-language or mixed, 60 spelling/OCR/table/abbreviation cases; categories may be stratified separately) plus at least 100 adversarial access/race/deletion cases. Expand based on observed failures, not a claim that these counts are statistically sufficient. Use bootstrap confidence intervals and per-slice results; a good mean cannot hide permission failures or exact-identifier errors. Human interviews inform usefulness separately; none has happened yet.

Cover supplier/company discovery; exact company name and legal identifier; goods + works/services bundles; person expertise and governed relations; project/need matching; technical grades/standards; Russian synonyms/declension, Latin/Cyrillic confusables, transliteration and typos; OCR errors, scanned tables with repeated headers/merged cells/units; multilingual entity spelling; multi-intent filters; stale availability; quote/RFQ amendments; claims vs confirmed/disputed facts; absence/conflict requiring abstention. Expected no-answer does not reveal inaccessible content.

## Metrics and proposed blocking criteria

| Measure | Initial target / gate | Interpretation |
|---|---|---|
| Unauthorized content/identifier/snippet/citation/field/side-channel fixture | Zero observed leaks; any failure blocks release | Test all access boundaries; finite tests do not prove universal security |
| Exact identifier, mandatory filter and numeric resolver fixtures | 100% correct on deterministic gold | No semantic substitution or relaxed spec; calculations checked independently |
| Authorized vector Recall@20 vs exact authorized oracle | >=0.95 per tested selectivity/scope stratum | Measure ANN approximation separately from relevance; strict order is not recall |
| Held-out relevance nDCG@10 / Recall@20 | >=0.80 / >=0.90 and no material regression vs lexical baseline | Proposed; report uncertainty, languages and entity-type slices; revise with review |
| Citation source/version/locator and access correctness | 100% deterministic; zero unauthorized in human sample | Resolve actual fragment and exact claim support; citation syntax alone is insufficient |
| Human-rated supported factual claims | >=0.98 precision on adjudicated sample | Separate canonical facts, attributed claims and disputes; no fabricated citations |
| No-answer recognition | >=0.95 precision and >=0.90 recall on unanswerable/conflict set | Both hallucination and unnecessary abstention matter; disclose denominators |
| Retrieval latency | p95 <=800 ms, p99 <=2 s under agreed peak mix | Search portion; independent model generation latency/cost measured separately |
| Permitted source-to-index freshness | p95 <=60 s normal, <=15 min agreed bulk backlog | Initial targets; stale current facts never substituted while lagging |
| Revocation security | No new response/citation admission after authoritative fence | Distinct from async cleanup target; already admitted network bytes cannot be recalled |
| Transaction p95 impact / resource isolation | <=20% increase over no-retrieval baseline | Proposed migration/scale trigger, not permission to overload core transactions |

Do not use model-as-judge scores alone for groundedness, authorization or money. Unit tests validate deterministic contract helpers; PostgreSQL integration tests exercise actual query plans/RLS roles; model evaluations use frozen provider versions; human review checks useful evidence and interpretation. Report failures and exclusions, never mark unknown measurements passed.

## Adversarial matrix

Exercise anonymous, own person, own company without object grant, authorized project participant, buyer, seller, unrelated company, revoked employee, support without case grant, and explicitly granted historical reader. For each, test source retrieval, exact/lexical/dense/fusion/rerank, hydration/provider egress, cached answer, saved conversation turn, autocomplete/facet/count, citation URL, attachment URL and final dispatch.

Mandatory races/faults: revoke between candidate scan and hydration; revoke between context and model call; revoke after generation before final admission; policy update between final preflight and dispatch (require admission fence); pooled connection reused by different principal; RLS policy-table change during query; public-to-private while stale ANN/lexical/cache remains; duplicate/out-of-order index jobs; deleted source restored from backup; model-generation rollback with newer tombstone; revoked consent; changed attachment locator; stale RFQ/quote; old saved citation; model returns valid-looking citation for unrelated claim; source says to reveal seller floor/send order/ignore policy; prompt or metric logging leakage. Tests must show untrusted text never changes an action mandate.

## Real cardinality, churn and selectivity protocol

Prepare synthetic permission-correct tiers of 10k, 100k, 1m and (if budget approved) 10m chunks; document entity/version/chunk expansion, dimension/precision, language/doc-length skew, shared-deal fanout and relationship density. These are **test inputs**, not expected customer volumes. Benchmark exact baseline first, then public HNSW and any proposed private cohorts. Run 1%, 0.1%, 0.01% and broad filters, tiny permitted sets, mixed party/field ACLs, cold/warm cache, 1/10/50 concurrent requests and 0/1/5% per-minute source/ACL churn. Tune tiers and duration to actual hardware/budget and report omitted cases.

Record PostgreSQL/pgvector build, extension settings, hardware, memory, rows/index size, schema, model revision, execution plans, iterative scan/overfetch budgets, freshness and active jobs. Use at least three 30-minute peak runs after warmup, with exact oracle checks and separate ingestion/transaction stress. Underfilled top-k, fallback timeouts and out-of-memory are failures/partial results, not successful empty matches. Repeat with unauthorized decoy vectors to detect cross-scope rank/recall/speed influence; do not hide the security limitation of a shared ANN graph.

## Release chain and current fixture limits

RAG-101 research/eval specification -> FND-002 shared contracts -> data/backend -> RAG-201 projection/indexer and RAG-301 retrieval -> RAG-401 real quality/security/operations evidence -> QA-001 -> authorized deployment -> explicit client approval. WEB-003 search/citation/freshness flows can use frozen fixtures after contracts and design; final integration waits for retrieval. No circular requirement for evaluation acceptance before implementing the component it evaluates.

`npm test` recursively discovers `tests/retrieval/*.test.ts`. Current fixtures use tiny predefined vectors and in-memory current policy/source records, and test authz gates, freshness, model generation, tombstones, citation lineage, RRF ranking and typed exact-fact authority. They do not install pgvector, call a model, simulate a production distributed fence or measure ANN performance. Runtime RLS/pool-race, real HNSW filtered recall, deletion backups and provider injection/groundedness checks remain explicit task acceptance work.

Additional required cases: mixed shared-deal/buyer-budget/seller-floor material never reaches embedding; saved multi-source answer audience intersection; employee exit invalidates personal assistant access; revoke between provider preflight and admission; missing/reused pooled identity fails closed; complete-domain totals/minima versus misleading top-k; all dependency invalidation after postprocessing and generation rollback.

BE-001 must prove common admission/revocation correctness before RAG-201 acceptance. RAG-201 repeats the preflight-to-actual-embedding-dispatch revocation race at its adapter boundary; RAG-301 reuses the same primitive. Negative binding fixtures cover query/document confusion, provider policy/revision, model/configuration, data class, payload digest, scope, principal, expiry and policy epoch. These fixtures do not authenticate a permit or implement production anti-replay/fencing.
