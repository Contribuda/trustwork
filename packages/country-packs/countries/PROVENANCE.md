# Country dataset provenance

`countries.json` lists every ISO 3166-1 alpha-2 country and territory that is not a restricted place (ADR-009 decision 2) so that a visitor can choose any country, with any engine language, independently (owner decision 2026-10-29). Countries with a contributed pack carry `pack: true`; every other country gets a generic profile from `genericPack()` until a pack is contributed (`docs/country-packs/how-to-add-a-country.md`).

| Item | Value |
|---|---|
| Source | https://github.com/mledoze/countries, file `countries.json`, read 2026-10-29 |
| Licence | Open Data Commons Open Database License 1.0 (`LICENSE-ODbL.txt`); attribution required, kept here and in `NOTICE` |
| Fields used | `cca2`, `name.common`, `translations.rus.common`, `currencies` (sorted codes; the first is the display currency), `region`, `subregion`, `independent`, `unMember`, `idd` (calling code), `timezones` |
| Dropped | Restricted places (RU, CU, IR, KP); regions of Ukraine under sanctions are ISO 3166-2 and never countries |
| Build | `packages/country-packs/countries/build.py` regenerates the file from a downloaded copy of the source |
| Known gaps | Four territories have no currency in the source (AQ, BV, FM, HM): the generic profile falls back to USD; names for languages other than en/ru come from `Intl.DisplayNames` at runtime |
