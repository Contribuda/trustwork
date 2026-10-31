# Brand

**Trustwork everywhere** (owner decision 2026-10-31, ADR 010 decision 14). The engine, the public site, the workspace, the documentation and the hosted preview show Trustwork in every language. The only exception is the Russian interface, which shows «Строй Репутация».

| Layer | Where it lives | Status |
|---|---|---|
| Product and engine name | `NOTICE`, `README.md`, package scope `@trustwork/*`, env prefix `TRUSTWORK_`, cookies `trustwork.*`, CSS utility prefix `trustwork-`, digest algorithm `trustwork-digest-1`, PostgreSQL schema and roles `trustwork*` | **Trustwork**, decided by the owner on 2026-10-29 (O18). Repository `Contribuddha/trustwork`. |
| Maintainer | `README.md`, `NOTICE`, `GOVERNANCE.md`, handbook | Created and maintained by Contribuddha (contribuddha.com), ADR 010 decision 13. |
| Mark (three blue squares) | `packages/ui/brand/logo-mark*.svg`, `<Brand variant="mark" />` | The project's own symbol (owner decision 2026-10-29), shipped with the engine; `NOTICE` states the trademark reservation. |
| Wordmark | `packages/ui/brand/logo-*.svg`, `packages/ui/src/components/Brand/wordmark.ts` | «trust / work», the default lockup. |
| Russian-interface overlay | `apps/web/brand/` (`lettering.json`, `wordmarks.ts`, `logo/`, `messages/ru.json`) | «Строй Репутация» with the lettering «строй / репутация», applied only when the visitor chose Russian. On by default (`stroyreputation-ru`); `NEXT_PUBLIC_TRUSTWORK_BRAND=none` turns it off. |
| Country packs | `packages/country-packs/packs/*.json` | Engine data; each pack cites its sources. |
| Legal templates | `docs/legal/templates` | Templates the operator adapts with counsel. |

## How overlays work

- `@trustwork/ui` renders the Trustwork lockup and the neutral `brand.*` strings; copy that embeds the name says "Trustwork".
- `apps/web/brand/index.ts` maps overlay ids to overlays (`wordmarks` and `messages` per locale tag) and exports `brandOverlay`. The default overlay `stroyreputation-ru` covers only `ru`; every other locale has no overlay entry and falls back to Trustwork. `NEXT_PUBLIC_TRUSTWORK_BRAND=none` disables it.
- `apps/web/app/_lib/locale-data.ts` layers the overlay messages above the dictionaries and registers the wordmarks on the server; `LocaleProvider` registers them in the client bundle; `<Brand />` asks `overlayWordmark(tag)` first.
- The container build passes `NEXT_PUBLIC_TRUSTWORK_BRAND` as a build argument (`infra/Dockerfile`); leave it empty for the default behaviour.

## Adding your own brand for a deployment

1. Generate your wordmark with `packages/ui/brand/tools/build-logo.py` (or supply your own SVGs and `wordmarks.ts`).
2. Add `messages/<tag>.json` with your `brand.*` keys and every string that embeds the name, for each language you serve.
3. Register the overlay under a new id in `apps/web/brand/index.ts`, listing only the locale tags it should replace, and build with `NEXT_PUBLIC_TRUSTWORK_BRAND=<id>`.

Names and lettering of overlays are marks of their owners; the licence grants no trademark rights to them (AGPL-3.0 section 7(e), see `NOTICE`).
