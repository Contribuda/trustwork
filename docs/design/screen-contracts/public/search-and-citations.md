# Search results and retrieval states (cited answers, citations drawer)

Routes: `/search?q=` (public), `/app/search?q=` (workspace, same component with wider authorized scope), citation drawer opened from any cited answer (assistant, search, comparison).

## Status and evidence

`no reference`. Derived from [retrieval-api.md](../../../architecture/retrieval-api.md) (statuses `complete | partial | no_answer | unavailable`; answer statuses `supported | qualified | abstain` as typed in [`packages/contracts/src/retrieval.ts`](../../../../packages/contracts/src/retrieval.ts) (`DerivedAnswer.status`); evidence states `asserted | confirmed | disputed | superseded`; temporal modes `current` vs explicit versions; `GET /v1/citations/:opaqueId` reauthorizes), [retrieval.md](../../../architecture/retrieval.md) (no hidden counts, no unauthorized hints, stale generation, revocation), spec R31, WEB-003 acceptance ("Partial/no-answer/unavailable/historical/stale states readable and accessible; citations open exact permitted versions; denied/revoked answer history handled without cached employer text").

## Audience and access policy

| Viewer | Scope |
|---|---|
| Anonymous | Public projections only; no assistant answer generation (search list only) |
| Authenticated | Public + own person + current memberships + object participations, intersected at delivery |
| Any | Never sees total counts beyond delivered results, facets that reveal unauthorized sources, previews of denied documents, or whether a forbidden document exists |

Each citation open re-checks rights; a previously shown citation may now be "unavailable". Saved answers in history are re-authorized on open; after employment end, employer-derived evidence is withheld and the answer shows as degraded (never cached text).

## Data projection

| Element | Fields |
|---|---|
| Query echo | user text (as data, escaped); detected typed constraints as removable chips (region, kind, standard, RFQ version) — constraints never silently relaxed |
| Result item | kind icon + label (company, person, project, need, quote, publication, file), title, permitted snippet (original spelling/units), source/observation/freshness line, evidence state label, status badge for companies, version label when historical |
| Status banner | `complete` (none), `partial` ("Not all results are shown: …reason"), `no_answer` ("No available material matches your query"), `unavailable` ("Search is temporarily unavailable") |
| Temporal switch | "Current data" (default) / "Version as of…" (explicit); historical results labelled "Historical version of {date}" |
| Cited answer (authenticated, when AnswerPort enabled) | typed facts block (field, value, unit, as-of, scope complete/partial) separate from attributed claims with citation chips; status `supported` / `qualified` ("With qualifications: …") / `abstain` (answer omitted, evidence list still shown) |
| Citation drawer | source kind, title, version id + date, projection label, locator (page/table/row/fragment), evidence state, "Open the source" (to permitted page), "Unavailable" reason category (revoked / deleted / consent withdrawn / no longer in your scope) without revealing more |

## Primary tasks

1. Find a permitted entity or document by text.
2. Understand why results may be incomplete and what to do (narrow query, log in, ask the assistant).
3. Open a citation and verify the exact source version.
4. Switch between current and historical views deliberately.

## Layout regions

| Width | Results page | Citation drawer |
|---|---|---|
| Desktop ≥1280 | Shell (public or workspace); search field with constraint chips; left: status banner, results list; right rail: kind filters (checkboxes), temporal switch, "How search works" note | Right-side non-modal panel ~400 px, overlaying content without reflow; stacked above the assistant overlay if both open (z-index scale in the [layout proposal](../layout-and-tokens-proposal.md): overlay 20, panel/drawer 30) |
| Tablet | Rail collapses into filter bar above results | Same panel, ~360 px |
| Mobile <768 | Field + "Filters" (`common.filters`) button; results single column; banner full width | Full-height bottom sheet (modal), 16 px gutters |

## Component inventory

SearchField (with clear), ConstraintChip (removable, `aria-label` "Remove the condition …"), StatusBanner (variant per status, icon + text, `role="status"`), ResultItem, KindIcon, EvidenceLabel, FreshnessLine, HistoricalLabel, TemporalSwitch (radio group), CheckboxGroup (kinds), CitedAnswer (FactsTable + ClaimList), CitationChip (numbered, button, `aria-describedby` source), CitationDrawer (Panel/Sheet), UnavailableNotice, EmptyState, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty query | Suggestions: sections to browse; no "popular queries" from other users |
| Loading | Skeleton results; banner area reserved; `aria-busy` on list |
| Error (`unavailable`) | Banner + retry; previous results, if any, remain visible but marked "Previous results are shown" |
| Permission-denied | Workspace search by anonymous → redirect to `/login?next=`; individual denied results simply absent |
| Offline | "No connection" (`common.offline`); last results cached only for the same principal and epoch, otherwise cleared |
| Partial | Banner with reason category: query limit reached, some sources unavailable, semantic search disabled (degraded to lexical/structured) — never names the missing source |
| No-answer | Neutral text; never "the document exists but is hidden" |
| Stale generation | Banner "Data is being updated; results may be incomplete" + retry |
| Historical | Every item labelled; temporal switch shows selected date; a "Back to current" link |
| Revoked/unavailable citation | Chip stays numbered but styled as unavailable with text label; drawer shows UnavailableNotice; answer re-marked `qualified` or `abstain` if a dependency vanished |
| Disputed/superseded evidence | Label on item and in drawer; superseded links to the current version when permitted |

## Keyboard order and focus

Shell → search field → constraint chips → (desktop) results list → rail; status banner is `role="status"` announced on change, not a tab stop. Result item: title link, then citation chips if any. Citation chip opens the drawer: focus moves to drawer heading; `Escape` closes and returns focus to the chip; on desktop the drawer is non-modal (`aria-expanded` on chip) so the rest of the page stays reachable; on mobile it is modal. Temporal switch change announces the new mode.

## Responsive table behaviour

FactsTable (field, value, unit, as of, completeness) collapses to stacked `dl` per fact below 768; "completeness: incomplete scope" stays visible as text, not icon only.

## Locale keys

| Key | English |
|---|---|
| `search.placeholder` | Search the industry |
| `search.title` | Search results |
| `search.removeConstraint` | Remove the condition “{label}” |
| `search.kinds` | What to search |
| `search.kind.company` | Companies |
| `search.kind.person` | People |
| `search.kind.project` | Projects |
| `search.kind.rfq` | Needs |
| `search.kind.quote` | Quotes |
| `search.kind.publication` | Publications |
| `search.kind.file` | Files |
| `search.temporal.current` | Current data |
| `search.temporal.asOf` | Version as of a date |
| `search.historicalLabel` | Historical version of {date} |
| `search.backToCurrent` | Back to current data |
| `search.status.partial` | Not all results are shown: {reason} |
| `search.status.noAnswer` | No available material matches your query |
| `search.status.unavailable` | Search is temporarily unavailable |
| `search.status.stale` | Data is being updated; results may be incomplete |
| `search.status.previousShown` | Previous results are shown |
| `search.reason.budget` | the query size limit was reached |
| `search.reason.sourcesUnavailable` | some sources are temporarily unavailable |
| `search.reason.semanticOff` | semantic search is off; exact matches are shown |
| `search.howItWorks` | How search works |
| `search.emptyQuery` | Enter a query or open a section |
| `search.freshness` | Source: {source}, data from {observedAt} |
| `answer.facts` | Platform data |
| `answer.claims` | From sources |
| `answer.supported` | Supported by sources |
| `answer.qualified` | With reservations: {reason} |
| `answer.abstain` | Not enough confirmed data to answer. The material found is below. |
| `answer.scopeIncomplete` | Incomplete data scope |
| `citation.open` | Source {index} |
| `citation.title` | Source |
| `citation.version` | Version {version} of {date} |
| `citation.locator.page` | Page {page} |
| `citation.locator.table` | Page {page}, table {table}, row {row} |
| `citation.locator.text` | Text fragment |
| `citation.openSource` | Open the source |
| `citation.unavailable` | Source unavailable |
| `citation.unavailableReason.revoked` | Access revoked |
| `citation.unavailableReason.deleted` | Material deleted |
| `citation.unavailableReason.consent` | Consent to publish withdrawn |
| `citation.unavailableReason.scope` | Access to the source is restricted |
| `citation.close` | Close the source |

## Open questions

- Whether anonymous public search ships before RAG-301 (lexical-only via structured resolver) — WEB-003 and RAG lane.
- Exact reason categories for `partial` must be frozen in FND-002 so that UI never leaks source identity.
- Answer generation on the public site: proposal **no** (search list only); answers live in the workspace and assistant.
