# Missing design backlog

Status: proposed. Every item is a design (not implementation) gap discovered while inspecting the eleven references against the contracts. Priority: P1 blocks the first implementable slice; P2 needed before public deployment; P3 later. "Task" is the owner lane in the task tracker; the human decision column marks items that need the client's visual acceptance (O09).

| # | Missing design / state | Contract | Priority | Task | Human decision |
|---|---|---|---|---|---|
| 1 | Canonical editable logo (three blue squares + stacked wordmark) with provenance and clear-space rules | all | P1 | DS-001 | yes |
| 2 | Tokens: final colours with contrast evidence, type scale with chosen Cyrillic font, spacing, focus ring | [layout proposal](layout-and-tokens-proposal.md) | P1 | DS-001 | yes |
| 3 | Mobile (<768) layouts for all seven public pages and the magazine reader; none exists | public/* | P1 | DS-001 + WEB-001 | no |
| 4 | Public header authenticated variant (avatar only) and mobile navigation sheet | [home](public/home.md) | P1 | WEB-001 | no |
| 5 | Empty, loading, error, denied, offline states for public lists and details | public/* | P1 | WEB-001 | no |
| 6 | News detail page; article detail page with TOC; correction banner and retraction notice | [news](public/news.md), [articles](public/articles.md) | P1 | CNT-001 | no |
| 7 | Company public page (tabs), person public page, project public page | [companies](public/companies.md), [people](public/people.md), [projects](public/projects.md) | P1 | WEB-001 | no |
| 8 | Sourced / claimed / verified badge system and provenance line; reputation summary with sample counts and "not enough data" | [companies](public/companies.md) | P1 | DS-001 | partly (O05, O07 policy) |
| 9 | Person card/profile without portrait (initials), consent indicators | [people](public/people.md) | P1 | DS-001 | no |
| 10 | Magazine mobile single-column reader; issue detail; archive empty state; PDF pending state; correction banner; PDF layout template and accessibility plan | [magazine](public/magazine.md) | P1 | CNT-001 | yes (PDF look) |
| 11 | Search results page with partial/no-answer/unavailable/stale/historical banners; citation drawer; unavailable citation | [search](public/search-and-citations.md) | P1 | WEB-003 | no |
| 12 | Login/signup error, rate-limit, loading, provider error, email verification interstitial, mobile stacked layout | [login](public/auth-login.md), [signup](public/auth-signup.md) | P1 | WEB-001 | no |
| 13 | Recovery request/reset pages and token-state cards | [recover](public/auth-recover.md) | P1 | WEB-001 | no |
| 14 | Onboarding selected states, keyboard focus on cards, mobile sticky actions; "I supply" and "I take part" variants of step 2 | [onboarding](public/onboarding-capabilities.md), [step 2](public/onboarding-categories-regions.md) | P1 | WEB-001 | small (Continue enabled with zero) |
| 15 | Workspace shell: collapsed sidebar, tablet overlay sidebar, mobile navigation sheet, notifications panel, avatar menu, offline banner, "More" (`shell.more`) disclosure | [shell](workspace/shell.md) | P1 | DS-001 + WEB-001 | yes (whole workspace visual) |
| 16 | Overview personal-only variant; empty cards; Decisions panel; "Create" menu | [overview](workspace/overview.md) | P1 | WEB-001 | yes |
| 17 | My page: private work view, public projection editor with preview and consent | [my page](workspace/my-page.md) | P1 | WEB-001 | no |
| 18 | Company: no-company empty state, join/create flows, member/admin views, catalogue version UI, end-membership confirmation | [company](workspace/company.md) | P1 | WEB-001 (+ COM-001 data) | partly (O05) |
| 19 | Projects: list, detail tabs, baseline vs changed timeline, evidence list, transfer flow, projection editor | [projects](workspace/projects.md) | P2 | WEB-002 / EXE-001 | no |
| 20 | Procurement: intake wizard with evidence pointers, RFQ versions, supplier discovery with eligibility, comparison table (desktop/tablet/mobile), order with authority/budget, outcome_unknown | [procurement](workspace/procurement.md) | P2 | WEB-002 / COM-001 | no |
| 21 | Sales: leads, quote editor (desktop table, mobile cards), versions, order acceptance, catalogue with private floors | [sales](workspace/sales.md) | P2 | WEB-002 / COM-001 | no |
| 22 | Publications: list, editor, correction/retraction dialogs, review feedback | [publications](workspace/publications.md) | P2 | CNT-001 | no |
| 23 | Assistant: full page tabs, overlay (desktop non-modal, mobile modal), minimized state, unread/action-required launcher badges, mandate form, approval digest, run timeline with outcome_unknown, stop dialog | [assistant](workspace/assistant.md) | P1 (overlay/launcher), P2 (mandates/runs) | AST-001 / WEB-002 | yes (overlay visual) |
| 24 | Settings pages and billing informational state; sessions table | [settings](workspace/settings.md) | P2 | WEB-001 / BILL-001 | no |
| 25 | Administration surfaces: editorial queue, issue editor + release checklist, moderation and support cases with scoped grants, offer version editor | [administration](workspace/administration.md) | P2 | BILL-001 / CNT-001 | no |
| 26 | Component states catalogue (hover/focus/disabled/error/loading) for every primitive, in Storybook | [component inventory](component-inventory.md) | P1 | DS-001 | no |
| 27 | Illustration set for onboarding and empty states, or decision to use none | onboarding | P3 | DS-001 | yes |
| 28 | Licensed photography plan for public pages (replace synthetic images) | public/* | P2 | CNT-001 / human | yes (budget) |
| 29 | Map view for projects | [projects](public/projects.md) | P3 | deferred (O08) | yes |
| 30 | 404 / 500 / maintenance pages in every interface language within public and workspace shells | all | P1 | WEB-001 | no |
| 31 | Email templates (verification, recovery, invitation, notifications) in every interface language, consistent with brand | auth, company | P2 | BE-000 / CNT-001 | no |
| 32 | Print styles for quote snapshots and acceptance records | sales, projects | P3 | WEB-002 | no |

## Coverage check against the design inventory table

| Inventory row | Covered by |
|---|---|
| Canonical vector logo, type/spacing/colors, component primitives | #1, #2, #26 |
| Personal/company detail and permissions | #7, #17, #18 |
| RFQ intake, comparison, quote versions, mixed bundles | #20, #21 |
| Assistant page/overlay, mandates, stop/revoke/unknown outcome | #23 |
| Project plan/execution/change/acceptance/dispute | #19 |
| Settings/billing/platform administration | #24, #25 |
| Magazine mobile/PDF/archive/corrections | #10 |
| Empty/loading/error/forbidden/offline/accessibility/mobile | #3, #5, #12, #15, #16, #30 |
