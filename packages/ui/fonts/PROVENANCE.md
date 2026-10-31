# Font provenance

Both families are licensed under the SIL Open Font License 1.1; the licence texts are vendored next to the files (`OFL-GolosText.txt`, `OFL-PTSerif.txt`). Downloaded by task DS-001 on 2026-10-27 from the official repositories; checksums are SHA-256.

## Golos Text (UI and public body)

| Item | Value |
|---|---|
| Upstream | https://github.com/googlefonts/golos-text (Paratype; Google Fonts onboarding repo) |
| Commit | `cf2e27222937d97c2d858fff0499bcc667a64e9d` (branch `main` at download time) |
| Source file | `fonts/variable/GolosText[wght].ttf`, SHA-256 `17bb58fb69aec2dfb047a2ebf52534023e9b688c97a6b7ac795b0a72912c2063`, upstream version 2.004 (Google Fonts PR #5753) |
| Vendored file | `GolosText[wght].woff2`, SHA-256 `e7f0a2bde7e9a397274ca1d6b64b7615c2dd6e4bc33c605445fa5005dc3a759f` |
| Conversion | Format-only container conversion TTF -> WOFF2 with fontTools 4.67.0 + brotli 1.2.1 (`TTFont(src); font.flavor = 'woff2'; font.save(...)`); no glyph, metric, hinting or name-table changes. The upstream repository publishes only static-instance WOFF2 files and the variable TTF, hence the local conversion. |
| Axis | `wght` 400–900 (one file covers regular, medium, semibold, bold) |
| Licence | `OFL-GolosText.txt` (copyright 2019 The Golos Text Project Authors; no Reserved Font Name) |

## PT Serif (magazine reader body)

| Item | Value |
|---|---|
| Upstream | https://github.com/google/fonts, directory `ofl/ptserif` (ParaType) |
| Commit | `f0f048639276f7abf542bc3956cc3672ef114e17` (last commit touching `ofl/ptserif` at download time) |
| Vendored files (unmodified) | `PT_Serif-Web-Regular.ttf` `a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a`; `PT_Serif-Web-Italic.ttf` `f57e95ff9dc85691a3b2e193f2028db36f6663939a46c0fc4f286d618b80b7ce`; `PT_Serif-Web-Bold.ttf` `038ba7336bd7ea14f12ad155bed51a4345cac5153275d521dec3ba04021c526e`; `PT_Serif-Web-BoldItalic.ttf` `f003788ba08981eb0988b3557a6f224a53dab49c20e283e8b74d5af3c466f8be` |
| Why TTF, not WOFF2 | PT Serif is a static family (no variable version exists) and its OFL declares Reserved Font Names («PT Sans», «PT Serif», «ParaType»). The official files are vendored byte-for-byte so no "Modified Version" question arises. A WOFF2 conversion (~55% smaller) can be added later once the licence owner's position on format-only conversion is recorded; the reader font is loaded only on magazine routes. |
| Licence | `OFL-PTSerif.txt` (copyright 2010 ParaType Ltd, with Reserved Font Names) |

## Subsetting

No subsetting was applied; both files contain full Cyrillic and Latin coverage including «», —, №, the ruble sign and Ё/ё. A Cyrillic+Latin subset is a later optimisation and would be a Modified Version under the OFL for PT Serif.

## Noto Sans Georgian and Noto Sans Armenian (script fallbacks, INTL-GE / INTL-AM)

Golos Text covers Latin and Cyrillic only. The Georgian (Mkhedruli, Mtavruli) and Armenian scripts are served from one script-subset file each, declared with a `unicode-range` so browsers download them only when a page contains those scripts. Downloaded on 2026-10-29 from the Google Fonts CDN build of the official Noto families (variable weight 400–700); checksums are SHA-256.

| Item | Value |
|---|---|
| Upstream | https://github.com/notofonts (Noto Project), distributed through https://github.com/google/fonts `ofl/notosansgeorgian` and `ofl/notosansarmenian` |
| Noto Sans Georgian | CDN v49, subset `georgian`: `https://fonts.gstatic.com/s/notosansgeorgian/v49/PlIVFke5O6RzLfvNNVSitxkr76PRHBC4Ytyq-Gof7PUs4S7zcGyUkcrrR3Zgdw.woff2` → `NotoSansGeorgian-georgian.woff2`, SHA-256 `a15bf839bf4d54141976adfc69cd85d6b9c1faef0ecc8a8a2872c3e014be386f`; unicode-range `U+0589, U+10A0-10FF, U+1C90-1CBA, U+1CBD-1CBF, U+205A, U+2D00-2D2F, U+2E31` |
| Noto Sans Armenian | CDN v47, subset `armenian`: `https://fonts.gstatic.com/s/notosansarmenian/v47/ZgN7jOZKPa7CHqq0h37c7ReDUubm2SEdFXp7ig73qtTY5idbxZhVoCmoeG70Lw.woff2` → `NotoSansArmenian-armenian.woff2`, SHA-256 `d0aafd35191621d182e68e6872c6932dfe21af25526763e90184fb2b6894cbc5`; unicode-range `U+0308, U+0530-058F, U+2010, U+2024, U+25CC, U+FB13-FB17` |
| Modification | None locally; the files are the subset builds Google Fonts serves (a Modified Version under the OFL produced by Google Fonts, redistributed unchanged). Noto declares no Reserved Font Name. |
| Licence | `OFL-NotoSansGeorgian.txt`, `OFL-NotoSansArmenian.txt` (copyright 2022 The Noto Project Authors) |
