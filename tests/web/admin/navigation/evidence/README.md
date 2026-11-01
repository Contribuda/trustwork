# HUBC-020 browser evidence

All records shown are synthetic fixtures. No live approval, activation, delivery, participant search or private directory is demonstrated.

The package suite captures inbox, device preferences and command palette in all seven locales at 1280, 768 and 375 pixels. Russian inbox captures are full-page; the other captures show the viewport. The three geometry JSON files record all 21 locale/width combinations, zero axe violations for the tested states, no document horizontal overflow, and navigation trigger target sizes. Modal bodies and palette results intentionally scroll vertically.

`manifest.json` records the production build source commit, build identifier, runtime tree hashes, browser test source commit, image dimensions and SHA-256 hashes. A later evidence-only commit does not alter that runtime. Screenshots are evidence, not golden snapshots; the test does not compare pixels.

Reproduce with the existing dependencies, one process at a time:

```sh
NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR=.next-hubc020 npm run build -w @trustwork/web
./node_modules/.bin/playwright test --config tests/web/admin/navigation/playwright.config.ts navigation.spec.ts
```

The config uses one Chromium worker, demo port 43471 and fail-closed non-demo port 43472. It never uses the shared preview on 9092. The build may append its generated type paths to `apps/web/tsconfig.json`; those build-generated additions are not part of this change.

Inspection covered Russian desktop and phone inbox/preferences/palette, plus English, Spanish, Uzbek, Georgian, Armenian and Azerbaijani phone captures. Wrapping, field-list differences, modal scrolling, focus outlines, local fonts and target geometry were inspected. Existing English synthetic hub/person names and technical identifiers are fixture data. All new interface text has localized dictionaries. Native-speaker review, manual assistive-technology testing and owner visual acceptance have not been performed.

The old staff route is preserved as Designed; no owning client detail implementation exists. Notification settings and predefined saved views are device-only previews. Synthetic decisions remain per browser session; the existing immutable fixture decision history is not a live/shared ledger. ADM-005 is not integrated because its owning implementation is absent. The original shell and approval route remain intact.
