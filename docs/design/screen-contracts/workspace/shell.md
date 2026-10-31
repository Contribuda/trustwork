# Workspace shell: sidebar, header, avatar menu, bell, floating assistant launcher

Applies to every `/app/*` route.

## Status and evidence

`proposed (reference: unapproved proposal)` — `workspace-latest.png` (private design archive), manifest `proposed_unapproved`. The shell elements that the reference shows **and** that the specification already mandates (collapse inside brand row, avatar-only account, bell, floating launcher, stable destinations) are contracted from the spec (R09, R23, R24), not from the image. Rejection ledger: no bottom-left account block, no avatar name/chevron, no collapse in a separate header cell, no docked assistant, no "Agents", no menu-setup button, no automatic reshuffling, no company switcher, no inbox. IA "Workspace navigation", "Assistant".

## Audience and access policy

Authenticated users only; anonymous → `/login?next=`. Navigation items are identical for everyone (deny-by-default applies to content, not to the menu). «Компания» without a company shows an empty state (see [company](company.md)), it is never removed. A user may **unpin** «Закупки»/«Продажи» in settings; unpinned items move under a «Ещё» disclosure at the end of the list in the same order, never deleted. Platform administration is not in this sidebar; admins get a separate entry in the avatar menu.

## Data projection

Sidebar: eight destinations (`workspaceNav`), outbound `publicExit`; per-item attention count (number of items needing the user's decision, computed from authorized objects only). Header: page title/breadcrumb (object-level, not «Рабочее пространство / …»), global search, bell with unread count, avatar (initials or consented image). Avatar menu: name (read-only text inside the menu, not in the header), «Моя страница», «Настройки аккаунта», «Безопасность и сессии», «Оплата и тарифы» (if permitted), «Администрирование» (if any admin role), «В отрасль», «Помощь» (always the last item before «Выйти», consistent help position, WCAG 2.2 3.2.6), «Выйти». Notifications panel: list of notifications (object-linked), never message bodies, never correspondence; «Все уведомления» link to `/app/notifications` (a list page, not a mailbox).

## Primary tasks

1. Move between the eight destinations quickly, with or without a mouse.
2. See where a decision is needed (attention counts) without charts.
3. Reach account/settings through the avatar; reach notifications through the bell.
4. Open the assistant from anywhere without losing page state.
5. Return to the public resource.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Fixed left sidebar 264 px (expanded) / 72 px (collapsed, icons with tooltips and visually hidden labels). Brand row: logo + wordmark + collapse button (`aria-expanded`, label «Свернуть меню»/«Развернуть меню») at the row's right edge. Items grouped: [Обзор, Моя страница, Компания] divider [Проекты, Закупки, Продажи, Публикации, Помощник]. Bottom: «В отрасль ↗» (external-style link to `/`). Header 64 px: page title (H1 lives in content; header shows breadcrumb only when depth > 1), search (expands to a dialog), bell, avatar 40 px. Content area scrolls independently; max content width 1360 px with 24 px padding. Floating assistant launcher 56 px circle bottom-right, 24 px from edges, above content, never inside the scrolling container |
| Tablet 768–1279 | Sidebar collapsed by default (72 px), expandable as overlay (not pushing content) via the brand-row button; header same; launcher same |
| Mobile <768 | Sidebar hidden; header: menu button (opens full-height navigation sheet with same items/order, brand row at top), page title, bell, avatar; search via a header icon; launcher 48 px circle, bottom-right, 16 px from edges, avoiding iOS safe area; bottom tab bar is **not** used (eight items do not fit; keep one navigation model) |

Collapsed state persists per user (preference). The assistant never changes order or pin state.

## Component inventory

SidebarNav (`nav[aria-label="Рабочее пространство"]`, `aria-current="page"`, roving focus optional, visible focus ring, attention Badge), BrandRow (Brand + CollapseButton), NavItem (icon + label + badge), NavDisclosure («Ещё» for unpinned), ExternalNavLink («В отрасль»), WorkspaceHeader, Breadcrumb, GlobalSearchButton → SearchDialog, NotificationBell (button, `aria-label` «Уведомления, {n} новых», count visible, dot only when count unknown), NotificationsPanel (popover; mobile sheet), AvatarButton (`aria-haspopup="menu"`, label «Аккаунт»), AvatarMenu (menu with items, arrow-key navigation), AssistantLauncher (button, `aria-label` «Помощник», `aria-expanded`, unread/action-required Badge with text alternative), AssistantOverlay (see [assistant](assistant.md)), Toast region (`aria-live="polite"`), Skeleton for sidebar counts.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | No attention counts → no badges; no notifications → panel shows «Новых уведомлений нет» |
| Loading | Sidebar renders immediately; counts and avatar hydrate without shifting items |
| Error | Counts failing silently hide; notification panel shows error with retry |
| Permission-denied | Route-level: content area renders «Нет доступа» page (see settings contract for the component) while shell stays; menu never hides items for permission reasons |
| Offline | Header shows persistent «Нет соединения» banner under header; navigation still works for cached pages; launcher opens overlay in read-only mode |
| Partial/stale | Counts older than N minutes get `title`/visually hidden «обновлено {time}» |
| Assistant attention | Launcher shows badge: unread (blue dot + count) or action-required (amber with icon + text in tooltip/visually hidden) |

## Keyboard order and focus

Skip link («К содержимому») → brand link → collapse button → nav items in order → «В отрасль» → header: breadcrumb links → search → bell → avatar → main content → assistant launcher (last in DOM order; always reachable). Collapsing keeps focus on the collapse button and announces state. Mobile nav sheet and notifications sheet are modal dialogs with focus trap, Escape and focus return. Avatar menu follows the WAI-ARIA menu button pattern (Enter/Space/ArrowDown open, arrows move, Escape closes to button). The launcher opens the overlay and moves focus into it; closing returns focus to the launcher (details in assistant contract). Page navigation moves focus to the new page H1.

## Responsive table behaviour

Not applicable to the shell; see page contracts.

## Locale keys

| Key | Russian |
|---|---|
| `ru.shell.navLabel` | Рабочее пространство |
| `ru.shell.collapse` | Свернуть меню |
| `ru.shell.expand` | Развернуть меню |
| `ru.shell.more` | Ещё |
| `ru.shell.skipToContent` | К содержимому |
| `ru.shell.openMenu` | Открыть меню |
| `ru.shell.closeMenu` | Закрыть меню |
| `ru.shell.search` | Поиск |
| `ru.shell.notifications` | Уведомления |
| `ru.shell.notificationsCount` | Уведомления, {count, plural, one {# новое} few {# новых} many {# новых}} |
| `ru.shell.noNotifications` | Новых уведомлений нет |
| `ru.shell.allNotifications` | Все уведомления |
| `ru.shell.account` | Аккаунт |
| `ru.shell.menu.myPage` | Моя страница |
| `ru.shell.menu.accountSettings` | Настройки аккаунта |
| `ru.shell.menu.security` | Безопасность и сессии |
| `ru.shell.menu.billing` | Оплата и тарифы |
| `ru.shell.menu.help` | Помощь |
| `ru.shell.menu.admin` | Администрирование |
| `ru.shell.menu.signOut` | Выйти |
| `ru.shell.offline` | Нет соединения. Показаны сохранённые данные. |
| `ru.shell.attention` | {count, plural, one {# требует решения} few {# требуют решения} many {# требуют решения}} |
| `ru.shell.updatedAt` | Обновлено {time} |
| `ru.assistant.launcher` | Помощник |
| `ru.assistant.launcherUnread` | Помощник, {count, plural, one {# непрочитанное} few {# непрочитанных} many {# непрочитанных}} |
| `ru.assistant.launcherAction` | Помощник, требуется ваше решение |
| `ru.common.noAccessTitle` | Нет доступа |
| `ru.common.noAccessBody` | У вас нет прав для этого раздела. Если это ошибка, обратитесь к администратору компании. |

Existing keys reused: `workspaceNav[0..7]`, `publicExit`.

## Open questions

- Breadcrumb root: the reference shows «Рабочее пространство / Обзор»; proposal is to drop the root and show breadcrumbs only for nested objects (human decision, listed in [human-review-request.md](../human-review-request.md)).
- Whether unpinning lives in «Настройки аккаунта → Разделы» (proposal) or inline in the sidebar via a non-primary control.
- Global search in the header: workspace-scoped search (`/app/search`) using the [search contract](../public/search-and-citations.md).
