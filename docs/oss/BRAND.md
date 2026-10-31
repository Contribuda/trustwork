# Brand

**Trustwork everywhere** (owner decision 2026-10-31, ADR 010 decision 14). The engine, the public site, the workspace, the documentation and the hosted preview show Trustwork in every language. The only exception is the Russian interface, which shows a Russian-language name and wordmark defined in `apps/web/brand`.

| Layer | Where it lives | Status |
|---|---|---|
| Product and engine name | `NOTICE`, `README.md`, package scope `@trustwork/*`, env prefix `TRUSTWORK_`, cookies `trustwork.*`, CSS utility prefix `trustwork-`, digest algorithm `trustwork-digest-1`, PostgreSQL schema and roles `trustwork*` | **Trustwork**, decided by the owner on 2026-10-29 (O18). Repository `Contribuddha/trustwork`. |
| Maintainer | `README.md`, `NOTICE`, `GOVERNANCE.md`, handbook | Created and maintained by Contribuddha (contribuddha.com), ADR 010 decision 13. |
| Mark (three blue squares) | `packages/ui/brand/logo-mark*.svg`, `<Brand variant="mark" />` | The project's own symbol (owner decision 2026-10-29), shipped with the engine; `NOTICE` states the trademark reservation. |
| Wordmark | `packages/ui/brand/logo-*.svg`, `packages/ui/src/components/Brand/wordmark.ts` | "trust / work", the default lockup. |
| Russian-interface overlay | `apps/web/brand/` (`lettering.json`, `wordmarks.ts`, `logo/`, `messages/ru.json`) | A Russian-language name with its stacked two-word lettering, applied only when the visitor chose Russian. On by default (`stroyreputation-ru`); `TRUSTWORK_BRAND=none` (runtime) or `NEXT_PUBLIC_TRUSTWORK_BRAND=none` (build) turns it off. |
| Country packs | `packages/country-packs/packs/*.json` | Engine data; each pack cites its sources. |
| Legal templates | `docs/legal/templates` | Templates the operator adapts with counsel. |

## How overlays work

- `@trustwork/ui` renders the Trustwork lockup and the neutral `brand.*` strings; copy that embeds the name says "Trustwork".
- `apps/web/brand/index.ts` maps built-in overlay ids to overlays (`wordmarks` and `messages` per locale tag). The default overlay `stroyreputation-ru` covers only `ru`; every other locale has no overlay entry and falls back to Trustwork.
- The overlay is runtime configuration (CFG-001, [Deployment configuration](../country-packs/configuration.md)): `brand.overlay` in `trustwork.config.json` or `TRUSTWORK_BRAND`, read when the server starts (`none` disables it), so one image serves deployments with different brands. When neither is set, the build-time `NEXT_PUBLIC_TRUSTWORK_BRAND` applies, then the default. An id that names no overlay stops the server at start.
- `apps/web/brand/load.ts` resolves the overlay (built in, or `<dataDir>/brands/<id>.json`); `apps/web/app/_lib/locale-data.ts` layers its messages above the dictionaries and registers the wordmarks on the server; the root layout hands the browser the wordmark of the page's language and `LocaleProvider` registers it; `<Brand />` asks `overlayWordmark(tag)` first.
- The container build may still pass `NEXT_PUBLIC_TRUSTWORK_BRAND` as a build argument (`infra/Dockerfile`); leave it empty and set `TRUSTWORK_BRAND` per container instead.

## Adding your own brand for a deployment

Without code (a deployment's data directory):

1. Generate your wordmark outlines with `packages/ui/brand/tools/build-logo.py`.
2. Write `<dataDir>/brands/<id>.json`: `{ "wordmarks": { "<tag>": { "line1": [...], "line2": [...], "width1": 0, "width2": 0, "viewBoxWidth": 0 } }, "messages": { "<tag>": { "brand": { ... } } } }` with your `brand.*` keys and every string that embeds the name, listing only the locale tags it should replace.
3. Set `TRUSTWORK_BRAND=<id>` (or `brand.overlay`) and restart.

To ship an overlay with the engine instead, register it under a new id in `apps/web/brand/index.ts` with `messages/<tag>.json` and generated `wordmarks.ts`.

Names and lettering of overlays are marks of their owners; the licence grants no trademark rights to them (AGPL-3.0 section 7(e), see `NOTICE`).
