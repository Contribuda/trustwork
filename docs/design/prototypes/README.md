# Administrative prototype continuation

Status: **Proposed design; package registration pending**. Agent: Codex CLI (OpenAI) for Parshkov.

This continues all six stopped studies and the existing console v2 sources. The HTML files are offline interaction studies with explicitly synthetic data. They do not implement application routes, grant permissions, connect providers or establish live acceptance. Proposed ADR 019 remains Proposed. The current result and publication blockers are recorded in [the continuation report](evidence/final-continuation-result.md).

## Six studies

| Study | Open artifact | Editable source | Scenario coverage |
|---|---|---|---|
| Console v2 | [Console](console-prototype.html) | `source/console-v2-src`, `source/locales/*/console.json` | Palette, staff invitation, role tabs, search/detail drawer, pause/resume/stop, restart approval, price validation, kill/release reason and confirmation, self-approval exclusion |
| Editorial | [Editorial office](editorial-prototype.html) | `source/editorial.html`, `source/locales/*/editorial.json` | Collection previews, claims, glossary correction, separate translation reviewer, first/second editor, self-review exclusion, publication simulation, autonomy review, auditor read-only view |
| Outreach | [Outreach](outreach-prototype.html) | `source/l10n-work/src/outreach.html`, `source/l10n-work/msg/outreach` | Inherited page, entity review, strict-mode block, notice scenario, recipient/language preview, claims, objection lookup and simulated code flow |
| Network | [Hub network](network-prototype.html) | `source/l10n-work/src/network.html`, `source/l10n-work/msg/network` | List/drawer, peer traffic/settings, widening approval, required reasons, second-person activation simulation, request steps, contact-data warning, suspension cancellation, listing withdrawal |
| Tender | [Tender desk](tender-prototype.html) | `source/l10n-work/src/tender.html`, `source/l10n-work/msg/tender` | Inherited opportunity filters, decision, expert booking simulation, citations, requirements, export preview, pricing/buyer projection, questions, team, review, invalid/valid submission code, single assistant |
| Operating company | [Operating company](operating-company-prototype.html) | `source/operating-company.html`, `source/locales/*/operating-company.json` | Setup/preset/second-person study, team grid/tree, six handover stages, finance, paid-ranking refusal, aggregate quality view |

Each picker offers `en`, `es`, `ru`, `uz-Latn`, `ka`, `hy`, `az-Latn`. English is the reference; every translation is an unreviewed draft. Shared picker labels and reduced-ICU formatting data live in `source/locales/*/common.json`. Brand values are generated from `packages/ui/locales/en.json` and `apps/web/brand/messages/ru.json`. Console fonts are embedded offline; the other studies use system fonts.

Dates and numbers use `Intl`; the shared formatting layer supplies explicit localized date parts when a browser lacks full locale data. Source-language editorial examples, translation source/target segments, synthetic tender citations and recipient-language outreach previews retain explicit `lang` annotations. Stable identifiers, synthetic proper names and valid shared spellings are distinguished from untranslated UI in `evidence/localization-review.json`. That lexical review is not native linguistic review.

## Preservation and generation

`source/original-inventory.json` preserves the owner's inventory of 57 files. Its paths are relative to the original handoff directory. Original files remain untouched. `source/original-prototypes` preserves the six received HTML files; `source/console-v2.html` preserves the received console v2. The inherited `source/l10n-work/orig`, scripts and verification reports retain historical work. No dependencies or node_modules were copied.

Build from the repository root with Node built-ins only:

```sh
node docs/design/prototypes/tools/build.mjs
PROTOTYPE_ORIGINALS=/path/to/trustwork-codex-handoff node docs/design/prototypes/tools/validate.mjs
```

The validator checks all 42 prototype dictionaries, supported plural-message shapes, placeholders, generated script syntax, offline resources, two-build reproducibility and, when the optional environment variable is supplied, original SHA256 values. `evidence/artifact-sha256.json` identifies the artifacts, sources and current tools; `evidence/source-validation.json` records the results. The build does not depend on the handoff directory.

Run focused browser checks one process at a time, reusing an existing Playwright installation:

```sh
PROTOTYPE_DEPS=/path/to/existing/trustwork-checkout node docs/design/prototypes/tools/interactions.mjs
PROTOTYPE_DEPS=/path/to/existing/trustwork-checkout node docs/design/prototypes/tools/audit.mjs
node docs/design/prototypes/tools/review-localization.mjs
```

Both browser commands accept study names to narrow a rerun. The interaction runner also accepts `PROTOTYPE_LOCALES` and `PROTOTYPE_WIDTHS` as comma-separated filters; omit them for all seven locales at 1280 and 375 px. It imports the inherited outreach/tender scenarios, adds the other four studies, and verifies keyboard behavior and locale persistence. All browser requests outside local/data resources are aborted and reported. Runtime errors, document overflow, unnamed visible controls, assertion failures or external requests make the command fail.

The older `source/l10n-work/tools/verify.mjs` now resolves generated artifacts inside this repository and accepts `PROTOTYPE_DEPS`; its original scenarios are preserved. Use the commands above for the complete current suite. `tools/extract-editorial.mjs` records the original bilingual extraction and accepts the same dependency path for TypeScript; normal generation uses the committed dictionaries and does not require extraction.

## Evidence and limits

- `evidence/audit.json`: major-screen rendering, seven locales and both widths, with runtime/overflow/control/resource findings and exact-English candidates.
- `evidence/interactions-<study>.json`: named scenario results, captured visible strings and labels, keyboard/persistence results and screenshots.
- `evidence/<study>-<locale>-<width>.png`: entry-screen captures in English, Spanish and Russian; additional Armenian captures cover the previously overflowing screens.
- `evidence/<study>-ru-375-<scenario>.png`: phone dialog, refusal, approval and handover evidence.
- `evidence/continuation-result.md`: the previous stopped run's historical report, including its 21 unresolved overflows; it is not the latest acceptance result.

The checks cover the named synthetic scenarios, not every possible input/state combination. They do not establish backend authorization, concurrency, production readiness, full WCAG conformance, screen-reader acceptance, native translation accuracy or owner/maintainer design acceptance. Real implementation needs those separate checks. Inert navigation context is identified as such; simulated confirmations remain inside the persistent prototype context.

## Publication dependency

The requested `ADM-UX-001` and `ADM-UX-002` names conflict with the existing registry's ID pattern. The owner's naming/scope question remains pending. This continuation does not change that validator, assign replacement IDs, write registry entries or promote a design to accepted/live. Integration PR #399 is merged; the worker report records that verification. Preserve upstream status wording and package IDs when integrating.

See [administrative guidelines](../admin-ui-guidelines.md) and [Proposed ADR 019](../../adr/019-admin-ui-libraries.md). ADRs 015-018 retain their reservations. Handbook, status and index links are drafted in the worktree. The draft design PR preserves this finished review material. Package registry publication and merge readiness remain pending the package-ID decision. Integration PR #399 is merged; this branch was rebased without replaying duplicate inherited designs.

Embedded script fragments and object-expression dictionaries use `.js.fragment` filenames: they are generator inputs, not standalone JavaScript modules. Their bytes are preserved; generated script syntax is checked by the prototype validator. The current executable tooling remains covered by the repository linter.
