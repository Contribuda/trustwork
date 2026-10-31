# Media provenance

The engine ships 16 SVG artworks generated in-repo by `tools/build-artworks.py` (deterministic, no third-party rights, licensed with the engine). It ships **no photographs**: the third-party photo set used by the reference deployment until 2026-10-29 was removed (its licence forbids compiling photographs into a competing service and three portraits showed real people on synthetic profiles). A deployment registers its own licensed photographs with `registerPhotos()` from `@trustwork/ui/media`; the engine falls back to artworks everywhere (`artworkFor(seed)`).

| Id | Tone | Kinds |
|---|---|---|
| `concrete-grain` | light | material, concrete, texture |
| `wood-lamellae` | light | material, wood, texture |
| `glass-grid` | dark | facade, glass, company |
| `steel-profile` | light | material, steel, structure |
| `brick-bond` | light | material, brick, texture |
| `mineral-wool` | light | material, insulation, supply |
| `facade-cassettes` | light | facade, project, company |
| `blueprint-lines` | dark | drawing, document, article, news |
| `iso-blocks` | light | project, supply, article |
| `rebar-mesh` | light | material, steel, site |
| `corrugated-sheet` | light | material, steel, facade |
| `terrazzo` | light | material, texture, article |
| `wall-layers` | light | structure, insulation, article |
| `timber-frame` | light | structure, wood, project, site |
| `glass-night` | dark | facade, glass, news |
| `formwork` | light | site, concrete, material |
