# Accessibility evidence (DS-001, revised by DS-002)

Target: WCAG 2.2 AA (see [accessibility acceptance](../../quality/accessibility.md)). Everything below is engineering evidence produced on 2026-10-27 in the DS-002 worktree on macOS (Darwin 25.5, Node 24.18.0, Chromium headless shell via Playwright 1.64.1, axe-core via `@axe-core/playwright` 4.14.0), superseding the DS-001 numbers. **Automated zero violations is not accessibility acceptance**; the manual sections state exactly what was and was not done.

## 1. Automated: axe-core over every story

| Item | Value |
|---|---|
| Command | `npm run test:a11y -w @trustwork/ui` (builds Storybook to `packages/ui/dist/storybook`, serves it on loopback, runs every spec in `tests/e2e`) |
| Rule tags | `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` (best-practice rules such as `region` are not enforced in the per-story run; Storybook's a11y addon panel runs them with `test: 'error'` for local review) |
| Stories scanned | **170** (28 CSF files: the 140 DS-001 stories plus 30 DS-002 stories for typography, media, editorial, workspace cards and the showcase compositions) |
| Violations | **0** |
| Page errors while rendering | 0 (the test fails on any uncaught exception, which also proves every `t()` key used by a component exists and every media file resolves) |
| Opened states | `tests/e2e/opened.spec.ts` reruns axe after a user opens each overlay kind (dialog, destructive confirm, avatar menu, row-actions menu, popover, select listbox, combobox listbox after typing, assistant overlay, tooltip on focus, comparison disclosure, sidebar «Ещё», **demo persona menu**); `mobile.spec.ts` rescans after opening the public menu sheet and the assistant sheet and on the showcase home. All 0 violations with one documented exception below |
| Known finding, not a defect | Combobox listbox open: React Aria keeps the non-modal popover interactive and marks the rest of the page `aria-hidden`; axe flags the other focusable fields as `aria-hidden-focus`. The rule is disabled for that single case with a comment |
| Output | `packages/ui/dist/axe-summary.json` (per story: id, violation count, rule ids); `packages/ui/dist/playwright-report.json` |

Violations found and fixed during DS-002 (kept so reviewers can see what the scan catches): `label-content-name-mismatch` on the magazine cover link and the demo persona button (`aria-label` replaced by visually hidden text so the visible text is part of the name); `aria-prohibited-attr` on `time` date tiles (`aria-label` replaced by visually hidden full date); `color-contrast` on the subtle text tone (`#6b7484` → `#616b7a`) and on the auth panel subline, which revealed that the panel photograph did not cover the whole panel (fixed with the `fill` ratio).

## 2. Automated: keyboard, focus, responsive behaviour and real contrast (Playwright)

Run: `npx playwright test` inside `packages/ui` after a Storybook build. Result on 2026-10-27: **220 passed, 0 failed** = 170 axe scans + 1 story-coverage test + 21 keyboard/focus tests at 1280×800 + 13 opened-state axe/focus tests + 7 mobile tests at 375×812 + **8 pixel-contrast tests**.

| Check | WCAG | Result |
|---|---|---|
| Dialog: opens from keyboard, initial focus on the first field, Tab stays inside, rest of document `inert`, Escape closes, focus returns to trigger | 2.1.2, 2.4.3, 2.4.7 | pass |
| Confirm dialog focuses the non-destructive action first | 3.3.4 | pass |
| Avatar menu: `aria-haspopup="menu"`, ArrowDown opens, arrows/End move, Escape closes and returns focus; «Помощь» is directly before «Выйти» | 2.1.1, 3.2.6 | pass |
| Tabs: ArrowRight selects, Tab reaches the panel | 2.1.1 | pass |
| Password toggle: `aria-pressed`, Space toggles, tab order unchanged | 4.1.2 | pass |
| Sortable headers: `aria-sort`, click/keyboard toggles; table region focusable with a label | 1.3.1, 2.1.1 | pass |
| Sidebar collapse inside the brand row, `aria-expanded`, focus stays, collapsed links keep names and attention text, «В отрасль» present | 2.4.3, 4.1.2 | pass |
| Bell count in the accessible name; avatar is the only account control | 4.1.2, R24 | pass |
| Assistant overlay: fixed, page width unchanged, non-modal, focus to «Закрыть», Escape returns focus, `aria-expanded` | 1.4.10, 2.4.3, R09 | pass |
| Launcher names its unread / action-required state | 4.1.2 | pass |
| Citation chips: state in name, `aria-expanded` | 4.1.2 | pass |
| TagSelect: `aria-pressed`, live «Выбран 1 вариант» | 4.1.2, 4.1.3 | pass |
| Public header: seven sections in order, `aria-current`, skip link first | 2.4.1, R15 | pass |
| Toast region polite, errors `role="alert"` | 4.1.3 | pass |
| Focus ring rendered on keyboard focus | 2.4.7 | pass |
| Focused control scrolled into view lands below the sticky header | 2.4.11 | pass |
| **StoryCard: exactly one link per card, focus ring drawn on the whole card** | 2.4.7, 2.4.4 | pass |
| **Hero: single link named by the headline, image `alt` present** | 1.1.1, 2.4.4 | pass |
| **MagazineCover link named «Обложка выпуска № 12 … Фасады перед зимой» from its own text** | 2.5.3, 2.4.4 | pass |
| **DemoBanner: `role="status"` message; persona menu opens with ArrowDown, `menuitemradio` checked state, End + Enter selects, name updates, focus returns** | 4.1.2, 2.4.3 | pass |
| **DecisionCard: one CTA, kicker names the state (never colour-only)** | 1.4.1 | pass |
| **EventList: `time[datetime]` with visually hidden full date, one link per item** | 1.3.1 | pass |
| axe after opening dialog, menus, popover, listboxes, assistant overlay, tooltip, disclosures, demo menu, mobile sheets | 1.3.1, 4.1.2 | pass (one documented exception) |
| Mobile: DataTable cards keep labels; ComparisonTable accordion; assistant sheet modal; public menu sheet; login no horizontal scroll | 1.3.1, 1.4.10, 2.1.2 | pass |
| **Mobile: showcase home at 375 px — no horizontal scroll, lead tiles stack to full width, axe 0** | 1.4.10 | pass |
| Icon-only controls ≥ 24×24 CSS px | 2.5.8 | pass |
| **White text over photographs ≥ 4.5:1 at every sampled pixel** (`contrast.spec.ts`: draws the rendered photograph into a canvas with the same `object-fit: cover` geometry, composites the frame scrim and the text-anchored gradient parsed from computed styles, samples the text box every 3 px): three scrim variants, lead hero, medium hero, showcase hero, magazine cover, auth panel | 1.4.3 | pass (minimum observed ≥ 4.5:1; the first pass measured 1.76:1 on the medium hero before the anchored gradient was added) |

## 3. Automated: unit tests

`npm run test:unit -w @trustwork/ui` — **25 tests, 25 passed**: Russian plural selection and interpolation, missing-key failure, `formatDate`, `tokens.css` in sync with `tokens/index.ts`, z-index and breakpoint invariants, blue scale monotonic, **40 contrast pairs** (text ≥ 4.5:1 on surface/canvas/tint/warm, navy band text and link hover, status and assistant families on their tints and on white, focus ring and status `strong` colours ≥ 3:1), **scrim worst case** (white over navy α 0.78 over pure white ≥ 4.5:1; every scrim gradient reaches α 0.78), type scale descending with tracking only on display sizes, motion tokens zeroed under reduced motion, locale invariants and Russian-only copy, **media set complete with provenance (24 photographs × 3 widths, SHA-256, download dates, Russian alt; 16 artworks), size budget, `coverFor` deterministic / spread / never a photograph for people**.

## 4. Manual checks performed (keyboard only, Chromium, 2026-10-27)

| Item | Result |
|---|---|
| DS-001 items (login tab order, workspace shell order, assistant overlay, comparison table, reduced motion, 200 % zoom) | unchanged, re-run on the restyled components |
| Showcase home: Tab order demo strip → skip link → header → nav → lead hero link → two tile links → news tiles → article cards → aside → magazine cover link → buttons → entity cards → band buttons → footer; every card is one Tab stop | as contracted |
| Reduced motion (emulated): no enter stagger, no card lift, no media scale, no cover tilt, no dialog/toast animation | as contracted |
| Showcase at 375 px: all grids stack, the lead hero becomes 4:5, cover widths follow the viewport | no clipping observed |

## 5. Not tested (must be done before acceptance)

| Item | Owner |
|---|---|
| Screen readers: VoiceOver (macOS/iOS) and NVDA (Windows) sessions over the login flow, sidebar collapse, dialog, assistant overlay, data table cards, citation drawer, **the new card families and the magazine cover link name** | QA-001 / phase 2 |
| Windows High Contrast / forced-colors mode (scrims and elevation disappear there; text stays readable because the overlay is real text, but it is unverified) | QA-001 |
| Real devices, safe-area insets, 320 px on a physical device | QA-001 |
| 400 % browser zoom | QA-001 |
| Firefox and WebKit engines (Chromium only, to keep the install small) | QA-001 |
| Colour vision simulation of the status families and the amber/violet decision rules | design review |
| Real pages composed in `apps/web` — only the Storybook compositions were tested | phase 2 |

## 6. How to reproduce

```sh
npm ci
npx playwright install chromium
npm run test:unit -w @trustwork/ui
npm run test:a11y -w @trustwork/ui      # Storybook build + axe (initial + opened states) + keyboard + mobile + contrast; prints "axe: 170 stories scanned, 0 violations"
npm run storybook -w @trustwork/ui      # interactive review with the a11y addon panel (violations shown as errors)
```
