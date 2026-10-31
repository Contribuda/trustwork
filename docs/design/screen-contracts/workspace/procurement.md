# Procurement: intake, RFQ list, RFQ detail with versions, supplier discovery, quote comparison, order

Routes: `/app/procurement` (list), `/app/procurement/needs/new` (intake), `/app/procurement/rfq/[id]` with tabs `requirements`, `suppliers`, `quotes`, `compare`, `negotiation`, `order`, `files`, `correspondence`, `approvals`; `/app/procurement/suppliers` (discovery); `/app/procurement/orders/[id]`.

## Status and evidence

`no reference`. Spec R05 (intake → clarification → RFQ → discovery → eligibility → quote versions → normalization → negotiation → selection/order → fulfillment → acceptance → review; goods, works, services and mixed bundles), R06, R08, R10, R13, "Commercial journeys" (clarify scope/quantity/unit/location/schedule/acceptance before solicitation; discovery with sourced provenance; eligibility shows criteria and uncertainty; quote version fields; comparisons show exclusions and non-comparable scope; order only after authority/budget checks; seller acceptance separate; accepted snapshots immutable); journeys 3, 4, 7; [lifecycles](../../../data/lifecycles.md) (NeedDraft → … → Reviewed; RFQ amendments mark prior responses stale); design inventory missing surface "RFQ intake, comparison, quote versions, mixed bundles".

## Audience and access policy

| Role | Access |
|---|---|
| Buyer-authorized operator (person with grant on the RFQ or company procurement grant) | Full buyer side: need, RFQ versions, invited suppliers, quotes, comparison, negotiation, private notes, budget ceiling, order commitment **only** with action/amount-bound authority |
| Project owner/leader where RFQ is linked | Per project grant |
| Company member without grant | Not listed; 404 |
| Supplier | Never sees this surface; sees own quote side in Sales |
| Assistant | Acts under a mandate; its actions appear as runs with digests in "Approvals" |

Buyer's cost limits, private evaluation notes and candidate scoring never enter the supplier projection.

## Data projection

| Screen | Fields |
|---|---|
| List | Need/RFQ title, kind mix (goods/works/services/bundle), status chip, current RFQ version, quotes count (received/stale), deadline, project link, operator, attention marker |
| Intake ("New need") | Source: manual / file / trusted email / assistant; extracted lines with evidence pointers (file page/row) and confidence; required fields: scope, quantity, unit, location, schedule, acceptance requirements; missing fields list; attachments (untrusted, scanned); "Clarify" questions |
| Requirements tab | RFQ versions (immutable once published): lines (kind, specification, quantity, unit basis, options/substitutions allowed, standards), delivery/work milestones, payment and validity terms, attachments, region; amendment creates new version and marks earlier quotes stale |
| Suppliers tab / discovery | Candidates: name, StatusBadge (sourced/claimed/verified), eligibility criteria table (criterion, met/unmet/unknown), fit explanation, provenance of contact ("source: …, outreach permission: no"), invite action (requires permitted outreach), invited state |
| Quotes tab | Per supplier: quote versions list, status (draft n/a, sent, superseded, withdrawn, expired, accepted), validity, references RFQ version, stale flag |
| Compare tab | Normalized comparison of selected quote versions: lines aligned by RFQ line; per cell value + unit + tax basis + currency; exclusions; "not comparable" cells with reason (different scope, substitution, missing line); totals only where complete; evidence/citation chips to quote pages |
| Negotiation tab | Threaded exchanges per supplier bound to quote versions; private notes (buyer only, labelled); counter-proposal request creates supplier's new version |
| Order tab | Selected quote version snapshot (immutable), authority check (who, limit, conditions), transaction budget reservation state, "Place the order" → seller acceptance pending → accepted; amendments as joint versions |
| Approvals tab | Assistant/operator proposed actions with digest, approval binding, expiry, outcome (incl. outcome_unknown) |

## Primary tasks

1. Capture an ambiguous need and get it clarified (journey 3).
2. Publish an RFQ version; invite eligible suppliers with permitted outreach.
3. Collect quotes, compare honestly, negotiate, select.
4. Commit an order only with authority and budget; see seller acceptance as a separate event (journey 4).
5. Follow fulfillment/acceptance in the linked project.

## Layout regions

| Width | List | RFQ detail | Compare |
|---|---|---|---|
| Desktop ≥1280 | Shell; PageHeader ("Procurement", "Create a need", "Find a supplier"); filters (status, kind, project, operator, deadline); DataTable | Shell; PageHeader (title, StatusChip, version pill "Version 2 (current)", deadline, project link; actions: Amend (new version), Invite suppliers, Close); tabs; panel; right rail: missing requirements checklist, budget ceiling (private label), decisions | Toolbar: quote version selector per supplier (VersionPicker), "Show only comparable", units/currency normalization note; ComparisonTable with sticky first column (RFQ lines) and sticky header (suppliers); below: exclusions list and notes; "Select" per supplier column (authority check on click) |
| Tablet | Cards | Tabs scroll; rail below | Table scrolls horizontally in a labelled region; max 3 suppliers visible, others via selector |
| Mobile <768 | Cards; filters sheet | Tabs scroll | Per-line accordion: each RFQ line expands to show each supplier's value stacked; a supplier switcher (segmented) at top; totals card at bottom; "Comparability" text per line |

## Component inventory

PageHeader, FilterBar, DataTable, StatusChip (lifecycle), VersionPill/VersionPicker, Tabs, IntakeWizard (source choice, extraction review with EvidencePointer chips, missing-fields checklist, clarification questions), LineItemTable/LineItemCards, KindBadge (goods/works/service/bundle), SupplierCandidateCard, EligibilityTable (criterion/state/explanation; states met/unmet/unknown as text + icon), ProvenanceLine, OutreachPermissionNote, QuoteVersionList, ComparisonTable (responsive; non-comparable cell pattern), ExclusionList, ThreadView with PrivateNoteBlock (labelled "Visible only to you"), AuthorityCheckCard (principal, limit, conditions, mandate version), BudgetReservationStatus, OrderSnapshotCard (immutable, version hash shown as "snapshot of …"), SellerAcceptanceStatus, ApprovalDigestCard, RunStatusBadge (incl. outcome_unknown), ConfirmDialog, Toast, EmptyState, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (list) | "No procurement yet" + create + find supplier; explanation that a company is not required for a personal need (if policy allows personal procurement; otherwise hint to join a company) |
| Empty (quotes) | "No quotes yet. Suppliers invited: N" |
| Loading | Skeletons; extraction shows progress "Reading the file…" with cancel |
| Error | Inline; extraction failure → "Could not read the file. Fill in manually or try another file." |
| Permission-denied | Order tab: AuthorityCheckCard shows "Insufficient authority: limit {limit}, required {amount}" with "Request approval"; never a silent disabled button |
| Offline | Read-only; drafts kept locally for intake form only (clearly labelled) |
| Partial/stale | Quotes against an older RFQ version flagged "Stale: answers version 1"; comparison excludes them by default with a toggle; extraction confidence below threshold flagged "Check this" |
| Outcome unknown | Order placement timed out: OrderSnapshotCard shows "Outcome unknown, reconciliation in progress"; no retry button; explains no duplicate order will be placed |
| Budget | Reservation failed: "Transaction budget unavailable: {reason}"; separate platform-service budget note when a paid comparison was requested |

## Keyboard order and focus

Shell → header actions → filters → table (row link, row menu) → pagination. Detail: header → actions → tabs → panel → rail. ComparisonTable: `table` with `th scope`, first column row headers; arrow-key cell navigation optional; "Select" buttons in the footer row; non-comparable cells contain text "Not comparable" plus a disclosure with reason. Intake wizard steps announce progress; evidence pointer chips open the file viewer in a side panel with focus return.

## Responsive table behaviour

- List table → cards (<768).
- Line items → cards with labelled fields.
- ComparisonTable → tablet: horizontal scroll region with sticky RFQ-line column; mobile: per-line accordion with supplier switcher. Totals and exclusions are always rendered as text blocks, not only as table cells.
- Eligibility table → stacked list.

## Locale keys

| Key | English |
|---|---|
| `procurement.title` | Procurement |
| `procurement.createNeed` | Create a need |
| `procurement.findSupplier` | Find a supplier |
| `procurement.empty` | No procurement yet |
| `procurement.col.title` | Need |
| `procurement.col.kind` | Composition |
| `procurement.col.version` | Version |
| `procurement.col.quotes` | Quotes |
| `procurement.col.deadline` | Deadline |
| `procurement.col.operator` | Responsible |
| `kind.goods` | Goods |
| `kind.works` | Works |
| `kind.services` | Service |
| `kind.bundle` | Bundle |
| `rfqStatus.needDraft` | Draft need |
| `rfqStatus.clarifying` | Clarifying |
| `rfqStatus.published` | Request published |
| `rfqStatus.quotesCollected` | Quotes collected |
| `rfqStatus.negotiating` | Negotiating |
| `rfqStatus.termsSelected` | Terms selected |
| `rfqStatus.orderPlaced` | Order placed |
| `rfqStatus.supplierAccepted` | Order accepted by the supplier |
| `rfqStatus.fulfilling` | In fulfilment |
| `rfqStatus.partiallyAccepted` | Partially accepted |
| `rfqStatus.accepted` | Accepted |
| `rfqStatus.reviewed` | Review left |
| `rfqStatus.disputed` | Disputed |
| `rfqStatus.closed` | Closed |
| `rfqStatus.expired` | Expired |
| `rfqStatus.cancelled` | Cancelled |
| `intake.title` | New need |
| `intake.source.manual` | Fill in manually |
| `intake.source.file` | From a file |
| `intake.source.email` | From an email |
| `intake.source.assistant` | With the assistant |
| `intake.parsing` | Reading the file… |
| `intake.parseError` | Could not read the file. Fill in manually or try another file. |
| `intake.evidence` | Source: {file}, {locator} |
| `intake.confidenceLow` | Check this |
| `intake.missing` | Needs clarification |
| `intake.field.scope` | What is needed |
| `intake.field.quantity` | Quantity |
| `intake.field.unit` | Unit of measure |
| `intake.field.location` | Place of delivery or works |
| `intake.field.schedule` | Timing |
| `intake.field.acceptance` | Acceptance requirements |
| `intake.untrustedNote` | Data from a file or email are assumptions until you confirm them. Addresses from an email are never used for outreach automatically. |
| `rfq.tabs.requirements` | Requirements |
| `rfq.tabs.suppliers` | Suppliers |
| `rfq.tabs.quotes` | Quotes |
| `rfq.tabs.compare` | Comparison |
| `rfq.tabs.negotiation` | Negotiation |
| `rfq.tabs.order` | Order |
| `rfq.tabs.files` | Files |
| `rfq.tabs.correspondence` | Correspondence |
| `rfq.tabs.approvals` | Approvals |
| `rfq.version` | Version {version} |
| `rfq.versionCurrent` | Version {version} (current) |
| `rfq.amend` | Amend |
| `rfq.amendNote` | Changes create a new version of the request. Quotes already received will be marked as stale. |
| `rfq.invite` | Invite suppliers |
| `rfq.close` | Close the request |
| `rfq.budgetCeiling` | Budget ceiling (visible only to you) |
| `supplier.eligibility` | Eligibility |
| `supplier.criterion.met` | Met |
| `supplier.criterion.unmet` | Not met |
| `supplier.criterion.unknown` | No data |
| `supplier.outreachNotPermitted` | Contact obtained from a public source; outreach without consent is not permitted |
| `supplier.invited` | Invited |
| `quote.status.sent` | Received |
| `quote.status.superseded` | Superseded by a new version |
| `quote.status.withdrawn` | Withdrawn |
| `quote.status.expired` | Expired |
| `quote.status.accepted` | Accepted |
| `quote.stale` | Stale: answers version {version} |
| `quote.validUntil` | Valid until {date} |
| `quote.empty` | No quotes yet. {count, plural, one {# supplier} other {# suppliers}} invited |
| `compare.title` | Quote comparison |
| `compare.onlyComparable` | Show only comparable |
| `compare.includeStale` | Include stale |
| `compare.notComparable` | Not comparable |
| `compare.reason.scope` | Different scope |
| `compare.reason.substitution` | Substitution offered |
| `compare.reason.missingLine` | Line missing |
| `compare.reason.unit` | Different unit of measure |
| `compare.exclusions` | Exclusions and qualifications |
| `compare.totalIncomplete` | Total not calculated: not every line is comparable |
| `compare.select` | Select |
| `compare.normalizationNote` | Amounts converted to {currency}, taxes: {taxBasis} |
| `negotiation.privateNote` | Visible only to you |
| `negotiation.requestRevision` | Request a new version |
| `order.snapshot` | Snapshot of the quote of {date}, version {version} |
| `order.immutable` | The terms are fixed and do not change when the supplier's catalogue is updated |
| `order.authority` | Authority |
| `order.authorityInsufficient` | Insufficient authority: limit {limit}, required {amount} |
| `order.requestApproval` | Request approval |
| `order.budgetReserved` | Transaction budget reserved |
| `order.budgetUnavailable` | Transaction budget unavailable: {reason} |
| `order.place` | Place the order |
| `order.awaitingSeller` | Awaiting the supplier's acceptance |
| `order.sellerAccepted` | The supplier accepted the order on {date} |
| `order.outcomeUnknown` | Outcome unknown, reconciliation in progress. The order will not be placed again automatically. |
| `approvals.digest` | Action approval |
| `approvals.expires` | Valid until {date} |
| `approvals.invalidated` | The terms changed; the approval is void |

## Open questions

- Personal (non-company) procurement: allowed for a person with a personal project? Spec journey 5 implies yes; confirm in COM-001.
- Which normalization rules (currency/tax/unit) are shown; O11 unit catalogue.
- Outreach permission model for sourced contacts (legal, O06).
