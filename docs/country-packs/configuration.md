# Deployment configuration

Work package CFG-001 (requirement R36, LOC-F13 in [Country packs and localization](../engine/modules/country-packs-and-localization.md)). Status: **Live** for the runtime configuration described here (file, environment, data directory, start-up check); the per-hub versioning with second-person activation is **Proposed** (HUB-001) and the setup wizard is **Proposed** (INST-001, HUBC).

One installation of the engine is configured as data: which countries and languages it offers, which country and language a visitor starts with, which brand overlay it shows and where extra country packs, dictionaries and demo-content translations live. Everything is read when the server starts. Changing it needs a restart, never a rebuild and never a change to TypeScript, so one container image serves any number of deployments.

The engine itself has no default country ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 11) and no country-specific code: `tests/config/engine-defaults.test.ts` fails on a `DEFAULT_COUNTRY` constant, a country code compared with a literal or a country that falls back to a named one.

## Where the configuration comes from

| Source | What it sets | Notes |
|---|---|---|
| Environment variables | The values operators most often set per container (table below) | Override the file |
| Configuration file `trustwork.config.json` | Everything | Named by `TRUSTWORK_CONFIG`, or found in the data directory |
| Data directory | Country packs, dictionaries, demo-content overrides, brand overlays | Named by `TRUSTWORK_DATA_DIR` or the file's `dataDir` |
| Nothing at all | No default country, every country and language offered, English, the default brand overlay | A neutral start: visitors choose their country |

### Environment variables

| Variable | Meaning | Example |
|---|---|---|
| `TRUSTWORK_CONFIG` | Path of the configuration file (relative to the working directory) | `/srv/hub/trustwork.config.json` |
| `TRUSTWORK_DATA_DIR` | Path of the data directory; its `trustwork.config.json` is used when `TRUSTWORK_CONFIG` is unset | `/srv/hub/data` |
| `TRUSTWORK_DEFAULT_COUNTRY` | Country of a visitor who has not chosen one (ISO 3166-1 alpha-2), or `none` | `US` |
| `TRUSTWORK_BRAND` | Brand overlay id, or `none` for Trustwork in every language | `none` |
| `TRUSTWORK_SITE_URL` | Public origin and path for absolute URLs (see [Runtime and build time](#runtime-and-build-time)) | `https://build.example.org` |

The hosted preview and the United States reference hub set only `TRUSTWORK_DEFAULT_COUNTRY=US` (ADR 012 decision 31): English, the United States for visitors who have not chosen, every other country and language one click away.

## The configuration file

```json
{
  "schemaVersion": 1,
  "revision": { "number": 4, "note": "Spanish added for the United States" },
  "countries": {
    "default": "US",
    "offered": "all",
    "featured": ["US", "MX", "CA"]
  },
  "languages": {
    "default": "en",
    "enabled": "all",
    "byCountry": { "MX": "es" }
  },
  "brand": { "overlay": null },
  "site": { "url": "https://build.example.org" },
  "dataDir": "./data"
}
```

A city hub in Nairobi that offers only East African countries in English would write `"countries": { "default": "KE", "offered": ["KE", "TZ", "UG", "RW"] }` and `"languages": { "enabled": ["en"] }`; it needs no country pack to start, because every country without one gets the generic profile.

| Field | Default | Meaning |
|---|---|---|
| `schemaVersion` | required, `1` | Format version; a future format gets a new number and an upgrade note |
| `revision` | none | The operator's own counter and note for this version of the file; logged at start |
| `countries.default` | `null` | Country of a visitor who has not chosen one; `null` means none: the first-visit window asks and preselects nothing |
| `countries.offered` | `"all"` | `"all"` (every country that is not a restricted place) or a list; only these can be chosen, by the selector, a cookie or `?country=` |
| `countries.featured` | every enabled pack | Countries shown first in the selector, in this order; each needs a country pack |
| `languages.default` | `"en"` | Language of a visitor whose browser asks for no offered language and who has not chosen a country (ADR 012 decision 27) |
| `languages.enabled` | `"all"` | `"all"` (every language with a dictionary) or a list; only these can be chosen, by the selector, a cookie or `?lang=` |
| `languages.byCountry` | `{}` | A country's starting language, overriding the pack's `defaultLocale` |
| `brand.overlay` | the application default | Brand overlay id, or `null` for Trustwork in every language |
| `site.url` | none | Public origin for absolute URLs (see [Runtime and build time](#runtime-and-build-time)) |
| `dataDir` | none | Data directory, relative to the file |

The schema is `DeploymentConfigSchema` in `packages/config/src/schema.ts`; unknown keys are refused, so a typo never passes silently.

## The data directory

```text
<dataDir>/
  trustwork.config.json            the configuration file (when TRUSTWORK_CONFIG names none)
  country-packs/<code>.json        country packs: a new country, or a replacement for a built-in pack
  locales/<tag>/<namespace>.json   application dictionaries: a new language, or files replacing built-in ones
  ui-locales/<tag>.json            design-system dictionaries
  fixtures/i18n/<tag>.json         demo-content overrides for a language
  brands/<id>.json                 brand overlays
```

Every part is optional. The files have exactly the formats of their counterparts in the repository (`packages/country-packs/packs`, `apps/web/locales`, `packages/ui/locales`, `apps/web/fixtures/i18n`), and the same validators check them. A brand overlay file is `{ "wordmarks": { "<tag>": { "line1": [...], "line2": [...], "width1": 0, "width2": 0, "viewBoxWidth": 0 } }, "messages": { "<tag>": { "brand": { "name": "..." } } } }`; the wordmark outlines come from `packages/ui/brand/tools/build-logo.py` ([Brand](../oss/BRAND.md)).

### Adding a country without changing code

1. Write the pack as described in [How to add your country](how-to-add-a-country.md) and save it as `<dataDir>/country-packs/<code>.json` (lower-case code).
2. Optionally add the languages it suggests (next section) and list it in `countries.featured`.
3. Restart the server. The country appears in the selector, with its regions, identifiers, currency and facts.

### Adding a language without changing code

1. Copy `apps/web/locales/en/` to `<dataDir>/locales/<tag>/` and translate it (keep every file; untranslated keys fall back to English).
2. Optionally copy `packages/ui/locales/en.json` to `<dataDir>/ui-locales/<tag>.json` and the demo-content overrides to `<dataDir>/fixtures/i18n/<tag>.json`.
3. Restart the server. With `languages.enabled: "all"` the language is offered at once; with a list, add the tag to it.

`tests/config/restart.test.ts` does exactly this with a synthetic pack and a language: before the files exist neither is offered; after a restart both are, with the dictionary, the design-system dictionary and the demo content in use.

## What is checked at start

`apps/web/instrumentation.ts` runs before the server answers its first request. It loads the configuration and refuses to start, printing one JSON log line with every problem (`"level":"fatal"`) and exiting with status 1, when:

- the file is missing, is not JSON, has an unknown key or a value of the wrong shape;
- a country in `countries.default`, `countries.offered`, `countries.featured` or `languages.byCountry` (or `TRUSTWORK_DEFAULT_COUNTRY`) is a **restricted place** or no country at all; the default or a featured country is not offered; a featured country has no pack;
- a pack in the data directory is a **restricted place**, lists a restricted region or parent, does not validate (sources, verification levels, identifiers, time zones, facets), is not valid JSON or is not named `<code>.json`;
- the default language, an enabled language or a per-country language has no dictionary;
- the brand overlay id names no overlay, or an overlay file does not validate;
- `TRUSTWORK_SITE_URL` is not an http or https URL; the data directory does not exist.

A valid start logs `deployment configuration loaded` with the file, data directory, revision, default country, data-directory packs and offered languages. The restricted-places list itself (`packages/country-packs/packs/restricted.json`) is part of the engine and cannot be changed by configuration.

## Runtime and build time

| Setting | When it is read | Notes |
|---|---|---|
| Countries, languages, packs, dictionaries, demo-content overrides | Start | Data and configuration |
| Brand overlay | Start | `brand.overlay` or `TRUSTWORK_BRAND`; when neither is set the build-time `NEXT_PUBLIC_TRUSTWORK_BRAND` still applies, then the default `stroyreputation-ru` (Russian interface only) |
| Site URL | Start (configuration); build (page metadata, for now) | `site.url` or `TRUSTWORK_SITE_URL` is validated and available as `currentDeployment().site.url`; the root layout's `metadataBase` still reads the build-time `NEXT_PUBLIC_SITE_URL` until the layout (owned by WEB-005) switches to it, a one-line change |
| Base path | Build | Next compiles `basePath` into every route, asset URL and client bundle, so `NEXT_PUBLIC_BASE_PATH` stays a build argument (`apps/web/next.config.ts`, `apps/web/app/_lib/base-path.ts`). A deployment under another path needs its own build |

So one image built without a base path serves, for example:

```sh
docker run -e TRUSTWORK_DEFAULT_COUNTRY=US -e TRUSTWORK_BRAND=none trustwork-web
docker run -e TRUSTWORK_DATA_DIR=/data -v /srv/am-hub:/data trustwork-web   # its trustwork.config.json sets AM and its own overlay
```

`tests/config/restart.test.ts` checks that two starts with different settings serve different default countries and brands from the same code; `tests/config/two-deployments.test.ts` does the same against a production build when one is present (see the file header).

## No default country

With nothing configured, a visitor who has not chosen a country gets a neutral profile: no regions, no currency (ISO 4217 `XXX`), UTC, English, and the first-visit window with no country preselected; the header switcher says "Country" (`locale.country`) until one is chosen. Any country that is offered can then be chosen, and any offered language with it. A hub (once HUB-001 and the setup wizard exist) always has a country: the wizard requires one before a hub is created; that is the hub's territory, separate from the deployment's starting country for visitors.

## Versions per hub (for HUB-001)

The file is designed to be stored as immutable versions: every document is complete on its own, carries `schemaVersion`, and holds no secrets or personal data. HUB-001 is expected to keep each hub's versions in the database (proposed by one administrator, activated by a second, with the activation recorded in the audit log), write the active version where the loader reads it (or hand the parsed document to `resolveDeployment` in `@trustwork/config`), and restart or reload the server. `revision.number` is the operator's counter for that history and is logged at start; the engine does not interpret it.

## What still needs code

- A script that Golos Text does not cover needs a font subset first (INTL-006), and right-to-left languages need INTL-005.
- A new provider (registry lookup, payments, signatures) is an adapter with a fake in engine code; packs only name adapters that exist (`ENGINE_ADAPTERS`).
- Contributing a pack to the repository (rather than a deployment's data directory) adds the JSON file to `packages/country-packs/packs` and one import line to `packages/country-packs/src/registry.ts`, because the built-in packs ship inside the browser bundle. A data-directory pack reaches the browser with the page, only for visitors in that country.
- A language's name in the selector comes from `Intl.DisplayNames` unless `apps/web/components/locale/LocaleSwitcher.tsx` lists a preferred spelling (INTL-007 moves language metadata into data).
