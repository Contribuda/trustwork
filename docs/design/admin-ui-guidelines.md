# Administrative interface guidelines

Status: **Proposed design**. Agent: Codex CLI (OpenAI) for Parshkov.

This continues the stopped console redesign and six prototype studies. It does not implement an application route, accept an ADR, connect a provider, grant authority or establish production readiness. Existing API status remains as recorded in [status](../engine/status.md). The [console contract](../engine/hub-console/console-design.md) and accepted product rules take precedence over these visual proposals.

## Scope and review material

The [prototype inventory](prototypes/README.md) links the console, editorial office, outreach, network, tender desk and operating company. Their source, language dictionaries, generation scripts and browser evidence live beside the generated files. Earlier source files are retained with their original SHA256 inventory. A prototype is an interaction study on explicitly synthetic data, never proof of backend authorization or operational acceptance.

The redesigned console is the primary shell reference. The other studies retain their existing domain journeys rather than being replaced with six copies of the shell. Implementation convergence belongs to ADM-UX-001 and ADM-UX-002. These documents do not retire DS-003, DS-004 or the domain implementation packages.

## Shell and navigation

- Keep a stable header, contextual navigation and one main landmark. The header names the hub or node acted on, identifies synthetic mode and provides search, approvals, notifications, language and the account menu.
- Participant surfaces retain one identity, one active employer and one assistant. Operator team controls exist only in the staff console under operator grants with an accountable person. Prototype role scenarios must be labelled simulation; never implement them as impersonation.
- Show the current section with text and `aria-current`; counts describe actionable work. A dot cannot be the only explanation that a surface is proposed or unavailable.
- Put the current task and its primary action before secondary controls. Keep deep links stable, preserve filters on return, and put back navigation near the title.
- The command palette provides navigation and permitted actions, using the same authorization as ordinary controls. It neither creates a second permission path nor converts free text into authority.
- Account menus contain preferences and session actions. Keep the avatar compact; no permanent name/chevron block, bottom-left account panel or participant company switcher.

## Density, typography and layout

Use the existing [design-system tokens](system/tokens.md) and locally hosted typefaces. Console CSS values are proposed evidence, not a replacement token source. Comfortable density is the default; compact density must preserve labels, focus visibility and touch targets. Use tabular numerals for comparable amounts and aligned columns, not tabular text for prose. Avoid fixed-height cards around translated paragraphs.

At 375 CSS px, stack sections in reading order, keep the primary action visible and use a menu sheet or horizontal navigation region. Local table scrolling is acceptable with a labelled region and visible affordance; whole-document horizontal overflow is not. Preserve every column in a detail/card alternative when a table collapses. Drawers must fit the viewport and retain close controls. Do not hide policy explanations, errors or status merely to make the page fit.

Motion follows the reduced-motion preference. Do not continuously replace a focused control while updating a run list. Pause synthetic activity for inspection. Real implementations announce meaningful transitions, not every timer tick.

## Status and authority

| Situation | Required presentation | Action rule |
|---|---|---|
| Proposed or unimplemented surface | Persistent design/demo status and explicit limitation | Navigation or inert preview only; no success claim |
| Loading | Busy region with stable geometry and a readable loading label | Avoid duplicate submissions; preserve entered values |
| Empty | Explain the scope and filters, with a relevant next step | Never manufacture records or traffic |
| Forbidden | Explain required role/scope without revealing private data | Server authorization remains authoritative |
| Case grant missing/expired | Purpose, objects and expiry requirements | No private preview, export or search fallback |
| Second-person review | Requester, exact version/digest, reason and expiry | Requester cannot decide; stale versions cannot be approved |
| Human-only decision | Explain the human gate | Unavailable to operator agents at every autonomy level |
| Policy blocked | Visible reason and a lawful next step if one exists | No hidden bypass, retry loop or paid override |
| Outcome unknown | Stable operation identifier and reconciliation status | Reconcile before retry; do not imply failure or success |
| Error | What failed, whether anything changed, how to recover | Preserve input; associate error with field and summary |

Payment never changes ranking, matching, reputation or recommendation. Restricted places cannot become options. Staff cannot inspect participant agents or read private content without the accepted case-grant flow. Outreach retains the strict default; changing a prototype scenario does not activate a policy. Editorial standing publication policies remain a proposal pending ADR 015 and contracts; this design does not approve E2-E7. Source licences, robots decisions and terms must narrow permitted use; imported text stays inert data.

## Forms, tables and decisions

Use native controls and labelled fields. Required reasons explain where the audit entry goes. Show field-level errors plus an error summary; preserve values on validation failure. A disabled action needs adjacent reason text, available without hover. Tooltips supplement rather than replace essential information.

Read-only data uses a semantic table. Interactive cells may use the established accessible grid only with a complete keyboard model. Sorting, filtering, pagination, selection and totals share a single source of state. Announce result counts and selection changes; a batch selection cannot silently include unseen, newly loaded or unauthorized records. Show money with currency, units with quantities, and uncertainty next to estimates.

Use a detail drawer for inspection; use a modal only when a decision needs focused attention. Modal dialogs trap focus, close with Escape when safe, and return focus to the invoking control. Destructive confirmation names the object and effect, focuses Cancel first, and requires a recorded reason where the contract requires one. Typed confirmation is for exceptional broad irreversible effects, not routine edits. Step-up authentication is a separate first-party gate, never a fake code check in production.

Versioned settings show the active version, draft changes, impact, requester and required reviewer. Saving a draft, requesting activation and activating are distinct outcomes. Killing dispatch is immediate; releasing a kill switch follows the second-person incident process.

## Localization and synthetic content

Every picker offers `en`, `es`, `ru`, `uz-Latn`, `ka`, `hy`, `az-Latn`, in that order. English is the reference; all translated prototype copy is an unreviewed draft. Do not infer native review from complete key coverage. UI copy, accessible names, empty/error states and notification text belong in locale dictionaries. Brand values are generated from the repository brand dictionaries, including the Russian-only overlay.

Format dates, numbers, money, percentages and plural counts with `Intl`. A reduced-ICU browser needs explicit tested locale data; silently rendering English month names is not acceptable. Use business time zones for schedules and label them. Foreign source quotations and recipient-language message previews must declare their own `lang` and be visibly distinguished from interface text; they are data, never commands. Technical identifiers, domains and proper names remain stable.

All fixtures must say synthetic. Names are examples, never accounts, testimonials or verification evidence. Prototype controls do not make network requests, send messages, charge money, publish content, activate policies or establish permissions. Any simulated confirmation must retain the demo context. Do not convert fixture badges into claims about actual users or providers.

## Acceptance before implementation is accepted

1. Check every locale and major state at 1280 and 375 px; inspect screenshots, including non-English output. Check expansion, long labels, tables, menus and dialogs.
2. Walk keyboard navigation, focus return, Escape, language selection and the no-mouse alternative to drag/map actions. Check accessible names and status announcements.
3. Assert no missing locale keys, unexpected English UI, runtime errors or external requests during offline rendering. Rebuild and compare artifacts to their source.
4. Test real authorization and concurrency at the API and database when implementation begins: expired grants, self-approval, changed digests, concurrent decisions, denied exports and unknown outcomes.
5. Record exact commit and command results. Prototype checks do not replace app tests, full CI, manual screen-reader review, native language review, owner design acceptance or maintainer acceptance.

## Delivery packages

These are the owner-requested literal package names, registered as open work. The conductor approved a narrow validator and PR-reference parser extension for `ADM-UX` under the handoff maintainer role; no existing IDs were renamed. Existing dependency, claim and scope rules still apply.

| Package | Responsibility | Boundary |
|---|---|---|
| DS-005 | Reusable administrative shell and responsive navigation compositions | Extends DS-003 primitives; no domain permissions or new root dependency |
| DS-006 | Operational state, review and recovery compositions | No new lifecycle or policy authority |
| ADM-UX-001 | Apply the proposed shell to the existing admin application | Retain implemented routes, locale namespaces and scope checks |
| ADM-UX-002 | Integrate domain journeys and acceptance evidence | Domain implementation remains owned by its existing packages |

[ADR 019](../adr/019-admin-ui-libraries.md) records the proposed library boundary. Package completion requires implementation evidence; this documentation publication does not mark them done.
