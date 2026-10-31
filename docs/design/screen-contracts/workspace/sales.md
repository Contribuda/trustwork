# Sales («Продажи»): leads, quote editor with versions, negotiation, order acceptance, catalogue

Routes: `/app/sales` (leads/requests), `/app/sales/quotes/[id]` with tabs `editor`, `versions`, `negotiation`, `order`, `files`, `correspondence`; `/app/sales/catalogue` (company catalogue, same component as [company](company.md) catalogue tab), `/app/sales/orders/[id]`.

## Status and evidence

`no reference` (the reference overview card «Продажи» only hints at leads and a catalogue link). Spec R06 (reusable versioned catalogue separate from client-specific quote snapshots; sent quote and agreed terms never change; private floors never published), R07 (leads/requests → quote → negotiation → order acceptance → fulfillment/acceptance; contacts/templates/campaigns contextual; no overloaded CRM navigation), R08, "Commercial journeys" (quote version fields), journeys 2 and 4; [lifecycles](../../../data/lifecycles.md) (quote draft → sent → superseded/withdrawn/expired/accepted; sent content immutable; buyer selection is not supplier acceptance).

## Audience and access policy

| Role | Access |
|---|---|
| Seller-authorized operator (company grant) | Leads addressed to the company, own quotes, negotiation, order acceptance within authority, catalogue read; catalogue edit only with catalogue grant |
| Company member without grant | 404 |
| Buyer | Never sees this side; sees the sent quote projection in Procurement |
| Independent specialist (person offering works/services without company) | Same as operator for personal catalogue if policy allows (open) |

Margin floors, private priorities and internal notes stay in the seller projection only.

## Data projection

| Screen | Fields |
|---|---|
| Leads list («Запросы») | Source (RFQ invitation / public open need / direct request / email), buyer (public projection), RFQ version pinned, deadline, kind mix, status (new / drafting / sent / negotiating / won / lost / expired), attention marker |
| Quote editor | Lines prefilled from the pinned RFQ version lines (specification, quantity, unit, milestones) so the seller never re-enters buyer data (WCAG 2.2 3.3.7): kind, specification, option/substitution flag with explanation, quantity, unit basis, unit price, taxes, currency, delivery/work milestones, payment terms, validity, attachments; «из каталога версии N» origin per line; private floor per line (locked, labelled «не отправляется»); totals; «Отправить версию» |
| Versions tab | List of versions: number, sent date, status, RFQ version answered, diff summary vs previous; opening a sent version is read-only with «Создать новую версию на основе» |
| Negotiation tab | Buyer requests/counter-proposals bound to versions; seller private notes labelled; reply creates version |
| Order tab | Buyer selection notice; accepted-terms snapshot; «Принять заказ» (authority check) / «Отклонить» with reason; after acceptance: obligations and link to project execution |
| Catalogue | Versioned entries (goods/works/services/mixed bundles), public flag, price or «по запросу», private floor; version history; «Опубликовать версию» |
| Contacts/templates/campaigns | Contextual: inside a quote («Шаблон условий»), inside catalogue («Экспорт для клиента»); no top-level CRM nav |

## Primary tasks

1. See incoming requests and their deadlines.
2. Draft a quote from the catalogue, send an immutable version.
3. Negotiate with versions, never editing a sent one.
4. Accept or decline an order under authority; see the obligations.
5. Maintain the catalogue without affecting sent quotes.

## Layout regions

| Width | Leads | Quote detail | Catalogue |
|---|---|---|---|
| Desktop ≥1280 | Shell; PageHeader («Продажи», «Каталог товаров, работ и услуг»); filters (status, source, deadline); DataTable | PageHeader (buyer, RFQ title, version pill, status, validity; actions: Отправить версию, Отозвать, Новая версия); tabs; editor: LineItemTable with inline editing; right rail: totals, validity, floors warning, buyer's RFQ summary (read-only) | PageHeader; VersionPicker; CatalogueTable; entry form in side panel |
| Tablet | Cards | Editor table scrolls horizontally; rail below | Table scrolls |
| Mobile <768 | Cards; filters sheet | Editor as line cards with a per-line edit sheet; totals sticky bottom; rail collapsed into accordion | Cards; entry form full-screen dialog |

## Component inventory

PageHeader, FilterBar, DataTable, LeadRow, StatusChip, Tabs, VersionPill/VersionPicker, LineItemTable (editable; per-cell inputs with labels; keyboard navigation), LineItemCards (mobile) with EditSheet, KindBadge, SubstitutionToggle with reason field, PrivateFloorField (locked style, lock icon + text), CatalogueOriginChip («из каталога, версия 7»), TotalsPanel, ValidityPicker (date), DiffSummary, ThreadView + PrivateNoteBlock, AuthorityCheckCard, OrderSnapshotCard, ConfirmDialog (send: «После отправки версия не меняется»), CatalogueTable, CatalogueEntryForm, TemplatePicker, EmptyState, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (leads) | «Запросов пока нет» + «Заполнить каталог» (if granted) + hint about public open needs |
| Empty (catalogue) | «Каталог пока пуст» + create; note that a quote can still be drafted manually |
| Loading | Skeleton |
| Error | Inline; send failure keeps draft with «Не отправлено» |
| Permission-denied | Order acceptance without authority: AuthorityCheckCard with «Запросить согласование»; catalogue edit without grant: read-only with NoAccess note on edit controls |
| Offline | Draft editing allowed locally with explicit «Не сохранено на сервере» banner; sending blocked |
| Partial/stale | Lead's RFQ amended: banner «Запрос изменён (версия 2). Ваше предложение относится к версии 1» + «Создать версию под новый запрос»; quote expired: status + «Продлить новой версией»; catalogue updated after sending: sent quote unaffected, editor shows «Каталог обновлён до версии 8; это предложение использует версию 7» |
| Validation | Line without unit or quantity blocks send with inline errors; floor below price warning (private, non-blocking) |

## Keyboard order and focus

Shell → header → filters → table/cards. Quote editor: header actions → tabs → line table: each cell input labelled by column header and row («Цена, позиция 3»); Tab moves across cells, Enter opens line options; «Добавить позицию» after the table; totals; send button. Send ConfirmDialog focuses Cancel first. Version switch moves focus to the panel heading.

## Responsive table behaviour

LineItemTable: tablet horizontal scroll with sticky specification column; mobile line cards (specification, quantity×unit, price, total, flags) with edit sheet. Versions table → cards. Catalogue table → cards.

## Locale keys

| Key | Russian |
|---|---|
| `ru.sales.title` | Продажи |
| `ru.sales.catalogue` | Каталог товаров, работ и услуг |
| `ru.sales.leads` | Запросы |
| `ru.sales.empty` | Запросов пока нет |
| `ru.sales.emptyHint` | Опубликованные потребности компаний доступны в разделе «Проекты» на сайте. |
| `ru.sales.fillCatalogue` | Заполнить каталог |
| `ru.sales.col.buyer` | Заказчик |
| `ru.sales.col.request` | Запрос |
| `ru.sales.col.source` | Источник |
| `ru.sales.col.deadline` | Срок |
| `ru.leadStatus.new` | Новый |
| `ru.leadStatus.drafting` | Готовим предложение |
| `ru.leadStatus.sent` | Отправлено |
| `ru.leadStatus.negotiating` | Переговоры |
| `ru.leadStatus.won` | Заказ принят |
| `ru.leadStatus.lost` | Заказчик выбрал другого |
| `ru.leadStatus.expired` | Истёк |
| `ru.leadSource.invitation` | Приглашение |
| `ru.leadSource.openNeed` | Открытая потребность |
| `ru.leadSource.direct` | Прямой запрос |
| `ru.leadSource.email` | Из письма |
| `ru.quoteEditor.title` | Предложение |
| `ru.quoteEditor.tabs.editor` | Редактор |
| `ru.quoteEditor.tabs.versions` | Версии |
| `ru.quoteEditor.tabs.negotiation` | Переговоры |
| `ru.quoteEditor.tabs.order` | Заказ |
| `ru.quoteEditor.send` | Отправить версию |
| `ru.quoteEditor.sendConfirm` | После отправки версия не меняется. Изменения возможны только новой версией. |
| `ru.quoteEditor.withdraw` | Отозвать |
| `ru.quoteEditor.newVersion` | Новая версия |
| `ru.quoteEditor.basedOn` | Создать новую версию на основе |
| `ru.quoteEditor.addLine` | Добавить позицию |
| `ru.quoteEditor.col.spec` | Спецификация |
| `ru.quoteEditor.col.qty` | Количество |
| `ru.quoteEditor.col.unit` | Единица |
| `ru.quoteEditor.col.price` | Цена |
| `ru.quoteEditor.col.tax` | Налог |
| `ru.quoteEditor.col.total` | Сумма |
| `ru.quoteEditor.substitution` | Замена |
| `ru.quoteEditor.substitutionReason` | Почему предложена замена |
| `ru.quoteEditor.floor` | Минимальная цена (заказчику не отправляется) |
| `ru.quoteEditor.floorWarning` | Цена ниже вашей минимальной цены |
| `ru.quoteEditor.fromCatalogue` | Из каталога, версия {version} |
| `ru.quoteEditor.catalogueNewer` | Каталог обновлён до версии {current}; это предложение использует версию {used} |
| `ru.quoteEditor.validity` | Срок действия |
| `ru.quoteEditor.deliveryMilestones` | Сроки поставки и работ |
| `ru.quoteEditor.paymentTerms` | Условия оплаты |
| `ru.quoteEditor.template` | Шаблон условий |
| `ru.quoteEditor.notSent` | Не отправлено |
| `ru.quoteEditor.notSavedServer` | Не сохранено на сервере |
| `ru.quoteEditor.rfqAmended` | Запрос изменён (версия {new}). Ваше предложение относится к версии {old}. |
| `ru.quoteEditor.createForNew` | Создать версию под новый запрос |
| `ru.quoteEditor.extend` | Продлить новой версией |
| `ru.quoteEditor.cellLabel` | {column}, позиция {row} |
| `ru.salesOrder.selectedByBuyer` | Заказчик выбрал версию {version} |
| `ru.salesOrder.accept` | Принять заказ |
| `ru.salesOrder.decline` | Отклонить |
| `ru.salesOrder.declineReason` | Причина отказа |
| `ru.salesOrder.obligations` | Обязательства |
| `ru.salesOrder.toExecution` | Перейти к исполнению |
| `ru.catalogue.exportForClient` | Экспорт для клиента |

## Open questions

- Personal catalogue for independent specialists (no company): policy open; UI supports it only if BE/COM confirm.
- Quote templates scope (company-level vs personal).
- Whether the seller may see the buyer's other invited suppliers (proposal: never).
