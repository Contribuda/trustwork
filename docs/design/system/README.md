# Design system (`@trustwork/ui`)

Status: **implemented by DS-001 and visually reworked by DS-002 (phase 1) on 2026-10-27; visuals not yet approved by the owner.** This directory documents the independent, accessible design system for Trustwork: tokens, brand asset, locale, React components, Storybook stories and automated accessibility evidence. It is engineering acceptance material; human visual approval (O09) and the decisions listed in [human-review-request.md](../screen-contracts/human-review-request.md) remain separate.

| Document | Content |
|---|---|
| [art-direction.md](art-direction.md) | DS-002 art direction: character, colour decision, type scale, depth, imagery, scrims, motion, consistency rules, before/after |
| [tokens.md](tokens.md) | Blue scale, colour roles, scrims, spacing and rhythm, type, radius, elevation, motion, z-index, breakpoints, focus ring |
| [media.md](media.md) | Photographs and artworks: inventory, licences, regeneration, serving, `coverFor`, text over images |
| [components.md](components.md) | Every component: API, states, accessibility behaviour, story names |
| [logo.md](logo.md) | Logo provenance, variants, usage rules |
| [accessibility-evidence.md](accessibility-evidence.md) | axe results per story, Playwright keyboard/mobile/contrast checks, manual checklist with dates, what was not tested |
| `showcase/` (private design archive) | Review screenshots of the Showcase compositions and key components at 1280 / 375 px |

## What is approved and what is not

- Accepted direction (manifest): public home menu, companies hub, magazine, login, signup, onboarding references; brand rules (three blue squares, black stacked wordmark, light restrained surfaces). The components follow those directions.
- **Not approved:** the workspace composition in `workspace-latest.png` (status `proposed_unapproved`). `SidebarNav`, `AppHeader`, `AssistantLauncher` and `AssistantOverlay` implement the parts that the specification already mandates (R09, R23, R24: collapse inside the brand row, avatar-only account, bell with count, floating launcher, no docked panel); the overview layout, breadcrumb root, split "Create" button and other A1–A11 questions are not implemented and wait for the owner.
- Token values are proposed canonical, not visually accepted. Nothing in this package claims visual approval.
- The rejection ledger was respected: no docked assistant, no avatar name/chevron, no bottom-left account block, no company switcher, no "Agents" UI, no primary menu-setup button, no OTP primary auth, no English product copy.

## Stack (integrator decision, 2026-10-27)

React 19 + React Aria Components (Apache-2.0) wrapped in our own components; CSS Modules with CSS custom-property tokens (no Tailwind); Lucide icons (ISC, Feather MIT notice vendored in `packages/ui/licenses`); Golos Text (OFL) for UI and PT Serif (OFL) for the reader, self-hosted in `packages/ui/fonts` with provenance in `packages/ui/fonts/PROVENANCE.md`; Storybook 10 with `@storybook/addon-a11y`; Playwright + `@axe-core/playwright`. All tooling is a devDependency of `@trustwork/ui` only.

## Package layout

```
packages/ui/
  package.json          exports map (TS sources, consistent with @trustwork/contracts), scripts
  tokens/index.ts       token source; tokens/tokens.css generated (npm run tokens:build)
  tokens.css            legacy path -> @import tokens/tokens.css
  locales/*.json        copy for every interface language (en is the reference); keys per DS-000 conventions
  brand/*.svg           logo variants (see logo.md)
  media/                artworks/*.svg + manifest, PROVENANCE.md, tools/ (no photographs ship with the engine; see media.md)
  fonts/                woff2/ttf, OFL texts, PROVENANCE.md, fonts.css
  licenses/             Lucide (ISC + Feather MIT), React Aria Components (Apache-2.0)
  src/index.ts          public surface
  src/i18n              t(), plural/number/date helpers, typed LocaleKey
  src/components/*      component + CSS module per folder
  src/media/index.ts    coverFor(), photo(), artwork(), media manifests
  src/styles/base.css   reset, focus-visible ring, typography utilities, container/grid/section rhythm, enter animation, reduced motion
  stories/              one CSF file per component family, all states
  tests/unit            node:test (i18n, tokens, locale invariants)
  tests/e2e             Playwright: axe over every story, opened states, keyboard, mobile, pixel contrast over scrims
  tests/screenshots     capture.mjs + optimize.py for docs/design/system/showcase
  .storybook/           Storybook config (react-vite, addon-a11y, viewports)
```

## How to use

```ts
// app root (once)
import '@trustwork/ui/tokens.css';
import '@trustwork/ui/fonts.css';
import '@trustwork/ui/base.css';

import { UiProvider, Button, TextField, t } from '@trustwork/ui';

// wrap the app once: sets React Aria's built-in strings and formatting to the active locale (intlTag(), also during SSR) and renders the toast region
<UiProvider>{children}</UiProvider>

<TextField label={t('auth.email')} autoComplete="username" inputMode="email" />
<Button type="submit" isLoading={busy} pendingLabel={t('auth.submitting')}>{t('auth.submitLogin')}</Button>
```

- All product copy comes from the locale dictionaries (`locales/<lang>.json`) through `t(key, params)`; components accept localized strings as props and never embed copy except via locale keys. Plural groups use ICU `{count, plural, …}` with the categories of each language (English one/other; Russian one/few/many).
- Styles: tokens are CSS custom properties; override by setting the property on a wrapper (`--color-accent`), never by targeting generated class names.
- Next.js consumers must add `transpilePackages: ['@trustwork/ui']` (TS sources + CSS Modules) and should load the fonts with `next/font/local` from `packages/ui/fonts` (WEB-001).
- Documentation and visual testing: `npm run storybook -w @trustwork/ui` (http://127.0.0.1:6006); static build `npm run build:storybook -w @trustwork/ui` → `packages/ui/dist/storybook`.

## Scripts and checks

| Command | What it does |
|---|---|
| `npm run typecheck -w @trustwork/ui` | `tsc --noEmit` with the root strict options (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes) plus DOM/JSX |
| `npm run test:unit -w @trustwork/ui` | node:test: i18n plurals, tokens.css in sync, contrast ≥ 4.5:1 / 3:1, locale invariants, Russian-only copy |
| `npm run test:a11y -w @trustwork/ui` | builds Storybook, runs axe-core (WCAG 2.0/2.1/2.2 A+AA tags) over every story and again after opening menus/dialogs/popovers/sheets/overlay, keyboard, focus-not-obscured and mobile Playwright specs; writes `dist/axe-summary.json` |
| `npm test -w @trustwork/ui` | both of the above |
| `npm run tokens:build -w @trustwork/ui` | regenerates `tokens/tokens.css` |
| `npm run media:build -w @trustwork/ui` | regenerates the SVG artworks and the WebP photo set with provenance (Python 3 + Pillow + curl) |
| `npm run screenshots -w @trustwork/ui` | captures and shrinks the showcase screenshots into `docs/design/system/showcase` (after `build:storybook`) |
| root `npm run lint` | includes `packages/ui` (TS/TSX) |
| root `npm run check` | includes `typecheck -w @trustwork/ui` and `test:unit -w @trustwork/ui` (root scripts since INTG-000); the Playwright/axe run stays a package-level gate |

## State matrix (summary; details per component in components.md)

| Family | States implemented |
|---|---|
| Button / IconButton / IconLink | default, hover, focus-visible, pressed, disabled, loading (`isPending`, label swap), icon-only with required `aria-label`, pressed toggle |
| Link | inline, standalone (arrow), external (icon + "external link" (`common.externalLink`), `rel="noopener"`), nav (`aria-current`), disabled, visited (inline) |
| TextField / TextArea / PasswordField | default, focus, filled, required (text marker), description, error (`aria-invalid` + `aria-describedby`), disabled, read-only, counter, show/hide toggle with `aria-pressed` |
| Select / ComboBox | closed, open, selected, filtering, loading, no results, error, disabled |
| Checkbox / Radio / Switch | unchecked, checked, mixed, focus, disabled, invalid, group label/description/error, switch on/off text, loading |
| Form helpers | form `aria-busy`, FormAlert info/success/warning/error (`role="status"`/`alert`, focusable summary with field links), Fieldset, FormRow, FormActions, Divider with text |
| Dialog / ConfirmDialog | closed, open, loading (no dismiss), sizes sm/md/lg/sheet, destructive (cancel focused first) |
| Popover / Menu / Tooltip | closed, open, disabled/destructive items, separators, header text (name in the menu, not in the header) |
| Toast | info/success/warning/error, action, dismiss, auto-dismiss ≥ 5 s with pause on hover/focus, errors persist |
| Badge / StatusChip | count, 99+, zero hidden, dot; record (sourced/claimed/verified), evidence (asserted/confirmed/disputed/superseded), kind, lifecycle, run states incl. outcome unknown / reconciling / revoked |
| Avatar / AvatarButton | image, initials, decorative, sizes 24–96, menu button |
| Skeleton / EmptyState / Card | text/card/row/circle/table bones in a busy status region; empty / error / denied with optional artwork illustration; card header/aside/footer, selected, hover lift, one primary link |
| Typography / Media | Heading, Text, Kicker, Meta; MediaFrame ratios, scrims, blur-up, `fill`; coverFor determinism |
| Editorial | Hero lg/md/sm, StoryCard s/m/l vertical/horizontal/text-only, SectionHeader, Band navy/tint/warm with backdrop, MagazineCover lg/md/sm link/static, Quote pull/inline/inverse, Prose |
| Workspace cards | DecisionCard decision/review/assistant, EntityCard company/person/project vertical/horizontal, DateTile/EventList, DemoBanner with persona menu |
| Breadcrumb / Pagination / Stepper / Tabs | current page, disabled ends, loading, links or buttons; step done/current/upcoming with "Step N of M"; tabs selected/disabled/overflow |
| DataTable | sorted asc/desc (`aria-sort`), loading, empty, error, row actions, tablet scroll region, mobile cards keeping labels |
| ComparisonTable / VersionPicker | comparable / non-comparable (reason disclosure) / missing cells, stale and excluded offers, incomplete totals, select per supplier, mobile accordion with supplier switcher; versions current / historical / stale with announcement and focus move |
| CitationChip / AnswerStatusLine / RetrievalStatusBanner / CitationDetails | available / historical / unavailable (revoked, deleted, consent, scope); supported / qualified / abstain with scope note; complete / partial (reason) / no answer / unavailable / stale / previous shown / historical / offline |
| Timeline / EvidenceList | done, pending, baseline vs changed, disputed, outcome unknown; evidence state per item with freshness line |
| TagSelect / RemovableTag | pills or cards, selected, disabled, announced count; removable constraint chips |
| SidebarNav | expanded, collapsed (icons + tooltips + hidden labels), attention badges with text, divider groups, "More" (`shell.more`) disclosure, "To the industry" (`publicExit`), sheet variant |
| AppHeader | breadcrumb (depth > 1), search, bell with count / unknown / none, avatar menu, offline banner, mobile menu button |
| PublicHeader / PublicFooter | anonymous / authenticated, active section, mobile sheet; four footer groups with "Help" (`footer.help`) last |
| AuthShell | desktop two columns, stacked < 900, mobile; login composition with every contract state in stories |
| AssistantLauncher / AssistantOverlay | closed, open (`aria-expanded`), unread, action required; overlay online / offline / unavailable, empty, unread marker, attention strip, not-sent message, desktop non-modal panel, mobile modal sheet |

## Accessibility checklist (applies to every component)

1. Native semantics first; ARIA from React Aria only where native elements fall short.
2. Visible focus ring (2 px, ≥ 3:1) on `:focus-visible` only; nothing hides it. `base.css` sets `scroll-padding-top` (sticky header height) and `scroll-padding-bottom` (launcher) on `html` and on the `.trustwork-scroll` class that workspace scroll containers must carry, so a control scrolled into view on focus lands fully visible (asserted by a Playwright test). Residual limitation: a control that is already inside the viewport but under the sticky header is not re-scrolled by browsers on focus; keep sticky bars short and avoid placing controls under them in page layouts.
3. Minimum 24×24 CSS px targets; defaults 40 px; error-summary links padded to 24 px.
4. Every icon-only control has a localized accessible name from a locale key; icons are `aria-hidden`.
5. Status never colour-only (text + icon); contrast verified by unit test and axe.
6. Keyboard: menu button, dialog, tabs, combobox, listbox, toggle group and grid patterns via React Aria; Escape closes overlays and returns focus; modal content makes the rest of the document `inert`.
7. Reduced motion respected via tokens and base.css.
8. Consistent help (3.2.6): "Help" (`footer.help`) last in PublicFooter and AuthShell footer, directly before "Sign out" (`shell.menu.signOut`) in the avatar menu (asserted in a Playwright test).
9. Redundant entry (3.3.7) and no cognitive-test auth: password fields allow paste/managers; prefill is the consumer's duty and documented in the contracts.
10. Automated zero axe violations is **not** accessibility acceptance; manual screen-reader sessions are listed in accessibility-evidence.md with what was and was not done.

## Not delivered in this slice

DatePicker, RichTextEditor, LineItemTable (editable), image Gallery with lightbox, IssueEditor/TaxonomyTree, FilterBar/FilterSheet, SearchDialog, NotificationsPanel contents, StickyActionBar, ReaderShell/AdminShell, charts (out of scope by decision). Dark theme. Favicon set. Phase 2 (applying the system to `apps/web`) is a separate task; see the handoff list in the task record.
