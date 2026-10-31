/**
 * Demo datasets (DEMO-US): which synthetic dataset a request reads. Pure data and rules, no file access, so the server
 * (apps/web/app/_lib/data/fixtures.ts), tests and tools share one definition.
 *
 * - `us`: the United States reference hub, set in San Diego County (ADR 012 decisions 28 and 31). Written in English in
 *   `fixtures/us/*.json`, localized by `fixtures/us/i18n/<tag>.json`.
 * - `example`: the original example hub (Uzbekistan; also shown for the Georgia, Armenia and Azerbaijan examples).
 *   Written in Russian in `fixtures/*.json`, localized by `fixtures/i18n/<tag>.json`.
 *
 * Both are synthetic: every record is invented, labelled synthetic in its file and shown under the demo strip.
 */
export const DATASETS = {
  example: { countries: ['UZ', 'GE', 'AM', 'AZ'], baseLanguage: 'ru', dir: '' },
  us: { countries: ['US'], baseLanguage: 'en', dir: 'us' },
} as const satisfies Record<string, { countries: readonly string[]; baseLanguage: string; dir: string }>;

export type DatasetId = keyof typeof DATASETS;
export const DATASET_IDS = Object.keys(DATASETS) as DatasetId[];

/** The dataset made for a country (ISO 3166-1 alpha-2, any case), or null. */
export function datasetForCountry(country: string | null | undefined): DatasetId | null {
  const code = country?.trim().toUpperCase();
  if (!code) return null;
  return DATASET_IDS.find((id) => (DATASETS[id].countries as readonly string[]).includes(code)) ?? null;
}

/**
 * The dataset of a request, chosen by configuration: the visitor's country when a dataset is made for it, otherwise the
 * deployment's default country (CFG-001: `TRUSTWORK_DEFAULT_COUNTRY` or `countries.default`) when a dataset is made for
 * that, otherwise `example`. The hosted preview configures `US`, so a first visit and any country without its own
 * dataset get the San Diego hub, while Uzbekistan, Georgia, Armenia and Azerbaijan keep the example hub.
 */
export function selectDataset(country: string | null | undefined, defaultCountry: string | null | undefined): DatasetId {
  return datasetForCountry(country) ?? datasetForCountry(defaultCountry) ?? 'example';
}
