# News list and news detail

Routes: `/news`, `/news/[slug]`.

## Status and evidence

`proposed (reference: content pattern only)` — `news.png` (private design archive), manifest `content_pattern_only`: "Old header must be replaced with seven accepted public sections." Spec R15, R16 and "Content and editorial" (news carries source and event/publication times). Detail page has no reference.

## Audience and access policy

Anonymous and authenticated readers see the same published items. Bookmark and «Предложить материал» require authentication. Editorial actions never appear here. Retracted items are not listed; a direct link to a retracted slug shows an explanatory record only if policy permits.

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
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; search + «Найти»; chip row (topics); filter row (period, region, source, sort); main column: day groups («Сегодня», «Вчера», dates) with rows (time, topic label, title, lede, source type, «К источнику», optional thumbnail, bookmark); right rail: «Темы в фокусе», «О новостной ленте», «Нужен контекст?»; «Показать ещё» + pagination | Public shell; breadcrumb; topic label; H1; byline (author kind, published time, event time, source); correction banner if corrected; body; source block («Первоисточник», link, source type); entity links; related news; footer |
| Tablet | Filters wrap to two lines; rail below list; detail single column max ~720 px | |
| Mobile <768 | Chips scroll horizontally; filters collapse into a «Фильтры» sheet button with active-count badge; rows stack (time + topic on one line, thumbnail below title); «Показать ещё» as primary pagination; rail at bottom | Single column; sticky source link at the end |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect, FilterSheet (mobile), DayGroupHeader, NewsRow, SourceLink (external icon, `rel="noopener"`), BookmarkButton, Pagination, LoadMoreButton, RailCard, CorrectionBanner, Byline, EntityLinkList, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (no filter) | «Пока нет новостей» with link to articles |
| Empty (filtered) | «По этим условиям ничего не найдено» + «Сбросить фильтры» |
| Loading | Skeleton rows (5) preserving row height; filters disabled with `aria-busy` |
| Error | Inline error card with retry; filters stay usable |
| Permission-denied | Not applicable for list; detail of unpublished slug returns 404 page, never "forbidden" (do not reveal existence) |
| Offline | Cached list readable; bookmark toast «Нет соединения» |
| Partial/stale | Corrected item shows «Исправлено DD.MM» label; detail shows CorrectionBanner with link to revision list; retracted shows RetractionNotice |

## Keyboard order and focus

Shell order → breadcrumb → H1 → search → chips (roving tabindex, arrow keys) → filters → rows (title is the link; «К источнику» and bookmark are separate tab stops) → «Показать ещё» → pagination → rail. After «Показать ещё», focus moves to the first new row and a live region announces «Загружено ещё N новостей». Filter sheet is a modal dialog with focus return.

## Responsive table behaviour

No tables; the list is a semantic `<ul>`/`<article>` list, not a table.

## Locale keys

| Key | Russian |
|---|---|
| `ru.news.title` | Новости отрасли |
| `ru.news.lede` | Что происходит в строительстве, производстве и на рынке материалов. *(wording from reference; editorial review)* |
| `ru.news.searchPlaceholder` | Найти новость, тему или источник |
| `ru.news.find` | Найти |
| `ru.news.allTopics` | Все темы |
| `ru.news.period` | Период |
| `ru.news.regions` | Все регионы |
| `ru.news.sources` | Все источники |
| `ru.news.sortNewest` | Сначала новые |
| `ru.news.today` | Сегодня |
| `ru.news.yesterday` | Вчера |
| `ru.news.toSource` | К источнику |
| `ru.news.primarySource` | Первоисточник |
| `ru.news.eventTime` | Событие |
| `ru.news.publishedTime` | Опубликовано |
| `ru.news.loadMore` | Показать ещё новости |
| `ru.news.loadedMore` | Загружено ещё {count, plural, one {# новость} few {# новости} many {# новостей}} |
| `ru.news.empty` | Пока нет новостей |
| `ru.news.emptyFiltered` | По этим условиям ничего не найдено |
| `ru.news.resetFilters` | Сбросить фильтры |
| `ru.news.topicsInFocus` | Темы в фокусе |
| `ru.news.aboutFeed` | О новостной ленте |
| `ru.news.howWeWorkWithSources` | Как мы работаем с источниками |
| `ru.news.needContext` | Нужен контекст? |
| `ru.news.readAnalyses` | Читать разборы |
| `ru.news.related` | По теме |
| `ru.common.filters` | Фильтры |
| `ru.common.bookmark` | Сохранить |
| `ru.common.bookmarked` | Сохранено |
| `ru.correction.banner` | Материал исправлен {date}. {summary} |
| `ru.correction.history` | История изменений |
| `ru.correction.retracted` | Материал отозван редакцией. |
| `ru.common.pagination` | Страницы |
| `ru.common.next` | Далее |

## Open questions

- Which source types are allowed and how source licensing is displayed (CNT-001 editorial source policy).
- Whether «Предложить материал» goes to a public form or requires login (propose: login, lands in `/app/publications/new`).
