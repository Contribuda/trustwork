# Company («Компания»): member view, admin view, no-company empty state

Route: `/app/company` (hub), `/app/company/settings/*` (admin), `/app/company/join` and `/app/company/new` (empty-state flows).

## Status and evidence

`no reference`. Spec R02 (one ordinary current employer; shared company page; permission-scoped editing; no switcher), R06 (versioned catalogue; private floors never published), R20 (company administration separate from platform administration), "Identity, company and public pages" (hub contains details, wall, people, catalogue, projects, reputation, external website; joining/editing needs invitation/verified authority under claim policy O05), journey 6; IA (no employer selector; purposeful empty state with optional joining/creation).

## Audience and access policy

| Viewer | Sees |
|---|---|
| No company linked | Empty state with «Присоединиться» (by invitation code/link or request to a claimed company) and «Создать страницу компании»; no forced completion; the rest of the workspace works |
| Pending invitation / pending join request | State card with status; cancel; still no company data |
| Company member | Member view: details, wall, people (member list with roles as permitted), catalogue (read; prices visible per grant; private floors only with grant), projects of the company the member is granted, company publications, reputation (internal evidence view per grant), settings entry only if admin |
| Company administrator | Member view + «Настройки компании»: profile editing, membership (invite, roles, end membership), claim/verification status, catalogue management grant, publication rights, company billing (if granted), delegation policies |
| Former member | Nothing here; empty state; residual grants (O04) are explicit and shown as «ограниченный доступ: …» if ever granted |

Only one current employer is modelled (O15 out of scope). No switcher anywhere.

## Data projection

| Tab | Member | Admin additional |
|---|---|---|
| Обзор | Public card preview, status badge (sourced/claimed/verified), open decisions for the company that I may act on, recent wall items | Claim/verification progress, pending invitations count |
| Стена | Company publications and project updates (shared publication records) | Publish/edit per grant |
| Люди | Members with role titles and public/consent markers; invite button if granted | Role assignment, end membership (confirmation dialog explaining revocations: grants, sessions, mandates), pending invites |
| Каталог | Versioned catalogue: goods / works / services / mixed bundles; version picker; public flag per entry; private floor fields only with grant | Create new version, publish version, archive |
| Проекты | Company-owned and company-participating projects I can see | Transfer ownership flow entry |
| Репутация | Evidence-backed dimensions with sample counts, methodology; disputes/appeals I may see | Appeal/respond actions |
| Настройки (admin only) | — | Profile, domain/website, membership policy, delegation policy, billing entry (contextual), danger zone |

## Primary tasks

1. Join or create a company without being forced.
2. See the company's shared state and act within my grants.
3. Admin: manage people, catalogue versions, claim/verification, settings and billing.
4. End a membership safely with clear revocation consequences.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Shell; PageHeader (logo, name, StatusBadge, «Публичная страница ↗», admin «Настройки компании»); tabs; panel; right rail on Обзор (claim status, website, invite) |
| Tablet | Rail below panel; tabs scroll |
| Mobile <768 | Header stacks; tabs scroll; tables collapse (see below) |

Empty state (no company): centered card max 640 px with illustration-free layout: H1 «Компания», text explaining that a company is optional, two buttons («Присоединиться по приглашению», «Создать страницу компании»), link «Найти компанию в каталоге» (public hub), and a note that joining needs confirmation by the company (O05).

## Component inventory

PageHeader, StatusBadge, Tabs, EmptyState (two actions), InviteDialog (email or link; role selection limited to admin's own authority), MemberTable → MemberCards (mobile), RoleSelect, ConfirmDialog (destructive; lists consequences), CatalogueTable with VersionPicker, CatalogueEntryForm (kind: goods/works/services/bundle; unit; price-on-request; public flag; private floor fields with lock icon + text «не публикуется»), ClaimStatusCard, ReputationPanel, ProjectCardList, SettingsForm, DangerZone, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (no company) | As above; never a modal; never blocks other navigation |
| Empty (member, tabs) | «Каталог пока пуст» (+ create if granted), «Сотрудников пока нет» etc. |
| Loading | Skeleton header and panel |
| Error | Inline + retry |
| Permission-denied | Tab visible but panel shows NoAccess card (e.g., catalogue private floors, settings); admin-only actions hidden, not disabled with no explanation |
| Offline | Read-only with banner |
| Partial/stale | Membership ended during session: next request returns empty state with explanation «Ваше членство завершено {date}»; catalogue draft version older than published one shows «Есть опубликованная версия новее» |
| Pending | Join request pending: status card with «Отменить запрос» |

## Keyboard order and focus

Shell → header links/buttons → tabs → panel. Tables: row actions in a menu button per row (not icon-only buttons without labels). Confirm dialogs: focus on the first non-destructive control (Cancel), destructive button requires explicit activation; Escape cancels.

## Responsive table behaviour

MemberTable (имя, роль, статус, с, действия) and CatalogueTable (наименование, тип, единица, цена/по запросу, публично, версия) collapse to cards below 768 with field labels; version picker becomes a select above the list; sort via select. Column visibility toggles on tablet (hide «с»/«версия» by default).

## Locale keys

| Key | Russian |
|---|---|
| `ru.company.title` | Компания |
| `ru.company.publicPage` | Публичная страница |
| `ru.company.settings` | Настройки компании |
| `ru.company.tabs.overview` | Обзор |
| `ru.company.tabs.wall` | Стена |
| `ru.company.tabs.people` | Люди |
| `ru.company.tabs.catalogue` | Каталог |
| `ru.company.tabs.projects` | Проекты |
| `ru.company.tabs.reputation` | Репутация |
| `ru.company.empty.title` | Вы пока не связаны с компанией |
| `ru.company.empty.body` | Можно работать без компании: читать, публиковать и вести личные проекты. Если вы представляете компанию, присоединитесь по приглашению или создайте её страницу. |
| `ru.company.empty.join` | Присоединиться по приглашению |
| `ru.company.empty.create` | Создать страницу компании |
| `ru.company.empty.find` | Найти компанию в каталоге |
| `ru.company.empty.policyNote` | Присоединение подтверждает компания. |
| `ru.company.join.code` | Код или ссылка приглашения |
| `ru.company.join.pending` | Запрос отправлен и ждёт подтверждения |
| `ru.company.join.cancel` | Отменить запрос |
| `ru.company.membershipEnded` | Ваше членство завершено {date} |
| `ru.company.invite` | Пригласить |
| `ru.company.invite.email` | Почта сотрудника |
| `ru.company.invite.role` | Роль |
| `ru.company.member.name` | Имя |
| `ru.company.member.role` | Роль |
| `ru.company.member.status` | Статус |
| `ru.company.member.since` | С |
| `ru.company.member.actions` | Действия |
| `ru.company.member.end` | Завершить участие |
| `ru.company.member.endConfirmTitle` | Завершить участие {name} в компании? |
| `ru.company.member.endConsequences` | Будут отозваны права компании, активные поручения помощнику и сессии, связанные с компанией. Личная страница и публикации сотрудника сохранятся. |
| `ru.company.catalogue.empty` | Каталог пока пуст |
| `ru.company.catalogue.newVersion` | Новая версия |
| `ru.company.catalogue.publish` | Опубликовать версию |
| `ru.company.catalogue.version` | Версия {version} от {date} |
| `ru.company.catalogue.newerPublished` | Есть опубликованная версия новее |
| `ru.company.catalogue.unit` | Единица |
| `ru.company.catalogue.price` | Цена |
| `ru.company.catalogue.priceOnRequest` | По запросу |
| `ru.company.catalogue.public` | Публично |
| `ru.company.catalogue.privateFloor` | Минимальная цена (не публикуется) |
| `ru.company.claim.title` | Статус страницы |
| `ru.company.claim.sourced` | Создана по открытому источнику |
| `ru.company.claim.claimed` | Заявлена, ожидает подтверждения |
| `ru.company.claim.verified` | Подтверждена |
| `ru.company.settings.profile` | Профиль |
| `ru.company.settings.membership` | Сотрудники и роли |
| `ru.company.settings.delegation` | Политика поручений |
| `ru.company.settings.billing` | Оплата и тарифы компании |
| `ru.company.settings.danger` | Опасные действия |
| `ru.common.noAccess` | Нет доступа к этому разделу |

Catalogue kind labels reuse the shared enum `ru.kind.*` (see [procurement](procurement.md) and the key conventions in the [README](../README.md)).

## Open questions

- O05: how a claim is proven; the UI only shows status and a «Подтвердить» entry.
- O04: residual read-only grant for former employees — not designed; only a label is reserved.
- Which roles exist (admin, publisher, buyer operator, seller operator, viewer) — FND-002/BE-001 freeze; the RoleSelect reads them from the contract.
