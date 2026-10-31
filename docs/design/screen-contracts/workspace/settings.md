# Settings: account, security and sessions, preferences, billing entry points

Routes: `/app/settings` (account), `/app/settings/security`, `/app/settings/preferences`, `/app/settings/channels`, `/app/settings/billing` (personal), `/app/company/settings/billing` (company; see [company](company.md)). Reached from the avatar menu and contextual links, **not** from the sidebar.

## Status and evidence

`no reference`. Spec R19 (free minimum; paid assistant trial, tiered subscriptions, separately billed outputs; personal/company payers and employee/project budgets; prices unknown), R20 (price acceptance, effective dates), R24 (contextual settings), "Assistant journeys" (connected channels individually granted with scopes and revocation); IA ("Company settings and company billing live with the company; personal settings with the account"); O03 (prices unknown; no billing activation).

## Audience and access policy

Own account only. Company billing requires company billing grant. Platform offers are displayed only as published versions with effective dates; nothing here enables payment until BILL-001 and O03 are resolved — the billing page in the first slice is an informational entry point with «Тарифы пока не опубликованы» state.

## Data projection

| Page | Fields |
|---|---|
| Account | Name, email (change via verified flow), avatar, language (ru only now; field hidden), delete account entry (policy O06) |
| Security and sessions | Password change, linked providers (Apple, Google) with link/unlink, active sessions list (device, location approximation, last seen, current marker, «Завершить»), «Завершить все другие сессии», recovery info |
| Preferences | Interests (link to onboarding steps), pinned sections (Закупки/Продажи pin toggles), notification preferences by category (decisions, runs, publications, magazine), reduced motion follows OS, assistant overlay preference (focus on open) |
| Channels | Connected email/messenger accounts with scopes, granted date, «Отозвать»; explanation that imported content is untrusted |
| Billing (personal) | Current plan (free), trial state if any, platform-service budget, accepted offers with version/date, invoices (when exist), entry to company billing if granted |

## Primary tasks

1. Keep account and recovery data correct.
2. See and end sessions; manage linked providers.
3. Control pinned sections and notifications.
4. Revoke a connected channel.
5. Understand what is paid and accept a versioned price before anything paid happens.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Shell; PageHeader («Настройки»); left sub-navigation (Аккаунт, Безопасность и сессии, Предпочтения, Подключения, Оплата и тарифы) 240 px; content max 760 px forms |
| Tablet | Sub-navigation as horizontal tabs |
| Mobile <768 | Sub-navigation as a select or stacked list page; forms full width |

## Component inventory

PageHeader, SubNav (`nav[aria-label="Настройки"]`), Form sections (`fieldset`/`legend`), TextField, PasswordField, AvatarUpload, ProviderLinkRow (icon, state, Link/Unlink with confirm), SessionTable → SessionCards, Switch (with text state), CheckboxGroup (notifications), PinToggle (Switch with explanation «раздел переместится в «Ещё»»), ChannelRow (scopes chips, Revoke with ConfirmDialog), OfferCard (version, effective date, price if published, «Принять условия» only when published), BudgetStatus, EmptyState, FormAlert, Toast.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Sessions: only current; Channels: «Подключений нет» + «Подключить» (hidden until providers exist, O08); Billing: «Тарифы пока не опубликованы. Базовые возможности бесплатны.» |
| Loading | Skeleton forms |
| Error | Inline; session end failure toast |
| Permission-denied | Company billing link hidden without grant; page direct access → NoAccess |
| Offline | Read-only |
| Partial/stale | Password changed elsewhere → re-login notice; provider unlink blocked if it is the only login method («Сначала задайте пароль») |
| Destructive | End all other sessions, unlink, revoke channel, delete account: ConfirmDialog with consequences |

## Keyboard order and focus

Shell → H1 → sub-nav → form fields in order → save per section. Switches announce state; confirm dialogs follow the dialog pattern.

## Responsive table behaviour

Sessions table (устройство, место, последняя активность, действие) → cards below 768.

## Locale keys

| Key | Russian |
|---|---|
| `ru.settings.title` | Настройки |
| `ru.settings.nav.account` | Аккаунт |
| `ru.settings.nav.security` | Безопасность и сессии |
| `ru.settings.nav.preferences` | Предпочтения |
| `ru.settings.nav.channels` | Подключения |
| `ru.settings.nav.billing` | Оплата и тарифы |
| `ru.settings.account.changeEmail` | Изменить почту |
| `ru.settings.account.deleteAccount` | Удалить аккаунт |
| `ru.settings.security.changePassword` | Сменить пароль |
| `ru.settings.security.currentPassword` | Текущий пароль |
| `ru.settings.security.newPassword` | Новый пароль |
| `ru.settings.security.providers` | Способы входа |
| `ru.settings.security.link` | Привязать |
| `ru.settings.security.unlink` | Отвязать |
| `ru.settings.security.unlinkBlocked` | Сначала задайте пароль |
| `ru.settings.security.sessions` | Активные сессии |
| `ru.settings.security.currentSession` | Текущая сессия |
| `ru.settings.security.endSession` | Завершить |
| `ru.settings.security.endOthers` | Завершить все другие сессии |
| `ru.settings.security.col.device` | Устройство |
| `ru.settings.security.col.location` | Место |
| `ru.settings.security.col.lastSeen` | Последняя активность |
| `ru.settings.preferences.interests` | Интересы |
| `ru.settings.preferences.sections` | Разделы меню |
| `ru.settings.preferences.pinProcurement` | Показывать «Закупки» в меню |
| `ru.settings.preferences.pinSales` | Показывать «Продажи» в меню |
| `ru.settings.preferences.pinNote` | Скрытый раздел переместится в «Ещё» и останется доступен. |
| `ru.settings.preferences.notifications` | Уведомления |
| `ru.settings.preferences.notify.decisions` | Решения и согласования |
| `ru.settings.preferences.notify.runs` | Запуски помощника |
| `ru.settings.preferences.notify.publications` | Публикации |
| `ru.settings.preferences.notify.magazine` | Новый выпуск журнала |
| `ru.settings.preferences.assistantFocus` | При открытии окна помощника переходить к последнему сообщению |
| `ru.settings.channels.empty` | Подключений нет |
| `ru.settings.channels.connect` | Подключить |
| `ru.settings.channels.scopes` | Разрешения |
| `ru.settings.channels.revoke` | Отозвать |
| `ru.settings.channels.untrustedNote` | Письма и файлы из подключений считаются непроверенными данными и не дают помощнику полномочий. |
| `ru.settings.billing.freeNote` | Базовые возможности бесплатны. |
| `ru.settings.billing.noOffers` | Тарифы пока не опубликованы. |
| `ru.settings.billing.currentPlan` | Текущий план |
| `ru.settings.billing.trial` | Пробный период до {date} |
| `ru.settings.billing.platformBudget` | Бюджет платных услуг |
| `ru.settings.billing.acceptedOffers` | Принятые условия |
| `ru.settings.billing.offerVersion` | Версия {version}, действует с {date} |
| `ru.settings.billing.accept` | Принять условия |
| `ru.settings.billing.companyBilling` | Оплата и тарифы компании |
| `ru.settings.billing.invoices` | Счета |
| `ru.common.confirm` | Подтвердить |

## Open questions

- O03: everything about prices; the OfferCard renders only published versions.
- Account deletion and data retention text (O06).
- Session location display (approximate, privacy) — security review.
