# Articles list and article detail

Routes: `/articles`, `/articles/[slug]`.

## Status and evidence

`proposed (reference: accepted direction)` for the list pattern — the "Articles and analyses" block of `public-home.png` (private design archive) and the publication cards in companies/people hubs; `no reference` for the detail page. Spec R15, R16 (author, format, topics, entity links, lifecycle, corrections; walls reference the same publication record), "Content and editorial" (format separate from topic taxonomy).

## Audience and access policy

Same as news: published/corrected items for everyone; bookmark and authoring require login. Author identity appears only as a public projection (person or company public page); an author who withdrew consent for a public profile is shown by name only if policy permits, otherwise "Author" with no link.

## Data projection

| Field | Public |
|---|---|
| Title, lede, cover (licensed), body with headings/figures/tables | yes |
| Format (analysis, practice, experience, opinion, interview, project story, overview; `articles.formats.*`) | yes, badge |
| Topics (materials, technologies, markets…) | yes, chips |
| Author kind + author public page; "with the assistant's help" flag if assistant-assisted | yes |
| Published/updated time; version number and correction history | yes |
| Entity links: companies, people, projects (public projections only) | yes |
| Attached files | only if explicitly published |
| Drafts, review notes, scheduled versions | never |

## Primary tasks

1. Browse by format and topic.
2. Read an article comfortably on any width.
3. See who wrote it and what it references.
4. Save it, share it, or start writing one.

## Layout regions

| Width | List | Detail |
|---|---|---|
| Desktop ≥1280 | Public shell; H1 "Articles and analyses"; format tabs (All, Analyses, Practice, Experience, Opinions, Interviews); topic chips; filter row (topic, author kind, period, sort); card grid 2 columns (cover, format badge, title, lede, author, time, bookmark); right rail "Useful at hand", "Something to share?" (`articles.ctaTitle`); pagination | Public shell; breadcrumb; format badge; H1; lede; byline with author avatar/logo and link; cover; article body max ~720 px with left-aligned text, figures full width ~960 px; sidebar (sticky) with table of contents on ≥1280; CorrectionBanner; entity links block; "More on the topic"; share/bookmark actions |
| Tablet | Grid 2 columns; rail below; detail single column, TOC collapsible above body | |
| Mobile <768 | Tabs scroll horizontally; grid 1 column; filters in sheet; detail single column, 16 px gutters, tables scroll horizontally inside a region with visible edge | |

## Component inventory

PublicShell, Tabs (format), ChipGroup, FilterSelect/FilterSheet, PublicationCard, Pagination, RailCard, Byline, ArticleBody (prose styles, figure, blockquote, table wrapper), TableOfContents, CorrectionBanner, EntityLinkList, ShareButton, BookmarkButton, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | "No articles in this format yet" + link to all |
| Loading | Skeleton cards; detail streams body server-side |
| Error | Inline error with retry |
| Permission-denied | Unpublished slug → 404 (no existence leak) |
| Offline | Cached detail readable; actions disabled with toast |
| Partial/stale | Corrected versions show banner; an article whose entity link target became private shows the entity as plain text without link |

## Keyboard order and focus

Shell → H1 → tabs (arrow keys) → chips → filters → cards (one tab stop per card title; bookmark separate) → pagination → rail. Detail: shell → breadcrumb → H1 → byline author link → TOC links → body (headings reachable via screen reader) → entity links → related. Share menu is a popover with focus return.

## Responsive table behaviour

Article body tables: on <768 the table sits in a horizontally scrollable region with `tabindex="0"`, `role="region"` and `aria-label` from the caption; headers stay visible (sticky first column optional). Never reflow editorial tables into cards (data meaning depends on columns).

## Locale keys

| Key | English |
|---|---|
| `articles.title` | Articles and analyses |
| `articles.lede` | Explanations, comparisons and practical material from the editors, professionals and companies. |
| `articles.formats.all` | All |
| `articles.formats.analysis` | Analysis |
| `articles.formats.practice` | Practice |
| `articles.formats.experience` | Experience |
| `articles.formats.opinion` | Opinion |
| `articles.formats.interview` | Interview |
| `articles.formats.projectStory` | Project story |
| `articles.formats.overview` | Overview |
| `articles.authorKind.editorial` | Editorial |
| `articles.authorKind.person` | Author |
| `articles.authorKind.company` | Company |
| `articles.assistantAssisted` | With the assistant’s help |
| `articles.readTime` | {minutes} min |
| `articles.toc` | Contents |
| `articles.mentions` | Mentioned in this material |
| `articles.moreOnTopic` | More on the topic |
| `articles.empty` | No articles in this format yet |
| `articles.write` | Write an article |
| `common.share` | Share |
| `common.tableScrollHint` | The table scrolls horizontally |
| `common.updated` | Updated {date} |

## Open questions

- Reading time: computed or omitted (reference shows it; it is not a stored claim).
- Whether comments exist on articles (not in spec; propose out of scope for first slice).
