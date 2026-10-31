/**
 * One "server start" for the configuration tests (CFG-001): a fresh Node process that loads the web application's
 * configuration modules exactly as the server does (same files, same environment variables) and prints what a
 * visitor would get as one JSON line. Run with the working directory `apps/web` (as `next start apps/web` resolves
 * it) and `node --import tsx`; the repository root is the first argument. Spawning a new process per observation is
 * what makes these tests a restart: nothing is cached between two runs.
 */
const root = process.argv[2];
const web = `${root}/apps/web`;
const { currentDeployment } = await import(`${root}/packages/config/src/server.ts`);
const negotiation = await import(`${web}/app/_lib/locale-negotiation.ts`);
const localeData = await import(`${web}/app/_lib/locale-data.ts`);
const { resolveActive } = await import(`${web}/app/_lib/locale.ts`);
const { fixturesFor, FIXTURE_LOCALES } = await import(`${web}/app/_lib/data/fixtures.ts`);
const { uiDictionary } = await import(`${root}/packages/ui/src/i18n/index.ts`);
const { packs, getCountryPack } = await import(`${root}/packages/country-packs/src/index.ts`);

const deployment = currentDeployment();
const probeLanguage = process.env.PROBE_LANGUAGE ?? 'pt';
const probeCountry = process.env.PROBE_COUNTRY ?? 'XF';
const visitor = resolveActive(undefined, undefined, null);
const chooser = resolveActive(probeCountry, undefined, null);
const appLayer = localeData.appLayers(probeLanguage)[0] ?? {};
const country = negotiation.offeredCountryPack(probeCountry);

console.log(
  JSON.stringify({
    defaultCountry: deployment.countries.default,
    packs: packs().map((p) => p.code),
    offeredLanguages: negotiation.offeredLanguages(),
    languageOffered: negotiation.isOfferedLanguage(probeLanguage),
    countryOffered: country?.code ?? null,
    countryName: getCountryPack(probeCountry)?.name?.en ?? null,
    countryLanguage: country ? negotiation.defaultLanguageFor(country) : null,
    visitor: { country: visitor.country, locale: visitor.locale, chosen: visitor.chosen },
    chooser: { country: chooser.country, locale: chooser.locale, chosen: chooser.chosen },
    gateTitle: appLayer.locale?.gateTitle ?? null,
    uiDictionary: Boolean(uiDictionary(probeLanguage)),
    fixtureLanguages: [...FIXTURE_LOCALES],
    fixtureText: FIXTURE_LOCALES.includes(probeLanguage) ? fixturesFor(probeLanguage).people[0]?.experience ?? null : null,
    brandName: { en: localeData.brandLayers('en')[0]?.brand?.name ?? null, ru: localeData.brandLayers('ru')[0]?.brand?.name ?? null },
    russianWordmark: Boolean(localeData.brandWordmark('ru')),
  }),
);
