# Search and knowledge

Requirement R31. Status: keyword search over public demo cards is **Demo** (`/search`); retrieval contracts (index generations, embedding configuration, citations) are **Contract** with deterministic fixtures; governed hybrid retrieval is **Designed** ([ADR 007](../adr/007-hybrid-retrieval.md), [retrieval architecture](../architecture/retrieval.md)); multilingual and federated retrieval, manufacturer and supplier knowledge and plan-step recommendations are **Proposed** (MAT-001, REC-001, AGT-021; [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 19).

People ask questions like "who installed ventilated facades on schools in Texas in the last two years?" or "what does the new standard say about anchors?". Your agent asks harder ones while working for you. The engine answers from **permitted facts with citations**, never from a model's imagination and never from data the asker may not see.

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
| Languages written in more than one script (for example Uzbek in Latin and Cyrillic, Serbian in Cyrillic and Latin) | Index both forms; transliterate queries; keep the original script in citations |
| Non-Latin alphabets (for example Georgian, Armenian, Greek, Cyrillic) | Full-text configuration per language; semantic models evaluated per language |
| Chinese and Japanese, written without spaces between words | PostgreSQL full-text search has no segmenter for them: n-gram indexing (for example `pg_trgm`) or a segmenter adapter with a fake, Unicode normalization and width folding for Japanese; recall measured per language before support is claimed (INTL-006 records the requirements; WEB-003 and RAG-201 implement them) |
| Hindi and other Devanagari text | Unicode normalization; the simple configuration until a stemmer is evaluated; Latin-script (transliterated) queries matched to Devanagari |
| Arabic | Normalize letter variants and optional diacritics for matching; keep the original text in citations; right-to-left display through INTL-005 |
| Mixed-language documents (Spanish specifications in a US hub, English datasheets in a German hub) | Language detection per chunk; cross-lingual retrieval evaluated before claiming it works |
| Names of people and companies | Transliteration variants as structured aliases, not fuzzy guesses |

## Hub knowledge sources (Proposed)

A hub can register **knowledge sources** in its console: building codes and standards it is licensed to index, register extracts, public procurement notices, association guidelines. Each source carries licence flags (display, index, model egress, syndication). A standard that may be cited but not reproduced is indexed for search and answered with a citation and a link, not with its text.

## Manufacturer and supplier knowledge (Proposed)

Owner decision 2026-10-31 (ADR 010 decision 19). Within the hub's legal basis and each source's licence and robots rules, the editorial office discovers manufacturers and suppliers and builds **sourced** company pages from their public sites ([publishing](publishing.md#manufacturer-and-supplier-sources-proposed), [autonomous editorial office](hub-console/autonomous-editorial.md#11-manufacturer-and-supplier-knowledge-adr-010-decision-19)). It indexes not only catalogues and products but also **learning resources**: installation guides, data sheets, warranty conditions, training, technical articles and events, tagged with plan-step terms. Only logged-off public pages are read, robots and licence rules are honoured, facts and links are stored rather than full documents unless licensed, and every field keeps its provenance. Pages stay labelled "from sources" until the company claims them (CLM-001); a takedown removes the item and propagates tombstones (MAT-001; entities [`product_entry`](../data/model.md#15-catalogue) and [`learning_resource`](../data/model.md#13-learning) in the data model).

## Plan-step recommendations (Proposed)

For every step of a participant's [plan](projects.md#plans-from-plan-to-people), the plan-step companion recommends what helps do that step well: materials and products, articles and guides, training and courses, events, consultants and contacts (REC-001; the agent module is AGT-021, [catalogue](agent-catalog.md#plan-step-companion)).

| Rule | How it holds |
|---|---|
| **Explained** | Every recommendation names the step it serves, the plan-step terms and criteria it matched (region, code or climate facets, trade, language, verified or sourced status) and what is unknown |
| **Matched on open data** | Plan items and targets meet through the CC0 [plan-step taxonomy](projects.md#what-a-plan-contains-proposed-plan-001) (PLAN-000) and structured attributes; semantic recall is added once governed retrieval exists (RAG-301), and retrieval is not a prerequisite ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 20) |
| **Never paid for** | Ranking uses a published, payment-blind recommendation method version, like matching; payment, commissions and sponsorship never change what is recommended |
| **Sponsored slot** | A hub may switch sponsored content on (it is **off by default**, ADR 012 decision 3); sponsored items appear only in a separate, labelled slot and never enter ranking, matching, recommendations or reputation |
| **Sourced stays sourced** | Sourced pages and products carry their label; being recommended never permits bulk outreach to a sourced company |
| **Private plan, public recommendations** | The companion reads the owner's private plan to choose; nothing about the plan reaches the recommended party. Step questions to a manufacturer are anonymous by default and show only the step, never the project, address or budget |

Hub staff review recommendation methods and sources in the console ([recommendations](hub-console/modules.md#plan-step-recommendations), screen HC-54).

## Search across the mesh (Proposed)

Each node indexes the **public replicas** it receives from peers as a separate source class with its licence flags ([Federation](federation.md)). Results show the home hub of each item. A node never indexes another node's `shared_party` data except for the parties of that deal, and never forwards private queries to peers.

## Invariants

- Retrieval never widens access: every result passes the same projection serializers as an API read.
- Structured facts (amounts, dates, quantities, counts) are answered from records with exact arithmetic, not from generated text.
- An answer without sufficient permitted evidence says so.
- Erasure and revocation reach indexes, caches and saved answers.
