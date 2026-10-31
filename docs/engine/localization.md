# Countries and languages

Requirements R25, R26 (as amended by ADR 009), R38 and R51. Status: country selection, six languages and localized demo content are **Live** in the web app; the languages and country packs marked *planned* below are work packages, not features.

## Any country, any language

Trustwork is international by default ([ADR 012 decision 30](../adr/012-integrator-decisions-2026-10-31.md#owner-decision-of-2026-10-31-international-by-default)): no region is privileged, and the United States reference hub is the main worked example. A visitor chooses a country and, independently, a language. Countries with a contributed pack are offered first and bring regions, identifier formats, currency and legal facts with a suggested language. Every other country that is not a restricted place gets a generic profile from the ISO dataset (currency, calling code, time zone, names; no regions; free-form registration number) until someone contributes its pack.

The choice is stored in two cookies, `trustwork.country` and `trustwork.locale`, on the deployment's base path. It is set from the first-visit window, the header switcher, or query parameters on any address (for example `?country=GE&lang=ka`), so links can carry a country and a language.

## Languages and countries

Live means it works in the web app today; planned means a work package exists in the [roadmap](roadmap.md#languages-and-country-packs) and nothing is implemented yet. Run `node scripts/work-packages.mjs show <ID>` for any package.

### Languages

Review status is one of *reference* (English, the source of every key), *machine draft*, *community reviewed* or *native reviewed*. It is recorded per locale and shown in the language picker once INTL-007 is done; until then this table is the record. A status is raised only when a named reviewer actually reviewed the text.

| Tag | Language | Status | Review status | Package | Notes |
|---|---|---|---|---|---|
| `en` | English | Live | Reference | INTL-002 | Reference key set and engine fallback; formats per country (`en-US`, `en-GB`, `en-IN` …) |
| `ru` | Russian | Live | Original product language; no separate review recorded | INTL-002 | Optional secondary language, never a default; the only interface that shows «Строй Репутация» |
| `uz-Latn` | Uzbek (Latin script) | Live | Machine draft | INTL-UZ | Default for Uzbekistan |
| `ka` | Georgian | Live | Machine draft | INTL-GE | Georgian script; Noto Sans for the wordmark |
| `hy` | Armenian | Live | Machine draft | INTL-AM | Armenian script; Noto Sans for the wordmark |
| `az-Latn` | Azerbaijani (Latin script) | Live | Machine draft | INTL-AZ | Default for Azerbaijan |
| `es` | Spanish | Next | — | LANG-ES | Formats per country (`es-US`, `es-MX`, `es-ES` …) |
| `pt` | Portuguese | Planned | — | LANG-PT | Formats per country (`pt-BR`, `pt-PT`) |
| `fr` | French | Planned | — | LANG-FR | Formats per country (`fr-FR`, `fr-CA` …) |
| `de` | German | Planned | — | LANG-DE | Formats per country (`de-DE`, `de-AT`, `de-CH`) |
| `it` | Italian | Planned | — | LANG-IT | |
| `pl` | Polish | Planned | — | LANG-PL | Four plural categories |
| `uk` | Ukrainian | Planned | — | LANG-UK | Translated from English, never derived from Russian |
| `tr` | Turkish | Planned | — | LANG-TR | Dotted and dotless *i* casing |
| `ar` | Arabic | Planned | — | LANG-AR | Right to left (INTL-005) |
| `zh-Hans` | Chinese (Simplified) | Planned | — | LANG-ZH | CJK typography (INTL-006) |
| `hi` | Hindi | Planned | — | LANG-HI | Devanagari typography (INTL-006) |
| `ja` | Japanese | Planned | — | LANG-JA | CJK typography (INTL-006) |
| — | Any language you bring | Welcome | — | — | See [Adding a language](#adding-a-language) |

All six live dictionaries are complete. Translations other than English and Russian were produced by the integrator and await native-speaker review; this is one of the most valuable contributions you can make. Shared foundations: right-to-left support (INTL-005), CJK and Devanagari typography (INTL-006) and review-status metadata (INTL-007).

### Country packs

Every fact in a pack cites a source and states how far it is verified ([Country specifics](country-specifics.md)). Without a pack, any country that is not a restricted place still works with a generic profile.

| Code | Country | Status | Package | Notes |
|---|---|---|---|---|
| `UZ` | Uzbekistan | Live (pack v1) | INTL-UZ; v2 facets CTRY-003 | Existing example |
| `GE` | Georgia | Live (pack v1) | INTL-GE; v2 facets CTRY-003 | Existing example |
| `AM` | Armenia | Live (pack v1) | INTL-AM; v2 facets CTRY-003 | Existing example |
| `AZ` | Azerbaijan | Live (pack v1) | INTL-AZ; v2 facets CTRY-003 | Existing example |
| `US` | United States | Next | INTL-US | The reference hub; the model for every other pack |
| `CA` | Canada | Planned | CTRY-CA | English and French |
| `MX` | Mexico | Planned | CTRY-MX | |
| `BR` | Brazil | Planned | CTRY-BR | |
| `GB` | United Kingdom | Planned | CTRY-GB | |
| `EU` | European Union layer | Planned | CTRY-EU | Shared facts (GDPR, eIDAS, VAT and ViDA, Eurocodes, procurement directives, SEPA) inherited by member packs |
| `DE` | Germany | Planned | CTRY-DE | Uses the EU layer |
| `FR` | France | Planned | CTRY-FR | Uses the EU layer |
| `ES` | Spain | Planned | CTRY-ES | Uses the EU layer |
| `IT` | Italy | Planned | CTRY-IT | Uses the EU layer |
| `PL` | Poland | Planned | CTRY-PL | Uses the EU layer |
| `UA` | Ukraine | Planned | CTRY-UA | Government-controlled territory only; UA-43, UA-40, UA-14 and UA-09 stay excluded |
| `TR` | Türkiye | Planned | CTRY-TR | |
| `AE` | United Arab Emirates | Planned | CTRY-AE | Arabic and English |
| `IN` | India | Planned | CTRY-IN | Hindi and English |
| `AU` | Australia | Planned | CTRY-AU | |
| — | Any other country | Generic profile | — | Contribute a pack: [How to add a country](../country-packs/how-to-add-a-country.md) |

Russia is not a market and is never offered; Russian remains available as a language.

## How strings are resolved

- **Interface**: `apps/web/app/_lib/locales/<tag>.json` and `packages/ui/locales/<tag>.json`; English is the reference; tests fail on missing keys and on placeholder words.
- **Demo content**: base fixtures plus `apps/web/fixtures/i18n/<tag>.json` overrides addressed by JSON pointer; resolution per string is the locale, then English, then base. Tests require English to cover every base string and every other language to cover every English override.
- **Real content**: publications have an original language and linked translations ([Publishing](publishing.md#multilingual-publishing-proposed)).
- **Formats**: dates, times, months, weekdays, time-zone names, numbers, currencies and units come from `Intl`.
- **Brand**: Trustwork in every language; only the Russian interface shows «Строй Репутация» (ADR 010 decision 14). The three-squares mark is shared.

Right-to-left scripts are not supported yet (planned: INTL-005), and Chinese, Japanese and Devanagari typography needs INTL-006 before LANG-ZH, LANG-JA and LANG-HI.

## Adding a language

1. Copy `en.json` in both dictionary folders to `<tag>.json` and translate every value. Keep ICU plural forms correct for your language.
2. Add demo content overrides in `apps/web/fixtures/i18n/<tag>.json` (optional but recommended).
3. Add the tag to the relevant country pack's `locales`, or to a new pack.
4. Add the language name to the switcher and, if you want a localized wordmark, the lettering to the brand generator.
5. Run `npm run check`; the locale tests list anything missing.
6. Label the translation honestly: a machine-drafted or AI-assisted translation is a *machine draft* until a person reviews it; add the language to the table above with its review status.

Once INTL-004 is done, dictionaries move to `apps/web/locales/<tag>/<namespace>.json`, and a new language follows the shape of the LANG packages (LANG-ES, LANG-PT …).

## Adding a country

Follow [How to add a country](../country-packs/how-to-add-a-country.md) for pack v1, then the facets in [Country specifics](country-specifics.md).
