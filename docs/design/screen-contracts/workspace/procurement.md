# Procurement («Закупки»): intake, RFQ list, RFQ detail with versions, supplier discovery, quote comparison, order

Routes: `/app/procurement` (list), `/app/procurement/needs/new` (intake), `/app/procurement/rfq/[id]` with tabs `requirements`, `suppliers`, `quotes`, `compare`, `negotiation`, `order`, `files`, `correspondence`, `approvals`; `/app/procurement/suppliers` (discovery); `/app/procurement/orders/[id]`.

## Status and evidence

`no reference`. Spec R05 (intake → clarification → RFQ → discovery → eligibility → quote versions → normalization → negotiation → selection/order → fulfillment → acceptance → review; goods, works, services and mixed bundles), R06, R08, R10, R13, "Commercial journeys" (clarify scope/quantity/unit/location/schedule/acceptance before solicitation; discovery with sourced provenance; eligibility shows criteria and uncertainty; quote version fields; comparisons show exclusions and non-comparable scope; order only after authority/budget checks; seller acceptance separate; accepted snapshots immutable); journeys 3, 4, 7; [lifecycles](../../../data/lifecycles.md) (NeedDraft → … → Reviewed; RFQ amendments mark prior responses stale); design inventory missing surface "RFQ intake, comparison, quote versions, mixed bundles".

## Audience and access policy

| Role | Access |
|---|---|
| Buyer-authorized operator (person with grant on the RFQ or company procurement grant) | Full buyer side: need, RFQ versions, invited suppliers, quotes, comparison, negotiation, private notes, budget ceiling, order commitment **only** with action/amount-bound authority |
| Project owner/leader where RFQ is linked | Per project grant |
| Company member without grant | Not listed; 404 |
| Supplier | Never sees this surface; sees own quote side in Sales |
| Assistant | Acts under a mandate; its actions appear as runs with digests in «Согласования» |

Buyer's cost limits, private evaluation notes and candidate scoring never enter the supplier projection.

## Data projection

| Screen | Fields |
|---|---|
| List | Need/RFQ title, kind mix (товары/работы/услуги/комплект), status chip, current RFQ version, quotes count (received/stale), deadline, project link, operator, attention marker |
| Intake («Новая потребность») | Source: manual / file / trusted email / assistant; extracted lines with evidence pointers (file page/row) and confidence; required fields: scope, quantity, unit, location, schedule, acceptance requirements; missing fields list; attachments (untrusted, scanned); «Уточнить» questions |
| Requirements tab | RFQ versions (immutable once published): lines (kind, specification, quantity, unit basis, options/substitutions allowed, standards), delivery/work milestones, payment and validity terms, attachments, region; amendment creates new version and marks earlier quotes stale |
| Suppliers tab / discovery | Candidates: name, StatusBadge (sourced/claimed/verified), eligibility criteria table (criterion, met/unmet/unknown), fit explanation, provenance of contact («источник: …, разрешение на рассылку: нет»), invite action (requires permitted outreach), invited state |
| Quotes tab | Per supplier: quote versions list, status (draft n/a, sent, superseded, withdrawn, expired, accepted), validity, references RFQ version, stale flag |
| Compare tab | Normalized comparison of selected quote versions: lines aligned by RFQ line; per cell value + unit + tax basis + currency; exclusions; «не сопоставимо» cells with reason (different scope, substitution, missing line); totals only where complete; evidence/citation chips to quote pages |
| Negotiation tab | Threaded exchanges per supplier bound to quote versions; private notes (buyer only, labelled); counter-proposal request creates supplier's new version |
| Order tab | Selected quote version snapshot (immutable), authority check (who, limit, conditions), transaction budget reservation state, «Разместить заказ» → seller acceptance pending → accepted; amendments as joint versions |
| Approvals tab | Assistant/operator proposed actions with digest, approval binding, expiry, outcome (incl. outcome_unknown) |

## Primary tasks

1. Capture an ambiguous need and get it clarified (journey 3).
2. Publish an RFQ version; invite eligible suppliers with permitted outreach.
3. Collect quotes, compare honestly, negotiate, select.
4. Commit an order only with authority and budget; see seller acceptance as a separate event (journey 4).
5. Follow fulfillment/acceptance in the linked project.

## Layout regions

| Width | List | RFQ detail | Compare |
|---|---|---|---|
| Desktop ≥1280 | Shell; PageHeader («Закупки», «Создать потребность», «Найти поставщика»); filters (status, kind, project, operator, deadline); DataTable | Shell; PageHeader (title, StatusChip, version pill «Версия 2 (текущая)», deadline, project link; actions: Внести изменения (new version), Пригласить поставщиков, Закрыть); tabs; panel; right rail: missing requirements checklist, budget ceiling (private label), decisions | Toolbar: quote version selector per supplier (VersionPicker), «Показать только сопоставимое», units/currency normalization note; ComparisonTable with sticky first column (RFQ lines) and sticky header (suppliers); below: exclusions list and notes; «Выбрать» per supplier column (authority check on click) |
| Tablet | Cards | Tabs scroll; rail below | Table scrolls horizontally in a labelled region; max 3 suppliers visible, others via selector |
| Mobile <768 | Cards; filters sheet | Tabs scroll | Per-line accordion: each RFQ line expands to show each supplier's value stacked; a supplier switcher (segmented) at top; totals card at bottom; «Сопоставимость» text per line |

## Component inventory

PageHeader, FilterBar, DataTable, StatusChip (lifecycle), VersionPill/VersionPicker, Tabs, IntakeWizard (source choice, extraction review with EvidencePointer chips, missing-fields checklist, clarification questions), LineItemTable/LineItemCards, KindBadge (товар/работы/услуга/комплект), SupplierCandidateCard, EligibilityTable (criterion/state/explanation; states met/unmet/unknown as text + icon), ProvenanceLine, OutreachPermissionNote, QuoteVersionList, ComparisonTable (responsive; non-comparable cell pattern), ExclusionList, ThreadView with PrivateNoteBlock (labelled «Видно только вам»), AuthorityCheckCard (principal, limit, conditions, mandate version), BudgetReservationStatus, OrderSnapshotCard (immutable, version hash shown as «снимок от …»), SellerAcceptanceStatus, ApprovalDigestCard, RunStatusBadge (incl. outcome_unknown), ConfirmDialog, Toast, EmptyState, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (list) | «Закупок пока нет» + create + find supplier; explanation that a company is not required for a personal need (if policy allows personal procurement; otherwise hint to join a company) |
| Empty (quotes) | «Предложений пока нет. Приглашено поставщиков: N» |
| Loading | Skeletons; extraction shows progress «Разбираем файл…» with cancel |
| Error | Inline; extraction failure → «Не удалось разобрать файл. Заполните вручную или попробуйте другой файл.» |
| Permission-denied | Order tab: AuthorityCheckCard shows «Недостаточно полномочий: лимит {limit}, нужно {amount}» with «Запросить согласование»; never a silent disabled button |
| Offline | Read-only; drafts kept locally for intake form only (clearly labelled) |
| Partial/stale | Quotes against an older RFQ version flagged «Устарело: ответ на версию 1»; comparison excludes them by default with a toggle; extraction confidence below threshold flagged «Проверьте» |
| Outcome unknown | Order placement timed out: OrderSnapshotCard shows «Результат неизвестен — идёт сверка»; no retry button; explains no duplicate order will be placed |
| Budget | Reservation failed: «Бюджет сделки недоступен: {reason}»; separate platform-service budget note when a paid comparison was requested |

## Keyboard order and focus

Shell → header actions → filters → table (row link, row menu) → pagination. Detail: header → actions → tabs → panel → rail. ComparisonTable: `table` with `th scope`, first column row headers; arrow-key cell navigation optional; «Выбрать» buttons in the footer row; non-comparable cells contain text «Не сопоставимо» plus a disclosure with reason. Intake wizard steps announce progress; evidence pointer chips open the file viewer in a side panel with focus return.

## Responsive table behaviour

- List table → cards (<768).
- Line items → cards with labelled fields.
- ComparisonTable → tablet: horizontal scroll region with sticky RFQ-line column; mobile: per-line accordion with supplier switcher. Totals and exclusions are always rendered as text blocks, not only as table cells.
- Eligibility table → stacked list.

## Locale keys

| Key | Russian |
|---|---|
| `ru.procurement.title` | Закупки |
| `ru.procurement.createNeed` | Создать потребность |
| `ru.procurement.findSupplier` | Найти поставщика |
| `ru.procurement.empty` | Закупок пока нет |
| `ru.procurement.col.title` | Потребность |
| `ru.procurement.col.kind` | Состав |
| `ru.procurement.col.version` | Версия |
| `ru.procurement.col.quotes` | Предложения |
| `ru.procurement.col.deadline` | Срок |
| `ru.procurement.col.operator` | Ответственный |
| `ru.kind.goods` | Товар |
| `ru.kind.works` | Работы |
| `ru.kind.services` | Услуга |
| `ru.kind.bundle` | Комплект |
| `ru.rfqStatus.needDraft` | Черновик потребности |
| `ru.rfqStatus.clarifying` | Уточнение |
| `ru.rfqStatus.published` | Запрос опубликован |
| `ru.rfqStatus.quotesCollected` | Сбор предложений |
| `ru.rfqStatus.negotiating` | Переговоры |
| `ru.rfqStatus.termsSelected` | Условия выбраны |
| `ru.rfqStatus.orderPlaced` | Заказ размещён |
| `ru.rfqStatus.supplierAccepted` | Заказ принят поставщиком |
| `ru.rfqStatus.fulfilling` | Исполнение |
| `ru.rfqStatus.partiallyAccepted` | Частично принято |
| `ru.rfqStatus.accepted` | Принято |
| `ru.rfqStatus.reviewed` | Отзыв оставлен |
| `ru.rfqStatus.disputed` | Спор |
| `ru.rfqStatus.closed` | Закрыт |
| `ru.rfqStatus.expired` | Истёк |
| `ru.rfqStatus.cancelled` | Отменён |
| `ru.intake.title` | Новая потребность |
| `ru.intake.source.manual` | Заполнить вручную |
| `ru.intake.source.file` | Из файла |
| `ru.intake.source.email` | Из письма |
| `ru.intake.source.assistant` | С помощью помощника |
| `ru.intake.parsing` | Разбираем файл… |
| `ru.intake.parseError` | Не удалось разобрать файл. Заполните вручную или попробуйте другой файл. |
| `ru.intake.evidence` | Источник: {file}, {locator} |
| `ru.intake.confidenceLow` | Проверьте |
| `ru.intake.missing` | Нужно уточнить |
| `ru.intake.field.scope` | Что нужно |
| `ru.intake.field.quantity` | Количество |
| `ru.intake.field.unit` | Единица измерения |
| `ru.intake.field.location` | Место поставки или работ |
| `ru.intake.field.schedule` | Сроки |
| `ru.intake.field.acceptance` | Требования к приёмке |
| `ru.intake.untrustedNote` | Данные из файла или письма — это предположения, пока вы их не подтвердите. Адреса из письма не используются для рассылки автоматически. |
| `ru.rfq.tabs.requirements` | Требования |
| `ru.rfq.tabs.suppliers` | Поставщики |
| `ru.rfq.tabs.quotes` | Предложения |
| `ru.rfq.tabs.compare` | Сравнение |
| `ru.rfq.tabs.negotiation` | Переговоры |
| `ru.rfq.tabs.order` | Заказ |
| `ru.rfq.tabs.files` | Файлы |
| `ru.rfq.tabs.correspondence` | Переписка |
| `ru.rfq.tabs.approvals` | Согласования |
| `ru.rfq.version` | Версия {version} |
| `ru.rfq.versionCurrent` | Версия {version} (текущая) |
| `ru.rfq.amend` | Внести изменения |
| `ru.rfq.amendNote` | Изменения создадут новую версию запроса. Полученные предложения будут помечены как устаревшие. |
| `ru.rfq.invite` | Пригласить поставщиков |
| `ru.rfq.close` | Закрыть запрос |
| `ru.rfq.budgetCeiling` | Потолок бюджета (видно только вам) |
| `ru.supplier.eligibility` | Соответствие критериям |
| `ru.supplier.criterion.met` | Соответствует |
| `ru.supplier.criterion.unmet` | Не соответствует |
| `ru.supplier.criterion.unknown` | Нет данных |
| `ru.supplier.outreachNotPermitted` | Контакт получен из открытого источника; рассылка без согласия не разрешена |
| `ru.supplier.invited` | Приглашён |
| `ru.quote.status.sent` | Получено |
| `ru.quote.status.superseded` | Заменено новой версией |
| `ru.quote.status.withdrawn` | Отозвано |
| `ru.quote.status.expired` | Истекло |
| `ru.quote.status.accepted` | Принято |
| `ru.quote.stale` | Устарело: ответ на версию {version} |
| `ru.quote.validUntil` | Действует до {date} |
| `ru.quote.empty` | Предложений пока нет. Приглашено {count, plural, one {# поставщик} few {# поставщика} many {# поставщиков}} |
| `ru.compare.title` | Сравнение предложений |
| `ru.compare.onlyComparable` | Показывать только сопоставимое |
| `ru.compare.includeStale` | Включить устаревшие |
| `ru.compare.notComparable` | Не сопоставимо |
| `ru.compare.reason.scope` | Другой объём |
| `ru.compare.reason.substitution` | Предложена замена |
| `ru.compare.reason.missingLine` | Позиция отсутствует |
| `ru.compare.reason.unit` | Другая единица измерения |
| `ru.compare.exclusions` | Исключения и оговорки |
| `ru.compare.totalIncomplete` | Итог не рассчитан: не все позиции сопоставимы |
| `ru.compare.select` | Выбрать |
| `ru.compare.normalizationNote` | Суммы приведены к {currency}, налоги: {taxBasis} |
| `ru.negotiation.privateNote` | Видно только вам |
| `ru.negotiation.requestRevision` | Запросить новую версию |
| `ru.order.snapshot` | Снимок предложения от {date}, версия {version} |
| `ru.order.immutable` | Условия зафиксированы и не меняются при обновлении каталога поставщика |
| `ru.order.authority` | Полномочия |
| `ru.order.authorityInsufficient` | Недостаточно полномочий: лимит {limit}, нужно {amount} |
| `ru.order.requestApproval` | Запросить согласование |
| `ru.order.budgetReserved` | Бюджет сделки зарезервирован |
| `ru.order.budgetUnavailable` | Бюджет сделки недоступен: {reason} |
| `ru.order.place` | Разместить заказ |
| `ru.order.awaitingSeller` | Ожидает принятия поставщиком |
| `ru.order.sellerAccepted` | Поставщик принял заказ {date} |
| `ru.order.outcomeUnknown` | Результат неизвестен — идёт сверка. Повторный заказ не будет размещён автоматически. |
| `ru.approvals.digest` | Согласование действия |
| `ru.approvals.expires` | Действительно до {date} |
| `ru.approvals.invalidated` | Условия изменились, согласование аннулировано |

## Open questions

- Personal (non-company) procurement: allowed for a person with a personal project? Spec journey 5 implies yes; confirm in COM-001.
- Which normalization rules (currency/tax/unit) are shown; O11 unit catalogue.
- Outreach permission model for sourced contacts (legal, O06).
