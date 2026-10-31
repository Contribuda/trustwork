# How to add your country

This guide covers country pack v1. The proposed pack v2 adds facets (registers, licensing, standards, procurement, tax and e-invoicing, electronic signatures, payments, calendar, scripts, privacy and content law): see [Country specifics](../engine/country-specifics.md).

A country pack tells the engine everything that differs between markets: languages, currency, the company registration identifier, legal entity types, regions, address order, legal templates and data-residency rules. The UI, demo data and contracts read the active pack; nothing country-specific is hard-coded (ADR-009).

## 0. Your country already works

Every country that is not a restricted place can be selected today with a generic profile (currency, calling code, time zone and names from `packages/country-packs/countries/countries.json`; no regions, a free-form registration number, English as the suggested language). A pack replaces that profile with real registration formats, regions, legal entity types, legal notes and a native dictionary.

## 1. Check eligibility

Restricted places (`packages/country-packs/packs/restricted.json`, ADR-009 decision 2) cannot have a pack and are rejected by the validator. Everything else is welcome.

## 2. Create the pack

Copy `packages/country-packs/packs/uz.json` to `packs/<code>.json` (lower-case ISO 3166-1 alpha-2) and fill every field. The schema is `CountryPackSchema` in `packages/country-packs/src/index.ts`:

| Field | What to put | Source required |
|---|---|---|
| `code`, `name` | ISO code and the country name in every locale you list | — |
| `enabled`, `status` | `enabled: true` once reviewed; `status` is `complete` (all dictionaries translated), `partial` (core UI translated, English fallback) or `draft` | — |
| `locales`, `defaultLocale` | BCP 47 tags (`uz-Latn`, `ka`, `hy`, `az-Latn`); English may be listed as a secondary locale | — |
| `currency`, `secondaryCurrencies` | ISO 4217 code, minor-unit digits, displayed digits, symbol | yes (central bank or ISO) |
| `formats` | IANA time zone, phone calling code and length, postal-code pattern | yes |
| `registrationIdentifier` | `kind` as `<CODE>-<NAME>` (e.g. `UZ-STIR`), regex `pattern`, an `example` that matches it, the issuing authority and how a company proves it | yes |
| `legalEntityTypes` | Codes and localized names of the entity forms companies register under | yes |
| `regions` | ISO 3166-2 codes with localized names and `kind` | yes |
| `address` | Order of address lines and whether the city comes first | — |
| `legalTemplates` | Template keys under `docs/legal/templates` (`terms`, `privacy`, `sanctions-and-export-controls`) | — |
| `dataResidency` | Whether personal data must stay in the country, with a note and sources | yes |
| `sources` | Every page you relied on: URL, what it confirms, access date, verification status | yes |

Facts must cite primary sources (the registry, the statistics office, the central bank, the law). Where only a secondary source exists, say so in `verification` so an operator knows what still needs confirmation.

## 3. Add the dictionaries

- `packages/ui/locales/<tag>.json`: the design-system dictionary; copy `en.json` and translate every key (plural forms follow CLDR for your language).
- `apps/web/app/_lib/locales/<tag>.json`: the application dictionary. A `complete` pack translates every key of `en.json`; a `partial` pack translates at least the sections `locale`, `error`, `demo`, `search`, `shell2`, `publicPages`, `taxonomy`, `signals` and the status enums, and the rest falls back to English.
- Register the tag in `packages/ui/src/i18n/index.ts` (`dictionaries`), `apps/web/app/_lib/locale-data.ts` (`DICTIONARIES`), `INTL_TAGS` (BCP 47 tag with region for `Intl`) and `LOCALE_NAMES` in `apps/web/components/locale/LocaleSwitcher.tsx`.
- If your script is not covered by Golos Text (Latin, Cyrillic), add an OFL font subset with `unicode-range` as done for Georgian and Armenian (`packages/ui/fonts/PROVENANCE.md`, `apps/web/app/layout.tsx`) and regenerate the wordmark with `packages/ui/brand/tools/build-logo.py` if the deployment brand is localized.

## 4. Localize the demo content (optional)

Demo fixtures are Russian base content with per-locale overrides in `apps/web/fixtures/i18n/<tag>.json` (`{ "<file>": { "json/pointer/path": "text" } }`). Resolution is per string: the locale's own override, then the English layer, then the base text. English must cover every base string, so a reader outside the Russian locale never sees Russian demo content (ADR-009 owner decision 10). `tests/web/fixtures.test.ts` checks that every pointer exists and parses, that the English layer is complete and that every other engine language overrides every English string, so no reader gets an English fallback either; `tests/web/locale-leak.spec.ts` renders every public page in each non-Russian locale and fails on any Cyrillic text.

## 5. Validate

```sh
node --import tsx scripts/validate-country-packs.ts            # all packs
node --import tsx scripts/validate-country-packs.ts packs/xx.json
npm test                                                         # pack, locale and fixture tests
```

The validator rejects restricted places, identifier examples that do not match their pattern, duplicate or foreign region codes, missing sources and a `complete` pack without dictionaries.

## 6. Open a pull request

Use the "Add or update a country pack" issue template first, then a PR with the pack, dictionaries, tests and screenshots of the home page and a company page in the pack's default language (desktop 1440 px and phone 390 px). Country-pack maintainers (GOVERNANCE.md) review facts; the integrator reviews the engine changes.
