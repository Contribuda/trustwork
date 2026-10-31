# Logo generator

`build-logo.py` rebuilds `packages/ui/brand/logo-*.svg` (one full lockup per language, `logo-full.<tag>.svg`; the Russian reference keeps the unsuffixed name) and `packages/ui/src/components/Brand/wordmark.ts` from the official Golos Text, Noto Sans Georgian and Noto Sans Armenian variable TTFs (not vendored; download them from the sources recorded in [`../../fonts/PROVENANCE.md`](../../fonts/PROVENANCE.md)).

```sh
cd packages/ui
python3 -m venv /tmp/logo-venv && /tmp/logo-venv/bin/pip install 'fonttools>=4.67' brotli
/tmp/logo-venv/bin/python brand/tools/build-logo.py /path/to/GolosText[wght].ttf /path/to/NotoSansGeorgian[wdth,wght].ttf /path/to/NotoSansArmenian[wdth,wght].ttf brand src/components/Brand/wordmark.ts engine
/tmp/logo-venv/bin/python brand/tools/build-logo.py <same fonts> ../../apps/web/brand/logo ../../apps/web/brand/wordmarks.ts deployment ../../apps/web/brand/lettering.json
```

Geometry constants (square size, gap, radius, baselines, mark scale and offset) live at the top of the script and are documented in [`docs/design/system/logo.md`](../../../../docs/design/system/logo.md). Changing them is a brand decision that needs owner approval.
