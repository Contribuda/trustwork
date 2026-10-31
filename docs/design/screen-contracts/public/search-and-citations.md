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

Each citation open re-checks rights; a previously shown citation may now be «недоступно». Saved answers in history are re-authorized on open; after employment end, employer-derived evidence is withheld and the answer shows as degraded (never cached text).

## Data projection

| Element | Fields |
|---|---|
| Query echo | user text (as data, escaped); detected typed constraints as removable chips (region, kind, standard, RFQ version) — constraints never silently relaxed |
| Result item | kind icon + label (компания, человек, проект, потребность, предложение, публикация, файл), title, permitted snippet (original spelling/units), source/observation/freshness line, evidence state label, status badge for companies, version label when historical |
| Status banner | `complete` (none), `partial` («Показаны не все результаты: …reason»), `no_answer` («По вашему запросу нет доступных материалов»), `unavailable` («Поиск временно недоступен») |
| Temporal switch | «Текущие данные» (default) / «Версия на дату…» (explicit); historical results labelled «Историческая версия от {date}» |
| Cited answer (authenticated, when AnswerPort enabled) | typed facts block (field, value, unit, as-of, scope complete/partial) separate from attributed claims with citation chips; status `supported` / `qualified` («С оговорками: …») / `abstain` (answer omitted, evidence list still shown) |
| Citation drawer | source kind, title, version id + date, projection label, locator (страница/таблица/строка/фрагмент), evidence state, «Открыть источник» (to permitted page), «Недоступно» reason category (revoked / deleted / consent withdrawn / no longer in your scope) without revealing more |

## Primary tasks

1. Find a permitted entity or document by text.
2. Understand why results may be incomplete and what to do (narrow query, log in, ask the assistant).
3. Open a citation and verify the exact source version.
4. Switch between current and historical views deliberately.

## Layout regions

| Width | Results page | Citation drawer |
|---|---|---|
| Desktop ≥1280 | Shell (public or workspace); search field with constraint chips; left: status banner, results list; right rail: kind filters (checkboxes), temporal switch, «Как работает поиск» note | Right-side non-modal panel ~400 px, overlaying content without reflow; stacked above the assistant overlay if both open (z-index scale in the [layout proposal](../layout-and-tokens-proposal.md): overlay 20, panel/drawer 30) |
| Tablet | Rail collapses into filter bar above results | Same panel, ~360 px |
| Mobile <768 | Field + «Фильтры» button; results single column; banner full width | Full-height bottom sheet (modal), 16 px gutters |

## Component inventory

SearchField (with clear), ConstraintChip (removable, `aria-label` «Убрать условие …»), StatusBanner (variant per status, icon + text, `role="status"`), ResultItem, KindIcon, EvidenceLabel, FreshnessLine, HistoricalLabel, TemporalSwitch (radio group), CheckboxGroup (kinds), CitedAnswer (FactsTable + ClaimList), CitationChip (numbered, button, `aria-describedby` source), CitationDrawer (Panel/Sheet), UnavailableNotice, EmptyState, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty query | Suggestions: sections to browse; no «popular queries» from other users |
| Loading | Skeleton results; banner area reserved; `aria-busy` on list |
| Error (`unavailable`) | Banner + retry; previous results, if any, remain visible but marked «Показаны прежние результаты» |
| Permission-denied | Workspace search by anonymous → redirect to `/login?next=`; individual denied results simply absent |
| Offline | «Нет соединения»; last results cached only for the same principal and epoch, otherwise cleared |
| Partial | Banner with reason category: лимит запроса, часть источников недоступна, семантический поиск отключён (degraded to lexical/structured) — never names the missing source |
| No-answer | Neutral text; never «документ существует, но скрыт» |
| Stale generation | Banner «Данные обновляются, результаты могут быть неполными» + retry |
| Historical | Every item labelled; temporal switch shows selected date; a «Вернуться к текущим» link |
| Revoked/unavailable citation | Chip stays numbered but styled as unavailable with text label; drawer shows UnavailableNotice; answer re-marked `qualified` or `abstain` if a dependency vanished |
| Disputed/superseded evidence | Label on item and in drawer; superseded links to the current version when permitted |

## Keyboard order and focus

Shell → search field → constraint chips → (desktop) results list → rail; status banner is `role="status"` announced on change, not a tab stop. Result item: title link, then citation chips if any. Citation chip opens the drawer: focus moves to drawer heading; `Escape` closes and returns focus to the chip; on desktop the drawer is non-modal (`aria-expanded` on chip) so the rest of the page stays reachable; on mobile it is modal. Temporal switch change announces the new mode.

## Responsive table behaviour

FactsTable (поле, значение, единица, по состоянию на, полнота) collapses to stacked `dl` per fact below 768; «полнота: неполный объём» stays visible as text, not icon only.

## Locale keys

| Key | Russian |
|---|---|
| `ru.search.placeholder` | Поиск по отрасли |
| `ru.search.title` | Результаты поиска |
| `ru.search.removeConstraint` | Убрать условие «{label}» |
| `ru.search.kinds` | Что искать |
| `ru.search.kind.company` | Компании |
| `ru.search.kind.person` | Люди |
| `ru.search.kind.project` | Проекты |
| `ru.search.kind.rfq` | Потребности |
| `ru.search.kind.quote` | Предложения |
| `ru.search.kind.publication` | Публикации |
| `ru.search.kind.file` | Файлы |
| `ru.search.temporal.current` | Текущие данные |
| `ru.search.temporal.asOf` | Версия на дату |
| `ru.search.historicalLabel` | Историческая версия от {date} |
| `ru.search.backToCurrent` | Вернуться к текущим данным |
| `ru.search.status.partial` | Показаны не все результаты: {reason} |
| `ru.search.status.noAnswer` | По вашему запросу нет доступных материалов |
| `ru.search.status.unavailable` | Поиск временно недоступен |
| `ru.search.status.stale` | Данные обновляются, результаты могут быть неполными |
| `ru.search.status.previousShown` | Показаны прежние результаты |
| `ru.search.reason.budget` | достигнут лимит запроса |
| `ru.search.reason.sourcesUnavailable` | часть источников временно недоступна |
| `ru.search.reason.semanticOff` | смысловой поиск отключён, показаны точные совпадения |
| `ru.search.howItWorks` | Как работает поиск |
| `ru.search.emptyQuery` | Введите запрос или откройте раздел |
| `ru.search.freshness` | Источник: {source}, данные от {observedAt} |
| `ru.answer.facts` | Данные платформы |
| `ru.answer.claims` | Из источников |
| `ru.answer.supported` | Подтверждено источниками |
| `ru.answer.qualified` | С оговорками: {reason} |
| `ru.answer.abstain` | Недостаточно подтверждённых данных для ответа. Ниже — найденные материалы. |
| `ru.answer.scopeIncomplete` | Неполный объём данных |
| `ru.citation.open` | Источник {index} |
| `ru.citation.title` | Источник |
| `ru.citation.version` | Версия {version} от {date} |
| `ru.citation.locator.page` | Страница {page} |
| `ru.citation.locator.table` | Страница {page}, таблица {table}, строка {row} |
| `ru.citation.locator.text` | Фрагмент текста |
| `ru.citation.openSource` | Открыть источник |
| `ru.citation.unavailable` | Источник недоступен |
| `ru.citation.unavailableReason.revoked` | Доступ отозван |
| `ru.citation.unavailableReason.deleted` | Материал удалён |
| `ru.citation.unavailableReason.consent` | Согласие на публикацию отозвано |
| `ru.citation.unavailableReason.scope` | Больше вам недоступно |
| `ru.citation.close` | Закрыть источник |

## Open questions

- Whether anonymous public search ships before RAG-301 (lexical-only via structured resolver) — WEB-003 and RAG lane.
- Exact reason categories for `partial` must be frozen in FND-002 so that UI never leaks source identity.
- Answer generation on the public site: proposal **no** (search list only); answers live in the workspace and assistant.
