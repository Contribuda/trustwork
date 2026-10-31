# Human review request: `workspace-latest.png` and contradictions found

Prepared by DS-000 on 2026-10-27. The reference `workspace-latest.png` (private design archive) has manifest status `proposed_unapproved`; this task does not change it. The questions below are the decisions a human must make before DS-001 draws the workspace and WEB-001 implements it. Each question lists the observed state, the constraint it touches, alternatives and trade-offs. Conversation with the human is in Russian; this document is the English engineering record.

## A. Decisions about `workspace-latest.png`

### A1. Accept the overall workspace composition as direction?

Observed: light sidebar with brand row and collapse control inside it, grouped navigation in the exact accepted order, "To the industry" (`publicExit`) at the bottom, header with search/bell/avatar, two commerce panels, projects and events, floating launcher.

Constraint check: complies with R23/R24 (no role switch, no company selector, no bottom-left account block, avatar only, collapse inside brand row, floating launcher). No contradictions with the rejection ledger were found.

Options: (1) accept as direction and proceed to full-state design; (2) request a second concept with a denser, more list-like overview; (3) accept with corrections listed in A2–A7.

Recommendation: option 3.

### A2. Breadcrumb root "Workspace / Overview"

Observed: header shows a two-level breadcrumb on the top-level page. Trade-off: it repeats the sidebar and wastes header space on mobile. Alternatives: (a) no breadcrumb on top-level destinations, breadcrumb only inside objects (recommended); (b) keep as in the image.

### A3. "+ Create ▾" as a split button

Observed: a primary split button (plus icon + label + chevron). Trade-off: a split button has two actions (default create vs menu) and is harder to make accessible and to explain; the default action is ambiguous for a mixed buyer/seller. Alternatives: (a) single menu button "Create" listing Need / Quote / Project / Publication by grant (`overview.createItems.*`) (recommended); (b) keep split with "Need" as default; (c) no global create, only per-card actions.

### A4. Decisions placement

Observed: each commerce card has a highlighted top item ("Your decision is needed", "To review"). Alternatives: (a) one cross-object "Your decision is needed" panel above the cards plus the per-card top item (recommended; it also serves the personal-only variant where approvals/publication reviews exist without commerce); (b) only per-card highlights as in the image; (c) only a global panel.

### A5. Sidebar divider groups

Observed: [Overview, My page, Company] | [Projects, Procurement, Sales, Publications, Assistant]. The IA fixes order, not grouping. Alternatives: (a) keep the divider (recommended; it separates identity from work); (b) no divider.

### A6. Catalogue label

Observed: "Catalogue of goods and services". Manifest correction already requires works. Options: (a) "Catalogue of goods, works and services" (recommended; contracts use it) / (b) "Catalogue" in tight spaces such as collapsed navigation, tabs and mobile headers, with the full wording as the accessible name.

### A7. Notification bell dot

Observed: red dot without count. Alternatives: (a) count badge with accessible name "Notifications, new: N" (recommended); (b) dot only. Also confirm that the bell opens a notifications panel (object-linked list) and never a message inbox.

### A8. Personal-only variant

Not shown. Confirm the proposed variant in [overview](workspace/overview.md): no commerce cards, Decisions/Projects/Publications/Events only, no welcome wizard. Alternative: show commerce cards with empty states anyway (rejected by journey 1).

### A9. Assistant overlay visual

Not shown. The launcher is a blue circle with a spark icon. Decide: (a) overlay panel 400×640 px bottom-right, non-modal on desktop, full-screen modal on mobile (recommended, matches R09 and accessibility doc); (b) centered modal dialog (rejected by spec: must not block content); (c) docked side panel (rejected by ledger).

### A10. Collapsed sidebar presentation

Not shown. Decide: icons with tooltips and visually hidden labels (recommended) vs labels under icons (taller items). Tablet default collapsed, desktop remembers preference.

### A11. Photos inside workspace rows

Observed: thumbnails for RFQ rows, projects and events. Trade-off: imagery looks warm but requires licensed photos per object; most objects will have none. Alternatives: (a) thumbnails optional with a neutral kind icon fallback (recommended); (b) no thumbnails in workspace lists.

## B. Contradictions and corrections found in other references (confirm)

| Ref | Issue | Proposed resolution |
|---|---|---|
| `signup.png` | Label "First and last name" | Use `auth.name` "Your name" as the visible label; example placeholder; no surname (already in manifest; confirm no objection) |
| `news.png` | Old header (Top stories, Materials, Technology, Market) | Replace with the seven sections; keep list pattern (already in manifest) |
| `onboarding-capabilities.png` | "Continue" disabled when nothing is selected | Proposal: enabled and equivalent to skip; keep "I’ll look around first" link. Needs a decision |
| `companies-hub.png` | Star ratings, review counts, "confirmed projects" and dimension bars shown without sample counts or methodology; "Confirmed experience" filter | Show reputation only when O07 allows, with counts/methodology; always show sourced/claimed/verified; no star for sourced records |
| `people-hub.png` | Portraits for everyone | Portraits only with consent + licence; initials fallback; no sourced-only people |
| `projects-hub.png` | Map view toggle | Hide until a map provider is chosen (O08) |
| `weekly-magazine.png` | Two-page spread preview; page counts without PDF | Spread optional/dropped; page count only when the PDF exists; mobile reader is single column |
| `public-home.png` | Pre-footer promises (Collections, Projects, Assistant) | Copy must describe only implemented capabilities at launch |
| All public references | Synthetic photos, names, ratings, counts | Never reused; licensed imagery plan needed (budget decision) |

## C. Product-level decisions surfaced by the contracts

1. Is personal (non-company) procurement allowed (journey 5 suggests yes)? Affects [procurement](workspace/procurement.md) empty state. Recommendation: yes, for personally owned projects; a person who owns a project may run its procurement without a company, with personal authority and a personal transaction budget.
2. May an independent specialist maintain a personal catalogue and quote without a company? Affects [sales](workspace/sales.md). Recommendation: no personal catalogue in the first slice; deferred to COM-001, which decides the data model before any UI is drawn.
3. Public search before RAG-301: lexical-only list, no answers on the public site (proposed). Confirm.
4. Admin route prefix `/admin` and avatar-menu entry (proposed). Recommendation: yes, `/admin` prefix with the avatar-menu entry "Administration" (`shell.menu.admin`) shown only to holders of a platform role.
5. Font choice: Golos Text (Russian-first) vs Inter (neutral); PT Serif for the reader. See [layout proposal](layout-and-tokens-proposal.md). Recommendation: Golos Text for UI and public body, PT Serif for the magazine reader and PDF body.
6. Technology stack proposal in [technology-recommendations.md](technology-recommendations.md) (React Aria Components, CSS Modules, Lucide, Storybook, Playwright+axe) — integrator decision because of the lockfile.

## What this request does not do

It does not approve anything, does not change the manifest, does not seed any synthetic content, and does not alter navigation labels or locale files. Decisions should be recorded with author and date in the manifest (`decisionSource`) and, where product policy changes, in the specification or an ADR by the integrator.
