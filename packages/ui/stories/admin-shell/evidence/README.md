# DS-005 focused browser evidence

Verified source commit: `eea3505f7e8c4c332d9f8b9481fa2369be1d7b93`. This evidence-only follow-up does not change the tested implementation, dictionaries, stories or tests. Package status remains in_progress; conductor acceptance and exact-final-head remote CI are separate.

- UI unit suite: exit 0, 39 passed, 0 failed/skipped (including the existing DS-003 cases).
- UI typecheck, focused ESLint, docs validation, work-package validation and package Storybook build: exit 0. Docs: 360 packages and 74 requirements.
- Registered `admin-shell.spec.ts`, one worker: exit 0, 15 passed, 0 failed/skipped; 14 language/width scenarios and one responsive/language scenario. All seven locales at 375 and 1280 px. 154 axe scans, no violations. No document horizontal overflow, runtime errors or external browser requests.
- Actual keyboard tests cover skip link, modal Tab containment, inert background, Escape/selection focus return, committed route heading focus, palette filtering, unavailable account action, empty navigation/account and responsive focus retention. Native screen-reader/native-speaker/physical-device testing remains unperformed.

[Manifest](manifest.json) records all 126 screenshots and SHA256 values, including the exact 11 captures individually inspected by the agent. [Source manifest](source-manifest.json) records file hashes and preservation assertions: all 359 other package objects, the entire prior status text, root manifests, all DS-003 owned source and all six prototypes are unchanged. The full screenshot corpus, raw failed/successful logs and result report are in the conductor handoff `tools/DS005-evidence/` and `tools/DS005-result.md`. Only representative Russian captures are committed here.

## Inspected Russian examples

[Desktop, closed](ru-1280-closed.png) · [Phone, closed](ru-375-closed.png) · [Phone, account menu](ru-375-account.png) · [Phone, long navigation labels](ru-375-long-open.png) · [Phone, empty palette](ru-375-palette-empty.png)

The agent inspected legibility, glyph rendering, wrapping, scope text, one avatar, focus visibility, unavailable explanations, and overlay boundaries. Visual inspection is not native translation review or owner visual approval. Vertical page scrolling is normal; a full-page capture of a fixed overlay can include the document below the viewport.

## Retained failures and intermediate evidence

The initial typecheck failed on exact optional `aria-controls`; it was corrected. Initial browser tests failed on a root-relative test dictionary path, then an ambiguous language label, a palette assertion including native language options, and a Russian partial-name navigation selector. The working-tree matrix then passed 15 tests with 112 captures. The first complete UI unit suite on `1c58e4d23db7688a3090e51d850b85c0d88956d3` passed 38 and failed 1 because language endonyms violated the Russian-copy invariant. Localized option names fixed it. No quarantine, assertion requirement or axe rule was relaxed. All failed logs and available error contexts are retained in the handoff; none are presented as final acceptance.

Reproduction commands and the consumer boundary are in the [component README](../../../src/components/AdminShell/README.md). No full local gate, deployment, real provider call, account registration, spending, new worktree or subagent was used.
