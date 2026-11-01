# Countries and languages

Normative requirements: [Country packs and localization](modules/country-packs-and-localization.md). Participants: [who uses what](participants/README.md).

Requirements R25, R26 (as amended by ADR 009), R38 and R51. Status: country selection, seven languages and localized demo content are **Live** in the web app; the languages and country packs marked *planned* below are work packages, not features.

## Any country, any language

Trustwork is international by default ([ADR 012 decision 30](../adr/012-integrator-decisions-2026-10-31.md#owner-decision-of-2026-10-31-international-by-default)): no region is privileged, and the United States reference hub is the main worked example. A visitor chooses a country and, independently, a language. Countries with a contributed pack are offered first and bring regions, identifier formats, currency and legal facts with a suggested language. Every other country that is not a restricted place gets a generic profile from the ISO dataset (currency, calling code, time zone, names; no regions; free-form registration number) until someone contributes its pack.

The engine has no default country ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 11): a deployment names one in its [configuration](../country-packs/configuration.md) (the reference hub uses the United States), or visitors start without one and the first-visit window asks. The countries and languages offered are deployment configuration too. The choice is stored in two cookies, `trustwork.country` and `trustwork.locale`, on the deployment's base path. It is set from the first-visit window, the header switcher, or query parameters on any address (for example `?country=GE&lang=ka`), so links can carry a country and a language.

## Public URLs (decided)

[ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 27 (owner, 2026-10-31). **English is the default language** of the reference hub and of the engine's public URLs. Status: **Live** (WEB-005). The unprefixed language is the deployment's `languages.default`; every other offered language is a prefix.

| Rule | Example |
|---|---|
| English pages have no language prefix | `/news/winter-concreting` |
| Every other language uses a prefix | `/es/news/winter-concreting`, `/ru/news/winter-concreting` |
| Every page lists its language versions as `hreflang` alternates and names one canonical URL | `<link rel="alternate" hreflang="es" href="…/es/news/…">` |
| The country is never part of a public URL | A hub defines its territory; a country selector never changes the address |
| The language cookie stays a preference | It redirects only from unprefixed entry pages, so a shared `/es/…` link always opens in Spanish |

How it works (WEB-005):

- Public pages live in `apps/web/app/(public)/[lang]/`. The proxy (`apps/web/proxy.ts`) maps an unprefixed address to the default language's segment and redirects `/en/…` permanently to the unprefixed address; the address rules are in `apps/web/app/_lib/public-paths.ts`.
- An *entry page* is an unprefixed public address that a visitor opens from outside the site: typed, bookmarked or followed from another site (`Sec-Fetch-Site: none` or `cross-site`), or requested by a client that sends no `Sec-Fetch-Site` at all (not a browser). Only then does the language preference redirect, to the same page under the preferred language's prefix (`307`, `Cache-Control: private, no-store`, `Vary: Cookie`). The preference is the `trustwork.locale` cookie, or the language of the country in `trustwork.country` when no language was chosen. Moving inside the site never redirects, so choosing the English version from a prefixed page sticks.
- Links, React Aria links, form actions and server redirects keep the language of the page being read (`localPath` and `localHref` in `apps/web/app/_lib/localize.ts`, `components/locale/LocalLink.tsx` in place of `next/link`).
- The language switcher and the first-visit window open the same page under the chosen language's prefix. The language of a public page is always its URL's; its country is the one the visitor chose (`trustwork.country`, which also selects the demo dataset, DEMO-US), else the deployment's default country, or the neutral profile.
- Every public page names its canonical URL and its `hreflang` alternates (`languageAlternates` in `apps/web/app/_lib/site.ts`), absolute on the deployment's `site.url` (`TRUSTWORK_SITE_URL`, [configuration](../country-packs/configuration.md)). Filtered lists are canonical to the unfiltered list and not indexed. With demo data no public page is indexed, so synthetic companies and people never appear as real.
- Private and transactional areas (workspace, sign-in, onboarding, event registration and tickets) are not localized by URL: they follow the cookies and are rendered per request.

## Languages and countries

Live means it works in the web app today; planned means a work package exists in the [roadmap](roadmap.md#languages-and-country-packs) and nothing is implemented yet. Run `node scripts/work-packages.mjs show <ID>` for any package.

### Languages

Review status is one of *reference* (English, the source of every key), *machine draft*, *community reviewed* or *native reviewed*. It is recorded per locale and shown in the language picker once INTL-007 is done; until then this table is the record. A status is raised only when a named reviewer actually reviewed the text.

| Tag | Language | Status | Review status | Package | Notes |
|---|---|---|---|---|---|
| `en` | English | Live | Reference | INTL-002 | Reference key set and engine fallback; formats per country (`en-US`, `en-GB`, `en-IN` …) |
| `ru` | Russian | Live | Original product language; no separate review recorded | INTL-002 | Optional secondary language, never a default; the only interface that shows the Russian-language name and wordmark |
| `uz-Latn` | Uzbek (Latin script) | Live | Machine draft | INTL-UZ | Default for Uzbekistan |
| `ka` | Georgian | Live | Machine draft | INTL-GE | Georgian script; Noto Sans for the wordmark |
| `hy` | Armenian | Live | Machine draft | INTL-AM | Armenian script; Noto Sans for the wordmark |
| `az-Latn` | Azerbaijani (Latin script) | Live | Machine draft | INTL-AZ | Default for Azerbaijan |
| `es` | Spanish | Live | Machine draft | LANG-ES | Neutral Latin American Spanish with US construction terms; formats per country (`es-US`, `es-MX`, `es-ES` …); native review requested on the LANG-ES pull request |
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
| `af` | Afrikaans | Planned | — | LANG-AF | Formats per country (`af-ZA`); after the Cape Town demo content (DEMO-ZA); proposed in the [market-opportunities note](../research/market-opportunities-2026-11.md) |
| `xh` | isiXhosa | Planned | — | LANG-XH | Formats per country (`xh-ZA`); after DEMO-ZA |
| `zu` | isiZulu | Planned | — | LANG-ZU | Formats per country (`zu-ZA`); after DEMO-ZA |
| `sw` | Swahili | Planned | — | LANG-SW | Kenya, Tanzania, Uganda, Rwanda ([launch playbooks](../launch/README.md)) |
| `fil` | Filipino | Planned | — | LANG-FIL | Philippines, next to English |
| `ha` | Hausa | Planned | — | LANG-HA | Nigeria (north) and West Africa |
| `yo` | Yoruba | Planned | — | LANG-YO | Nigeria (south-west); tone marks |
| `ig` | Igbo | Planned | — | LANG-IG | Nigeria (south-east) |
| `rw` | Kinyarwanda | Planned | — | LANG-RW | Rwanda, next to English |
| — | Any language you bring | Welcome | — | — | See [Adding a language](#adding-a-language) |

All seven live dictionaries are complete. Translations other than English and Russian were produced by the integrator or, for Spanish, by an AI agent (Claude Code, LANG-ES) and await native-speaker review; this is one of the most valuable contributions you can make. Shared foundations: right-to-left support (INTL-005), CJK and Devanagari typography (INTL-006) and review-status metadata (INTL-007).

### Country packs

Every fact in a pack cites a source and states how far it is verified ([Country specifics](country-specifics.md)). Without a pack, any country that is not a restricted place still works with a generic profile.

| Code | Country | Status | Package | Notes |
|---|---|---|---|---|
| `UZ` | Uzbekistan | Live (pack v2) | INTL-UZ; v2 facets CTRY-003 | Existing example |
| `GE` | Georgia | Live (pack v2) | INTL-GE; v2 facets CTRY-003 | Existing example |
| `AM` | Armenia | Live (pack v2) | INTL-AM; v2 facets CTRY-003 | Existing example |
| `AZ` | Azerbaijan | Live (pack v2) | INTL-AZ; v2 facets CTRY-003 | Existing example |
| `US` | United States | Live (pack v2, English) | INTL-US | The reference hub and the model v2 pack: every state, DC and the territories; California and San Diego County in depth; Spanish is offered (LANG-ES), English stays the default |
| `CA` | Canada | Planned | CTRY-CA | English and French |
| `MX` | Mexico | Planned | CTRY-MX | |
| `BR` | Brazil | Planned | CTRY-BR | |
| `GB` | United Kingdom | Planned | CTRY-GB | |
| `EU` | European Union layer | Live (layer data) | CTRY-EU | Shared facts (GDPR, eIDAS, VAT and ViDA, Eurocodes, Construction Products Regulation, procurement directives, SEPA, Late Payment, DSA, AI Act, Accessibility Act, EU sanctions list) inherited by member packs; no member pack yet |
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
| `ZA` | South Africa | Planned | CTRY-ZA; demo DEMO-ZA | English default; Afrikaans, isiXhosa and isiZulu planned; Cape Town is the candidate second reference hub in the [market-opportunities note](../research/market-opportunities-2026-11.md) (Proposed) |
| `PE` | Peru | Planned | CTRY-PE | Launch country 1 ([playbook](../launch/countries/pe.md)) |
| `PH` | Philippines | Planned | CTRY-PH | Launch country 2 ([playbook](../launch/countries/ph.md)); English and Filipino |
| `KE` | Kenya | Planned | CTRY-KE | Launch country 3 ([playbook](../launch/countries/ke.md)); English and Swahili |
| `GH` | Ghana | Planned | CTRY-GH | Launch country 4 ([playbook](../launch/countries/gh.md)) |
| `CO` | Colombia | Planned | CTRY-CO | Launch country 5 ([playbook](../launch/countries/co.md)) |
| `DO` | Dominican Republic | Planned | CTRY-DO | Launch country 6 ([playbook](../launch/countries/do.md)) |
| `NG` | Nigeria | Planned | CTRY-NG | Launch country 8 ([playbook](../launch/countries/ng.md)); English, Hausa, Yoruba, Igbo |
| `RW` | Rwanda | Planned | CTRY-RW | Launch country 10 ([playbook](../launch/countries/rw.md)); personal data stored in Rwanda unless authorised |
| — | Any other country | Generic profile | — | Contribute a pack: [How to add a country](../country-packs/how-to-add-a-country.md) |

Russia is not a market and is never offered; Russian remains available as a language.

## How strings are resolved

- **Interface**: the application dictionaries are `apps/web/locales/<tag>/<namespace>.json` (one directory per language, one file per feature namespace, see [Namespaces](#namespaces)); the design system's dictionary is `packages/ui/locales/<tag>.json`. English is the reference; tests fail on missing keys, missing namespace files and placeholder words.
- **Demo content**: two synthetic datasets chosen per request by the visitor's country, then the configured default country (`apps/web/fixtures/datasets.ts`, DEMO-US): the United States hub (English base files in `apps/web/fixtures/us`, overrides in `apps/web/fixtures/us/i18n/<tag>.json`) and the original example hub (Russian base files in `apps/web/fixtures`, overrides in `apps/web/fixtures/i18n/<tag>.json`). Overrides are addressed by JSON pointer; resolution per string is the locale, then English, then base. Tests require English to cover every base string of the example hub, every other language to cover every English override, and every engine language to cover every reader-facing string of the US hub (`tests/web/demo-us`).
- **Real content**: publications have an original language and linked translations ([Publishing](publishing.md#multilingual-publishing-proposed)).
- **Formats**: dates, times, months, weekdays, time-zone names, numbers, currencies and units come from `Intl`, with a tag derived from the language and the country: English with the United States gives `en-US` (month before day, `$1,234.50`), English with the United Kingdom `en-GB`, Spanish with the United States `es-US`, Uzbek with Uzbekistan `uz-Latn-UZ`. A pair `Intl` has no data for uses the language's own formats; for English that is international English (`en-001`, day before month). See `intlTagFor` in `packages/ui/src/i18n/index.ts`.
- **Plurals**: a counted word is one ICU message, `{count, plural, one {# project} other {# projects}}`; the category comes from `Intl.PluralRules` for the active language (English one/other, Russian one/few/many/other). Never write a plural helper or split a word into `…One`/`…Few`/`…Many` keys; `tests/web/i18n/plural-lint.test.ts` rejects both.
- **One language per request, only the namespaces a route uses**: the server resolves the request's message layers (brand overlay, every application namespace with the English keys it lacks, the design-system dictionary) for server components. Client components receive less: every HTML document (`apps/web/components/RootDocument.tsx`, rendered by the public, workspace, sign-in and onboarding layouts) hands over the brand overlay, the root namespaces and the design-system dictionary, and each route group's layout adds the namespaces its client components use (`apps/web/locales/client-namespaces.json`, checked by `tests/web/i18n/client-namespaces.test.ts`). During server rendering they live in a React context (`LocaleScope` in `packages/i18n-runtime`), on the server-component side in a per-request scope, and route handlers wrap themselves in `withRequestLocale` (private ones, from the cookies) or `withPublicLocale` (public feeds and calendar files, from the URL); no store is shared between requests (`tests/web/i18n/concurrent-render.test.ts`, `concurrent-locales.spec.ts`). Client bundles import no dictionary except the design system's English reference, and a page carries only its route group's namespaces (`locale-weight.spec.ts`).
- **Brand**: Trustwork in every language; only the Russian interface shows a Russian-language name and wordmark, defined in `apps/web/brand` (ADR 010 decision 14). The three-squares mark is shared.

Right-to-left scripts are not supported yet (planned: INTL-005), and Chinese, Japanese and Devanagari typography needs INTL-006 before LANG-ZH, LANG-JA and LANG-HI.

## Namespaces

Application strings are split by feature: `apps/web/locales/<tag>/<namespace>.json`, one directory per language, one file per namespace (ADR 012 decision 16). A namespace file holds whole top-level keys (`companies`, `companyPage` …); the key paths used in code (`t('companyPage.ask')`) do not mention the namespace.

| Namespace | Top-level keys |
|---|---|
| `core` | `error`, `locale`, `shell2`, `taxonomy`, `signals`, `role`, `unitLabel` |
| `demo` | `demo` |
| `auth` | `auth` |
| `public` | `publicPages`, `search`, `status`, `provenance`, `reputation`, `sr`, `detail` |
| `home` | `home` |
| `editorial` | `news`, `correction`, `articles` |
| `magazine` | `magazine`, `reader`, `archive` |
| `companies` | `companies`, `companyPage` |
| `people` | `people`, `personPage` |
| `projects` | `projects`, `projectStatus`, `updateType`, `milestone`, `projectPage` |
| `events` | `events` |
| `map` | `map` |
| `onboarding` | `onboarding2`, `onboarding3` |
| `workspace` | `overview`, `ws`, `me`, `company`, `projectsWs`, `notifications` |
| `settings` | `settings` |
| `procurement` | `procurement`, `rfqStatus` |
| `sales` | `sales`, `leadStatus`, `leadSource` |
| `publishing` | `publications`, `pubState` |
| `assistant` | `assistantPage`, `mandate`, `approval`, `runs` |

**The rule for features.** A feature adds `apps/web/locales/<tag>/<feature>.json` in every engine language, with new top-level keys of its own, and never edits another feature's file. Besides the dictionary files it adds one line to `apps/web/locales/types.ts` (the key types of `t()`) and, if its client components look strings up, its namespace to the route groups in `apps/web/locales/client-namespaces.json`; `npm test` names the exact groups when that list is stale. Shared vocabulary stays in `core` and changes through its own review.

**Checks.** `tests/web/locales.test.ts` lists the directories: every language must have every namespace file of `en/` (a missing file fails, even for a language that falls back to English for most keys: it then holds `{}` or only what is translated), a top-level key may live in one namespace only and in the same namespace in every language, and nothing but `<tag>.meta.json` (review status, INTL-007), `client-namespaces.json` and `types.ts` may sit next to the language directories. `tests/web/locale-leak.spec.ts` renders every public page in every language directory it finds. For a restructuring that must not change a word, `tests/web/i18n/page-text.spec.ts` records the text of every page in every language from one build and compares another build against it (opt-in; see the file header).

**Server and browser.** The server reads the files once per process (restart after adding a language or namespace). A deployment can add or replace dictionaries without touching the repository: `<dataDir>/locales/<tag>/<namespace>.json` ([Deployment configuration](../country-packs/configuration.md)). Server components resolve against every namespace; the browser receives only the namespaces of its route group, so a feature's strings weigh nothing on pages that do not use them.

## Adding a language

Adding a language is a data-only change: no TypeScript file changes, in the repository or in a deployment's data directory (CFG-001, `tests/config/restart.test.ts`). Use the BCP 47 tag with a script subtag where the language is written in more than one script (`uz-Latn`, `az-Latn`, `zh-Hans`) and no region (`es`, not `es-US`: formats come from the visitor's country). Spanish (LANG-ES) was added exactly this way and is the worked example: `apps/web/locales/es/`, `packages/ui/locales/es.json`, `apps/web/fixtures/i18n/es.json` and its checks in `tests/web/es/`.

1. **Application dictionary**: copy `apps/web/locales/en/` to `apps/web/locales/<tag>/` (for example `apps/web/locales/es/`) and translate every value of every namespace file. Keep every file, even one you have not translated yet: delete the keys you have not translated (they fall back to English key by key), leaving `{}` at worst. Keep ICU plural forms correct for your language (the categories `Intl.PluralRules` reports for it).
2. **Design-system dictionary**: copy `packages/ui/locales/en.json` to `packages/ui/locales/<tag>.json` and translate it. The web server registers any design-system dictionary it finds there.
3. **Offer the language**: nothing to do. Every language with a dictionary directory is offered in every country (deployment configuration `languages.enabled: "all"`, the default; a deployment that lists its languages adds the tag there, see [Deployment configuration](../country-packs/configuration.md)). Add the tag to `locales` in the country packs that should suggest it (`packages/country-packs/packs/<code>.json`, data; for Spanish the US pack) so it becomes that country's default language and is listed early. The language picker shows the language's own name from `Intl.DisplayNames` (`español`).
4. **Demo content** (optional but recommended): overrides in `apps/web/fixtures/i18n/<tag>.json`, discovered by file name.
5. **Review status**: once INTL-007 is done, add `apps/web/locales/<tag>.meta.json` next to the directory with the honest status (a machine-drafted or AI-assisted translation is a *machine draft* until a named person reviews it). Until then, add the language to the table above with its review status.
6. **Check**: `npm run check`; the locale tests list every missing namespace file, key or placeholder, and the leak and page-text browser suites pick the new directory up by themselves. Scripts that `Intl` and Golos Text do not cover need fonts first (INTL-006) and right-to-left languages need INTL-005.

## Adding a country

Follow [How to add a country](../country-packs/how-to-add-a-country.md) for pack v1, then the facets in [Country specifics](country-specifics.md).
