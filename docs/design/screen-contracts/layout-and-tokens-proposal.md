# Layout and tokens proposal

Status: **proposed; all values provisional until DS-001 review and human visual acceptance (O09).** The current `packages/ui/tokens.css` (surface `#ffffff`, canvas `#f5f7fb`, text `#172033`, accent `#0756d8`, border `#dce3ed`, space unit `0.25rem`, radius `0.5rem`) is the starting point and is consistent with what the references show. Nothing below changes that file; DS-001 owns it.

## Breakpoints (provisional)

| Name | Range | Rationale |
|---|---|---|
| mobile | < 768 px | Single column; sheets instead of popovers; tables collapse |
| tablet | 768–1279 px | Sidebar collapsed by default; two columns where content allows; tables scroll in regions |
| desktop | ≥ 1280 px | Sidebar expanded; rails; comparison tables |
| wide | ≥ 1600 px | Content max-width caps; no new layouts |

Test widths from the accessibility doc: 320 px, 768, 1024, 1280, 1440; 200% text zoom at 1280 (≈ 640 px effective) must fall into the mobile layout cleanly.

## Grid and containers

- Public pages: 12-column fluid grid, max content width 1200 px, gutters 24 px desktop / 16 px mobile, column gap 24 px. Rails take 4 columns; main 8.
- Workspace: sidebar 264 px expanded / 72 px collapsed; content max 1360 px with 24 px padding; cards on a 12-column grid with 16 px gap.
- Reader: single column max 720 px text measure (≈ 65–75 characters at 18 px), figures up to 960 px.
- Auth/onboarding: centered column max 1200 px; form column 480 px.

## Spacing scale

Base unit 4 px (`--space-unit`). Scale: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96. Component internal padding uses 8/12/16; section spacing uses 32/48/64. Touch targets ≥ 40 px (24 px minimum only for inline secondary controls).

## Type scale (provisional)

| Token | Size / line-height | Use |
|---|---|---|
| display | 40/48 (mobile 32/40) | Public H1, onboarding H1 |
| h1 | 32/40 (mobile 28/36) | Page H1 |
| h2 | 24/32 | Section/card headings |
| h3 | 20/28 | Sub-headings, card titles |
| body-lg | 18/28 | Reader body |
| body | 16/24 | Default UI and public body |
| body-sm | 14/20 | Meta, table cells dense |
| caption | 12/16 | Labels, badges (never below 12 px) |

Weights: 400 regular, 500 medium (UI labels), 600–700 for headings. Letter-spacing neutral; Cyrillic needs no tracking tricks. Numbers in tables use tabular figures where the font supports `tnum`.

## Russian typography considerations and font candidates

Requirements: complete Cyrillic (including Ё, ё, №, «», — and currency signs), tabular figures, readable at 14–16 px, open licence, self-hostable (no third-party font CDN dependency for a Russian audience), variable font preferred for weight range with one file.

| Candidate | Cyrillic | Licence | Notes | Source |
|---|---|---|---|---|
| Inter (variable) | Yes, extended Cyrillic | SIL Open Font License 1.1 | Neutral UI sans; tabular figures; wide weight range; very common in product UIs (not distinctive) | https://rsms.me/inter/ and https://github.com/rsms/inter |
| Golos Text (variable, weight axis 400–900) | Yes, designed for Russian | SIL Open Font License 1.1 | By Paratype; made for Russian text and UI; good at small sizes; distinct from generic UI fonts | https://fonts.google.com/specimen/Golos+Text and https://github.com/googlefonts/golos-text |
| PT Sans / PT Serif | Yes, designed for Russian languages | SIL Open Font License 1.1 (also ParaType Free Font License) | Public project for languages of Russia; serif pairs well for magazine reader; static weights only | https://fonts.google.com/specimen/PT+Sans and https://company.paratype.com/pt-sans-pt-serif |
| Manrope (variable) | Yes | SIL OFL 1.1 | Geometric; good display; check Cyrillic italics (none) | https://fonts.google.com/specimen/Manrope |
| Onest (variable) | Yes, Russian-designed | SIL OFL 1.1 | Modern UI sans with Cyrillic focus | https://fonts.google.com/specimen/Onest |

Proposal: **Golos Text** for UI and public body (Russian-first, OFL, variable), with **PT Serif** as the optional magazine reader/PDF body serif, and a system-font fallback stack (`system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`). Inter remains the safe alternative if the human prefers neutrality. Licence files must be vendored in `packages/ui` with provenance (DS-001). URLs above are the official project pages as known at writing; DS-001 must verify licence text and version when vendoring (this task did not fetch them).

Typography rules: hyphenation `hyphens: auto` with `lang="ru"` for long words in narrow columns; Russian quotation marks «» and em dash — in copy; dates as `27 октября 2026`, short `27.10.2026`; numbers with non-breaking space thousands separator (`1 250 000 сум`), decimal comma; currency symbol after number; no English in product copy.

## Colour roles (provisional, not final hex)

| Role | Current/observed | Use |
|---|---|---|
| canvas | #f5f7fb | Page background, tinted panels |
| surface | #ffffff | Cards, inputs, sidebar |
| surface-tint | ~#eef3fb | Selected nav item, magazine band, chip selected background |
| text | #172033 | Primary text |
| text-muted | ~#5b6474 (must keep ≥ 4.5:1 on surface) | Meta text |
| border | #dce3ed | Dividers, input borders |
| accent | #0756d8 | Links, active states, primary chips, launcher |
| accent-strong | ~#1e2a44 (navy) | Primary buttons, pre-footer band |
| accent-contrast | #ffffff | Text on accent |
| focus | accent with 2 px ring + 2 px offset, or a dedicated high-contrast ring | Focus indicator |
| status-info / success / warning / danger | blue / green / amber / red families with text ≥ 4.5:1 on their tints | Lifecycle chips, alerts |
| record-sourced / claimed / verified | gray / blue / green families | StatusBadge (with text) |
| evidence-asserted / confirmed / disputed / superseded | gray / green / amber / muted | EvidenceLabel (with text) |

Contrast must be verified at implementation; the observed blue accent on white passes for text ≥ 14 px bold / 18 px regular and needs checking for small regular text. Colour is never the sole carrier.

## Elevation, radius, motion, z-index

- Radius: control 8 px (`--radius-control`), card 12 px, pill 999 px, launcher circle.
- Shadows: card none/hairline border; popover `0 4px 16px rgba(23,32,51,.12)`; overlay/panel `0 8px 32px rgba(23,32,51,.18)`.
- Motion: 120–200 ms ease-out for open/close; none under reduced motion.
- Z-index scale: content 0, sticky 10, assistant overlay 20, panel/drawer 30, dialog 40, toast 50. A citation drawer or file viewer therefore stacks above the assistant overlay when both are open. Mobile overlay (modal) uses dialog level.

## Density

One density. Tables use 44 px rows by default, 36 px compact only in administration with a user toggle.

## Dark mode

Out of scope for the first slice (not required by spec; light restrained design is the accepted direction). Tokens are named by role so a dark theme can be added later without component changes.

## Icons

One outline icon set at 1.5–2 px stroke, 20/24 px, with a licence compatible with vendoring (MIT/ISC). Brand mark and section illustrations are separate assets created by DS-001 with provenance. Candidates are evaluated in [technology recommendations](technology-recommendations.md).

## Imagery

Photography must be licensed or own; portraits only with consent. Until assets exist, use neutral illustration or no image; never the synthetic reference photos.
