# DS-003 acceptance repair result

Agent: Codex CLI (OpenAI) for Parshkov

Owner: Dmitry Parshkov. Package: DS-003, [issue #408](https://github.com/Contribuda/trustwork/issues/408). Existing draft [PR #503](https://github.com/Contribuda/trustwork/pull/503), branch `work/DS-003/codex`, worktree `/Users/parshkov/Dev/ctw-ds-003`.

Implementation verification: **PASS**. Conductor acceptance, exact-final-head CI and human/native accessibility review are separate gates. Nothing has been approved, queued, merged or deployed.

## Baseline, ownership and preservation

- Continued the clean published head `af7e3bd8f6a4c434017b00abfff28f870408be83`; worker 11819 and watcher 52538 were absent from the process table before any write. No second source writer, subagent or new worktree was launched.
- Read the handoff, owner directives, common and implementation briefs, onboarding, DS-003 context and relevant design/ADR material, the actual first-pass result, and conductor reviews 6554043844/6554054171. The existing accepted #408 claim remains the authority; no replacement claim or takeover occurred.
- Initial conductor-review baseline `4c2fd2e7c7cbb4c9dce29678bfe14f4b4a2c244b`, original verified source `a367f034408793e9d49ffd595e76e514fa2a7e80`, and the first-pass report/evidence are retained unchanged. The first-pass blanket grid acceptance claim is superseded by this report's specific browser proofs.
- Tested implementation/story/test source: `f6aa6803915cbf615e3ee9ed298683c141501787`. After trailer normalization the identical implementation tree is also at `315680e1276fafacbea1dcde4370f4dd930fb682`. The final reporting commit adds only evidence, documentation and package hand-back status; its full SHA is recorded in the PR body and the conductor's handoff copy, avoiding a self-referential hash here.
- All 22 component directories and the minimal real-admin compatibility adapters are retained. The repair changes only DataTable behavior, seven locale additions, its synthetic story/tests and allocated documentation/evidence/status paths. No new library, root configuration/lockfile, API, domain authorization, migration or backend change.
- No upstream rebase was necessary: the remote PR was mergeable. The five own repair commits were later replayed solely to place the Codex CLI coauthor after the DCO trailer. Trees were identical before and after that metadata normalization. Original SHAs and a Git bundle are retained in the handoff archive. Every push used the exact previously observed branch SHA as an explicit lease; only this branch was rewritten. All 359 other work-package objects and every non-design-system upstream status row were checked against `ea906192912cb3aeb536262152204af8f5c29ab0` and preserved.
- Each new commit uses the authorized Dmitry Parshkov DCO and ends with `Co-Authored-By: Codex CLI <noreply@openai.com>`.

## The four findings

1. **Every enabled cell control is reachable.** Navigation retains one grid cell in the page tab order; the redundant grid scroll-container tab stop is removed. Enter/F2 focuses the first enabled, visible control, skipping an initially disabled action. Tab and Shift+Tab traverse the other enabled buttons and link, skip a disabled middle action, and then move to the adjacent actual cell. Escape returns to the owning cell. Navigation Tab and interaction Tab at the grid boundary leave the grid. Cleanup restores descendant tab attributes if grid mode changes. Real browser keys activate both row actions, verify their callback payloads, enter and toggle selection, return focus, and leave/re-enter the grid. These are not destination-function-only tests.

2. **Edit Tab uses rendered grid geometry.** The row-major destination uses the entire grid: optional selection, visible data columns and optional actions. It wraps to the preceding/following row rather than clamping against `shown.length - 1`; outer boundaries allow native focus exit. Browser coverage includes selection on/off, actions on/off, two data columns or the first data column hidden, first/last visible edits, both directions and external boundaries at every target width. Exact requested values are asserted after real Enter/F2 and Tab/Shift+Tab. Escape discards an edit. A synchronous callback exception keeps the editor and draft focused rather than losing its value.

3. **A controlled callback is not persistence acknowledgement.** On inspecting the actual baseline, all seven `consoleKit.saved` translations already said "Change requested"; this existing correction is retained. DataTable now uses explicit `changeRequested` and `changeRejected` keys in all seven languages. The request notice includes the value and explicitly says persistence is not confirmed. Callback resolution never triggers a saved/success message. Synchronous exceptions and rejected promises produce a failure notice with the attempted value; rejected or unanswered drafts remain available on reopening while the controlled source value is unchanged. A new caller-supplied value remains authoritative. Browser scenarios cover delayed resolution with a later controlled row update, rejected promises, no response, and synchronous exceptions, with no unhandled page errors or false saved announcement. No server response or domain API was invented. Synthetic story results are localized; exact callback payloads are test metadata, not visible technical copy.

4. **Preserved readable DiffViewer, verified scrolling and semantics.** The existing 32rem minimum width, localized scroll hint and labelled focusable region are unchanged. At 375 px the browser focuses the region and uses ArrowRight until the After header and values lie entirely inside the visible region; ArrowLeft returns to the start. Native row/column headers and exact before/after values are asserted, including added/removed empty sides and an unchanged row with equal values shown only after the checkbox. The fixture previously labelled unequal values unchanged; that story data is corrected without changing the component layout. The new Russian 375, keyboard-scrolled After and 1280 screenshots were visually inspected: words remain readable, Before/After keep their meaning, and desktop values align with their headers. Zero axe or page overflow alone was not treated as visual acceptance.

## Original acceptance retained across all 22 components

| Components | Evidence and boundary |
|---|---|
| DataTable | Controlled server sort/filter/page callbacks preserve caller rows; selection and all-matching snapshots, visibility/order/density and saved-view slot retained. Real table mode and existing admin consumers remain compatible. New grid and request proofs above. |
| FilterBar, FacetPanel, SavedViews | Localized controlled search/facets, active-filter chips, filter/result counts and view controls; actual keyboard interactions in the seven-language matrix. Persistence and document-title integration stay with consuming pages. |
| BulkActionBar, DetailDrawer | Polite selection counts, Escape clear, non-modal drawer, focus enters and returns to its actual opener. The existing records tests exercise these at all three widths. |
| AuditTrail, DiffViewer, ApprovalCard | Semantic projected history, exact diff semantics, disabled approval and required decline reason; no new decision authority. |
| PermissionMatrix, ScopePicker, EffectiveAccess | APG grid navigation and phone list, scoped controlled choices, textual access explanation; authorization remains upstream. |
| LockedRule, StepUpPrompt | Noninteractive locked explanations and distinct kill-switch requests; typed confirmation paste, password-manager autocomplete, code/password switching, disabled confirmation and focus return retained. ReasonField/AuditNote and their real-admin adapters remain compatible. |
| CommandPalette, InboxList, InlineHelp, KeyboardShortcuts | Actual combobox keyboard/open/close/focus return, labelled work items, disclosure and shortcut preference; no participant multi-agent surface or installed single-key handlers. |
| RunHistory, CalendarAgenda | Text states, unknown outcomes, ordered runs and a list-first timezone-aware agenda; no colour-only status. |
| MetricChart, NetworkMap | Equivalent semantic metric table and primary hub list; canonical restricted-place rejection tests, marker keyboard navigation, zero external requests in the matrix and no external tiles. |

Shared StatusLabel, money/cohort helpers and the existing minimal ADM-002 wrappers are retained. The first-pass report contains the full per-component code/API matrix; this report narrows and corrects its previously overstated grid acceptance. All new visible copy is localized in seven dictionaries. No paid-ranking, participant mandate, authorization or private-data boundary is changed.

## Commands, exits and counts

Source for final implementation checks: `f6aa6803915cbf615e3ee9ed298683c141501787`.

| Command | Exit | Count/result |
|---|---:|---|
| `npm run test:unit -w @trustwork/ui` | 0 | 32 passed, 0 failed/skipped |
| `npm run typecheck -w @trustwork/ui` | 0 | UI, stories and tests; no diagnostics |
| `npm run typecheck -w @trustwork/web` | 0 | Real web/admin consumers; no diagnostics |
| Scoped ESLint (exact command in evidence manifest) | 0 | No diagnostics |
| `npm run build:storybook -w @trustwork/ui` | 0 | Real static Storybook, no new dependency |
| Focused browser command below | 0 | 49 passed, 0 failed/skipped; 42 DS-003 + 7 primitive regressions |
| `npm run validate:docs` | 0 | 360 packages, 74 requirements; final evidence/status documentation validated |
| `node scripts/work-packages.mjs validate` | 0 | 360 packages, 76 available; only DS-003 status changed |
| `git diff --check` | 0 | Final whitespace check |

Browser command, from `packages/ui`, one worker and loopback only:

```sh
STORYBOOK_PORT=6213 npx --no-install playwright test tests/e2e/console.spec.ts tests/e2e/keyboard.spec.ts tests/e2e/mobile.spec.ts --project=desktop --project=mobile --workers=1 --max-failures=1 --grep 'DS-003|dialog traps|confirm dialog focuses|tabs move|password toggle|sortable table headers|assistant overlay is|data table collapses'
```

The bounded matrix has ten real stories in seven languages at 375/768/1280 px (210 rendered combinations), actual keyboard and opened-state checks, and axe WCAG 2.0 A/AA, 2.1 A/AA and 2.2 AA. Its 49 tests comprise 42 DS-003 and seven existing primitive regressions. No quarantine, disabled axe rule or screenshot-only replacement was introduced.

Node 24.18.0/npm 11.16.0 and the first worker's existing install were reused under the LOAD RULE; its successful `npm ci` remains historical evidence, not a new run. No full local `npm run check`, full application browser suite or database runner was run. Exact-final-head full CI remains a conductor gate; the PR checkbox stays unchecked until that SHA actually passes.

## Historical and failed runs, never promoted to final success

- Original `4c2fd2e7c7cbb4c9dce29678bfe14f4b4a2c244b` CI run 41277938868 and original 40-browser/31-unit evidence at `a367f034408793e9d49ffd595e76e514fa2a7e80` remain in the first-pass report and evidence directory. They do not establish repair acceptance.
- First repair typecheck: exit 2, five diagnostics in the new synthetic story (the exported Error story shadowed the global Error constructor; row inference needed an explicit generic). Source was an uncommitted patch on `af7e3bd8f6a4c434017b00abfff28f870408be83`, preserved with its SHA-256 and raw log in the handoff archive; no fictitious clean commit is assigned to that run. Both causes were fixed before `569c66f13358bfbe46d557f64f054d3c71b970bd`.
- Browser subset at `569c66f13358bfbe46d557f64f054d3c71b970bd`: exit 130 after an intentional bounded stop, seven passed, two timed out, one interrupted. The new exact-label selector could not locate the native scenario select; its accessible combobox name is now used. Failure context, JSON report and screenshots are archived. The grid traversal, geometry and Russian 375 proofs passed in that run, but the run is not counted as successful.
- Controlled-request subset at `6f0462cc9fad6f205ddfcc31eb4c11273aabc512`: exit 0, three passed. Its next full bounded matrix stopped at the first failure: exit 1, one failed and 48 did not run; the synthetic scenario select overflowed at English 375. Width containment was fixed, not waived.
- Matrix at `e441f238e0ea9e4ba8a8c48aa608e994fe3a1b03`: deliberately stopped (exit 130) after 11 passed and 38 did not run to localize visible callback markers in the new story. This partial run is retained, not final acceptance.
- Final source and browser result are the separate row above. Every failed/partial run retains its actual source identifier and raw output under `/Users/parshkov/Dev/trustwork-codex-handoff/tools/DS003-repair-evidence/`; compact history is also in the committed evidence manifest.

## Evidence, remaining gates and hand-back

The new evidence is additive under `docs/design/system/console-evidence/repair-f6aa6803/`: nine Russian PNGs (the original four compositions at phone/desktop plus the keyboard-scrolled After region), hashes/dimensions/source SHA, exact command, summary and historical run metadata. The original evidence and `tools/DS003-result.md` remain intact. The complete English repair report is also copied to `/Users/parshkov/Dev/trustwork-codex-handoff/tools/DS003-repair-result.md`.

The package status is `done` for the conductor-authorized implementation hand-back: all implementation criteria above pass the focused gate. This does not mean maintainer acceptance, green exact-final-head CI, merge or deployment. The conductor still reviews and accepts through the existing draft PR; its full-check box remains unchecked pending current-head CI.

Human VoiceOver/NVDA, native-speaker acceptance, physical devices, Firefox/WebKit, 400% zoom and high-contrast review remain unperformed and explicitly separate. Scripted Chromium focus/clipboard/axe evidence is not a claim about those reviews. Consuming owners still provide real persistence, server-projected authority and actual authentication/approval handlers; DS-004 owns dark-theme acceptance. No implementation criterion is silently waived.

Only this repair's generated Storybook/test output may be cleaned after evidence is archived. Dependencies, original evidence, other worktrees and other processes are preserved. No provider/account, secrets, spending, outreach, approval/queue, merge or deployment action was taken.
