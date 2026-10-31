# Frontend/UI technology recommendations for DS-001 and WEB-001

Status: **proposal.** The integrator and the DS-001/WEB-001 owners decide; adding dependencies touches the root lockfile and requires integrator review. Constraints that drive the evaluation: Next 16 App Router with React 19 (already in `apps/web`), server rendering of public pages, strict TypeScript, Russian-only copy via `packages/ui/locales/ru.json`, WCAG 2.2 AA target, an independent design system (no proprietary system copying, Orbit deferred), small team, and the component list in [component-inventory.md](component-inventory.md) which is heavy on dialogs, menus, comboboxes, tabs, tables and a non-modal overlay. Official sources are listed per option; this task did not execute any of the libraries, so claims are from documentation, and versions must be checked at adoption time.

## 1. Component foundation

| Option | What it is | Pros | Cons | Source |
|---|---|---|---|---|
| React Aria Components (Adobe; Apache-2.0) | Unstyled, accessible components built on React Aria hooks: Button, Dialog, Menu, ComboBox, ListBox, Tabs, Table, DatePicker, Toolbar, Tree, etc. | Broadest coverage of our inventory (table, combobox, date picker, toolbar); internationalization built in (locale-aware date/number, RTL not needed); keyboard/focus management handled; render-props styling fits any CSS approach; server component friendly as client islands | Larger API surface to learn; Table/collections API is opinionated; bundle larger than minimal headless; styling is fully on us | https://react-spectrum.adobe.com/react-aria/ |
| Radix Primitives | Unstyled primitives: Dialog, DropdownMenu, Tabs, Popover, Tooltip, Switch, Checkbox, etc. | Mature, widely used; simple composable API; good focus management | No combobox, table, date picker or toolbar; Radix team moved focus to Base UI; several patterns would need other libraries | https://www.radix-ui.com/primitives |
| Base UI (MUI + Radix authors; released 1.x) | Unstyled component library (Dialog, Menu, Select, Combobox, Tabs, Toolbar, NumberField, Tooltip…) | Modern API; active development; combines Radix/MUI lessons; stable 1.x release | Younger ecosystem; verify coverage at adoption; no table | https://base-ui.com/ |
| Headless own | Write components with WAI-ARIA patterns directly | Full control, no dependency churn | Highest accessibility risk and cost for ~15 complex widgets; not realistic for the team size | https://www.w3.org/WAI/ARIA/apg/patterns/ |

**Recommendation:** React Aria Components as the behaviour foundation, wrapped in our own `packages/ui` components with our tokens and Russian strings. Rationale: it covers ComboBox, Table, DatePicker, Toolbar and Tree which the inventory needs and the alternatives lack; it has explicit focus-management primitives for the non-modal assistant overlay and citation drawer. Keep a thin wrapper layer so a later swap is contained.

## 2. Styling

| Option | Pros | Cons | Source |
|---|---|---|---|
| CSS Modules (built into Next) | Zero config in Next; SSR-safe; plain CSS with custom properties for tokens; easy for designers to read; no runtime | No type-safety of class names without extra tooling; variants by hand; the Next docs now present Tailwind as the default styling choice, so CSS Modules is a deliberate deviation | https://nextjs.org/docs/app/getting-started/css |
| Tailwind CSS v4 | Fast authoring; `@theme` maps tokens to utilities; design tokens as CSS variables; no runtime; Next documents it | Markup verbosity; consistency depends on discipline; utility names in Russian-UI codebase are fine (engineering is English) | https://tailwindcss.com/docs and https://tailwindcss.com/blog/tailwindcss-v4 |
| vanilla-extract | Type-safe styles and themes in TS; zero runtime CSS; `createTheme` for tokens; recipes for variants | Build plugin integration with Next/webpack must be maintained; smaller ecosystem | https://vanilla-extract.style/documentation/getting-started/ |
| Panda CSS | Build-time atomic CSS with typed tokens and recipes; works with RSC | Younger; codegen step; two mental models (tokens + utilities) | https://panda-css.com/docs/overview/getting-started |

**Recommendation:** **CSS Modules + CSS custom properties** for `packages/ui` (tokens in `tokens.css`, which already exists), with a small typed variant helper. Although the current Next documentation recommends Tailwind by default, CSS Modules remain first-party supported and are the lowest-risk option here (no plugin to maintain, SSR trivially correct), keeps the design system readable for a human reviewer, and matches the scale (≈ 60 components). If the team prefers utilities, Tailwind v4 with `@theme` fed from the same token file is the alternative; avoid mixing both in the same package.

## 3. Icons

| Option | Licence | Notes | Source |
|---|---|---|---|
| Lucide | ISC (plus the MIT notice of the Feather icons it derives from; both notices must be vendored) | Large outline set, consistent 2 px stroke, tree-shakable React package | https://lucide.dev/ and https://github.com/lucide-icons/lucide/blob/main/LICENSE |
| Tabler Icons | MIT | Very large set, 1.5–2 px stroke, outline + filled | https://tabler.io/icons |
| Phosphor | MIT | Multiple weights | https://phosphoricons.com/ |

**Recommendation:** Lucide (ISC, broadly used, stroke matches the references' line icons), vendored as needed; brand mark and illustrations are own assets.

## 4. Forms and validation

| Option | Pros | Cons | Source |
|---|---|---|---|
| React Hook Form + Zod | Minimal re-renders; schema shared with `packages/contracts` validation; good a11y integration via `aria-invalid`/`describedby` wrappers | Controlled components from React Aria need `Controller`; Zod error messages must be mapped to locale keys | https://react-hook-form.com/ and https://zod.dev/ |
| React Aria Components built-in validation + Server Actions | Native constraint validation, server errors mapped to fields, no extra dependency | Complex multi-step forms (mandate, intake wizard) need state management anyway | https://react-spectrum.adobe.com/react-aria/forms.html |

**Recommendation:** Start with React Aria form validation plus Next Server Actions for simple forms (auth, settings), add React Hook Form only for the editors (quote line items, mandate wizard, intake). All messages via locale keys; schemas reuse the frozen contract types from FND-002.

## 5. Tables

| Option | Pros | Cons | Source |
|---|---|---|---|
| TanStack Table (headless) | Sorting/filtering/column visibility logic without markup; pairs with our responsive card collapse | Still need accessible markup ourselves | https://tanstack.com/table/latest |
| React Aria Table | Accessible grid keyboard navigation, selection, sorting built-in | Collection API; virtualization separate | https://react-spectrum.adobe.com/react-aria/Table.html |

**Recommendation:** React Aria Table for interactive data tables (keyboard grid navigation matters for the comparison table and line-item editor); plain semantic `<table>` for read-only tables; a shared `ResponsiveTable` wrapper that switches to cards below 768 using the same column definitions. TanStack only if client-side column logic grows.

## 6. Component documentation and visual testing

| Option | Pros | Cons | Source |
|---|---|---|---|
| Storybook | Industry default; a11y addon (axe); interaction tests; visual testing integrations; Next framework support | Heavier install and config; slower | https://storybook.js.org/docs |
| Ladle | Very fast Vite-based stories; CSF-compatible; small | Fewer addons; separate build tool from Next | https://ladle.dev/ |

**Recommendation:** Storybook (framework `@storybook/nextjs` or the Vite variant) because the a11y addon and interaction tests give DS-001 the evidence it must report; keep stories CSF so Ladle remains possible. Storybook is a dev dependency in `packages/ui` only.

## 7. Accessibility and end-to-end testing

- Playwright for browser tests across Chromium/WebKit/Firefox with mobile viewports (320/375/768), keyboard-only flows and reduced-motion emulation. https://playwright.dev/
- `@axe-core/playwright` for automated WCAG checks in each page test; automated zero violations is **not** acceptance (accessibility doc). https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright
- Manual walkthroughs with VoiceOver (macOS/iOS) and NVDA (Windows) recorded per the accessibility doc template.
- Visual regression: Playwright screenshots with per-component stories as a start; a hosted visual diff service is a separate decision (cost, external service → O08).

## 8. Internationalization and locale keys

Requirements as written by DS-000 (since superseded by [ADR 009](../../adr/009-international-engine-and-open-source.md): English is the reference language and Russian is one additional interface language): Russian only, keys in `packages/ui/locales/ru.json`, typed keys, ICU-style plurals for Russian (one/few/many), no English fallback strings in product copy.

| Option | Pros | Cons | Source |
|---|---|---|---|
| next-intl | App Router native; server and client; ICU messages with plurals; typed keys from JSON via TS augmentation | Dependency; routing locale segments not needed (single locale) — can be configured without i18n routing | https://next-intl.dev/docs/getting-started |
| Own tiny `t()` with typed key union generated from `ru.json` + `Intl.PluralRules`/`Intl.NumberFormat`/`Intl.DateTimeFormat` | No dependency; full control; the current JSON already exists | Must implement ICU-like interpolation and plural selection ourselves (small) | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl |

**Recommendation:** Keep `ru.json` as the single source; generate a typed key union at build (simple script in `packages/ui`) and use a small in-house `t()` with `Intl` for plurals/numbers/dates. Adopt next-intl only if a second locale is ever required. The proposed `ru.*` keys in the contracts should be merged into `ru.json` by DS-001/WEB-001 under their leases, restructured into nested objects (the current file uses arrays for navigation; keep those invariants intact because `validate:docs` checks `publicNav`).

## 9. Fonts delivery

Self-host variable fonts via `next/font/local` (no external font requests; subsetting Cyrillic + Latin). Licence texts vendored. https://nextjs.org/docs/app/api-reference/components/font

## 10. Summary table

| Concern | Recommendation | Alternative |
|---|---|---|
| Behaviour foundation | React Aria Components wrapped in `packages/ui` | Base UI (re-evaluate at adoption) |
| Styling | CSS Modules + custom-property tokens | Tailwind v4 `@theme` |
| Icons | Lucide (ISC) | Tabler (MIT) |
| Forms | React Aria validation + Server Actions; RHF+Zod for editors | RHF everywhere |
| Tables | React Aria Table + `ResponsiveTable` wrapper | TanStack Table |
| Docs | Storybook with a11y addon | Ladle |
| Testing | Playwright + axe-core + manual SR | — |
| i18n | Typed `ru.json` + `Intl` | next-intl |
| Fonts | `next/font/local`, Golos Text (+ PT Serif for reader) | Inter |

All of the above are proposals; none is installed by this task, and any adoption must go through the integrator because it changes the root lockfile.
