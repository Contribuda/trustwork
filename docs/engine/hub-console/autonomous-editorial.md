# The autonomous editorial office

Status: **Proposed**. Contract: `HubSourceSchema`, `AllowedUsesSchema`, `RobotsCheckSchema`, `TermsCheckSchema`, `PipelineVersionSchema`, `PipelineStepSchema`, `EditorialItemSchema`, `editorialApprovalBlockers`, `AiImageSchema`, `ContentTypeMappingSchema`, `RecommendationRuleSchema`, `SponsoredContentPolicySchema`, `HUMAN_GATES` in [`hub.ts`](../../../packages/contracts/src/hub.ts); publications and issues in `content.ts`. Screens HC-40…HC-49 and HC-54 in [screens](screens.md#editorial-office). Backend: proposed EDIT-001 and REC-001; runs on the pipeline engine of [automation](automation-and-scheduling.md).

A new hub must not start from an empty page, and a small editorial team cannot read the whole internet. The editorial office lets model-assisted pipelines do the tireless part (finding sources, checking whether they may be used, fetching, deduplicating, drafting, translating, checking, illustrating, assembling) while people keep every decision that matters: which sources are used, what is published, what the magazine says. The newsroom rules of [publishing](../publishing.md) stay intact: sources are named, dates are honest, corrections are visible, AI assistance is labelled, and **imported items are never published without a person's decision**.

The "agents" of the editorial office are **pipeline stages run by the hub**, configured in the console. They are not participants' agents, have no mandates, no budgets of anyone else, and no presence in the product; the console shows pipelines and stages, never a list of bots.

## The flow

```text
discover → check legal → propose source ──(person approves)──▶ active source
active source → fetch → parse → normalise → deduplicate → classify → link entities
             → treatment (headline+link | summary | rewrite | translation)
             → similarity check → fact check → illustrate (licensed or labelled AI)
             → propose for review ──(editor approves / returns / rejects)──▶ scheduled → published
published items → magazine assembly proposal ──(editor-in-chief curates and releases)──▶ issue
```

Every arrow into a person is a **human gate** (`source_activation`, `publication`, `magazine_release`). There is no `publish` step in the pipeline vocabulary (`PIPELINE_STEPS`), and content pipelines must end in `propose_for_review` (`PipelineVersionSchema`). Automation levels change who *starts* the work, not who *decides*:

| Level | What happens without a person | What always needs a person |
|---|---|---|
| `manual` | Nothing; staff run each step | Every step and every decision |
| `assisted` | Steps run when a person starts a run; drafts appear as suggestions | Starting runs; every gate |
| `supervised_autonomous` | Scheduled runs go from discovery to the review queue on their own, within caps and windows | Every gate; raising a domain to this level needs a second person and active caps |

## 1. Discovering sources

A **source discovery** pipeline searches the web (through a `web_search` connection) and peers' public feeds for thematic sites in the hub's territory and languages: trade media, associations, regulators, standards bodies, procurement portals, statistics offices, manufacturers and suppliers, training providers, event organisers. For each candidate it records, **before proposing it**:

| Check | Recorded as | Effect |
|---|---|---|
| Licence | `SourceLicenceSchema`: open licence, public domain, statutory public data, publisher agreement, press release, all rights reserved, unknown | Unknown or all-rights-reserved sources can only show headline and link and be indexed; no full text, models, translation, rewriting, images or syndication |
| robots.txt | `RobotsCheckSchema`: URL, user agent, allowed, crawl delay, digest of the file | Crawling kinds (`sitemap`, `web_page`) require `allowed` |
| Terms of use | `TermsCheckSchema`: URL, digest of the terms page, automated access permitted / forbidden / unclear / not applicable, reviewer, notes | Crawling requires `permitted`, recorded by a person; "unclear" means no crawling |
| Feeds and APIs | RSS, Atom, sitemap, API documentation found | Preferred over crawling whenever they exist |
| Personal data | Whether the source contains personal data and on what legal basis | Personal data needs a recorded legal basis |
| Takedown contact | Where removal requests go | Required |

The candidate arrives in **Discovery** as a proposal (`proposedBy: pipeline`). A data steward or the editor-in-chief reviews it, adjusts purposes and allowed uses (constrained by the licence), writes the attribution template, assigns an owner and **activates** it. Only people activate sources (`activatedBy` is a person, enforced by the contract).

US examples a discovery run might propose (all candidates): state contractor licensing board news pages, SAM.gov contract opportunities (API, statutory public data), state Department of Transportation procurement notices, the US Census Bureau construction spending releases, OSHA news releases, trade association newsrooms, manufacturers' technical libraries. Samarkand: regional administration announcements, the national e-procurement portal (candidate), association news.

## 2. Ingestion

Per active source the operator sets the kind (RSS, Atom, sitemap, API, file drop, press inbox, peer feed, page crawl where permitted), the schedule ([automation](automation-and-scheduling.md)), a per-host request limit honouring the source's crawl delay, and **auto-pause triggers**: robots.txt changed, terms page digest changed, licence ended, error streak, cap reached, takedown. A paused source says why (`pauseReason`) and needs a person to resume, after re-checking.

Ingested items store the source URL, retrieval time, content digest and the **licence snapshot** under which they were fetched, so a later licence change never silently re-legitimises old copies.

## 3. Deduplication

Duplicates are common (the same press release in five outlets, the same notice in two portals). Steps: canonical URL; exact content digest; near-duplicate detection (MinHash or n-gram shingles); cross-language duplicates through embeddings when the embeddings route allows the data. Duplicates are grouped into one **story cluster**; the draft cites every source in the cluster, the earliest first. The data steward can split or join clusters (`admin.sources.dedupe.decide`).

## 4. Treatments

The licence decides the strongest treatment allowed (`AllowedUsesSchema`):

| Treatment | Allowed when | Output |
|---|---|---|
| `headline_link` | Always (if display of headline and link is allowed) | Headline, source, date, link |
| `summary` | `displaySummary` | A short summary in the hub's words, quoting at most a short marked quotation |
| `rewrite` | `rewriteWithAttribution`, which requires `storeFullText` | A new text in the hub's editorial voice, with attribution to every source, no paragraphs carried over |
| `translation` | `translate` | A linked edition in another hub language, labelled machine-assisted until a person reviews it |
| `original_reporting` | Staff-written | Normal editorial work |

Any model use also requires `sendToModelProviders` on the source and an allowed egress cell for `public` data on the route's connection.

## 5. Plagiarism safeguards

- **Similarity check** after every rewrite or summary (`similarity_check` must follow `rewrite`): maximum overlap with any source by n-gram Jaccard or MinHash, against a threshold set in editorial policy (for example 0.35). Above the threshold the item cannot be approved (`similarity_above_threshold`).
- Quotations are marked as quotations, attributed, short, and counted separately.
- Paywalled or "all rights reserved" text is never stored in full and never rewritten.
- Attribution is mandatory: the item's attribution text names every source in the cluster; the published item links them.
- The reader sees «Prepared with AI assistance from [sources]; reviewed by [editor]» when any AI step was used.

## 6. Fact and source checks

The `fact_check` step extracts checkable claims (dates, amounts, names, places, regulatory references) and looks for support in a second independent source, an official register or the item's own primary source. Each claim is `supported`, `contradicted` or `unverifiable` with evidence links (`FactCheckSchema`). A contradicted claim blocks approval; unverifiable claims are highlighted for the editor. Structured facts (amounts, dates, counts) are compared exactly, not by text similarity.

## 7. Images

Preferred order: the source's own image if its licence allows reuse (`reuseImages`), a licensed image from the hub's library, the engine's generated artwork, then an **AI-generated illustration**. AI images:

- are labelled for readers («Illustration generated by AI») next to the image and in its caption, and in file metadata (IPTC digital source type `trainedAlgorithmicMedia`; C2PA content credentials where the toolchain supports them) — `readerLabel: true`, `metadataLabel` in the contract;
- never depict a real, identifiable person (`depictsRealPerson: false`), a real site or event presented as documentary, or a company's products as if photographed;
- are generated from prompts that contain public data only (the image route allows only `public`).

## 8. Review queue

The **review workbench** shows the draft beside its sources, the similarity meter, fact checks, the treatment and the licence that allowed it, the AI steps used, the image and its label, the proposed topics, entity links and target languages. The editor can edit, approve, return with a note, or reject; approval records the person (`review.decision = approved`) and is the only way an item reaches `approved`, `scheduled` or `published`. `editorialApprovalBlockers` lists anything that prevents approval (similarity, contradicted claim, licence forbids the treatment, model use, translation or image reuse). Translations needing human review per language (editorial policy) appear in their own queue.

## 9. Editorial calendar and publishing schedules

The calendar is a list first (accessible, phone-friendly), a month grid on desktop. It shows planned slots (for example "regulation round-up every Monday 08:00"), scheduled items, embargoes, magazine issue dates and the pipelines that feed each slot. Editors drag nothing: they assign items to slots with buttons, and the scheduled time is stored in UTC with the hub's time zone for display. Publication at the scheduled time is performed by the content module on the editor's prior approval.

## 10. Magazine assembly

A `magazine_assembly` pipeline proposes an issue from the week's published items: sections by rubric, an ordering rationale, a draft editor's letter labelled as AI-assisted. The editor-in-chief curates the table of contents (move up / move down), writes or edits the letter, runs the release checklist (web reader on mobile, PDF rendered and checked page by page, accessibility plan) and releases. Released issues are frozen ([magazine](../magazine.md)).

## 11. Manufacturer and supplier knowledge (ADR 010 decision 19)

The editorial office also discovers **manufacturers and suppliers** relevant to the territory and builds **sourced company pages** from their public sites, within each source's licence, robots and terms:

- **Content-type mapping** per source (`ContentTypeMappingSchema`): rules by path prefix and schema.org type map pages to `company_profile`, `catalogue_item`, `training`, `guide`, `technical_article`, `event`, or `ignore`. Unmapped pages are ignored. The data steward tests a mapping with a dry run that lists what would be imported.
- **Rate limits and refresh**: per-host request limits and a refresh schedule per source (weekly for catalogues, daily for events, for example).
- **Sourced, never claimed by us**: the page shows «From sources» with the source and date; facts carry field-level provenance. The manufacturer can **claim** the page through the normal claim flow and recipes ([modules](modules.md#people-and-companies)); after a claim the company controls its page and the sourced fields become suggestions it may accept.
- **Takedown**: a manufacturer's request removes the source's records, tombstones reach indexes and peers, and the audit records why.
- **Indexing**: catalogue items, training, guides, technical articles and events are indexed in search and the knowledge base with their licence flags; a guide that may be cited but not reproduced is answered with a citation and a link.

### Plan-step recommendations

For each step of a participant's project plan, the system recommends materials and products, articles and guides, training and courses, events, consultants, contractors and contacts. The console configures this in **Data → Recommendations** (HC-54):

- **Plan-step taxonomy mapping**: plan-step categories (from planner templates, for example `foundation`, `roofing`, `electrical`) map to hub taxonomy categories, content types and licence categories.
- **Recommendation rules** (`RecommendationRuleSchema`): per plan-step category, which kinds to recommend, how many, whether sourced (unclaimed) records may appear, and which **signals** may rank them: plan-step match, category match, region served, licence valid, language match, freshness, verified status, reputation with sample sizes, availability. **Payment, sponsorship and plan tier do not exist as signals.** People and firms are recommended only where they serve the region. Every recommendation shows its explanation (`explanationShown: true`): "matches step Foundation; serves Travis County; licence verified 2026-09-12; 14 confirmed projects".
- **Sponsored-content policy** (`SponsoredContentPolicySchema`): a hub may forbid sponsored content or allow it only in a separately labelled slot, with a verified sponsor, at most a few slots per page, and **never** in search results, matching results, plan recommendations, reputation or directory order. It never affects ranking or matching.
- **Quality metrics** (aggregate): recommendation coverage per plan-step category (how many steps had at least one verified recommendation), share of sourced versus claimed items, freshness, takedown and complaint counts, click-through as cohort counts only. No per-person profiles of what someone looked at.

## 12. Per-source and per-pipeline settings, logs, metrics and costs

| Level | Settings | Metrics (aggregate) |
|---|---|---|
| Source | Kind, purposes, licence, legal checks, allowed uses, attribution, takedown contact, owner, schedule, request limits, auto-pause triggers, content-type mapping | Items fetched, new, duplicates, skipped by licence or robots, accepted into publications, last success, error streak |
| Pipeline | Steps and their model routes, automation level, cap, schedule, thresholds (similarity, relevance), target languages | Runs, success rate, items proposed, acceptance rate by editors, median time in review, cost per run, **cost per published item** |
| Editorial office | Policy: review rules per format and author type, languages needing human review, AI labelling texts, similarity threshold | Published items per week by treatment, corrections and retractions, share of AI-assisted items, reader-visible corrections |

Run logs are structured step events (counts, durations, model route used, cost, error codes); they never contain secrets, full prompts with private data, or private chain-of-thought.

## US and non-US example in one table

| Setting | US hub | Samarkand hub |
|---|---|---|
| Languages | Drafts in English; translations to `es-US` need human review | Drafts in Uzbek Latin; translations to Russian need human review |
| Sources | SAM.gov opportunities (API), state DOT notices, Census construction spending, trade media RSS, manufacturer technical libraries | Regional administration news, national procurement portal (candidate), association news |
| Models | Vendor route for public rewriting; self-hosted for anything private | Self-hosted in-country for everything; vendor only for public data if allowed |
| Schedule | Weekdays 05:00–07:00 Central for ingestion; magazine every Friday | Weekdays 06:00–08:00 Samarkand time; magazine every Thursday |

## Acceptance (when implemented)

- No code path publishes, schedules or releases without a person's approval record.
- A crawling source without recorded robots permission and permitting terms cannot be saved.
- A robots or terms change pauses the source automatically.
- A rewrite above the similarity threshold cannot be approved.
- AI images carry the reader label and the metadata label; prompts contain public data only.
- Recommendations are identical with and without sponsorship or paid plans (comparison test).
