/**
 * One server start for the demo-dataset tests (DEMO-US): a fresh Node process that loads the web application's fixture
 * store exactly as the server does (same configuration files and environment variables) and prints, as one JSON line,
 * which dataset a first visitor gets and a few strings of it. Run with the working directory `apps/web` and
 * `node --import tsx`; the repository root is the first argument. See tests/config/probe.mjs for the same pattern.
 */
const root = process.argv[2];
const web = `${root}/apps/web`;
const { activeDataset, fixturesFor, fixtureLocales } = await import(`${web}/app/_lib/data/fixtures.ts`);
const language = process.env.PROBE_LANGUAGE ?? 'en';
const dataset = activeDataset();
const data = fixturesFor(language, dataset);
console.log(
  JSON.stringify({
    dataset,
    languages: fixtureLocales(dataset),
    firstCompany: data.companies[0]?.company.name ?? null,
    firstTagline: data.companies[0]?.profile?.tagline ?? null,
    regions: [...new Set(data.companies.map((c) => c.region))],
  }),
);
