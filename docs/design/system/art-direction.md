# Art direction (DS-002, phase 1)

Status: **implemented in `@trustwork/ui` on 2026-10-27 (DS-002 phase 1); visual approval by the owner pending (O09).** Phase 2 applies this system to `apps/web` (see the DS-002 handoff list).

## Why this pass exists

The owner judged the DS-001 build "a wireframe, not a design": flat bordered cards on a cool grey canvas, empty grey image boxes, no depth, no imagery, no motion, headings that did not lead the eye. The private design references show the opposite: a serious trade publication with photographs of materials and structures, bold headlines, restrained blue on light surfaces, dense but airy grids. This document records the direction that `@trustwork/ui` now implements and the rationale behind each choice.

| Before (DS-001 build) | After (DS-002 system) |
|---|---|
| Cool grey canvas `#f5f7fb`, white cards with 1 px `#dce3ed` borders | Warm paper canvas `#f6f5f2`; cards rest on elevation `e1` with a 4 % hairline ring, lift to `e2` on hover |
| 40 px display, 32 px H1, no tracking | 56 px display −0.02em, 40 px H1 −0.015em, 28 px H2, kicker 12 px uppercase +0.08em; PT Serif 19/1.65 for articles and pull quotes |
| Empty grey rectangles where images belong | 16 generated artworks (a deployment may add its own licensed photographs) + 16 generated SVG material artworks; `coverFor(kind, seed)` assigns them deterministically |
| No scrims; white text over blue gradients | Navy scrims proven AA against the real pixels (unit test on the worst case, Playwright test on the rendered photograph) |
| Flat magazine tile with a gradient | `MagazineCover`: 3:4 artwork, inverse brand mark, issue number, spine highlight, cover shadow, tilt on hover |
| Pre-footer and footer on white | Navy bands with light text and blue link hover; optional photograph backdrop |
| Static UI | Enter fade+rise 240 ms with 40 ms stagger, card lift + media scale 1.03 (300 ms), nav underline slide, dialog spring (200/150 ms), toast slide-in, button press 0.98, focus ring expansion — all off under `prefers-reduced-motion` |

## 1. Character: editorial × industrial

Serious trade publication meets modern workspace. Confident typography, real imagery of materials and structures, deep navy and brand blue on warm light surfaces, generous whitespace inside a dense grid. No startup-generic look, no gradients as decoration, no glassmorphism. The only gradients in the system are scrims (navy over photographs) and the glass-like highlights inside the generated artworks.

## 2. Colour

Brand blue stays untouched: `#1a6ee8` is the logo mark (blue-500), `#0756d8` the UI accent (blue-600). Around them, a tonal scale blue-50…900 where 900 is the navy `#0f1f3d` used for dark bands, primary buttons and scrims.

**Canvas decision: warm `#f6f5f2`, not `#f5f6f8`.** Photographs of concrete, timber, brick and clay carry warm greys; on a cool grey canvas they look washed and the page reads as a SaaS dashboard. Warm paper under navy ink is the trade-press register the references ask for, and the blue accent gains contrast against it (accent on canvas 6.4:1). The cost — blue tints look slightly cooler next to warm paper — is handled by the dedicated `surfaceTint` (blue-50) and `surfaceWarm` (`#ece9e3`) roles so each section chooses one deliberately.

Roles (all verified by `tests/unit/tokens.test.ts`): ink `#111827`, muted `#5b6472`, subtle `#616b7a` (≥ 4.5:1), hairline `#e5e8ee`, control boundary `#7a8494` (≥ 3:1). Status families keep text ≥ 4.5:1 on their tints and add a `strong` colour (≥ 3:1 on white) for rules and marks: amber for decisions, green for ok, red for danger, violet for the assistant. Navy band text: white and `#c3cce0` muted (9.8:1), link hover blue-300.

## 3. Typography

Golos Text for UI and public pages, PT Serif only for article bodies and pull quotes. Scale (desktop / mobile, unitless line-height, tracking):

| Style | Size | Line | Tracking | Weight |
|---|---|---|---|---|
| display | 56 / 36 | 1.05 | −0.02em | 700 |
| h1 | 40 / 30 | 1.1 | −0.015em | 700 |
| h2 | 28 / 24 | 1.2 | −0.01em | 700 |
| h3 | 22 / 20 | 1.25 | −0.005em | 600 |
| h4 | 18 | 1.35 | 0 | 600 |
| body-lg / body / small / caption | 18 / 16 / 14 / 12 | 1.6 / 1.6 / 1.5 / 1.4 | 0 | 400 |
| kicker | 12 | 1.3 | +0.08em, uppercase | 600 |
| serif / quote | 19 / 26 | 1.65 / 1.35 | 0 / −0.005em | 400 |

Primitives `Heading` (level separate from `styleAs`), `Text`, `Kicker`, `Meta`; CSS utilities `.trustwork-display … .trustwork-serif`. Tabular figures via `tabular` / `.trustwork-tabular`. Headings balance line breaks (`text-wrap: balance`).

## 4. Space, grid, shape, depth

4 px base; section rhythm 64 / 96 px desktop, 40 / 56 mobile (`--space-section`, `--space-section-lg`); 12-column 1200 px container with 24 px gutters (`.trustwork-container`, `.trustwork-grid`). Radii: 8 controls, 12 cards, 16 media, 999 pills. Hairlines instead of borders. Elevation `e1 0 1px 2px rgba(16,24,40,.06)`, `e2 0 4px 12px .08`, `e3 0 12px 32px .12`; cards rest on `e1` and lift to `e2` with `translateY(-2px)`; popovers `e2`, dialogs `e3`, magazine cover its own deeper shadow.

## 5. Imagery

The biggest gap of DS-001. Delivered in `packages/ui/media/`:

- **16 original SVG artworks** generated deterministically by `tools/build-artworks.py` (seeded; byte-identical on re-run): concrete grain, wood lamellae, glass grid, steel profiles, brick bond, mineral wool, facade cassettes, blueprint lines, isometric blocks, rebar mesh, corrugated sheet, terrazzo, wall layers, timber frame, glass at night, formwork. Brand palette plus warm neutrals, subtle `feTurbulence` grain. Two are dark (`blueprint-lines`, `glass-night`) for dark bands.
- **No photographs ship with the engine**; a deployment registers its own licensed set. Formerly 24 photographs of materials, facades, structures and sites (free commercial use, no attribution required; attribution recorded anyway). Downloaded from the public CDN, converted to WebP 1600 / 800 / 400 with a 24 px blur-up placeholder; source URL, author, licence, download date and SHA-256 per file in `packages/ui/media/PROVENANCE.md`. `person` entities never receive a photograph (artwork + initials avatar).
- `MediaFrame` (ratios 21/9, 16/10, 4/3, 1/1, 3/4, auto, fill; scrims bottom / left / full; blur-up; `alt` required) and `coverFor(kind, seed)`.

Rules: no stock people, no portraits, no synthetic customers, no brands. See [media.md](media.md).

## 6. Scrims and text over photographs

White text over a photograph needs ≥ 4.5:1 wherever the text sits. Two layers guarantee it: the frame scrim (`--scrim-bottom` / `-left` / `-full`, navy reaching alpha 0.78 in its text zone) and a **text-anchored** gradient on the overlay block itself (`--scrim-text`: 0 → 0.78 over `--scrim-fade`, then constant), so a tall headline on a short frame is still covered. The unit test composites alpha 0.78 navy over pure white (worst case: 8.3:1); `tests/e2e/contrast.spec.ts` samples the real rendered pixels of eight compositions and asserts the minimum. The first version of the pass failed this test at 1.76:1 on a medium hero — which is exactly why the anchored layer exists.

## 7. Motion

Tokens: `fast` 120, `base` 160, `slow` 200, `enter` 240, `hover` 300, `open` 200, `exit` 150, `stagger` 40 ms; easings standard / out / in / spring. Utilities `.trustwork-enter`, `.trustwork-enter-group` (DOM-order stagger up to 12) and `useEnter()`. Under `prefers-reduced-motion` every duration token is 0 ms and `base.css` neutralises remaining animations and transitions; the magazine tilt and media scale are also disabled explicitly.

## 8. Consistency rules

One card family (`StoryCard`, `EntityCard`, `DecisionCard`, `Card`: surface, radius 12, `e1`, hairline ring, one primary link stretched over the card), one chip family (`StatusChip` tones; topic chips in cards are plain text), one meta row (`Meta`: «Редакция · 21 окт 2026 · 6 мин», 14 px muted, middle dots hidden from assistive technology), link style ink with blue hover underline in prose and blue in UI, icons 20 px in UI / 16 px in meta, kicker always 12 px uppercase.

## 9. What was deliberately not done

Nothing from the rejection ledger was revived (no docked assistant, no switchers, no avatar name/chevron, no English product text, no new logo). No charts or stat tiles. No stock photographs of people. No dark theme (tokens stay role-based so one can be added). Visual acceptance remains the owner's decision; this document and the `Showcase/Compositions` stories are the material for it.
