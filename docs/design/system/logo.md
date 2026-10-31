# Logo: provenance, variants, usage

Status: **canonical editable asset created by DS-001 (2026-10-27)**; visual acceptance by the owner is a separate step (O09). The asset follows the accepted brand direction (spec R25, design inventory brand rules): three blue squares in an L-like arrangement with a black stacked wordmark that reads "build reputation" in the active language (ADR-009 decision 5, owner 2026-10-29; the earlier Russian-language stacked lockup is the historical reference). No new logo concept was introduced.

## Provenance

| Item | Value |
|---|---|
| Source of the direction | Raster references `login-classic.png`, `workspace-latest.png`, `public-home.png` kept in the private design archive (synthetic illustrations; inspected and cropped at 4× during DS-001, not copied) |
| Geometry | Three equal squares of 46 units with an 8-unit gap on a 100×100 grid, corner radius 5; positions bottom-left, bottom-right and top-right (the top-left slot is empty). This matches every reference crop: one square above the right-hand square of a two-square base row |
| Wordmark | Two stacked lowercase lines "trust / work" in every language (engine set). The Russian interface alone shows a Russian-language wordmark overlay defined in `apps/web/brand` (ADR 010 decision 14); Trustwork is the product name everywhere. Latin and Cyrillic in Golos Text Bold (`wght` 700 instance of the OFL variable font vendored in `packages/ui/fonts`), converted to outlined SVG paths with fontTools 4.67.0 (`instancer` + `SVGPathPen`, GPOS pair kerning applied). Georgian and Armenian in Noto Sans Georgian / Noto Sans Armenian Bold (`wght` 700, `wdth` 100; OFL, see `packages/ui/fonts/PROVENANCE.md`). Text is therefore **outlined**, not `<text>`: the logo renders identically without the font installed. The viewBox width follows the widest line of each language (253–425 units). Line baselines at 45 and 96 units at a 50-unit em; wordmark offset 126 units from the mark |
| Colours | Squares `#1a6ee8` (`--color-brand-blue`); wordmark `#0f1627` (`--color-brand-ink`). The brand blue is slightly lighter than the UI accent `#0756d8` to match the references; it is used only in the logo |
| Generator | `packages/ui/brand/tools/build-logo.py` (Python 3, fontTools ≥ 4.67, brotli) rebuilds the two mark SVGs, three full lockups per language (`logo-full[.tag].svg`, `-mono`, `-inverse`) and `src/components/Brand/wordmark.ts` from the official Golos Text, Noto Sans Georgian and Noto Sans Armenian variable TTFs; see `packages/ui/brand/tools/README.md`. The React component and the SVG files share the generated geometry and cannot drift |
| Licence | Font outlines: SIL OFL 1.1 (Golos Text and Noto Sans, no Reserved Font Names). The three-squares mark and the Trustwork lettering are the owner's marks shipped with the engine; the Russian-language wordmark shown only in the Russian interface is an overlay and a mark of its owner (docs/oss/BRAND.md) |

## Files

| File | Use |
|---|---|
| `packages/ui/brand/logo-full.svg` | Full lockup, colour (394×112 viewBox) |
| `packages/ui/brand/logo-full-mono.svg` | Full lockup, single colour via `currentColor` (print, monochrome) |
| `packages/ui/brand/logo-full-inverse.svg` | Full lockup, white (dark bands, pre-footer) |
| `packages/ui/brand/logo-mark.svg` | Compact mark only, colour (100×100) |
| `packages/ui/brand/logo-mark-mono.svg` | Compact mark, `currentColor` |
| `<Brand />` component | Inline SVG with the same geometry; `variant="full" | "mark"`, `tone="color" | "mono" | "inverse"`, `height`, optional `href` (accessible name `brand.logoLabel` (e.g. "Trustwork — home")), `decorative` |

Every SVG carries `role="img"` and a `<title>` with the brand name (Trustwork for the engine lockup). When the component is a link, the SVG is hidden and the link carries the name.

## Usage rules

1. Minimum height: 24 px for the full lockup (wordmark stays legible at 12 px x-height), 16 px for the mark alone.
2. Clear space: at least one square's width (46/100 of the mark height) on every side.
3. Do not re-letter, re-space, recolour or rotate; do not add a skyscraper, gradients or effects (rejection ledger).
4. The mark alone is used only where the wordmark is present elsewhere on the screen (collapsed sidebar, favicon) or the context is obviously the product.
5. On dark backgrounds use `logo-full-inverse.svg` or `tone="inverse"`; on tinted light surfaces the colour version stays.
6. Favicon/app icons are derived from `logo-mark.svg`; they are not yet produced (WEB-001).

## Open points for the owner

- Confirm the wordmark weight (700) and the slightly lighter brand blue against the references; both are one-line changes in the generator and `tokens/index.ts`.
- Decide whether a horizontal single-line wordmark variant is needed (not in the references; not produced).
