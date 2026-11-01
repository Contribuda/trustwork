# Tender desk: opportunities, bid/no-bid, compliance matrix, library, documents, pricing, clarifications, team, reviews, submission, outcomes

Routes under the existing Sales destination: `/app/sales/tenders` (dashboard), `/app/sales/tenders/opportunities`, `/app/sales/tenders/library`, `/app/sales/tenders/outcomes`, `/app/sales/tenders/settings`, and the pursuit `/app/sales/tenders/[pursuit]` with tabs `overview` (bid/no-bid), `requirements`, `documents`, `pricing`, `clarifications`, `team`, `reviews`, `submission`, `outcome`. Design: [The supplier bid desk](../../../engine/tender-desk.md); requirements: [module BID](../../../engine/modules/bid-desk.md). Packages: WEB-013 (dashboard, opportunities, overview, requirements, library, documents), WEB-014 (pricing, clarifications, team, reviews, submission, outcomes).

## Status and evidence

`no reference`. Status **Proposed**. Follows the workspace shell ([shell](shell.md)), the Sales contract ([sales](sales.md)) and the component inventory ([inventory](../component-inventory.md)); components already built in `packages/ui` keep their names there (SectionHeader, DataTable, Tabs, DecisionCard, Citation, ComparisonTable, Timeline, DateTile, Stepper, VersionPicker, Dialog, Toast, EmptyState, Badge, Field, Select, TagSelect). New composites are marked **new**. A clickable prototype with synthetic data was produced for review outside the repository; it is not a reference until the owner approves it.

## Navigation rules

- Reached from Sales (a "Tenders" tab next to "Requests" and "Catalogue") and from decisions waiting on Overview; no new top-level navigation, no generic inbox, no company or persona switcher.
- A platform RFQ invitation opened from Sales requests shows "Prepare as a tender" which creates a pursuit; routine quotes keep the quote editor of [sales](sales.md).
- The assistant overlay is the one assistant surface; every screen action has an agent equivalent and the overlay can open the exact first-party form for confirmations.

## Audience and access policy

| Role | Access |
|---|---|
| Company member with `bids.view` | Dashboard, opportunities, pursuits, matrix, library read, outcomes |
| Member with `bids.manage` | Create pursuits, edit matrix, documents, clarifications, team |
| Member with `bids.pricing.view` / `bids.pricing.manage` | Pricing tab; without it the tab shows NoAccess and the price schedule totals only after submission |
| Member with `bids.library.manage` | Library edits and review cycles |
| Approver selected by an approval route | Decision cards for `bid_decision` and `bid_submission` |
| Member with `bids.submit` | Submission confirmation (still bound by the approval route and step-up) |
| Teaming partner (another company) | Only the scope package shared with it, in its own workspace under Sales requests; never the pursuit |
| Expert in a consultation | Only the consultation scope, in the consultation context |
| Anyone else, including staff without a case grant | 404 |

## Data projection

| Screen | Fields |
|---|---|
| Dashboard | Decisions waiting (bid/no-bid, reviews, submission, stale rows, expiring credentials); deadlines this week (DateTile with buyer time zone); pursuits by stage; alert summary; agent suggestions labelled "suggested by your agent" |
| Opportunities | Title, buyer (public projection), source label ("from a public source: SAM.gov", "platform invitation", "open need", "added by your company"), classification codes, place of performance, value band where published, deadline with time zone, match reasons (matched terms, gates pass/fail/unknown), follow state; never any count of other followers |
| Overview and bid/no-bid | Notice facts with ProvenanceLine; EligibilityTable (gates); BidScorecard (criteria, weight, score, evidence, "your judgement" markers); recommendation with reasons; decision state; consultation suggestion card |
| Requirements (compliance matrix) | Requirement summary, kind, obligation, citation chip (document, page), confidence, status, owner, response link, evidence links, stale marker, review state; filters by kind, obligation, status, owner |
| Library | Item, kind, version, owner, review due, expiry, source of truth ("from your credentials"), used in pursuits; CV items show the consent state |
| Documents | Outline (volumes, sections, page limits), section editor, bound library versions, draft labels, translation labels and reviewer, accessibility findings, export panel with removed metadata list |
| Pricing | LineItemTable (line, quantity with source, unit, rate with source and date, cost build-up columns, unit price, total), escalation series and computation, MarginGuardPanel findings, PrivateFloorField per line and total, TotalsPanel; "Buyer sees" preview of the price schedule |
| Clarifications | Questions (draft, sent, answered) with the requirement cited, channel, recipient from structured data, question deadline, sent evidence; imported answers and addenda with the rows they affect |
| Team | Gaps, partner candidates with explanations and screening status words, introductions, scope packages sent, sub-quotes received (own only), teaming agreement drafts with competition-law note acknowledgement |
| Reviews | Rounds (outline, draft, final) with bound versions and digests, reviewers, comments, outcome; approval requests and decisions |
| Submission | Checklist groups with pass, fail and "confirm by a person"; bid security reference; final files with digests; channel (platform or portal steps from pack facts); confirmation dialog with step-up |
| Outcomes | Outcome, source (platform notice, imported award, recorded), debrief window and record, lessons, hand-off action and link to the project or agreement |

## Primary tasks

1. See matching opportunities and why they match.
2. Decide bid or no bid for stated reasons.
3. Turn the solicitation into a checked compliance matrix.
4. Assemble compliant documents from current library content in the buyer's format and language.
5. Price with escalation and a margin guard; send only the buyer's schedule.
6. Ask questions in time through the official channel.
7. Find partners and share only their scope.
8. Review, approve and submit as a person.
9. Record outcomes, request debriefs, keep lessons, hand off wins.
10. Book a real expert when the desk suggests one.

## Layout regions

| Width | Dashboard and lists | Pursuit tabs |
|---|---|---|
| Desktop ≥1280 | Shell; PageHeader ("Tenders"); left: decisions and deadlines; main: DataTable; FilterBar above lists | PageHeader (title, buyer, source label, deadline DateTile, stage StatusChip; actions per stage); Tabs; main content; right rail: deadlines, checklist progress, agent suggestions |
| Tablet | Cards for decisions; tables scroll horizontally in a labelled region | Rail moves below content; Tabs scroll with visible affordance |
| Mobile <768 | Cards; FilterSheet | Tabs become a Select; matrix rows as cards with a detail sheet; pricing shows line cards and a "more comfortable on a wide screen" note while staying operable; sticky bottom bar for the primary action |

## Component inventory

From the inventory (built in `packages/ui` or listed for DS-001): PageHeader, SectionHeader, FilterBar/FilterSheet, DataTable, Tabs, StatusChip/Badge, DateTile, EligibilityTable, DecisionCard, Citation (CitationChip and drawer), ProvenanceLine, VersionPicker, Timeline, Stepper, ComparisonTable (sub-quote view, own quotes only), LineItemTable, PrivateFloorField, TotalsPanel, ConfirmDialog, Dialog, Toast, EmptyState, NoAccess, Skeleton, Field, Select, TagSelect, AuthorityCheckCard, ThreadView, AssistantOverlay.

New composites (to add to `packages/ui` with the same accessibility rules):

| Component | Purpose | Accessibility |
|---|---|---|
| MatchReasons **new** | Matched terms, gates and unknowns as a short list | List with text labels for pass, fail, unknown; never colour only |
| BidScorecard **new** | Criteria, weights, scores, evidence links and the recommendation | Table with caption; score as text; recommendation in a status region |
| RequirementRow **new** | Summary, kind, obligation, citation chip, confidence, status, owner | Row header is the summary; confidence as text ("low confidence, 0.42"); stale marker as text |
| SectionOutline **new** | Volumes and sections with page limits and completion | Tree pattern with buttons for move; page-limit overrun announced |
| MarginGuardPanel **new** | Findings with severity and the line they refer to | List of findings; each links to its line; "not sent to the buyer" stated in text |
| DeadlineList **new** | Deadlines with both time zones and countdown | Dates via `Intl`; countdown text updates politely (no live region spam) |
| ChecklistGroup **new** | Pass, fail, confirm items per group | Each item a list item with text state; failures summarized at the top with links |
| ScopePackageForm **new** | Choose requirements, files and dates for one partner | Fieldsets; summary step before sending, naming the recipient |

## Interaction states

| State | Behaviour |
|---|---|
| Empty (opportunities) | "No matching opportunities yet" with "Set up alerts" and "Add a tender yourself" |
| Empty (library) | "Your library is empty" with "Start from your credentials" (imports from REP-001 and PREQ-001) |
| Loading | Skeleton rows |
| Error | Inline with retry; a failed extraction keeps documents and shows "Extraction failed; you can retry or enter requirements yourself" |
| Permission-denied | Pricing without right: NoAccess panel; submission without right: AuthorityCheckCard with "Ask an approver" |
| Offline | Reading cached pursuits allowed; editing drafts locally with "Not saved on the server"; sending, confirming and submitting blocked |
| Stale | Addendum: banner "The buyer published an addendum on {date}. {count} requirements changed." with "Review changes" |
| Quarantine | Banner on documents: "One document was set aside because it may contain information you must not use" with "Decide" (person only) |
| Deadline passed | Read-only with outcome actions; question drafts past the question deadline show "Past the question deadline" |
| Outcome unknown | Submission card "We could not confirm the submission. Check the portal before trying again." |
| Agent work | Drafts and suggestions labelled "Draft by your agent"; nothing auto-applies |

## Keyboard order and focus

Shell → PageHeader actions → Tabs → filters → content → rail. Matrix: row headers in reading order; Enter opens the row sheet; the citation chip opens the drawer with focus on the cited passage; Escape returns focus to the chip. Pricing: cells labelled "{column}, line {n}"; Tab across cells. Confirmation dialogs focus Cancel first; the submission dialog names the recipient, the files' digests and the deadline before the step-up prompt. Switching tabs moves focus to the panel heading.

## Responsive table behaviour

Opportunities and matrix collapse to cards under 768 px with field labels kept; pricing keeps a sticky description column on tablet and line cards on mobile; ComparisonTable of sub-quotes uses the per-line accordion.

## Locale keys

Namespace `bidDesk` in `apps/web/locales/<lang>/bid-desk.json` for every engine language (`en`, `ru`, `uz-Latn`, `ka`, `hy`, `az-Latn`, `es`).

| Key | English |
|---|---|
| `bidDesk.title` | Tenders |
| `bidDesk.tabs.overview` | Overview |
| `bidDesk.tabs.requirements` | Requirements |
| `bidDesk.tabs.documents` | Documents |
| `bidDesk.tabs.pricing` | Pricing |
| `bidDesk.tabs.clarifications` | Questions |
| `bidDesk.tabs.team` | Team and partners |
| `bidDesk.tabs.reviews` | Reviews |
| `bidDesk.tabs.submission` | Submission |
| `bidDesk.tabs.outcome` | Outcome |
| `bidDesk.opportunities` | Opportunities |
| `bidDesk.library` | Content library |
| `bidDesk.outcomes` | Awards and debriefs |
| `bidDesk.source.public` | From a public source: {portal} |
| `bidDesk.source.invitation` | Platform invitation |
| `bidDesk.source.openNeed` | Open need |
| `bidDesk.source.manual` | Added by your company |
| `bidDesk.follow` | Follow |
| `bidDesk.whyMatch` | Why this matches |
| `bidDesk.gate.pass` | Meets |
| `bidDesk.gate.fail` | Does not meet |
| `bidDesk.gate.unknown` | Unknown |
| `bidDesk.recommendation.bid` | Recommended: bid |
| `bidDesk.recommendation.bidWithConditions` | Recommended: bid if {condition} |
| `bidDesk.recommendation.resolveFirst` | Resolve first |
| `bidDesk.recommendation.noBid` | Recommended: do not bid |
| `bidDesk.decide` | Decide |
| `bidDesk.yourJudgement` | No evidence; your judgement |
| `bidDesk.extract` | Find requirements |
| `bidDesk.citation` | {document}, page {page} |
| `bidDesk.confidence` | Confidence {value} |
| `bidDesk.stale` | Changed since you answered |
| `bidDesk.agentDraft` | Draft by your agent |
| `bidDesk.machineTranslation` | Machine-assisted translation, not reviewed |
| `bidDesk.reviewDue` | Review due |
| `bidDesk.cvConsent` | Used with {name}'s consent until {date} |
| `bidDesk.metadataRemoved` | Removed from the export: {items} |
| `bidDesk.floor` | Your floor (never sent) |
| `bidDesk.belowFloor` | Below your floor |
| `bidDesk.buyerSees` | What the buyer receives |
| `bidDesk.unbalanced` | Unit price far from its cost build-up |
| `bidDesk.questionDeadline` | Questions due {date} ({zone}) |
| `bidDesk.officialChannel` | Sent through the official channel: {channel} |
| `bidDesk.pastQuestionDeadline` | Past the question deadline |
| `bidDesk.scopeOnly` | Shares only this partner's scope; never your prices |
| `bidDesk.competitionNote` | Competition-law note |
| `bidDesk.checklist.fail` | {count} items block submission |
| `bidDesk.submit.platform` | Submit on Trustwork |
| `bidDesk.submit.portal` | I submitted on the portal |
| `bidDesk.submit.confirm` | You are about to submit a binding offer to {buyer}. Files: {digests}. Deadline: {deadline}. |
| `bidDesk.outcomeUnknown` | We could not confirm the submission. Check the portal before trying again. |
| `bidDesk.debriefDue` | Debrief request due {date} |
| `bidDesk.handOff` | Hand off to execution |
| `bidDesk.suggestExpert` | An expert could help with {topic} |
| `bidDesk.expertUnavailable` | This expert is not available for this request |
| `bidDesk.synthetic` | Synthetic demo data |

## Open questions

- Whether "Tenders" is a tab of Sales or a separate pinned destination for companies that bid often (proposal: tab; pinning stays the person's choice).
- Whether partners see scope packages under Sales requests or in a dedicated "Invitations to team" list (proposal: Sales requests).
