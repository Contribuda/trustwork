# Countries and languages

Requirements R25, R26 (as amended by ADR 009) and R38. Status: country selection, six languages and localized demo content are **Live** in the web app.

## Any country, any language

A visitor chooses a country and, independently, a language. Countries with a contributed pack (Uzbekistan, Georgia, Armenia, Azerbaijan today) are offered first and bring regions, identifier formats, currency and legal facts with a suggested language. Every other country that is not a restricted place gets a generic profile from the ISO dataset (currency, calling code, time zone, names; no regions; free-form registration number) until someone contributes its pack.

The choice is stored in two cookies, `trustwork.country` and `trustwork.locale`, on the deployment's base path. It is set from the first-visit window, the header switcher, or `?country=UZ&lang=uz-Latn` on any address, so links can carry a country and a language.

## Languages today

| Tag | Language | Notes |
|---|---|---|
| `en` | English | Reference key set and engine fallback |
| `ru` | Russian | Optional secondary language; never a default |
| `uz-Latn` | Uzbek (Latin script) | Default for Uzbekistan |
| `ka` | Georgian | Georgian script; Noto Sans for the wordmark |
| `hy` | Armenian | Armenian script; Noto Sans for the wordmark |
| `az-Latn` | Azerbaijani (Latin script) | Default for Azerbaijan |

All six dictionaries are complete. Translations other than English and Russian were produced by the integrator and await native-speaker review; this is one of the most valuable contributions you can make.

## How strings are resolved

- **Interface**: `apps/web/app/_lib/locales/<tag>.json` and `packages/ui/locales/<tag>.json`; English is the reference; tests fail on missing keys and on placeholder words.
- **Demo content**: base fixtures plus `apps/web/fixtures/i18n/<tag>.json` overrides addressed by JSON pointer; resolution per string is the locale, then English, then base. Tests require English to cover every base string and every other language to cover every English override.
- **Real content**: publications have an original language and linked translations ([Publishing](publishing.md#multilingual-publishing-proposed)).
- **Formats**: dates, times, months, weekdays, time-zone names, numbers, currencies and units come from `Intl`.
- **Brand**: Trustwork in every language; only the Russian interface shows «Строй Репутация» (ADR 010 decision 14). The three-squares mark is shared.

Right-to-left scripts are not supported yet.

## Adding a language

1. Copy `en.json` in both dictionary folders to `<tag>.json` and translate every value. Keep ICU plural forms correct for your language.
2. Add demo content overrides in `apps/web/fixtures/i18n/<tag>.json` (optional but recommended).
3. Add the tag to the relevant country pack's `locales`, or to a new pack.
4. Add the language name to the switcher and, if you want a localized wordmark, the lettering to the brand generator.
5. Run `npm run check`; the locale tests list anything missing.

## Adding a country

Follow [How to add a country](../country-packs/how-to-add-a-country.md) for pack v1, then the facets in [Country specifics](country-specifics.md).
