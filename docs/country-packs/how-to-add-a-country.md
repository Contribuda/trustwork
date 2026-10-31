# How to add your country

This guide covers country pack v2 (CTRY-002). A v2 pack keeps every v1 field and adds verification levels, several time zones, subdivision kinds for federal countries, facts per subdivision and facets: identifiers, registers, licensing, standards, procurement, tax and e-invoicing, electronic signatures, payments, calendar and holidays, units, scripts, privacy, content law, national sanctions lists and agent-law defaults. v1 files (without `schemaVersion`) stay valid and are upgraded losslessly when loaded. Background: [Country specifics](../engine/country-specifics.md).

A country pack tells the engine everything that differs between markets: languages, currency, the company registration identifier, legal entity types, regions, address order, legal templates and data-residency rules. The UI, demo data and contracts read the active pack; nothing country-specific is hard-coded (ADR-009).

## 0. Your country already works

Every country that is not a restricted place can be selected today with a generic profile (currency, calling code, time zone and names from `packages/country-packs/countries/countries.json`; no regions, a free-form registration number, English as the suggested language). A pack replaces that profile with real registration formats, regions, legal entity types, legal notes and a native dictionary.

## The happy path needs no code (CFG-001)

A deployment adds a country without changing or rebuilding the engine ([Deployment configuration](configuration.md)):

1. Write the pack (sections 1 to 2a below) and save it as `<dataDir>/country-packs/<code>.json` in the deployment's data directory (`TRUSTWORK_DATA_DIR`).
2. Add the dictionaries of any new language as `<dataDir>/locales/<tag>/` and `<dataDir>/ui-locales/<tag>.json` (section 3), and optionally demo-content overrides as `<dataDir>/fixtures/i18n/<tag>.json` (section 4).
3. Optionally make it the starting country (`"countries": { "default": "<CODE>" }` in `trustwork.config.json`, or `TRUSTWORK_DEFAULT_COUNTRY`) and feature it (`countries.featured`).
4. Restart the server. It validates every file with the schemas below and refuses to start on any problem (a restricted place, a fact without sources, a malformed file), listing them all in one log line.

Sharing the pack with everyone (section 6) is the same file in `packages/country-packs/packs` plus one import line in `packages/country-packs/src/registry.ts`, because the repository's packs ship inside the browser bundle.

## 1. Check eligibility

Restricted places (`packages/country-packs/packs/restricted.json`, ADR-009 decision 2) cannot have a pack and are rejected by the validator. Everything else is welcome.

## 2. Create the pack

Copy `packages/country-packs/packs/us.json` (the model v2 pack) or `uz.json` (a small v1 pack) to `<code>.json` (lower-case ISO 3166-1 alpha-2) in your data directory's `country-packs/` (or in `packages/country-packs/packs/` for a contribution), set `"schemaVersion": 2` and fill every field. The schema is `CountryPackSchema` in `packages/country-packs/src/schema.ts`; the facets are in `src/facets.ts`:

| Field | What to put | Source required |
|---|---|---|
| `code`, `name` | ISO code and the country name in every locale you list | — |
| `enabled`, `status` | `enabled: true` once reviewed; `status` is `complete` (all dictionaries translated), `partial` (core UI translated, English fallback) or `draft` | — |
| `locales`, `defaultLocale` | BCP 47 tags (`uz-Latn`, `ka`, `hy`, `az-Latn`); English may be listed as a secondary locale | — |
| `currency`, `secondaryCurrencies` | ISO 4217 code, minor-unit digits, displayed digits, symbol | yes (central bank or ISO) |
| `formats` | The representative IANA time zone, phone calling code and length, postal-code pattern | yes |
| `timeZones` (v2) | Every IANA time zone used in the country; must include `formats.timeZone` | yes (pack `sources`) |
| `registrationIdentifier` | The primary company identifier: `kind` as `<CODE>-<NAME>` (e.g. `UZ-STIR`), regex `pattern`, an `example` that matches it, the issuing authority, a free-text `verification` note and (v2) `verificationLevel`. Further kinds go into the `identifiers` facet | yes |
| `legalEntityTypes` | Codes and localized names of the entity forms companies register under | yes |
| `regions` | ISO 3166-2 codes with localized names and `kind` (`city`, `region`, `republic`, `autonomous-republic`, `rayon`, `municipality`, `state`, `district`, `territory`, `province`); v2 adds an optional `parent` (a county inside a state), the region's own `timeZones` (a subset of the pack's) and `facets` that hold only there | yes |
| `address` | Order of address lines (`street`, `street2` for a unit or suite, `city`, `region`, `postalCode`) and whether the city comes first | — |
| `legalTemplates` | Template keys under `docs/legal/templates` (`terms`, `privacy`, `sanctions-and-export-controls`) | — |
| `dataResidency` | Whether personal data must stay in the country, with a note, sources and (v2) `verificationLevel` | yes |
| `verificationLevel` (v2) | Level of the pack-wide facts cited in `sources` (formats, currency, entity types, regions) | — |
| `facets` (v2) | Country-level facts, see below | yes, per fact |
| `sources` | Every page you relied on: URL, what it confirms, access date, an optional free-text note | yes |

Facts must cite primary sources (the registry, the statistics office, the central bank, the law). Where only a secondary source exists, say so with the verification level so an operator knows what still needs confirmation.

### Verification levels

Every fact states one of four levels, and the validator refuses a fact without one:

| Level | Meaning |
|---|---|
| `official` | Checked against the primary source: the law, the register, the authority's own page |
| `secondary` | Taken from reputable secondary sources; official confirmation still to do |
| `candidate` | A lead worth checking (for example a portal named by one source); not yet a fact |
| `pending` | Recorded but not yet checked by a maintainer |

Be conservative: a level is never higher than what you checked. v1 facts upgraded automatically become `secondary` when their note says so, otherwise `pending`, never `official`. Agent-law defaults stay below `official` until counsel review (`counselReview: "done"`).

## 2a. Add facts (facets)

`facets` (on the pack, and on any region) is an object of lists, one list per facet. Every fact in every list has the same envelope:

```json
{ "id": "state-sales-tax", "sources": [{ "url": "https://...", "what": "What this page confirms", "accessed": "2026-10-30" }], "verification": "secondary", "verificationNote": "optional free text", "effectiveFrom": "2025-01-01" }
```

- `id` is lower-case letters, digits and hyphens, unique within its scope (the country, or one region).
- A region fact with the same `id` as a country fact (or as a fact of an enclosing region) replaces it for that region; it must be the same facet and kind, and it cites its own sources. This is how a state overrides a national default, and how a member pack will override a shared layer (CTRY-EU).
- Text shown to people (`name`, `summary`, `label`) is localized and needs at least `en`.
- Rates are percentages as decimal strings (`"6.25"`, never `6.25`), between 0 and 100. Amounts are money objects in integer minor units (`{ "minorUnits": "10000000", "currency": "USD" }`).
- `adapter` names an adapter that exists in engine code, as `{ "capability": "<provider capability>", "id": "<adapter id>" }` from `ENGINE_ADAPTERS` in `src/adapters.ts`; the validator refuses any other. An adapter that does not exist yet goes into `candidateAdapters` as a plain name. Facts never call anything: they describe the world, and the hub decides what to switch on.
- Nothing in a facet can name, enable or override a restricted place; the list in `packs/restricted.json` is authoritative.

| Facet | Kinds of fact (`type` where there is more than one) | Notes |
|---|---|---|
| `identifiers` | Identifier kinds besides the primary one: `kind`, `role` (`registration`, `tax`, `vat`, `register`, `licence`, `procurement`, `statistical`, `other`), `label`, `pattern`, `example`, `issuer`, optional `appliesTo`, `checkDigit`, `register` (a register fact id) | National kinds are `<CC>-<NAME>`; a region's kinds are `<CC>-<SUB>-<NAME>` (for example a state contractor licence). Kinds are unique across the pack |
| `registers` | `name`, `url`, `query` (`manual`, `open_data`, `api`), `dataLicence`, `covers` (identifier kinds) | — |
| `licensing` | `activity` (authority, `required`, `register`, `identifierKind`, `categories`), `profession` (certifying body), `insurance` (`mandatory`) | — |
| `standards` | Code `system`, standards `body`, `publications`, `textLicence`, `adopts` | — |
| `procurement` | `portal` (`level`: national, federal, state, regional, local; `openData`), `threshold` (money) | — |
| `tax` | `rate` (`taxKind`: vat, gst, sales, use, excise, withholding, other; `standardRate` or `null`; `reducedRates`; `localRates`: none or additive; `registrationThreshold`; `calculation`: rate or adapter), `e-invoicing` (`system`, `mandatory`, `scope`: B2B, B2G, B2C; `signatureRequired`) | `calculation: "adapter"` needs `adapter` or `candidateAdapters`; the engine never hard-codes a tax computation |
| `eSignature` | `kind` (signature, identity, both), `strength` (simple, advanced, qualified), `legalBasis` | — |
| `payments` | `scheme` (`rails`: card, credit-transfer, instant-credit-transfer, direct-debit, wallet, cash, other), `currency-control` | No sanctioned bank or Russian payment rail, ever |
| `calendar` | `working-week`, `fiscal-year`, `holiday` (`rule`: `fixed` month and day, `nth-weekday` with `nth` 1 to 4 or -1 for the last, or published `dates`; `observed`: none, nearest-weekday, next-weekday, sunday-to-monday; `holiday`: public, federal, state, bank, observance; `nonWorking`) | Movable holidays are published per year with sources. `holidaysInYear(pack, year, region)` computes dates and observed dates |
| `units` | `system` (metric, imperial, us-customary, mixed; `common` catalogue units), `local-name` (a local name for a catalogue unit) | Unit codes come from the catalogue in `packages/contracts/src/common/units.ts` (metric and inch-pound units with exact conversion factors); unknown codes are refused |
| `scripts` | `language`, ISO 15924 `scripts`, `direction`, `transliteration` | — |
| `privacy` | `law` (`authority`, `consent`, `subjectRequestDays`, `breachNotificationHours`, `minorsAge`, `appliesWhen`), `retention`, `data-residency` (regions only; the country rule stays in `dataResidency`) | — |
| `contentLaw` | `topic` (media registration, defamation, right of reply, reviews, advertising, copyright, takedown, consumer protection, distance selling, other), `summary` | — |
| `sanctions` | National lists a hub must apply: `name`, `authority`, `url`, `updateCadence`, optional `adapter` | Restricted places are not a facet and cannot be changed by a pack |
| `agentLaw` | Defaults for agent disclosure, liability, consent, record keeping and per-action limits, with `counselReview` | Unverified until counsel review |

A federal country puts national facts on the pack and per-state facts on each region: sales tax, privacy laws, contractor licensing boards, state holidays. Engine code reads them with `factsFor(pack, facet, regionCode)`, `identifierKinds(pack, regionCode)` and `packTimeZones(pack, regionCode)`; it never branches on a country code. `tests/country-packs/v2/federal-fixture.ts` is a complete synthetic example (not real facts); `packs/us.json` is the real, sourced model (every state, the District of Columbia and the territories, with California in depth), and `tests/country-packs/us` shows the tests a pack of that size should carry.

## 3. Add the dictionaries

- `packages/ui/locales/<tag>.json`: the design-system dictionary; copy `en.json` and translate every key (plural forms follow CLDR for your language).
- `apps/web/locales/<tag>/`: the application dictionary, one file per namespace ([Namespaces](../engine/localization.md#namespaces)); copy `apps/web/locales/en/` and keep every file. A `complete` pack translates every key; a `partial` pack translates at least the namespaces `core`, `demo` and `public` and the status enums, and leaves the keys it has not translated out of the other files (they fall back to English).
- In a deployment, put them in the data directory instead (`<dataDir>/locales/<tag>/`, `<dataDir>/ui-locales/<tag>.json`); a file there replaces the built-in file of the same name.
- No registration in code: the web server discovers both dictionaries from their files, and the language picker names the language through `Intl.DisplayNames`. A browser receives only the active language and only the namespaces its route uses. Formats need no registration either: the `Intl` tag is derived from the language and the visitor's country. See [Adding a language](../engine/localization.md#adding-a-language).
- If your script is not covered by Golos Text (Latin, Cyrillic), add an OFL font subset with `unicode-range` as done for Georgian and Armenian (`packages/ui/fonts/PROVENANCE.md`, `apps/web/components/RootDocument.tsx`) and regenerate the wordmark with `packages/ui/brand/tools/build-logo.py` if the deployment brand is localized.

## 4. Localize the demo content (optional)

Demo fixtures are Russian base content with per-locale overrides in `apps/web/fixtures/i18n/<tag>.json` or a deployment's `<dataDir>/fixtures/i18n/<tag>.json` (`{ "<file>": { "json/pointer/path": "text" } }`), discovered by file name. Resolution is per string: the locale's own override, then the English layer, then the base text. English must cover every base string, so a reader outside the Russian locale never sees Russian demo content (ADR-009 owner decision 10). `tests/web/fixtures.test.ts` checks that every pointer exists and parses, that the English layer is complete and that every other engine language overrides every English string, so no reader gets an English fallback either; `tests/web/locale-leak.spec.ts` renders every public page in each non-Russian locale and fails on any Cyrillic text.

## 5. Validate

```sh
node --import tsx scripts/validate-country-packs.ts            # all packs
node --import tsx scripts/validate-country-packs.ts packs/xx.json
npm test                                                         # pack, locale and fixture tests
```

For a deployment's data directory, starting the server is the check: `apps/web/instrumentation.ts` validates the configuration and every pack file with the same validator and stops with a list of problems (`tests/config/restart.test.ts` shows the cases).

The validator (`packProblems` in `packages/country-packs/src/validate.ts`, also used by the script and the start-up check) lists every problem at once. It rejects restricted places as a pack, region or parent; identifier examples that do not match their pattern and duplicate identifier kinds; duplicate or foreign region codes and broken parent chains; invalid IANA time zones; facts without sources or verification level; rates that are not decimal strings between 0 and 100; adapters that do not exist in the engine; unknown unit codes; v2 fields in a file without `"schemaVersion": 2`; and a `complete` pack without dictionaries.

## 6. Open a pull request

To share a pack with every deployment, add it to `packages/country-packs/packs/<code>.json` and its import to `BUILT_IN_PACKS` in `packages/country-packs/src/registry.ts`. Use the "Add or update a country pack" issue template first, then a PR with the pack, dictionaries, tests and screenshots of the home page and a company page in the pack's default language (desktop 1440 px and phone 390 px). Country-pack maintainers (GOVERNANCE.md) review facts; the integrator reviews the engine changes.
