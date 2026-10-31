# Sales: leads, quote editor with versions, negotiation, order acceptance, catalogue

Routes: `/app/sales` (leads/requests), `/app/sales/quotes/[id]` with tabs `editor`, `versions`, `negotiation`, `order`, `files`, `correspondence`; `/app/sales/catalogue` (company catalogue, same component as [company](company.md) catalogue tab), `/app/sales/orders/[id]`.

## Status and evidence

`no reference` (the reference overview card "Sales" only hints at leads and a catalogue link). Spec R06 (reusable versioned catalogue separate from client-specific quote snapshots; sent quote and agreed terms never change; private floors never published), R07 (leads/requests → quote → negotiation → order acceptance → fulfillment/acceptance; contacts/templates/campaigns contextual; no overloaded CRM navigation), R08, "Commercial journeys" (quote version fields), journeys 2 and 4; [lifecycles](../../../data/lifecycles.md) (quote draft → sent → superseded/withdrawn/expired/accepted; sent content immutable; buyer selection is not supplier acceptance).

## Audience and access policy

| Role | Access |
|---|---|
| Seller-authorized operator (company grant) | Leads addressed to the company, own quotes, negotiation, order acceptance within authority, catalogue read; catalogue edit only with catalogue grant |
| Company member without grant | 404 |
| Buyer | Never sees this side; sees the sent quote projection in Procurement |
| Independent specialist (person offering works/services without company) | Same as operator for personal catalogue if policy allows (open) |

Margin floors, private priorities and internal notes stay in the seller projection only.

## Data projection

| Screen | Fields |
|---|---|
| Leads list ("Requests") | Source (RFQ invitation / public open need / direct request / email), buyer (public projection), RFQ version pinned, deadline, kind mix, status (new / drafting / sent / negotiating / won / lost / expired), attention marker |
| Quote editor | Lines prefilled from the pinned RFQ version lines (specification, quantity, unit, milestones) so the seller never re-enters buyer data (WCAG 2.2 3.3.7): kind, specification, option/substitution flag with explanation, quantity, unit basis, unit price, taxes, currency, delivery/work milestones, payment terms, validity, attachments; "from catalogue version N" origin per line; private floor per line (locked, labelled "not sent"); totals; "Send version" |
| Versions tab | List of versions: number, sent date, status, RFQ version answered, diff summary vs previous; opening a sent version is read-only with "Create a new version based on" |
| Negotiation tab | Buyer requests/counter-proposals bound to versions; seller private notes labelled; reply creates version |
| Order tab | Buyer selection notice; accepted-terms snapshot; "Accept the order" (authority check) / "Decline" with reason; after acceptance: obligations and link to project execution |
| Catalogue | Versioned entries (goods/works/services/mixed bundles), public flag, price or "on request", private floor; version history; "Publish the version" |
| Contacts/templates/campaigns | Contextual: inside a quote ("Terms template"), inside catalogue ("Export for a client"); no top-level CRM nav |

## Primary tasks

1. See incoming requests and their deadlines.
2. Draft a quote from the catalogue, send an immutable version.
3. Negotiate with versions, never editing a sent one.
4. Accept or decline an order under authority; see the obligations.
5. Maintain the catalogue without affecting sent quotes.

## Layout regions

| Width | Leads | Quote detail | Catalogue |
|---|---|---|---|
| Desktop ≥1280 | Shell; PageHeader ("Sales", "Catalogue of goods, works and services"); filters (status, source, deadline); DataTable | PageHeader (buyer, RFQ title, version pill, status, validity; actions: Send version, Withdraw, New version); tabs; editor: LineItemTable with inline editing; right rail: totals, validity, floors warning, buyer's RFQ summary (read-only) | PageHeader; VersionPicker; CatalogueTable; entry form in side panel |
| Tablet | Cards | Editor table scrolls horizontally; rail below | Table scrolls |
| Mobile <768 | Cards; filters sheet | Editor as line cards with a per-line edit sheet; totals sticky bottom; rail collapsed into accordion | Cards; entry form full-screen dialog |

## Component inventory

PageHeader, FilterBar, DataTable, LeadRow, StatusChip, Tabs, VersionPill/VersionPicker, LineItemTable (editable; per-cell inputs with labels; keyboard navigation), LineItemCards (mobile) with EditSheet, KindBadge, SubstitutionToggle with reason field, PrivateFloorField (locked style, lock icon + text), CatalogueOriginChip ("from the catalogue, version 7"), TotalsPanel, ValidityPicker (date), DiffSummary, ThreadView + PrivateNoteBlock, AuthorityCheckCard, OrderSnapshotCard, ConfirmDialog (send: "Once sent, the version does not change"), CatalogueTable, CatalogueEntryForm, TemplatePicker, EmptyState, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (leads) | "No requests yet" + "Fill in the catalogue" (if granted) + hint about public open needs |
| Empty (catalogue) | "The catalogue is empty" + create; note that a quote can still be drafted manually |
| Loading | Skeleton |
| Error | Inline; send failure keeps draft with "Not sent" |
| Permission-denied | Order acceptance without authority: AuthorityCheckCard with "Request approval"; catalogue edit without grant: read-only with NoAccess note on edit controls |
| Offline | Draft editing allowed locally with explicit "Not saved on the server" banner; sending blocked |
| Partial/stale | Lead's RFQ amended: banner "The request has changed (version 2). Your quote refers to version 1" + "Create a version for the new request"; quote expired: status + "Extend with a new version"; catalogue updated after sending: sent quote unaffected, editor shows "The catalogue has been updated to version 8; this quote uses version 7" |
| Validation | Line without unit or quantity blocks send with inline errors; floor below price warning (private, non-blocking) |

## Keyboard order and focus

Shell → header → filters → table/cards. Quote editor: header actions → tabs → line table: each cell input labelled by column header and row ("Price, line 3"); Tab moves across cells, Enter opens line options; "Add a line" after the table; totals; send button. Send ConfirmDialog focuses Cancel first. Version switch moves focus to the panel heading.

## Responsive table behaviour

LineItemTable: tablet horizontal scroll with sticky specification column; mobile line cards (specification, quantity×unit, price, total, flags) with edit sheet. Versions table → cards. Catalogue table → cards.

## Locale keys

| Key | English |
|---|---|
| `sales.title` | Sales |
| `sales.catalogue` | Catalogue of goods, works and services |
| `sales.leads` | Requests |
| `sales.empty` | No requests yet |
| `sales.emptyHint` | Companies’ published needs are available in the Projects section of the site. |
| `sales.fillCatalogue` | Fill in the catalogue |
| `sales.col.buyer` | Buyer |
| `sales.col.request` | Request |
| `sales.col.source` | Source |
| `sales.col.deadline` | Deadline |
| `leadStatus.new` | New |
| `leadStatus.drafting` | Preparing a quote |
| `leadStatus.sent` | Sent |
| `leadStatus.negotiating` | Negotiating |
| `leadStatus.won` | Order accepted |
| `leadStatus.lost` | The buyer chose another supplier |
| `leadStatus.expired` | Expired |
| `leadSource.invitation` | Invitation |
| `leadSource.openNeed` | Open need |
| `leadSource.direct` | Direct request |
| `leadSource.email` | From an email |
| `quoteEditor.title` | Quote |
| `quoteEditor.tabs.editor` | Editor |
| `quoteEditor.tabs.versions` | Versions |
| `quoteEditor.tabs.negotiation` | Negotiation |
| `quoteEditor.tabs.order` | Order |
| `quoteEditor.send` | Send version |
| `quoteEditor.sendConfirm` | Once sent, the version does not change. Changes are only possible as a new version. |
| `quoteEditor.withdraw` | Withdraw |
| `quoteEditor.newVersion` | New version |
| `quoteEditor.basedOn` | Create a new version based on |
| `quoteEditor.addLine` | Add a line |
| `quoteEditor.col.spec` | Specification |
| `quoteEditor.col.qty` | Quantity |
| `quoteEditor.col.unit` | Unit |
| `quoteEditor.col.price` | Price |
| `quoteEditor.col.tax` | Tax |
| `quoteEditor.col.total` | Amount |
| `quoteEditor.substitution` | Substitution |
| `quoteEditor.substitutionReason` | Why a substitution is proposed |
| `quoteEditor.floor` | Minimum price (not sent to the buyer) |
| `quoteEditor.floorWarning` | The price is below your minimum price |
| `quoteEditor.fromCatalogue` | From the catalogue, version {version} |
| `quoteEditor.catalogueNewer` | The catalogue has been updated to version {current}; this quote uses version {used} |
| `quoteEditor.validity` | Validity |
| `quoteEditor.deliveryMilestones` | Delivery and work dates |
| `quoteEditor.paymentTerms` | Payment terms |
| `quoteEditor.template` | Terms template |
| `quoteEditor.notSent` | Not sent |
| `quoteEditor.notSavedServer` | Not saved on the server |
| `quoteEditor.rfqAmended` | The request has changed (version {new}). Your quote refers to version {old}. |
| `quoteEditor.createForNew` | Create a version for the new request |
| `quoteEditor.extend` | Extend with a new version |
| `quoteEditor.cellLabel` | {column}, line {row} |
| `salesOrder.selectedByBuyer` | The buyer selected version {version} |
| `salesOrder.accept` | Accept the order |
| `salesOrder.decline` | Decline |
| `salesOrder.declineReason` | Reason for declining |
| `salesOrder.obligations` | Obligations |
| `salesOrder.toExecution` | Go to execution |
| `catalogue.exportForClient` | Export for a client |

## Open questions

- Personal catalogue for independent specialists (no company): policy open; UI supports it only if BE/COM confirm.
- Quote templates scope (company-level vs personal).
- Whether the seller may see the buyer's other invited suppliers (proposal: never).
