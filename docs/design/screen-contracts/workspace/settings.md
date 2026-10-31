# Settings: account, security and sessions, preferences, billing entry points

Routes: `/app/settings` (account), `/app/settings/security`, `/app/settings/preferences`, `/app/settings/channels`, `/app/settings/billing` (personal), `/app/company/settings/billing` (company; see [company](company.md)). Reached from the avatar menu and contextual links, **not** from the sidebar.

## Status and evidence

`no reference`. Spec R19 (free minimum; paid assistant trial, tiered subscriptions, separately billed outputs; personal/company payers and employee/project budgets; prices unknown), R20 (price acceptance, effective dates), R24 (contextual settings), "Assistant journeys" (connected channels individually granted with scopes and revocation); IA ("Company settings and company billing live with the company; personal settings with the account"); O03 (prices unknown; no billing activation).

## Audience and access policy

Own account only. Company billing requires company billing grant. Platform offers are displayed only as published versions with effective dates; nothing here enables payment until BILL-001 and O03 are resolved — the billing page in the first slice is an informational entry point with "Plans are not published yet" state.

## Data projection

| Page | Fields |
|---|---|
| Account | Name, email (change via verified flow), avatar, interface language (`settings.account.language`), delete account entry (policy O06) |
| Security and sessions | Password change, linked providers (Apple, Google) with link/unlink, active sessions list (device, location approximation, last seen, current marker, "End"), "End all other sessions", recovery info |
| Preferences | Interests (link to onboarding steps), pinned sections (Procurement/Sales pin toggles), notification preferences by category (decisions, runs, publications, magazine), reduced motion follows OS, assistant overlay preference (focus on open) |
| Channels | Connected email/messenger accounts with scopes, granted date, "Revoke"; explanation that imported content is untrusted |
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
| Desktop ≥1280 | Shell; PageHeader ("Settings"); left sub-navigation (Account, Security and sessions, Preferences, Connections, Billing and plans; `settings.nav.*`) 240 px; content max 760 px forms |
| Tablet | Sub-navigation as horizontal tabs |
| Mobile <768 | Sub-navigation as a select or stacked list page; forms full width |

## Component inventory

PageHeader, SubNav (`nav[aria-label="Settings"]` (`settings.nav.label`)), Form sections (`fieldset`/`legend`), TextField, PasswordField, AvatarUpload, ProviderLinkRow (icon, state, Link/Unlink with confirm), SessionTable → SessionCards, Switch (with text state), CheckboxGroup (notifications), PinToggle (Switch with explanation "the section moves to “More”"), ChannelRow (scopes chips, Revoke with ConfirmDialog), OfferCard (version, effective date, price if published, "Accept the terms" only when published), BudgetStatus, EmptyState, FormAlert, Toast.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Sessions: only current; Channels: "No connections" + "Connect" (hidden until providers exist, O08); Billing: "Plans are not published yet. Basic features are free." |
| Loading | Skeleton forms |
| Error | Inline; session end failure toast |
| Permission-denied | Company billing link hidden without grant; page direct access → NoAccess |
| Offline | Read-only |
| Partial/stale | Password changed elsewhere → re-login notice; provider unlink blocked if it is the only login method ("Set a password first") |
| Destructive | End all other sessions, unlink, revoke channel, delete account: ConfirmDialog with consequences |

## Keyboard order and focus

Shell → H1 → sub-nav → form fields in order → save per section. Switches announce state; confirm dialogs follow the dialog pattern.

## Responsive table behaviour

Sessions table (device, location, last activity, action) → cards below 768.

## Locale keys

| Key | English |
|---|---|
| `settings.title` | Settings |
| `settings.nav.account` | Account |
| `settings.nav.security` | Security and sessions |
| `settings.nav.preferences` | Preferences |
| `settings.nav.channels` | Connections |
| `settings.nav.billing` | Billing and plans |
| `settings.account.changeEmail` | Change the email |
| `settings.account.deleteAccount` | Delete the account |
| `settings.security.changePassword` | Change the password |
| `settings.security.currentPassword` | Current password |
| `settings.security.newPassword` | New password |
| `settings.security.providers` | Ways to sign in |
| `settings.security.link` | Link |
| `settings.security.unlink` | Unlink |
| `settings.security.unlinkBlocked` | Set a password first |
| `settings.security.sessions` | Active sessions |
| `settings.security.currentSession` | Current session |
| `settings.security.endSession` | End |
| `settings.security.endOthers` | End all other sessions |
| `settings.security.col.device` | Device |
| `settings.security.col.location` | Location |
| `settings.security.col.lastSeen` | Last activity |
| `settings.preferences.interests` | Interests |
| `settings.preferences.sections` | Menu sections |
| `settings.preferences.pinProcurement` | Show Procurement in the menu |
| `settings.preferences.pinSales` | Show Sales in the menu |
| `settings.preferences.pinNote` | A hidden section moves to “More” and stays available. |
| `settings.preferences.notifications` | Notifications |
| `settings.preferences.notify.decisions` | Decisions and approvals |
| `settings.preferences.notify.runs` | Assistant runs |
| `settings.preferences.notify.publications` | Publications |
| `settings.preferences.notify.magazine` | A new magazine issue |
| `settings.preferences.assistantFocus` | When the assistant window opens, jump to the latest message |
| `settings.channels.empty` | No connections |
| `settings.channels.connect` | Connect |
| `settings.channels.scopes` | Permissions |
| `settings.channels.revoke` | Revoke |
| `settings.channels.untrustedNote` | Emails and files from connections count as untrusted data and give the assistant no authority. |
| `settings.billing.freeNote` | Basic features are free. |
| `settings.billing.noOffers` | Plans are not published yet. |
| `settings.billing.currentPlan` | Current plan |
| `settings.billing.trial` | Trial until {date} |
| `settings.billing.platformBudget` | Paid services budget |
| `settings.billing.acceptedOffers` | Accepted terms |
| `settings.billing.offerVersion` | Version {version}, effective from {date} |
| `settings.billing.accept` | Accept the terms |
| `settings.billing.companyBilling` | Company billing and plans |
| `settings.billing.invoices` | Invoices |
| `common.confirm` | Confirm |

## Open questions

- O03: everything about prices; the OfferCard renders only published versions.
- Account deletion and data retention text (O06).
- Session location display (approximate, privacy) — security review.
