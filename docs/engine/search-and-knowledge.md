# Search and knowledge

Requirement R31. Status: keyword search over public demo cards is **Demo** (`/search`); retrieval contracts (index generations, embedding configuration, citations) are **Contract** with deterministic fixtures; governed hybrid retrieval is **Designed** ([ADR 007](../adr/007-hybrid-retrieval.md), [retrieval architecture](../architecture/retrieval.md)); multilingual and federated retrieval are **Proposed**.

People ask questions like "who installed ventilated facades on schools in Samarkand in the last two years?" or "what does the new standard say about anchors?". Your agent asks harder ones while working for you. The engine answers from **permitted facts with citations**, never from a model's imagination and never from data the asker may not see.

## Three ways to find things

| Mode | What it does | Status |
|---|---|---|
| **Keyword search** | Every word of the query must occur in titles, ledes and labels of public cards (news, articles, events, companies, people, projects) | Demo |
| **Structured filters** | Category, region, format, date, badge, licence, capacity; exact and complete | Designed |
| **Cited answers** | Hybrid retrieval (lexical + semantic + structured facts), then an answer that cites exact source versions, shows freshness and says what it does not know | Designed |

## The architecture in one paragraph

Canonical records in PostgreSQL stay the truth. Derived, versioned **projections** separate field audiences before anything is embedded or sent to a model. Chunks and embeddings live in PostgreSQL with pgvector, alongside native full-text search and exact resolvers for structured facts (prices, dates, quantities, counts are answered from records, not from text similarity). Permissions are checked at **candidacy** (what may be considered), **hydration** (what may be read), **egress** (what may be sent to a model provider) and **delivery** (what may be shown now, re-checked at the moment of display). A saved answer that combines several sources is visible only to people who may see **all** of them.

## Index generations

An index generation is built, validated, activated, drained and retired: `building → validated → active → draining → retired`, plus `failed` and `tainted`. A generation that may have mixed public and private material is **tainted** and can only retire; queries fall back to exact permitted retrieval. Revocation, deletion and erasure produce tombstones that are replayed after any restore.

## Models

Candidate embedding models are evaluated locally first (multilingual models with 1024-dimensional vectors are on the candidate list). The exact model, revision, tokenizer, normalization, metric, licence and hardware are frozen per generation; vectors from different models never mix. No model is downloaded and no paid inference happens without authorization. Evaluation gates (recall against an exact oracle, latency under concurrent load, citation correctness) are proposals until measured.

## Many languages and scripts (Proposed)

| Challenge | Approach |
|---|---|
| Uzbek in Latin and Cyrillic scripts | Index both forms; transliterate queries; keep the original script in citations |
| Georgian and Armenian scripts | Full-text configuration per language; semantic models evaluated per language |
| Mixed-language documents (Russian specifications in an Uzbek hub) | Language detection per chunk; cross-lingual retrieval evaluated before claiming it works |
| Names of people and companies | Transliteration variants as structured aliases, not fuzzy guesses |

## Hub knowledge sources (Proposed)

A hub can register **knowledge sources** in its console: building codes and standards it is licensed to index, register extracts, public procurement notices, association guidelines. Each source carries licence flags (display, index, model egress, syndication). A standard that may be cited but not reproduced is indexed for search and answered with a citation and a link, not with its text.

## Search across the mesh (Proposed)

Each node indexes the **public replicas** it receives from peers as a separate source class with its licence flags ([Federation](federation.md)). Results show the home hub of each item. A node never indexes another node's `shared_party` data except for the parties of that deal, and never forwards private queries to peers.

## Invariants

- Retrieval never widens access: every result passes the same projection serializers as an API read.
- Structured facts (amounts, dates, quantities, counts) are answered from records with exact arithmetic, not from generated text.
- An answer without sufficient permitted evidence says so.
- Erasure and revocation reach indexes, caches and saved answers.
