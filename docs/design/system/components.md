# Components: API, states, accessibility

All components live in `packages/ui/src/components/<Name>/` and are exported from `@trustwork/ui`. DS-002 (2026-10-27) added the typography primitives, media, editorial and workspace-card sections below and restyled the existing components per [art-direction.md](art-direction.md). Props marked "RAC" pass through to the underlying React Aria component (`isDisabled`, `onPress`, `name`, `value`, `autoFocus`, …). Every optional prop accepts `undefined` explicitly so callers compiled with `exactOptionalPropertyTypes` can forward values. Story titles refer to `packages/ui/stories`.

## Provider

### UiProvider
`withToastRegion` (default true). Wraps `I18nProvider locale={intlTag()}` (React Aria's own strings and Intl formatting follow the active locale on the server and in the browser) and `ToastProvider` + `ToastRegion`. Required once at the application root.

## Primitives

### Brand
`variant: 'full' | 'mark'`, `tone: 'color' | 'mono' | 'inverse'`, `height`, `href`, `decorative`. Inline SVG with `role="img"` + `aria-label` = `brand.name`, or a link named `brand.logoLabel`. Stories: *Brand/Logo*. See [logo.md](logo.md).

### Icon, Spinner
`Icon` wraps a Lucide icon: `aria-hidden` unless `label` is given (then `role="img"`); sizes 12–24. `Spinner` is a `ProgressBar` (indeterminate) with a localized label; reduced motion stops the rotation. Stories: *Primitives/Button → Icons And Spinner*.

### Button, IconButton, IconLink, ButtonLink
`variant: primary (navy) | accent (blue) | secondary (outlined) | ghost | danger`, `size: sm | md | lg`, `icon`, `isLoading` + `pendingLabel` (React Aria `isPending`: the button stays focusable, is announced busy, and the label changes), `fullWidth`, `ref`. `IconButton` requires `aria-label` (type-enforced) and supports `isPressed` for toggles; `IconLink` is the link counterpart (`href`); `ButtonLink` renders navigation styled as a button (never nest a link inside a button). Disabled buttons stay in the DOM with reduced opacity; the contracts prefer explaining over disabling. Stories: *Primitives/Button* (Variants, Sizes, States, Icon Only).

### Link
`variant: inline | standalone | external | nav`. External adds the arrow icon, `rel="noopener"`, `target="_blank"` and visually hidden "external link" (`common.externalLink`). `nav` styles `aria-current`. Stories: *Primitives/Link*.

### Badge and status chips
`Badge` (count ≥ 1, `99+`, `dot`, tones) is `aria-hidden`: the parent control carries the number in its accessible name. `StatusChip` (`tone`, `icon`, `size`) plus typed helpers `RecordStatusChip` (sourced / claimed / verified), `EvidenceLabel` (asserted / confirmed / disputed / superseded, superseded struck through with text intact), `KindBadge` (goods / works / service / bundle), `LifecycleChip`, `RunStatusBadge` (11 run states incl. `outcomeUnknown`, `reconciling`, `revoked`). Text always present. Stories: *Primitives/Badge and status chips*.

### Avatar, AvatarButton
`Avatar` renders an image (`alt` = name) or initials from `data-initials` generated content; `decorative` hides it when the name is adjacent. `AvatarButton` is the only account control: circular, `aria-haspopup="menu"`, accessible name "Account" (`shell.account`) (R24: no name, no chevron); the person's name appears as read-only text inside the menu. Stories: *Primitives/Avatar*.

### Skeleton, SkeletonGroup, EmptyState, Card
Skeleton bones are `aria-hidden`; wrap them in `SkeletonGroup` (`role="status" aria-busy`) with a label. `EmptyState` (`tone: neutral | error | denied`, `headingLevel`, up to two actions) never reveals object existence. `Card` is a `section` with optional title (`aria-labelledby`), aside, footer, `isSelected`; `CardLink` is the single primary link stretched over the card (no nested interactives). Stories: *Primitives/Skeleton, EmptyState, Card*.

## Forms

### TextField, TextArea, PasswordField
`label` (required), `isRequired` (adds the text "(required)"), `description`, `errorMessage` (sets `aria-invalid`, React Aria links the message with `aria-describedby`), `placeholder`, `icon`, `trailing`, `autoComplete`, `inputMode`; TextArea adds `rows`, `maxLength`, `showCounter` (polite live counter); PasswordField adds the show/hide `IconButton` with `aria-pressed` and keeps `autocomplete="current-password"`/`new-password` (never `off`). Paste is never blocked. Stories: *Forms/TextField*.

### Select, ComboBox
Both take `label`, `options: { id, label, description?, isDisabled? }[]`, `placeholder`, `description`, `errorMessage`, RAC selection props. Select = button + listbox (short lists); ComboBox = input + listbox with typed filtering, `emptyText`, `isLoading`. Stories: *Forms/Select*.

### Checkbox, CheckboxGroup, Radio, RadioGroup, Switch
Label is inside the control element; `description` optional; indeterminate supported. Groups expose their label/description/error and `orientation`. `Switch` is `role="switch"` with visible on/off words (`onText`/`offText`) and `isLoading`. Stories: *Forms/Checkbox, Radio, Switch*.

### Form, FormAlert, Fieldset, FormRow, FormActions, Divider
`Form` (RAC validation, `isBusy` → `aria-busy`). `FormAlert` (`tone`, `title`, `autoFocus`, `errors: { id, label }[]` → links to fields; `role="alert"` for errors, `role="status"` otherwise; `tabIndex=-1` so it can receive focus after submit). `Fieldset` = native fieldset/legend. `FormRow` 1–2 columns (1 on mobile). `FormActions` `align: start | end | stretch`. `Divider` with optional text ("or" (`auth.or`), `role="separator"`). Stories: *Forms/Form helpers* (Alerts, Layout, Submit Flow, Submit Error).

### TagSelect, RemovableTag
`TagSelect` = `ToggleButtonGroup` multi-select (`aria-pressed` per option, labelled by the visible group label, polite "N options selected"), `appearance: pill | card` (onboarding capability cards). `RemovableTag` = constraint chip with a "Remove “…”" button (`common.removeItem`). Stories: *Forms/TagSelect*.

## Overlays

### Dialog, ConfirmDialog, DialogTrigger
Controlled `isOpen`/`onOpenChange`, `title`, `description`, `actions`, `size: sm | md | lg | sheet` (bottom sheet on mobile automatically), `isLoading` (blocks dismissal, shows status), `isKeyboardDismissDisabled`. React Aria provides focus containment, `inert` on the rest of the document, Escape, scroll lock and focus return. `ConfirmDialog` places the cancel button first with `autoFocus`; `isDestructive` uses the danger variant. Stories: *Overlays/Dialog*.

### Popover, Menu, Tooltip
`Popover` (`title` required, `hideTitle`) is a non-modal dialog anchored to its trigger. `Menu` takes `items: MenuItemDef[]` (`href`, `icon`, `isDisabled`, `isDestructive`, `separatorBefore`), optional `header` text and `onAction`; wrap with `MenuTrigger`. `Tooltip` appears on hover and focus, closes on Escape, is supplementary (never the only name). Stories: *Overlays/Popover, Menu, Tooltip*.

### Toast
`ToastProvider` + `ToastRegion` (`section[aria-live="polite"]` labelled "Action notifications") + `useToast().add({ tone, title, description, action, timeout })`. Info/success/warning use `role="status"`, errors `role="alert"` and never auto-dismiss; others persist ≥ 5 s and pause while hovered or focused. Stories: *Overlays/Toast*.

## Navigation

### Tabs
`tabs: { id, label, content, isDisabled?, href? }[]`, `aria-label`, RAC selection props. Arrow keys move, panel is focusable, overflow scrolls with a fade. Stories: *Navigation/Tabs*.

### Breadcrumb, Pagination, Stepper
`Breadcrumb` (`nav[aria-label="Breadcrumbs"]`, last item is a `span[aria-current="page"]`, not a link; shown only when depth > 1). `Pagination` (`page`, `pageCount`, `hrefFor` for links or `onPageChange` for buttons, `isLoading`; `nav[aria-label="Pages"]`, disabled ends, labelled numbers). `Stepper` (`steps`, `current`; `aria-current="step"`, "Step N of M" live text, labels hidden except the current one on mobile). Stories: *Navigation/Breadcrumb, Pagination, Stepper*.

## Data

### DataTable
`caption`, `columns: { id, header, cell, sortable?, align?, isRowHeader?, width? }[]`, `rows`, `rowKey`, controlled `sort`/`onSortChange` (`aria-sort` on headers), `rowActions`, `state: idle | loading | error`, `emptyTitle/emptyBody/errorAction`, `layout: auto | table | cards`. Table (RAC grid semantics) inside a focusable labelled `region` with a scroll hint; below 768 px renders a list of cards with a `dl` keeping every column label. Stories: *Data/DataTable*.

### ComparisonTable, VersionPicker, VersionPill
`ComparisonTable`: `lines` (row headers, `th scope="row"`), `offers` (`version`, `isStale`, `isExcluded`), `cells[line][offer]` of kind `comparable | nonComparable (reason: unit | scope | substitution | missingLine, detail) | missing`, `totals` (null = incomplete, explained in text), `onSelectOffer`; sticky first column and header; mobile accordion per line with a supplier `Select`. `VersionPicker`: `versions` (current / historical / stale), `selectedId`, `onChange`, `contentHeadingId` (focus moves there and a polite announcement "Showing version N" is made). Stories: *Data/ComparisonTable and VersionPicker*.

### CitationChip, AnswerStatusLine, RetrievalStatusBanner, CitationDetails
Vocabulary comes from `packages/contracts/src/retrieval.ts` (`complete | partial | no_answer | unavailable`; `supported | qualified | abstain`; evidence states) and the search contract. `CitationChip` (`index`, `state: available | historical(date) | unavailable(reason)`, `isExpanded`, `onPress`, `describedBy`) keeps its number and says the state in the name. `AnswerStatusLine` (`role="status"`). `RetrievalStatusBanner` (`status`, `reason`, `date`, `onRetry`, `onBackToCurrent`) never names a missing source. `CitationDetails` renders the drawer body: focusable heading, unavailable/historical notice, `dl` with version, locator (page / table / fragment), evidence label, "Open the source". The drawer container (Panel/Sheet) is composed by WEB-003 from `Dialog size="sheet"` on mobile and a non-modal `aside` on desktop. Stories: *Retrieval/Citations and retrieval states*.

### Timeline, EvidenceList
`Timeline` ordered list; each event has a text mark (`done | pending | baseline | changed | disputed | outcomeUnknown`), optional time, description and evidence label. `EvidenceList` lists items with state and freshness line ("Source: …, data as of …"). Stories: *Retrieval/… → Timeline, EvidenceList*.

## Shells

### SidebarNav
`items: { id, label, href, icon, isCurrent?, attentionCount?, dividerBefore? }[]`, `moreItems` ("More" (`shell.more`) disclosure, same order), `exitHref` ("To the industry" (`publicExit`)), `brandHref`, `isCollapsed`/`onCollapsedChange`, `variant: sidebar | sheet`, children slot (skeleton). `nav[aria-label="Workspace"]`; collapse button in the brand row with `aria-expanded` and labels "Collapse menu" (`shell.collapse`)/"Expand menu" (`shell.expand`); collapsed items keep visually hidden labels, tooltips and attention text (", 2 need a decision"); keyboard order identical in both states; the order is never changed by code. Stories: *Shell/Workspace shell → Sidebar ...*.

### AppHeader
`breadcrumbs` (rendered only when > 1), `onSearchPress`, `notificationCount: number | 'unknown'` (bell name "Notifications, N new" / "Notifications, there are new ones" (`shell.notificationsUnknown`) / "Notifications" (`shell.notifications`)), `onNotificationsPress`, `account { name, avatarSrc }`, `menuItems` (place "Help" (`footer.help`) directly before "Sign out" (`shell.menu.signOut`)), `onMenuAction`, `onMenuPress` (mobile menu button), `isOffline` (status banner). Sticky (`position: sticky; top: 0`); `base.css` compensates with `scroll-padding-top` so controls scrolled into view on focus are not obscured (WCAG 2.2 2.4.11; workspace scroll containers must carry the `.trustwork-scroll` class). `header[aria-label]`. Stories: *Shell/Workspace shell → Header ...*.

### PublicHeader, PublicFooter
`hrefs` is a 7-tuple in the exact order of `publicNav`; `currentIndex`; `brandHref`, `aboutHref`, `onSearchPress`, `signInHref` or `account { name, avatarSrc, menuItems, onMenuAction }`, `mainId` for the skip link. Mobile: "Menu" button opens a modal sheet with the same seven items and the sign-in action. Footer: `contentinfo` with sections, `editorialLinks`, `platformLinks`, legal links and "Help" (`footer.help`) last. Stories: *Shell/Public shell*.

### AuthShell
`brandHref`, `backHref` ("Back to home" (`auth.backHome`)), `visual { headline, subline, imageSrc? }` (decorative), children = form column (480 px), `privacyHref`, `termsHref`, `helpHref` (last), skip link to `main`. Stories: *Shell/AuthShell* (login with all contract states incl. credentials / rate-limited / expired / offline / submitting / mobile).

### AssistantLauncher, AssistantOverlay
Launcher: `isOpen` (`aria-expanded`), `onPress`, `unreadCount`, `actionRequired`, `isHidden`, `ref`; fixed bottom-right, 56/48 px, name "Assistant" (`assistant.title`) / "Assistant, N unread" / "Assistant, your decision is needed" (`assistant.launcherAction`); hides itself while the mobile sheet is open. Overlay: `isOpen`, `onClose`, `onMinimize`, `pageHref` ("Open page" (`assistant.overlay.openPage`)), `state: online | offline | unavailable`, `messages`, `onSend` (Enter sends, Shift+Enter newline, hint text), `onAttach`, `unreadCount` (announced in the header status), `attentionCount` + `onAttentionOpen` (attention strip), `returnFocusTo`, `mode: auto | panel | sheet`. Desktop/tablet: `aside[role="complementary"][aria-label="Assistant window"]` (`assistant.overlay.label`), `position: fixed` 400×640 (380×600 tablet) above the launcher, focus moves to "Close" (`common.close`) on open, Escape inside closes and focus returns to the launcher, Tab leaves the panel in DOM order, the page is never resized (asserted by test). Mobile: modal sheet (React Aria `Modal`, rest of document `inert`, Escape, focus return). Conversation is `role="log" aria-live="polite"` with hidden "You:"/"Assistant:" prefixes. Stories: *Shell/Assistant launcher and overlay*.

## Typography primitives (DS-002)

### Heading, Text, Kicker, Meta
`Heading` separates semantics (`level` 1–4) from appearance (`styleAs: display | h1 | h2 | h3 | h4`, `tone`, `balance`). `Text` (`as`, `styleAs: bodyLg | body | bodySm | caption | serif`, `tone: default | muted | subtle | inverse | inverseMuted | accent`, `weight`, `tabular`). `Kicker` (12 px uppercase, `tone: accent | muted | inverse`). `Meta` renders the one meta-row style ("Editorial · Oct 21, 2026 · 6 min"): `items` (nullish skipped), `tone`, `size`, optional 16 px `icon`; the middle dots are `aria-hidden`. Stories: *Primitives/Typography*.

## Media (DS-002)

### MediaFrame
`media` (a `coverFor()` result or `{ src, alt, srcSet?, sizes?, placeholder?, width?, height? }`; `alt` required), `ratio: 16/10 | 4/3 | 1/1 | 21/9 | 3/4 | auto | fill`, `scrim: none | bottom | left | full`, `radius: media | card | none`, `loading`, `hoverScale`, `sizes`, `overlayAlign`, children = overlay content. Paints the blur-up placeholder behind a real `img` until load; with a scrim, the bottom overlay block carries the text-anchored navy gradient (`--scrim-text`) so white text keeps ≥ 4.5:1 whatever the frame height (pixel test in `contrast.spec.ts`). `fill` covers a positioned parent (auth panel, band backdrop). Stories: *Media/Covers and photographs* (ratios, scrims with white text, 24 photographs, 16 artworks, `coverFor` assignment).

### coverFor and helpers
`coverFor(kind, seed, { prefer })`, `photo(id)`, `artwork(id)`, `listPhotos()`, `listArtworks()`, `configureMedia({ base })`, `coverSizes`. See [media.md](media.md).

## Editorial (DS-002)

### Hero
`media`, `kicker`, `title`, `dek`, `meta`, `href`, `headingLevel: 1 | 2`, `size: lg (21:9, display) | md (16:10, h1) | sm (16:10 tile, h3)`, `footer`. One link (the title) stretched over the frame; white text on the scrim; focus ring on the frame. Stories: *Editorial/Hero, cards, bands → Hero Lead / Hero Medium / Hero Mobile*.

### StoryCard
`title`, `href`, `kicker`, `chips` (plain text topics), `dek`, `meta`, `media`, `ratio`, `size: s | m | l`, `layout: vertical | horizontal`, `headingLevel`, `enterIndex`. Rests on `e1`, lifts to `e2` + `translateY(-2px)` with a 1.03 media scale on hover; without media it carries a 3 px accent top rule (news tiles). Exactly one link per card (asserted). Stories: *Story Cards / Story Card Sizes / Story Card Horizontal / StoryCard without media*.

### SectionHeader
`title`, `kicker`, `description`, `action` (trailing, aligned to the heading baseline), `headingLevel`, `size: lg | md | sm`, `tone: default | inverse`, `id`. Stories: *Section Headers*.

### Band
`tone: navy | tint | warm | surface`, `padding: sm | md | lg` (section rhythm), `fullBleed`, `backdrop` (photograph under the full scrim), `width: container | fluid`, `as`, `aria-label`/`aria-labelledby`. Navy bands use light text and blue link hover. Stories: *Bands*.

### MagazineCover
`issue`, `dateRange`, `title`, `topics` (≤ 3), `media`, `size: lg | md | sm`, `href` (whole cover becomes one link whose name starts with "Issue cover" from visually hidden text), `tilt` (rotateY micro-animation on hover, off under reduced motion). Print-like spine highlight, cover shadow, inverse brand mark, issue number, title over the scrim. Stories: *Magazine Covers*.

### Quote
`children`, `cite`, `source`, `variant: pull | inline`, `tone`. PT Serif pull quote with blue rule and locale-appropriate quotation marks; `blockquote` + `figcaption`. Stories: *Pull Quote*.

### Prose
`family: serif | sans`, `measure: reader | none`, `as`, `lang`. Styles h2–h4, paragraphs, lists with blue markers, figures and captions, tables with tabular figures (`data-align="num"` for numeric cells), block quotes, code, notes; ink links with blue hover underline; hyphenation on. Stories: *Article Prose*.

## Workspace cards (DS-002)

### DecisionCard
`title`, `summary`, `meta`, `action { label, href }` (the only interactive element), `tone: decision (amber) | review (blue) | assistant (violet)`, `kicker` override, `children` (for example a warning strip), `headingLevel`, `enterIndex`. The coloured left rule is never the only carrier: the kicker names the state ("Your decision is needed", "To review", "The assistant is waiting for a decision"). Stories: *Workspace/Decision, entity, events → Decision Cards*.

### EntityCard
`kind: company | person | project`, `name`, `href`, `description`, `status: sourced | claimed | verified` (chip over the cover), `media` (default `coverFor(kind, name)`; people never get photographs), `facts` (≤ 4, `dl` row), `meta`, `layout: vertical | horizontal`, `headingLevel`, `enterIndex`. Person cards show an initials avatar overlapping an artwork cover. One link (the name). Stories: *Entity Cards / Entity Cards Horizontal*.

### DateTile, EventList
`DateTile` (`date` ISO, `size: sm | md`, `tone: default | accent | warning`): day over month abbreviation inside `time[datetime]` with the full localized date as visually hidden text. `EventList` (`label`, `items { id, date, title, context, meta, href, tone }`): ordered list with a rail; one link per item. Stories: *Dates And Events*.

### DemoBanner
`message` (default "Demo data…"), `personas`, `currentId`, `onChange`. 32 px warm strip with `role="status"` and a compact menu button ("Demo participant: Guest") opening a single-selection menu (`menuitemradio`). Stories: *DemoBanner (32 px strip)*; keyboard test covers open, select, name update and focus return.

### EmptyState (extended)
New `illustration?: MediaRef | MediaSource | 'auto'` (artwork from the media set, decorative) and `variant: card | plain`. Stories: *Empty With Illustration*.

### Visual upgrades of existing components (no API change unless noted)
`Card` (elevation + hover lift), `Button` (press scale 0.98, `e1` on primary/accent), `SidebarNav` (soft accent pill + bar, heavier icon stroke for the current item, hairlines), `AppHeader` (search rendered as a pill field with a "/" hint; still a button opening the search dialog), `AuthShell` (`visual.media` accepts a `MediaRef`; photograph under the anchored scrim), `PublicFooter` (navy band, kicker column titles, blue link hover), `PublicHeader` (nav underline slide), `Dialog` (spring open 200 ms, close 150 ms), `Toast` (slide-in), `Tabs` (underline slide), `Skeleton` (softer shimmer). Hooks: `useEnter({ index })`.

## Showcase

*Showcase/Compositions → Home, Home Mobile, Workspace, Article* compose the public home (demo strip, header, lead hero + two tiles, news tiles, articles with aside, magazine band, entity cards, navy CTA band with photograph backdrop, footer), the workspace overview (sidebar, header, decision cards, projects, events, industry stories) and an article page (hero image, prose, pull quote, next issue). Screenshots: `docs/design/system/showcase/`.

## Inventory coverage (DS-000 component inventory → this package)

| Inventory item | Delivered as |
|---|---|
| Button, Link, TextField/Textarea, PasswordField, Checkbox/CheckboxCard, Radio, Switch, Select, Combobox, Chip/Tag, Badge, StatusChip/StatusBadge, Avatar, Icon, Spinner, Skeleton, Divider, Tooltip, Toast/FormAlert/StatusBanner, Card, Breadcrumb, Pagination, EmptyState, NoAccess | Yes (NoAccess = `EmptyState tone="denied"`; SelectableCard = `TagSelect appearance="card"`; ConstraintChip = `RemovableTag`; StatusBanner = `RetrievalStatusBanner`) |
| PublicHeader/PublicNav, PublicFooter, SidebarNav + BrandRow + CollapseButton + NavItem + NavDisclosure + ExternalNavLink, WorkspaceHeader + Breadcrumb + GlobalSearchButton + NotificationBell + AvatarButton + AvatarMenu, AuthShell, Tabs, Dialog/ConfirmDialog/Sheet, AssistantLauncher + AssistantOverlay + OverlayHeader, DataTable, ComparisonTable, VersionPill/VersionPicker, Timeline/EvidenceList, CitationChip + CitationDrawer body + UnavailableNotice, CitedAnswer status, StepProgress | Yes |
| PageHeader, story/row cards, ActionCard (decision), entity cards, DateTile/EventList, DemoBanner, Hero, Band, MagazineCover, Quote, Prose, SectionHeader, MediaFrame/Gallery covers | Yes (DS-002): `SectionHeader size="lg"`, `StoryCard`, `DecisionCard`, `EntityCard`, `DateTile`/`EventList`, `DemoBanner`, `Hero`, `Band`, `MagazineCover`, `Quote`, `Prose`, `MediaFrame` |
| SegmentedControl, DatePicker, ProgressBar (determinate), NotificationsPanel content, SearchField/SearchDialog, FilterBar/FilterSheet, StickyActionBar, Panel/Drawer container, OnboardingShell/ReaderShell/AdminShell, SubNav, LineItemTable, DescriptionList, ReputationSummary, ProvenanceLine/FreshnessLine (partially: in EvidenceList), MessageBubble/ProposalCard/MandateCard/ApprovalDigestCard, AuthorityCheckCard etc., EligibilityTable, CorrectionBanner, reader controls, image Gallery with lightbox, RichTextEditor, IntakeWizard, forms for mandates/offers, IssueEditor/TaxonomyTree, Consent/Private blocks | **Not in this slice**; compose from the primitives above in WEB-001/WEB-002/WEB-003/CNT-001/AST-001 or raise a DS follow-up task |
