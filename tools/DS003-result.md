# DS-003 result report

Agent: Codex CLI (OpenAI) for Parshkov

Owner: Dmitry Parshkov. Conductor: Codex. Branch: `work/DS-003/codex`.
Draft pull request: [#503](https://github.com/Contribuda/trustwork/pull/503). Work package: [DS-003 #408](https://github.com/Contribuda/trustwork/issues/408).

Implementation and local acceptance: **PASS**. Package hand-back: **in_review**, not done or accepted. Full CI at the final PR head is a separate gate, tracked with the full SHA in the PR description; it is not inferred from these local results.

## Revisions and coordination

- Original parent: `72f7c62c7c80f30b476b2e64a72c36c58bbe8cbb`.
- Final upstream parent: `ea906192912cb3aeb536262152204af8f5c29ab0`, including merged PR #446. Its reference prototype head was `33659933248505e67c93df9a7d377ed51c387454`.
- Verified implementation/test commit: `a367f034408793e9d49ffd595e76e514fa2a7e80`. Later changes in this PR are the report, evidence and status hand-back only. The final PR description names its current full head SHA, avoiding a self-referential commit hash in this file.
- `/claim DS-003` was linted successfully and accepted by the claims bot after [comment 6553854982](https://github.com/Contribuda/trustwork/issues/408#issuecomment-6553854982), before implementation. No other claim was displaced. The owner explicitly authorized the tenth maintainer claim and narrow shared integration paths.
- Read HANDOFF, OWNER-DIRECTIVES, agent/implementation briefs, repository onboarding and required project documents, DS-003 context, console/system/accessibility chapters, and referenced ADRs. `ctw-admin-ux` was a read-only design reference; no files were copied from that worktree. ADR 019 remains proposed; no library or root configuration/dependency/lockfile was added.
- Rebase preservation: every upstream work-package object except DS-003 is identical; the upstream status text is preserved, with only the DS-003 component-evidence addition. DS-001 and ADM-002 remain done. PR #446's DS-005 and administrative UX packages remain as upstream defined them.
- Every commit has `Signed-off-by: Dmitry Parshkov <3625177+Parshkov@users.noreply.github.com>` and ends with `Co-Authored-By: Codex CLI <noreply@openai.com>`.

## Criteria and implementation matrix

Paths below are relative to `packages/ui/src/components/` unless stated otherwise. API details and caller obligations are in [components.md](../docs/design/system/components.md#console-component-kit-ds-003).

| Criterion / component | Implementation | Verification / result |
|---|---|---|
| Backward-compatible DataTable; controlled server sort, filter, page, selection | `DataTable/DataTable.tsx`, `selection.ts` | PASS: existing props compile in web; existing sort and mobile regression pass; query/page changes preserve the supplied fixed server rows. Selection preserves off-page keys and invalidates an all-matching snapshot on a changed query. |
| Column visibility/order, density, saved-view slot | `DataTable/DataTable.tsx` | PASS: controlled callbacks, last-column guard, button-based reordering, density select, sticky header/first column and `savedViews` slot. Browser tests hide/restore/reorder columns and change page; no drag-only controls. |
| APG editable grid; read-only native tables | `DataTable/grid.ts`, `DataTable.tsx` | PASS: roving cell focus, arrows, Home/End, Ctrl/Cmd bounds, PageUp/PageDown, Enter/F2 edit, Escape rollback, Enter/Tab commit, focus return. Grid behavior is enabled only for explicit grid mode; read-only table buttons stay ordinary tab stops. |
| FilterBar/chips, FacetPanel | `FilterBar/FilterBar.tsx`, `FacetPanel/FacetPanel.tsx` | PASS: controlled query and removable chips, clear action, fieldset/legend facets, count/suppression text. Filter and result counts use polite live regions; keyboard facet toggling runs in all seven languages. |
| SavedViews | `SavedViews/SavedViews.tsx` | PASS: select/save/share/default callbacks; configuration stores only query, filters, columns and sort. Menu and form use existing primitives; current view announced. Browser save and column controls are exercised. Persistence and document-title integration belong to the page owner. |
| BulkActionBar | `BulkActionBar/BulkActionBar.tsx` | PASS: selection count, action slot, first-selection focus, Escape clears and returns focus; the Records composition replaces the filter bar while selection is nonempty. |
| Non-modal DetailDrawer | `DetailDrawer/DetailDrawer.tsx` | PASS: labelled aside, own-page link, full-width phone layout, list remains operable, Escape closes and returns focus to the opening row. Opened-state axe and focus assertions at all three widths. |
| AuditTrail | `AuditTrail/AuditTrail.tsx` | PASS: ordered projected activity, actor role/reason/approval/digest slots; absolute localized time with explicit time zone. No activity is invented outside labelled synthetic stories. |
| DiffViewer | `DiffViewer/DiffViewer.tsx` | PASS: semantic before/after table, changed-only default, checkbox reveals unchanged fields; added/removed/effect are text. Phone table has readable column widths and keyboard-focusable horizontal scrolling with a visible hint. |
| ApprovalCard | `ApprovalCard/ApprovalCard.tsx` | PASS: projected scope/requester/reason/digest/expiry/diff and availability explanations. Disabled approve cannot run; decline requires controlled reason. Caller eligibility is authoritative; no identity/approval policy is duplicated. |
| PermissionMatrix | `PermissionMatrix/PermissionMatrix.tsx` | PASS: role/permission grid, row/column headers, one cell tab stop, navigation and explanation on focus/Enter/Space; labelled phone list. Caller selects the comparison roles (up to four); this is not a role editor. |
| ScopePicker | `ScopePicker/ScopePicker.tsx` | PASS: platform/node/hub radio group and combobox, taking the already projected role/assigner scope intersection. No participant identity or impersonation surface. |
| EffectiveAccess, LockedRule | `EffectiveAccess/EffectiveAccess.tsx`, `LockedRule/LockedRule.tsx` | PASS: projected description lists, granting roles/expiry/state text; locked guard rails are explanatory text and a source link, with no switch or policy evaluator. |
| TypedConfirmation | `StepUpPrompt/TypedConfirmation.tsx` | PASS: existing Dialog composition; cancel first/focused, exact controlled confirmation, mismatch disabled, paste/autocomplete allowed, Escape and focus return. Existing ConfirmDialog remains compatible for the other confirmation tiers. |
| StepUpPrompt | `StepUpPrompt/StepUpPrompt.tsx` | PASS: code/password, optional passkey/security-key callback, pending/error and caller-confirmed state. Clipboard paste tested; `one-time-code` and `current-password` preserved; switching method retains input. No fixture submission fabricates successful backend authentication. |
| ReasonField, AuditNote | `StepUpPrompt/ReasonField.tsx` | PASS: required reason defaults, linked description, polite counter that follows controlled external updates; audit note. Caller can compose an optional reason-code Select. Existing ADM-002 wrapper suppresses the new counter and retains original labels/defaults. |
| CommandPalette | `CommandPalette/CommandPalette.tsx` | PASS: controlled query/results, grouped combobox/listbox, Ctrl/Cmd+K, arrows/Home/End, Enter action, result announcements, Escape and focus return. All seven languages receive keyboard/opened axe coverage. |
| InboxList, InlineHelp, KeyboardShortcuts | Respective named component directories | PASS: structured articles and actions, disclosure, semantic shortcut table and controlled single-key preference. The shell owns persistence and application-wide shortcut registration; the kit installs no single-key shortcuts. |
| RunHistory, StatusLabel | `RunHistory/RunHistory.tsx`, `StatusLabel.tsx` | PASS: ordered runs/steps, dry-run and unknown outcomes stated in text; shared Live/Demo/Contract/Designed/Proposed/Fake/Manual labels. Existing RunStatusBadge remains authoritative for run states. |
| KillSwitchControl | `LockedRule/KillSwitchControl.tsx` | PASS: distinct engage/request-release callbacks, reason and incident note; release remains a request. Second-person decisions stay upstream. |
| Money/cohort helpers | `MetricChart/values.tsx` | PASS: Intl decimal currency formatting, negative-margin text, text-first budget meter; suppressed counts contain a threshold and no hidden number. No accounting or cohort authorization calculation. |
| CalendarAgenda | `CalendarAgenda/CalendarAgenda.tsx` | PASS: accessible chronological agenda, timezone-aware event day, localized month/weekdays, decorative desktop month grid and caller event actions. |
| MetricChart plus equivalent table | `MetricChart/MetricChart.tsx` | PASS: metric definition/period, text labels, bars and always-present semantic table with identical points; suppressed points have no revealing bar. Browser checks table rows in every language/width. |
| NetworkMap plus equivalent list | `NetworkMap/NetworkMap.tsx`, `places.ts` | PASS: bundled schematic SVG, keyboard marker order and Enter, zoom buttons, same safe hubs in primary list. Canonical restricted codes, descendants, mixed/empty/malformed lists and invalid coordinates are rejected from selectable display. No external tiles or services. |
| Seven languages, Intl and brand boundaries | `packages/ui/locales/*.json`, `src/i18n/dictionaries.ts` | PASS: English, Spanish, Russian, Uzbek Latin, Georgian, Armenian and Azerbaijani Latin; Spanish registered in the existing provider. Dates/numbers use Intl; no component hard-codes brand. Native-language acceptance remains separate. |
| Shared promotion without domain/runtime takeover | `apps/web/app/admin/_components/ConsoleForm.tsx`, `shell.tsx`, `apps/web/components/ui.ts`, UI exports | PASS: minimal ADM-002 compatibility adapters for StatusLabel, ReasonField and AuditNote; web types pass. No page, command action, API/domain/backend, active screening/billing/content flow or global agent-management UI was edited. |

## Commands, exits and counts

All local work follows the LOAD RULE: focused component tests, selected primitive regressions, types/lint/docs. No local full `npm run check`, full application browser suite, database runner or dependency reinstall.

| Command / scope | Exit | Result and revision |
|---|---:|---|
| `node --version`; `npm --version` | 0 | `v24.18.0`; `11.16.0` |
| `npm ci` (once, original base) | 0 | 388 packages; 13 moderate audit findings reported, no dependency changes |
| `npm run claims -- lint /tmp/DS-003-claim.txt` | 0 | Claim format passed; bot accepted before code |
| Baseline `npm run test:unit -w @trustwork/ui` | 0 | 26 passed at original parent |
| Final `npm run test:unit -w @trustwork/ui` | 0 | 31 passed, 0 failed at verified implementation/test commit |
| `npm run build:storybook -w @trustwork/ui` | 0 | Actual local static stories; component/story source identical to verified commit (only test/trailer edits followed the build) |
| Focused Playwright command below | 0 | 40 passed, 0 failed, 0 skipped at the verified implementation/test commit; 33 DS-003 + 7 existing primitive regressions |
| `npm run typecheck -w @trustwork/ui` | 0 | UI, stories and tests; no diagnostics |
| `npm run typecheck -w @trustwork/web` | 0 | Existing callers and minimal admin adapters; no diagnostics |
| Scoped ESLint over changed UI components, locales registration, stories/tests/exports and admin adapters | 0 | No diagnostics; scope listed in evidence manifest |
| `npm run validate:docs`; `node scripts/work-packages.mjs validate`; `git diff --check` | 0 | 360 packages, 74 requirements, local links/navigation invariant; no whitespace errors |

The final browser command runs from `packages/ui` against loopback port 6213 with one worker:

```sh
STORYBOOK_PORT=6213 npx --no-install playwright test tests/e2e/console.spec.ts tests/e2e/keyboard.spec.ts tests/e2e/mobile.spec.ts --project=desktop --project=mobile --workers=1 --grep 'DS-003|dialog traps|confirm dialog focuses|tabs move|password toggle|sortable table headers|assistant overlay is|data table collapses'
```

The DS-003 registration covers nine rendered stories at 375, 768 and 1280 px in all seven languages (189 rendered story/locale/width combinations), keyboard interactions and opened states, plus 12 detailed interaction tests. Axe includes WCAG 2.0 A/AA, 2.1 A/AA and 2.2 AA tags. The matrix asserts no page errors, no page-level horizontal overflow, no external browser requests and no selectable restricted fixture. Diff/grid scrolling inside a labelled region is intentional. The existing primitive subset covers dialog, confirmation, tabs, password toggle, sorting, assistant overlay and mobile table labels.

## Visual and retained evidence

Eight Russian screenshots from the actual rendered local stories are in [console-evidence](../docs/design/system/console-evidence/README.md), with SHA-256 hashes, viewport dimensions, source commit and compact test summaries in `manifest.json`.

Visually inspected phone and desktop evidence includes Records, Access, Decisions and Activity. Long labels wrap; mobile cards retain every column label; permission focus is visible; the diff scrolls with readable columns; controlled reason counters agree; chart/table and map/list stay paired. These are component-story checks, not application flow or human screen-reader acceptance.

## Historical evidence, kept separate

- Initial component checks exposed and fixed native-table focus accidentally receiving grid behavior, palette group ARIA, long-label overflow, controlled reason-counter drift and narrow phone diff columns.
- Spanish registration exposed a pre-existing placeholder regex that treated ordinary Spanish words as TODO markers. The locale test now checks explicit uppercase TODO/TBD markers and lorem ipsum; dictionaries and all seven-language key invariants pass.
- Historical CI on `4c2fd2e7c7cbb4c9dce29678bfe14f4b4a2c244b`, [run 41277938868](https://github.com/Contribuda/trustwork/actions/runs/41277938868), passed full `npm run check`, application/browser and other jobs, but its UI accessibility job failed seven tests: six pointer checks against visually hidden checkbox inputs and the old mobile assertion omitting the first column label. The current tests use real keyboard activation and assert all labels. The current local focused gate passes; the historical run is not final-head CI acceptance.
- Earlier local passing iterations are superseded by the manifest's exact implementation/test commit. Commit-trailer normalization preserved the entire source tree; all commits now end with the required Codex coauthor.

## Limitations and concrete follow-ups

1. **Conductor / CI:** confirm every required check on the exact current PR head before acceptance. Keep the full-check box unchecked until that run succeeds; do not transfer a previous SHA's result. This report seals local implementation evidence; the PR description records the latest remote gate.
2. **Maintainer:** review and accept DS-003; only then mark it done and unblock dependent DS-005 / ADM-UX-001 work. Worker completion, draft publication and a passing automated gate are not approval or merge.
3. **QA / native reviewers:** VoiceOver/NVDA, real devices, Firefox/WebKit, 400% zoom, high-contrast review and native copy acceptance were not performed. Axe and scripted Chromium keyboard checks do not replace them.
4. **Consuming page owners:** wire projected server data/actions, query-snapshot identity, persistence and authorization; put the selected saved-view name in the document title, apply the single-key preference globally, and integrate real step-up/approval handlers. The fixed synthetic server page intentionally does not filter/fetch locally or authenticate anyone.
5. **ADM-002 / section owners:** adopt remaining domain-specific run/approval/money compositions through their own permitted runtime changes. This package exports shared presentation equivalents without migrating active screening, billing or content pages.
6. **DS-004:** dark-theme tokens remain separate. Components use existing semantic tokens; this package does not claim dark-theme acceptance.

No production, provider, account, deployment, spending, outreach, approval, merge or approved-list action was taken. No subagents or new worktrees were created. Only generated build/test output from this task may be removed after the evidence is retained; dependencies and source remain intact.
