# Brand separation

The engine and the reference deployment are different things (ADR-009 decisions 4 and 6: the engine is Trustwork).

| Layer | Where it lives | Status |
|---|---|---|
| Maintainer | `README.md`, `NOTICE`, `GOVERNANCE.md`, handbook | Created and maintained by Contribuddha (contribuddha.com); owner decision 2026-10-30 (ADR 010 decision 13). |
| Engine name | `NOTICE`, `README.md`, package scope `@trustwork/*`, env prefix `TRUSTWORK_`, cookies `trustwork.*`, CSS utility prefix `trustwork-`, digest algorithm `trustwork-digest-1`, PostgreSQL schema and roles `trustwork*` | **Trustwork**, decided by the owner on 2026-10-29 (O18); core team repository `Parshkov/trustwork` (private); public engine repository `Contribuddha/trustwork`. |
| Deployment brand: name and lettering | Overlay `apps/web/brand/` (`lettering.json`, generated `wordmarks.ts` and `logo/`, `messages/<tag>.json`); the engine's own `brand.*` keys and `wordmark.ts` say Trustwork | Localized per language («build reputation»: ru, en, uz-Latn, ka, hy, az-Latn), owner decision 2026-10-29. Not part of the engine export (see `NOTICE`). |
| Mark (three blue squares) | `packages/ui/brand/logo-mark*.svg`, `<Brand variant="mark" />` | The owner's Trustwork mark, shipped with the engine (owner decision 2026-10-29: «это наш символ»); `NOTICE` states the trademark reservation. |
| Country packs | `packages/country-packs/packs/*.json` | Engine data; each pack cites its sources. |
| Legal templates | `docs/legal/templates` | Engine templates; the operator adapts them. |

How another operator rebrands a deployment: replace the `brand.*` keys and regenerate the wordmark with `packages/ui/brand/tools/build-logo.py` (or supply their own `wordmark.ts` and SVGs), keep the geometry if they want the same lockup or replace `<Brand />` entirely. Nothing else in the engine references the brand name except through these keys.

## How the overlay works (2026-10-29)

- `@trustwork/ui` renders the neutral lockup («trust / work», `packages/ui/brand/logo-*.svg`, `src/components/Brand/wordmark.ts`) and neutral `brand.*` strings; the copy that embeds the name says "Trustwork".
- `apps/web/brand/` is the reference deployment's overlay: `wordmarks.ts` and `logo/` (generated with `build-logo.py … deployment`), `messages/<tag>.json` (brand keys and every string that embeds the name, per locale), `index.ts` exporting `brandOverlay`.
- `apps/web/app/_lib/locale-data.ts` layers the overlay messages above the dictionaries and registers the wordmarks on the server; `LocaleProvider` registers them in the client bundle. `<Brand />` asks `overlayWordmark(tag)` first.
- `scripts/export-open-source.mjs` replaces `apps/web/brand/index.ts` with `brandOverlay = null`, so the open-source engine never carries the «Строй Репутация» assets. Another operator fills the same folder with their own brand.
