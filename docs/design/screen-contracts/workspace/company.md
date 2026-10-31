# Company: member view, admin view, no-company empty state

Route: `/app/company` (hub), `/app/company/settings/*` (admin), `/app/company/join` and `/app/company/new` (empty-state flows).

## Status and evidence

`no reference`. Spec R02 (one ordinary current employer; shared company page; permission-scoped editing; no switcher), R06 (versioned catalogue; private floors never published), R20 (company administration separate from platform administration), "Identity, company and public pages" (hub contains details, wall, people, catalogue, projects, reputation, external website; joining/editing needs invitation/verified authority under claim policy O05), journey 6; IA (no employer selector; purposeful empty state with optional joining/creation).

## Audience and access policy

| Viewer | Sees |
|---|---|
| No company linked | Empty state with "Join" (by invitation code/link or request to a claimed company) and "Create a company page"; no forced completion; the rest of the workspace works |
| Pending invitation / pending join request | State card with status; cancel; still no company data |
| Company member | Member view: details, wall, people (member list with roles as permitted), catalogue (read; prices visible per grant; private floors only with grant), projects of the company the member is granted, company publications, reputation (internal evidence view per grant), settings entry only if admin |
| Company administrator | Member view + "Company settings": profile editing, membership (invite, roles, end membership), claim/verification status, catalogue management grant, publication rights, company billing (if granted), delegation policies |
| Former member | Nothing here; empty state; residual grants (O04) are explicit and shown as "restricted access: …" if ever granted |

Only one current employer is modelled (O15 out of scope). No switcher anywhere.

## Data projection

| Tab | Member | Admin additional |
|---|---|---|
| Overview | Public card preview, status badge (sourced/claimed/verified), open decisions for the company that I may act on, recent wall items | Claim/verification progress, pending invitations count |
| Wall | Company publications and project updates (shared publication records) | Publish/edit per grant |
| People | Members with role titles and public/consent markers; invite button if granted | Role assignment, end membership (confirmation dialog explaining revocations: grants, sessions, mandates), pending invites |
| Catalogue | Versioned catalogue: goods / works / services / mixed bundles; version picker; public flag per entry; private floor fields only with grant | Create new version, publish version, archive |
| Projects | Company-owned and company-participating projects I can see | Transfer ownership flow entry |
| Reputation | Evidence-backed dimensions with sample counts, methodology; disputes/appeals I may see | Appeal/respond actions |
| Settings (admin only) | — | Profile, domain/website, membership policy, delegation policy, billing entry (contextual), danger zone |

## Primary tasks

1. Join or create a company without being forced.
2. See the company's shared state and act within my grants.
3. Admin: manage people, catalogue versions, claim/verification, settings and billing.
4. End a membership safely with clear revocation consequences.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Shell; PageHeader (logo, name, StatusBadge, "Public page ↗", admin "Company settings"); tabs; panel; right rail on Overview (claim status, website, invite) |
| Tablet | Rail below panel; tabs scroll |
| Mobile <768 | Header stacks; tabs scroll; tables collapse (see below) |

Empty state (no company): centered card max 640 px with illustration-free layout: H1 "Company", text explaining that a company is optional, two buttons ("Join by invitation", "Create a company page"), link "Find a company in the directory" (public hub), and a note that joining needs confirmation by the company (O05).

## Component inventory

PageHeader, StatusBadge, Tabs, EmptyState (two actions), InviteDialog (email or link; role selection limited to admin's own authority), MemberTable → MemberCards (mobile), RoleSelect, ConfirmDialog (destructive; lists consequences), CatalogueTable with VersionPicker, CatalogueEntryForm (kind: goods/works/services/bundle; unit; price-on-request; public flag; private floor fields with lock icon + text "not published"), ClaimStatusCard, ReputationPanel, ProjectCardList, SettingsForm, DangerZone, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (no company) | As above; never a modal; never blocks other navigation |
| Empty (member, tabs) | "The catalogue is empty" (+ create if granted), "No employees yet" (`company.membersEmpty`) etc. |
| Loading | Skeleton header and panel |
| Error | Inline + retry |
| Permission-denied | Tab visible but panel shows NoAccess card (e.g., catalogue private floors, settings); admin-only actions hidden, not disabled with no explanation |
| Offline | Read-only with banner |
| Partial/stale | Membership ended during session: next request returns empty state with explanation "Your membership ended on {date}"; catalogue draft version older than published one shows "A newer published version exists" |
| Pending | Join request pending: status card with "Cancel the request" |

## Keyboard order and focus

Shell → header links/buttons → tabs → panel. Tables: row actions in a menu button per row (not icon-only buttons without labels). Confirm dialogs: focus on the first non-destructive control (Cancel), destructive button requires explicit activation; Escape cancels.

## Responsive table behaviour

MemberTable (name, role, status, since, actions) and CatalogueTable (item, type, unit, price/on request, public, version) collapse to cards below 768 with field labels; version picker becomes a select above the list; sort via select. Column visibility toggles on tablet (hide "since"/"version" by default).

## Locale keys

| Key | English |
|---|---|
| `company.title` | Company |
| `company.publicPage` | Public page |
| `company.settings` | Company settings |
| `company.tabs.overview` | Overview |
| `company.tabs.wall` | Wall |
| `company.tabs.people` | People |
| `company.tabs.catalogue` | Catalogue |
| `company.tabs.projects` | Projects |
| `company.tabs.reputation` | Reputation |
| `company.empty.title` | You are not linked to a company yet |
| `company.empty.body` | You can work without a company: read, publish and run personal projects. If you represent a company, join by invitation or create its page. |
| `company.empty.join` | Join by invitation |
| `company.empty.create` | Create a company page |
| `company.empty.find` | Find a company in the directory |
| `company.empty.policyNote` | Joining is confirmed by the company. |
| `company.join.code` | Invitation code or link |
| `company.join.pending` | The request was sent and awaits confirmation |
| `company.join.cancel` | Cancel the request |
| `company.membershipEnded` | Your membership ended on {date} |
| `company.invite` | Invite |
| `company.invite.email` | Employee email |
| `company.invite.role` | Role |
| `company.member.name` | Name |
| `company.member.role` | Role |
| `company.member.status` | Status |
| `company.member.since` | Start |
| `company.member.actions` | Actions |
| `company.member.end` | End participation |
| `company.member.endConfirmTitle` | End {name}'s membership in the company? |
| `company.member.endConsequences` | Company rights, active assistant mandates and company-related sessions will be revoked. The employee's personal page and publications remain. |
| `company.catalogue.empty` | The catalogue is empty |
| `company.catalogue.newVersion` | New version |
| `company.catalogue.publish` | Publish the version |
| `company.catalogue.version` | Version {version} of {date} |
| `company.catalogue.newerPublished` | A newer published version exists |
| `company.catalogue.unit` | Unit |
| `company.catalogue.price` | Price |
| `company.catalogue.priceOnRequest` | On request |
| `company.catalogue.public` | Public |
| `company.catalogue.privateFloor` | Floor price (not published) |
| `company.claim.title` | Page status |
| `company.claim.sourced` | Created from an open source |
| `company.claim.claimed` | Claimed, awaiting verification |
| `company.claim.verified` | Verified |
| `company.settings.profile` | Profile |
| `company.settings.membership` | Employees and roles |
| `company.settings.delegation` | Delegation policy |
| `company.settings.billing` | Company billing and plans |
| `company.settings.danger` | Danger zone |
| `common.noAccess` | No access to this section |

Catalogue kind labels reuse the shared enum `kind.*` (see [procurement](procurement.md) and the key conventions in the [README](../README.md)).

## Open questions

- O05: how a claim is proven; the UI only shows status and a "Confirm" (`common.confirm`) entry.
- O04: residual read-only grant for former employees — not designed; only a label is reserved.
- Which roles exist (admin, publisher, buyer operator, seller operator, viewer) — FND-002/BE-001 freeze; the RoleSelect reads them from the contract.
