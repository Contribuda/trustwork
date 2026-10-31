# Articles list and article detail

Routes: `/articles`, `/articles/[slug]`.

## Status and evidence

`proposed (reference: accepted direction)` for the list pattern — the «Статьи и разборы» block of `public-home.png` (private design archive) and the publication cards in companies/people hubs; `no reference` for the detail page. Spec R15, R16 (author, format, topics, entity links, lifecycle, corrections; walls reference the same publication record), "Content and editorial" (format separate from topic taxonomy).

## Audience and access policy

Same as news: published/corrected items for everyone; bookmark and authoring require login. Author identity appears only as a public projection (person or company public page); an author who withdrew consent for a public profile is shown by name only if policy permits, otherwise «Автор» with no link.

## Data projection

| Field | Public |
|---|---|
| Title, lede, cover (licensed), body with headings/figures/tables | yes |
| Format (разбор, практика, опыт, мнение, интервью, история проекта, обзор) | yes, badge |
| Topics (materials, technologies, markets…) | yes, chips |
| Author kind + author public page; «при участии помощника» flag if assistant-assisted | yes |
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
| Desktop ≥1280 | Public shell; H1 «Статьи и разборы»; format tabs (Все, Разборы, Практика, Опыт, Мнения, Интервью); topic chips; filter row (topic, author kind, period, sort); card grid 2 columns (cover, format badge, title, lede, author, time, bookmark); right rail «Полезно под рукой», «Есть чем поделиться?»; pagination | Public shell; breadcrumb; format badge; H1; lede; byline with author avatar/logo and link; cover; article body max ~720 px with left-aligned text, figures full width ~960 px; sidebar (sticky) with table of contents on ≥1280; CorrectionBanner; entity links block; «Ещё по теме»; share/bookmark actions |
| Tablet | Grid 2 columns; rail below; detail single column, TOC collapsible above body | |
| Mobile <768 | Tabs scroll horizontally; grid 1 column; filters in sheet; detail single column, 16 px gutters, tables scroll horizontally inside a region with visible edge | |

## Component inventory

PublicShell, Tabs (format), ChipGroup, FilterSelect/FilterSheet, PublicationCard, Pagination, RailCard, Byline, ArticleBody (prose styles, figure, blockquote, table wrapper), TableOfContents, CorrectionBanner, EntityLinkList, ShareButton, BookmarkButton, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | «Пока нет статей в этом формате» + link to all |
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

| Key | Russian |
|---|---|
| `ru.articles.title` | Статьи и разборы |
| `ru.articles.lede` | Объяснения, сравнения и практические материалы от редакции, специалистов и компаний. |
| `ru.articles.formats.all` | Все |
| `ru.articles.formats.analysis` | Разбор |
| `ru.articles.formats.practice` | Практика |
| `ru.articles.formats.experience` | Опыт |
| `ru.articles.formats.opinion` | Мнение |
| `ru.articles.formats.interview` | Интервью |
| `ru.articles.formats.projectStory` | История проекта |
| `ru.articles.formats.overview` | Обзор |
| `ru.articles.authorKind.editorial` | Редакция |
| `ru.articles.authorKind.person` | Автор |
| `ru.articles.authorKind.company` | Компания |
| `ru.articles.assistantAssisted` | При участии помощника |
| `ru.articles.readTime` | {minutes} мин |
| `ru.articles.toc` | Содержание |
| `ru.articles.mentions` | В материале упоминаются |
| `ru.articles.moreOnTopic` | Ещё по теме |
| `ru.articles.empty` | Пока нет статей в этом формате |
| `ru.articles.write` | Написать статью |
| `ru.common.share` | Поделиться |
| `ru.common.tableScrollHint` | Таблицу можно прокрутить по горизонтали |
| `ru.common.updated` | Обновлено {date} |

## Open questions

- Reading time: computed or omitted (reference shows it; it is not a stored claim).
- Whether comments exist on articles (not in spec; propose out of scope for first slice).
