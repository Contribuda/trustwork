# Media: covers and artworks

Everything lives in `packages/ui/media/` and is consumed through `@trustwork/ui/media` (`coverFor`, `artworkFor`, `MediaFrame`, `listArtworks`, `artwork(id)`; `registerPhotos` / `listPhotos` / `photo(id)` for a deployment's own photographs).

## Inventory

| Set | Count | Files | Licence |
|---|---|---|---|
| Artworks | 16 | `media/artworks/<id>.svg` + `media/artworks/manifest.json` | Original, generated in-repo (`tools/build-artworks.py`); licensed with the engine |
| Photographs | 0 | — | The engine ships none (owner decision 2026-10-29): the earlier third-party photo set is not open-licensed for a competing service and three portraits showed real people on synthetic profiles. A deployment registers its own licensed photographs with `registerPhotos()`; until then `artworkFor(seed)` gives every former photograph slot a deterministic artwork. |

People never receive photographs: avatars are initials unless a deployment registers consented portraits.

## Regenerating

```sh
python3 packages/ui/media/tools/build-artworks.py        # deterministic SVGs + artworks/manifest.json
```

## Serving the files

`coverFor()` returns URLs under `getMediaBase()` (default `/media`). Storybook serves `packages/ui/media` at `/media` (`staticDirs`). An application must expose the directory at that path or call `configureMedia({ base })` once at startup:

- Next.js (`apps/web`, phase 2): copy or symlink `packages/ui/media/{photos,artworks}` into `public/media` in a `prebuild` step, or serve from a CDN and call `configureMedia({ base: 'https://cdn…/media' })`.
- Photos carry `width`/`height`, so `MediaFrame` reserves space before load; `srcSet` lists the three widths and `sizes` defaults to `(max-width: 767px) 100vw, 50vw` (pass a tighter `sizes` for thumbnails).

## Choosing a cover

```ts
import { coverFor, MediaFrame } from '@trustwork/ui';

const cover = coverFor('company', company.id);            // deterministic for this entity
<MediaFrame media={cover} ratio="16/10" scrim="bottom">…</MediaFrame>
```

`kind` is one of `article | news | company | person | project | material | site | facade | structure | drawing | supply | magazine | any`; each maps to tags in the manifests (`kinds`). `person` resolves to artworks only. `prefer: 'photo' | 'artwork'` forces a pool; by default 60 % of seeds get a photograph. The same `kind + seed` always yields the same media (FNV-1a hash), so lists stay stable across renders and deployments; `tests/unit/media.test.ts` guards this.

Pin a specific image with `photo('cranes-sky')` or `artwork('blueprint-lines')` when the editorial choice matters (lead stories, the magazine issue).

## Text over images

Use `MediaFrame scrim="bottom"` (cards, heroes), `"left"` (wide 21:9 lead) or `"full"` (bands). Content passed as children sits in an overlay block that carries the text-anchored gradient; keep text white (`tone="inverse"`) and never place interactive controls inside the overlay except the single stretched link of a card/hero. The contrast is verified by `tests/e2e/contrast.spec.ts` against the rendered photograph. See [art-direction.md](art-direction.md) §6.

## Alt text

`alt` is required by the types. Artworks carry their title from `artworks/manifest.json`; a deployment's photographs bring their own `alt`. Pass `alt: ''` only for a purely decorative image inside a control that already has a name (for example the auth panel, which is `aria-hidden`).
