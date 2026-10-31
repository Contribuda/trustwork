# Component inventory for DS-001

Status: proposed. Consolidated from every screen contract in this directory. DS-001 builds these as accessible, localized primitives and composites in `packages/ui`; WEB tasks compose them. Required states and accessibility notes are the acceptance baseline, not optional polish. WCAG 2.2 AA is the target (see [accessibility](../../quality/accessibility.md)); the patterns referenced are the WAI-ARIA Authoring Practices patterns (menu button, dialog, tabs, combobox, listbox, toolbar, tree, disclosure).

## Conventions that apply to every component

- Visible focus indicator with at least 3:1 contrast against adjacent colours, not removed on mouse use; focus never obscured by sticky bars, the launcher or the overlay (WCAG 2.2 2.4.11).
- Minimum target 24×24 CSS px; comfortable default 40×40 for primary controls, 44 on touch.
- Status is never colour-only: text label or icon with text alternative accompanies every colour.
- Every icon-only control has a localized accessible name from a locale key.
- Reduced motion: transitions ≤200 ms and disabled under `prefers-reduced-motion`.
- Text zoom 200% and 320 px width reflow without loss; no horizontal page scroll except inside labelled table regions.
- All copy via locale keys; components accept labels as props, never embed product strings.
- Consistent help (WCAG 2.2 3.2.6): the "Help" link (`footer.help`) appears in the same relative position in every shell: last item of the legal link group in PublicFooter, the AuthShell footer and the OnboardingShell footer, and the item directly before "Sign out" (`shell.menu.signOut`) in the workspace AvatarMenu.
- Redundant entry (WCAG 2.2 3.3.7): information a person already entered in the same process is prefilled or selectable, never re-typed: the email from a failed login is carried to `/recover`; name and email persist from signup through email verification and first login; RFQ lines (specification, quantity, unit, milestones) are prefilled into the quote editor; onboarding selections are pre-checked on revisit. Exceptions are only security re-entry (password confirmation) and cases where the earlier value is no longer valid.

## Primitives

| Component | Variants / props | Required states | Accessibility requirements |
|---|---|---|---|
| Button | primary (dark navy), secondary (outlined), tertiary (text), destructive, icon-only; sizes md/lg; with leading icon; loading | default, hover, focus-visible, active, disabled (`aria-disabled` + reason when action is blocked, prefer explanation over disabling), loading (`aria-busy`, label changes) | Native `button`; icon-only requires `aria-label`; loading announces via live region in form context |
| Link | inline, standalone with arrow, external (icon + visually hidden "external link" (`common.externalLink`)) | default, hover, focus, visited (public content only) | Native `a`; external links `rel="noopener"` |
| TextField / Textarea | label, hint, error, leading icon, counter, required marker (text, not only `*`) | default, focus, filled, error, disabled, read-only | Label element; `aria-describedby` for hint+error; `aria-invalid`; autocomplete attributes; paste allowed |
| PasswordField | show/hide toggle | as TextField; toggle pressed/unpressed | Toggle `aria-pressed` + label; no `autocomplete="off"` |
| Checkbox / CheckboxCard / SelectableCard | label with inline links; card with icon/illustration | unchecked, checked, mixed, focus, disabled, error | Native input inside label or `role="checkbox"`; whole card activatable; selected state has border + check mark |
| Radio / SegmentedControl | horizontal/vertical | selected, focus, disabled | Radio group with `fieldset/legend` or `role="radiogroup"`; arrow keys |
| Switch | with visible on/off text | on, off, focus, disabled, loading | `role="switch"` + `aria-checked`; label describes the effect |
| Select (native) | — | default, focus, error, disabled | Native `select` for short lists |
| Combobox (multi/single, typeahead) | tags for multi; async loading | closed, open, filtering, loading, no-results, selected tags, error | WAI-ARIA combobox pattern; listbox options; Backspace removes last tag; announces result count |
| DatePicker | input + popover calendar | default, open, invalid, range | Text input accepts a typed date in the active locale's format; calendar grid pattern; localized month/day names from `Intl` |
| Chip / ChoiceChip / ConstraintChip / Tag | selectable, removable | default, selected, focus, removable (× with label) | Selectable chips as toggle buttons `aria-pressed`; removable chips have labelled remove button |
| Badge (count) | numeric, dot | zero (hidden), n, 99+ | Text alternative in parent control's accessible name |
| StatusChip / StatusBadge | lifecycle (RFQ, quote, run, publication, project, membership), record status (sourced/claimed/verified), evidence state (asserted/confirmed/disputed/superseded), kind (goods/works/service/bundle; `kind.*`) | one per enum value; icon + text | Text always present; colour token per family; `title` not relied on |
| Avatar | image, initials, sizes 24–96; decorative vs informative | loaded, fallback initials, consent-hidden | `alt` = name when informative, empty when decorative next to name |
| Icon | from one set; sizes 16/20/24 | — | `aria-hidden` unless standalone with label |
| Spinner / ProgressBar | inline, block, determinate | — | `role="status"` / `progressbar` with label |
| Skeleton | text, card, row, table | — | `aria-hidden`; container `aria-busy` |
| Divider (with optional text) | — | — | `role="separator"` or plain `hr` |
| Tooltip | on hover/focus for icon-only and collapsed nav | — | Not the only accessible name; dismissible with Escape; does not obscure |
| Toast / InlineAlert / FormAlert / StatusBanner | info, success, warning, error; variants per search status | appear, dismiss, action | `role="status"` for info/success, `role="alert"` for errors; toasts persist ≥5 s and are pausable; FormAlert receives focus on submit error |
| Card / Panel / RailCard | — | default, interactive, selected | Interactive card has one primary link; not nested interactive inside link |
| Breadcrumb | — | — | `nav[aria-label="Breadcrumbs"]` (`common.breadcrumbs`), `aria-current="page"` |
| Pagination / LoadMore | — | current, disabled ends, loading | `nav[aria-label="Pages"]` (`common.pagination`); LoadMore moves focus to first new item |
| EmptyState | title, body, up to two actions, optional illustration | — | Heading level matches context |
| NoAccess | title/body/action | — | Same as EmptyState; never reveals object existence beyond the route |

## Navigation and layout composites

| Component | Required states | Accessibility requirements |
|---|---|---|
| PublicHeader + PublicNav (7 items) | anonymous / authenticated; active item; mobile sheet open | `nav[aria-label]`; `aria-current`; mobile sheet is a dialog with focus trap/return |
| PublicFooter | — | `contentinfo` landmark |
| SidebarNav + BrandRow + CollapseButton + NavItem + NavDisclosure ("More" (`shell.more`)) + ExternalNavLink | expanded, collapsed (icons + tooltips + visually hidden labels), mobile sheet; item active; attention badge; disclosure open/closed | Collapse button `aria-expanded`; order never changes programmatically; keyboard order identical in both states |
| WorkspaceHeader + Breadcrumb + GlobalSearchButton + NotificationBell + NotificationsPanel + AvatarButton + AvatarMenu | bell with count/dot; panel open; menu open; offline banner | Menu button pattern; popover/sheet with focus return; bell count in accessible name |
| AuthShell / OnboardingShell / ReaderShell / AdminShell | desktop two-column, stacked | Landmarks; skip link |
| PageHeader | title, subtitle, actions, status, version pill | H1 is the page's only H1 |
| SubNav (settings/admin) | horizontal tabs on tablet; select on mobile | `nav[aria-label]` |
| Tabs | scrollable overflow with visible affordance; deep-link | WAI-ARIA tabs; arrow keys; panel focusable when deep-linked |
| Dialog (modal) / ConfirmDialog / PreviewDialog / Sheet (bottom, mobile) | open, loading, destructive variant | `role="dialog"` `aria-modal`; focus trap; Escape; return focus; initial focus on first non-destructive control; destructive requires explicit activation |
| Panel / Drawer (non-modal side) — citation drawer, file viewer | open/closed; stacked with overlay | `aria-expanded` on trigger; Escape closes when focused inside; no focus trap |
| AssistantLauncher + AssistantOverlay + OverlayHeader | closed, open, minimized, unread, action-required, offline, mobile modal | Launcher last in tab order; overlay non-modal desktop / modal mobile; `role="log"` conversation; `position: fixed`, never reflows content; respects focus-not-obscured |
| StickyActionBar (mobile) | — | Does not cover focused inputs (`scroll-padding`) |
| FilterBar + FilterSheet | active count badge; reset | Sheet as dialog |
| SearchField + SearchDialog | empty, typing, results, loading | Combobox or simple form; dialog pattern |

## Data display composites

| Component | Required states | Accessibility requirements |
|---|---|---|
| DataTable (sortable, selectable rows optional, row action menu) | loading, empty, error, sorted asc/desc, responsive collapse to cards (<768), horizontal scroll region (tablet), column visibility (tablet) | `table/caption/th scope`; sort buttons with `aria-sort`; scroll region `role="region"` + label + `tabindex=0`; cards keep field labels |
| ComparisonTable (quotes) | comparable / non-comparable cells; stale excluded/included; totals incomplete; select column | Row headers = RFQ lines; sticky header/column; non-comparable cell contains text + disclosure; mobile per-line accordion with supplier switcher |
| LineItemTable (editable) | editing, validation errors per cell, added/removed rows | Each input labelled "{column}, line {n}"; Tab across cells; errors via `aria-describedby`; mobile line cards + edit sheet |
| DescriptionList (dl) for facts, digests, provenance | — | `dl/dt/dd` |
| VersionPill / VersionPicker | current, historical selected, stale | Listbox/select; selection announces and moves focus to content heading |
| Timeline / MilestoneTimeline / RunTimeline / EvidenceList / ChangeLogList | baseline vs changed (two labelled marks), disputed annotation, outcome_unknown | Ordered list; text labels for every mark; no colour-only |
| ReputationSummary | numbers + sample counts + methodology; insufficient data; disputed | Description list; bars decorative with numeric text |
| ProvenanceLine / FreshnessLine / HistoricalLabel | sourced/claimed/verified; stale | Plain text with icon |
| CitationChip + CitationDrawer + UnavailableNotice | available, unavailable (reason category), historical | Chip is a button `aria-expanded`; drawer per Panel rules |
| CitedAnswer (FactsTable + ClaimList) | supported / qualified / abstain; scope incomplete | Facts table collapses to dl; status text visible |
| StoryCard / PublicationCard / NewsRow / CompanyRow / PersonCard / ProjectCard / ObjectRow / LeadRow / DecisionRow / EventRow | loading, corrected label, bookmark state | One primary link; secondary actions as separate controls; images with alt from data |
| MessageBubble / ProposalCard / ActionCard / ApprovalDigestCard / MandateCard / RunStatusBadge | all run states incl. outcome_unknown/reconciling/revoked; digest invalidated | Text states; dialogs for approve/reject/stop |
| AuthorityCheckCard / BudgetStatus / OrderSnapshotCard / SellerAcceptanceStatus | sufficient / insufficient / pending / unknown | Explanations in text; no silent disabled buttons |
| EligibilityTable | met / unmet / unknown | Text + icon; stacked list on mobile |
| CorrectionBanner / RetractionNotice / EditionLabel | corrected, retracted | `role="status"` region at top of content |
| IssueHeader / IssueCard / TOCList / ReaderTopBar / ReaderProgress / FontSizeControl / PrevNextNav | pdf pending; edition > 1 | Reader controls labelled; font size control announces |
| Gallery | loading, single image, many | Buttons + dots as real controls; swipe optional |
| RichTextEditor (toolbar + content) | formatting states; autosave states; conflict | Toolbar pattern (one tab stop, arrows); content `contenteditable` with `role="textbox"` `aria-multiline`; shortcuts documented in Russian |
| IntakeWizard / StepProgress / StepPill | parsing, low confidence, missing fields | Progress announced; evidence pointers as buttons |
| MandateForm / OfferVersionForm / ScopeGrantForm / CatalogueEntryForm / ProjectionEditor | validation, summary step, published-immutable | Fieldsets; summary review before submit |
| IssueEditor (ordered, keyboard reorder) / TaxonomyTree | moved announcement | Buttons for move; tree pattern |
| ConsentStatement / PrivateFloorField / PrivateNoteBlock / OutreachPermissionNote | — | Explicit text; lock icon has text |

## Theming hooks DS-001 must provide

Colour roles (surface, canvas, text, muted text, border, accent, accent-contrast, status families: info/success/warning/danger, record-status families: sourced/claimed/verified, evidence families), spacing scale, radius, shadow for floating overlay/panel, z-index scale (content < sticky < panel < overlay < dialog < toast), focus ring token, motion tokens. See [layout and tokens proposal](layout-and-tokens-proposal.md).

## Out of scope for the first slice (listed so they are not improvised)

Drag-and-drop reordering as the only method, Gantt charts, map view, bottom tab bar, dark mode, charts of any kind on Overview, comments.
