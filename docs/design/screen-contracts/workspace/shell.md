# Workspace shell: sidebar, header, avatar menu, bell, floating assistant launcher

Applies to every `/app/*` route.

## Status and evidence

`proposed (reference: unapproved proposal)` — `workspace-latest.png` (private design archive), manifest `proposed_unapproved`. The shell elements that the reference shows **and** that the specification already mandates (collapse inside brand row, avatar-only account, bell, floating launcher, stable destinations) are contracted from the spec (R09, R23, R24), not from the image. Rejection ledger: no bottom-left account block, no avatar name/chevron, no collapse in a separate header cell, no docked assistant, no "Agents", no menu-setup button, no automatic reshuffling, no company switcher, no inbox. IA "Workspace navigation", "Assistant".

## Audience and access policy

Authenticated users only; anonymous → `/login?next=`. Navigation items are identical for everyone (deny-by-default applies to content, not to the menu). "Company" without a company shows an empty state (see [company](company.md)), it is never removed. A user may **unpin** "Procurement"/"Sales" in settings; unpinned items move under a "More" disclosure at the end of the list in the same order, never deleted. Platform administration is not in this sidebar; admins get a separate entry in the avatar menu.

## Data projection

Sidebar: eight destinations (`workspaceNav`), outbound `publicExit`; per-item attention count (number of items needing the user's decision, computed from authorized objects only). Header: page title/breadcrumb (object-level, not "Workspace / …"), global search, bell with unread count, avatar (initials or consented image). Avatar menu: name (read-only text inside the menu, not in the header), "My page", "Account settings", "Security and sessions", "Billing and plans" (if permitted), "Administration" (if any admin role), "To the industry", "Help" (always the last item before "Sign out", consistent help position, WCAG 2.2 3.2.6), "Sign out". Notifications panel: list of notifications (object-linked), never message bodies, never correspondence; "All notifications" link to `/app/notifications` (a list page, not a mailbox).

## Primary tasks

1. Move between the eight destinations quickly, with or without a mouse.
2. See where a decision is needed (attention counts) without charts.
3. Reach account/settings through the avatar; reach notifications through the bell.
4. Open the assistant from anywhere without losing page state.
5. Return to the public resource.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Fixed left sidebar 264 px (expanded) / 72 px (collapsed, icons with tooltips and visually hidden labels). Brand row: logo + wordmark + collapse button (`aria-expanded`, label "Collapse menu"/"Expand menu") at the row's right edge. Items grouped: [Overview, My page, Company] divider [Projects, Procurement, Sales, Publications, Assistant]. Bottom: "To the industry ↗" (`publicExit`) (external-style link to `/`). Header 64 px: page title (H1 lives in content; header shows breadcrumb only when depth > 1), search (expands to a dialog), bell, avatar 40 px. Content area scrolls independently; max content width 1360 px with 24 px padding. Floating assistant launcher 56 px circle bottom-right, 24 px from edges, above content, never inside the scrolling container |
| Tablet 768–1279 | Sidebar collapsed by default (72 px), expandable as overlay (not pushing content) via the brand-row button; header same; launcher same |
| Mobile <768 | Sidebar hidden; header: menu button (opens full-height navigation sheet with same items/order, brand row at top), page title, bell, avatar; search via a header icon; launcher 48 px circle, bottom-right, 16 px from edges, avoiding iOS safe area; bottom tab bar is **not** used (eight items do not fit; keep one navigation model) |

Collapsed state persists per user (preference). The assistant never changes order or pin state.

## Component inventory

SidebarNav (`nav[aria-label="Workspace"]` (`shell.navLabel`), `aria-current="page"`, roving focus optional, visible focus ring, attention Badge), BrandRow (Brand + CollapseButton), NavItem (icon + label + badge), NavDisclosure ("More" for unpinned), ExternalNavLink ("To the industry" (`publicExit`)), WorkspaceHeader, Breadcrumb, GlobalSearchButton → SearchDialog, NotificationBell (button, `aria-label` "Notifications, {n} new", count visible, dot only when count unknown), NotificationsPanel (popover; mobile sheet), AvatarButton (`aria-haspopup="menu"`, label "Account"), AvatarMenu (menu with items, arrow-key navigation), AssistantLauncher (button, `aria-label` "Assistant", `aria-expanded`, unread/action-required Badge with text alternative), AssistantOverlay (see [assistant](assistant.md)), Toast region (`aria-live="polite"`), Skeleton for sidebar counts.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | No attention counts → no badges; no notifications → panel shows "No new notifications" |
| Loading | Sidebar renders immediately; counts and avatar hydrate without shifting items |
| Error | Counts failing silently hide; notification panel shows error with retry |
| Permission-denied | Route-level: content area renders "No access" page (see settings contract for the component) while shell stays; menu never hides items for permission reasons |
| Offline | Header shows persistent "No connection" (`common.offline`) banner under header; navigation still works for cached pages; launcher opens overlay in read-only mode |
| Partial/stale | Counts older than N minutes get `title`/visually hidden "updated {time}" |
| Assistant attention | Launcher shows badge: unread (blue dot + count) or action-required (amber with icon + text in tooltip/visually hidden) |

## Keyboard order and focus

Skip link ("Skip to content") → brand link → collapse button → nav items in order → "To the industry" (`publicExit`) → header: breadcrumb links → search → bell → avatar → main content → assistant launcher (last in DOM order; always reachable). Collapsing keeps focus on the collapse button and announces state. Mobile nav sheet and notifications sheet are modal dialogs with focus trap, Escape and focus return. Avatar menu follows the WAI-ARIA menu button pattern (Enter/Space/ArrowDown open, arrows move, Escape closes to button). The launcher opens the overlay and moves focus into it; closing returns focus to the launcher (details in assistant contract). Page navigation moves focus to the new page H1.

## Responsive table behaviour

Not applicable to the shell; see page contracts.

## Locale keys

| Key | English |
|---|---|
| `shell.navLabel` | Workspace |
| `shell.collapse` | Collapse menu |
| `shell.expand` | Expand menu |
| `shell.more` | More |
| `shell.skipToContent` | Skip to content |
| `shell.openMenu` | Open menu |
| `shell.closeMenu` | Close menu |
| `shell.search` | Search |
| `shell.notifications` | Notifications |
| `shell.notificationsCount` | Notifications, {count, plural, one {# new} other {# new}} |
| `shell.noNotifications` | No new notifications |
| `shell.allNotifications` | All notifications |
| `shell.account` | Account |
| `shell.menu.myPage` | My page |
| `shell.menu.accountSettings` | Account settings |
| `shell.menu.security` | Security and sessions |
| `shell.menu.billing` | Billing and plans |
| `shell.menu.help` | Help |
| `shell.menu.admin` | Administration |
| `shell.menu.signOut` | Sign out |
| `shell.offline` | No connection. Showing saved data. |
| `shell.attention` | {count, plural, one {# needs a decision} other {# need a decision}} |
| `shell.updatedAt` | Updated {time} |
| `assistant.launcher` | Assistant |
| `assistant.launcherUnread` | Assistant, {count, plural, one {# unread} other {# unread}} |
| `assistant.launcherAction` | Assistant, your decision is needed |
| `common.noAccessTitle` | No access |
| `common.noAccessBody` | You do not have rights for this section. If that is a mistake, contact your company administrator. |

Existing keys reused: `workspaceNav[0..7]`, `publicExit`.

## Open questions

- Breadcrumb root: the reference shows "Workspace / Overview"; proposal is to drop the root and show breadcrumbs only for nested objects (human decision, listed in [human-review-request.md](../human-review-request.md)).
- Whether unpinning lives in "Account settings → Sections" (proposal) or inline in the sidebar via a non-primary control.
- Global search in the header: workspace-scoped search (`/app/search`) using the [search contract](../public/search-and-citations.md).
