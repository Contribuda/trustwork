# Platform administration: editorial, moderation, support, commercial offers and prices

Routes (proposed): `/admin` (landing by role), `/admin/editorial`, `/admin/moderation`, `/admin/support`, `/admin/commercial`. Entered from the avatar menu («Администрирование») only when the person holds at least one platform role. Not a company setting, not in the workspace sidebar.

## Status and evidence

`no reference`. Spec R20 (platform commercial administration versions offers, plans, prices, entitlements, usage and credits; effective dates and price acceptance; separate editorial/moderation/support/company administration), "Content and editorial" (lifecycle with review; issue release freezes order and versions; corrections create revisions), access table rows Editorial/moderation, Commercial platform admin, Support (case-scoped, audited; never customer transactions; no default private negotiation access); IA ("separately permissioned administration surface").

## Audience and access policy

| Role | Area | Boundary |
|---|---|---|
| Editorial | Review queue, scheduling, magazine issue curation/release/corrections, taxonomy | Public content policy only; no commercial data |
| Moderation | Reports on public content/profiles, consent/portrait issues, retractions by policy, directory record disputes (sourced vs claimed) | Scoped case evidence only |
| Support | Case list; per case an explicit audited grant to a diagnostic view of specific objects; never by default | Case-scoped; read-only unless case grant says otherwise; audit visible to the affected user where policy says so |
| Commercial admin | Offers/plans/prices/entitlements versions with effective dates; usage and credits views; no customer transactions | Separate from editorial right |
| Platform admin without case grant | Sees nothing private (authorization suite requirement) | |

Every action is audited with actor identity; UI shows «Действие будет записано в журнал» on consequential forms.

## Data projection

| Area | Content |
|---|---|
| Editorial queue | Publications in review: title, author credit, format, submitted, reviewer, SLA; actions approve/return with feedback/schedule |
| Magazine issues | Draft/curated/review/released/corrected; TOC editor pinning publication versions; release checklist (web reader check, PDF generated and checked page-by-page, accessibility plan); corrections editor producing edition 2+ |
| Taxonomy | Topics, formats, categories, units (O11) with versions |
| Moderation cases | Report type, target (public projection reference), reporter (if permitted), evidence, decision, appeal |
| Support cases | Case id, user (minimal), subject, granted scope (objects, fields, expiry), actions log |
| Commercial | Offer versions (plan, price, currency, trial duration, entitlements, effective from/to, status draft/published/retired); acceptance stats as counts (no per-user listing beyond permission); credits/usage aggregates |

## Primary tasks

1. Review and schedule publications; release and correct magazine issues.
2. Handle reports and consent problems with evidence.
3. Help a user through a scoped, audited diagnostic view.
4. Publish versioned offers with effective dates; never edit a published version in place.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Admin shell: distinct header band label «Администрирование» (so staff never confuse it with the workspace), left sub-navigation per granted areas, content with DataTables and detail panels; return link «В рабочее пространство» |
| Tablet | Sub-navigation collapses to tabs |
| Mobile <768 | Supported for reading queues and approving/returning; complex editors (issue TOC, offer versions) show «Удобнее на широком экране» note but remain operable |

## Component inventory

AdminShell (reuses workspace primitives with a different accent band), SubNav, DataTable with filters and saved views, QueueRow, ReviewPanel (publication preview + feedback form), IssueEditor (ordered list with keyboard reordering: move up/down buttons, not drag-only), ReleaseChecklist (checkbox items with evidence links), CorrectionEditor, TaxonomyTree (tree view pattern), CaseCard, EvidenceList, ScopeGrantForm (objects, fields, expiry; audited), OfferVersionTable, OfferVersionForm (price in minor units with currency, effective dates, entitlements), PublishConfirmDialog («Опубликованную версию изменить нельзя; создайте новую»), AuditNote, EmptyState, Skeleton, Toast.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Queue: «Материалов на проверке нет»; cases: «Открытых обращений нет»; offers: «Опубликованных версий нет» |
| Loading | Skeleton |
| Error | Inline + retry |
| Permission-denied | Area missing from sub-nav; direct URL → NoAccess; case view without grant → NoAccess with «Запросить доступ по обращению» |
| Offline | Read-only |
| Partial/stale | Issue release blocked: checklist shows unmet items; offer with past effective date cannot be edited; publication changed since review started → «Материал изменён автором; проверьте заново» |

## Keyboard order and focus

Admin header → sub-nav → filters → table → detail panel. Issue TOC reordering via buttons with announcements («Материал перемещён на позицию 3»). Publish confirmation focuses Cancel.

## Responsive table behaviour

All admin tables → cards below 768 with a «Показать столбцы» control on tablet.

## Locale keys

| Key | Russian |
|---|---|
| `ru.admin.title` | Администрирование |
| `ru.admin.backToWorkspace` | В рабочее пространство |
| `ru.admin.nav.editorial` | Редакция |
| `ru.admin.nav.moderation` | Модерация |
| `ru.admin.nav.support` | Поддержка |
| `ru.admin.nav.commercial` | Коммерческие условия |
| `ru.admin.auditNote` | Действие будет записано в журнал |
| `ru.admin.editorial.queue` | На проверке |
| `ru.admin.editorial.queueEmpty` | Материалов на проверке нет |
| `ru.admin.editorial.approve` | Одобрить |
| `ru.admin.editorial.return` | Вернуть с замечаниями |
| `ru.admin.editorial.schedule` | Запланировать |
| `ru.admin.editorial.changedSinceReview` | Материал изменён автором; проверьте заново |
| `ru.admin.issues.title` | Выпуски журнала |
| `ru.admin.issues.state.draft` | Черновик |
| `ru.admin.issues.state.curated` | Собран |
| `ru.admin.issues.state.review` | На проверке |
| `ru.admin.issues.state.released` | Выпущен |
| `ru.admin.issues.state.corrected` | Исправленная редакция |
| `ru.admin.issues.moveUp` | Переместить выше |
| `ru.admin.issues.moveDown` | Переместить ниже |
| `ru.admin.issues.moved` | Материал перемещён на позицию {index} |
| `ru.admin.issues.checklist` | Чек-лист выпуска |
| `ru.admin.issues.check.web` | Веб-версия проверена на мобильном |
| `ru.admin.issues.check.pdf` | PDF собран и проверен постранично |
| `ru.admin.issues.check.a11y` | План доступности PDF заполнен |
| `ru.admin.issues.release` | Выпустить |
| `ru.admin.issues.correct` | Создать исправленную редакцию |
| `ru.admin.taxonomy.title` | Справочники |
| `ru.admin.moderation.cases` | Обращения |
| `ru.admin.moderation.casesEmpty` | Открытых обращений нет |
| `ru.admin.moderation.decision` | Решение |
| `ru.admin.moderation.appeal` | Апелляция |
| `ru.admin.support.cases` | Обращения в поддержку |
| `ru.admin.support.grantScope` | Доступ по обращению |
| `ru.admin.support.grantExpires` | Доступ до {date} |
| `ru.admin.support.requestAccess` | Запросить доступ по обращению |
| `ru.admin.commercial.offers` | Версии предложений |
| `ru.admin.commercial.noOffers` | Опубликованных версий нет |
| `ru.admin.commercial.plan` | План |
| `ru.admin.commercial.price` | Цена |
| `ru.admin.commercial.trialDays` | Пробный период, дней |
| `ru.admin.commercial.entitlements` | Возможности |
| `ru.admin.commercial.effectiveFrom` | Действует с |
| `ru.admin.commercial.effectiveTo` | Действует до |
| `ru.admin.commercial.state.draft` | Черновик |
| `ru.admin.commercial.state.published` | Опубликовано |
| `ru.admin.commercial.state.retired` | Снято |
| `ru.admin.commercial.publishConfirm` | Опубликованную версию изменить нельзя; для изменений создайте новую версию. |
| `ru.admin.commercial.acceptances` | {count, plural, one {# принятие} few {# принятия} many {# принятий}} |
| `ru.admin.commercial.usage` | Использование и кредиты |
| `ru.admin.narrowScreenNote` | Удобнее на широком экране |

## Open questions

- Route prefix (`/admin` vs `/app/admin`): proposal `/admin` to keep the separate permission surface obvious.
- Which roles may combine (editorial + commercial) — policy; UI supports any union.
- Support diagnostic view design per object type — deferred to BILL-001/BE-001; only the grant form is contracted.
