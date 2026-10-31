# News list and news detail

Routes: `/news`, `/news/[slug]`.

## Status and evidence

`proposed (reference: content pattern only)` — `news.png` (private design archive), manifest `content_pattern_only`: "Old header must be replaced with seven accepted public sections." Spec R15, R16 and "Content and editorial" (news carries source and event/publication times). Detail page has no reference.

## Audience and access policy

Anonymous and authenticated readers see the same published items. Bookmark and "Suggest a material" require authentication. Editorial actions never appear here. Retracted items are not listed; a direct link to a retracted slug shows an explanatory record only if policy permits.

## Data projection

| Field | Public |
|---|---|
| Title, lede, body (detail), format `news` | yes |
| Source name, source URL, source type (industry media, manufacturer, event materials, scientific publication) | yes |
| Event time and publication time (distinct) | yes, both shown when they differ |
| Topic taxonomy (materials, technologies, markets…) and entity links (company/person/project) | yes, links only to public projections |
| Author kind (editorial/person/company), editor credit | yes; editor rights are not shown as authorship |
| Correction history (version, date, summary) | yes on detail |
| Region | yes |
| Internal review notes, scheduled items | never |

## Primary tasks

1. Scan what happened today/yesterday by topic.
2. Jump to the original source.
3. Filter by topic, period, region, source.
4. Read a news item and its corrections; follow entity links.

## Layout regions

| Width | List | Detail |
|---|---|---|
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; search + "Find"; chip row (topics); filter row (period, region, source, sort); main column: day groups ("Today", "Yesterday", dates) with rows (time, topic label, title, lede, source type, "To the source", optional thumbnail, bookmark); right rail: "Topics in focus", "About the news feed", "Need context?"; "Show more" (`common.showMore`) + pagination | Public shell; breadcrumb; topic label; H1; byline (author kind, published time, event time, source); correction banner if corrected; body; source block ("Primary source", link, source type); entity links; related news; footer |
| Tablet | Filters wrap to two lines; rail below list; detail single column max ~720 px | |
| Mobile <768 | Chips scroll horizontally; filters collapse into a "Filters" sheet button with active-count badge; rows stack (time + topic on one line, thumbnail below title); "Show more" (`common.showMore`) as primary pagination; rail at bottom | Single column; sticky source link at the end |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect, FilterSheet (mobile), DayGroupHeader, NewsRow, SourceLink (external icon, `rel="noopener"`), BookmarkButton, Pagination, LoadMoreButton, RailCard, CorrectionBanner, Byline, EntityLinkList, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (no filter) | "No news yet" with link to articles |
| Empty (filtered) | "Nothing matches these conditions" + "Reset filters" |
| Loading | Skeleton rows (5) preserving row height; filters disabled with `aria-busy` |
| Error | Inline error card with retry; filters stay usable |
| Permission-denied | Not applicable for list; detail of unpublished slug returns 404 page, never "forbidden" (do not reveal existence) |
| Offline | Cached list readable; bookmark toast "No connection" (`common.offline`) |
| Partial/stale | Corrected item shows "Corrected <date>" label; detail shows CorrectionBanner with link to revision list; retracted shows RetractionNotice |

## Keyboard order and focus

Shell order → breadcrumb → H1 → search → chips (roving tabindex, arrow keys) → filters → rows (title is the link; "To the source" and bookmark are separate tab stops) → "Show more" → pagination → rail. After "Show more" (`common.showMore`), focus moves to the first new row and a live region announces "Loaded N more news items". Filter sheet is a modal dialog with focus return.

## Responsive table behaviour

No tables; the list is a semantic `<ul>`/`<article>` list, not a table.

## Locale keys

| Key | English |
|---|---|
| `news.title` | Industry news |
| `news.lede` | What is happening in construction, manufacturing and the materials market. *(wording from reference; editorial review)* |
| `news.searchPlaceholder` | Find a news item, topic or source |
| `news.find` | Find |
| `news.allTopics` | All topics |
| `news.period` | Period |
| `news.regions` | All regions |
| `news.sources` | All sources |
| `news.sortNewest` | Newest first |
| `news.today` | Today |
| `news.yesterday` | Yesterday |
| `news.toSource` | To the source |
| `news.primarySource` | Primary source |
| `news.eventTime` | Event |
| `news.publishedTime` | Published |
| `news.loadMore` | Show more news |
| `news.loadedMore` | Loaded {count, plural, one {# more news item} other {# more news items}} |
| `news.empty` | No news yet |
| `news.emptyFiltered` | Nothing matches these conditions |
| `news.resetFilters` | Reset filters |
| `news.topicsInFocus` | Topics in focus |
| `news.aboutFeed` | About the news feed |
| `news.howWeWorkWithSources` | How we work with sources |
| `news.needContext` | Need context? |
| `news.readAnalyses` | Read the analyses |
| `news.related` | Related |
| `common.filters` | Filters |
| `common.bookmark` | Save |
| `common.bookmarked` | Saved |
| `correction.banner` | This material was corrected on {date}. {summary} |
| `correction.history` | Change history |
| `correction.retracted` | This material was retracted by the editors. |
| `common.pagination` | Pages |
| `common.next` | Next |

## Open questions

- Which source types are allowed and how source licensing is displayed (CNT-001 editorial source policy).
- Whether "Suggest a material" goes to a public form or requires login (propose: login, lands in `/app/publications/new`).
