import { z } from 'zod';

/**
 * The deployment configuration file (CFG-001), `trustwork.config.json`: what one installation of the engine offers
 * and starts with. It is data, read once at start; changing it needs a restart, never a rebuild or a code change.
 *
 * The format is versioned (`schemaVersion`) and every document is complete on its own, so HUB-001 can later store it
 * per hub as immutable versions (proposed by one person, activated by a second) and hand the active version to the
 * same loader. `revision` is the operator's own counter for that history; the engine only displays it.
 *
 * Nothing here can name, offer or default to a restricted place: the loader refuses such a file and the engine does
 * not start. See docs/country-packs/configuration.md.
 */
export const DEPLOYMENT_CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILE_NAME = 'trustwork.config.json';

/** ISO 3166-1 alpha-2, upper case. */
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'expected an ISO 3166-1 alpha-2 code in upper case, for example "US"');

/** A canonical BCP 47 tag as used for dictionary directories: `en`, `es`, `uz-Latn`, `zh-Hans`. */
export function isCanonicalLanguageTag(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag)[0] === tag;
  } catch {
    return false;
  }
}
export const LanguageTagSchema = z.string().min(2).max(35).refine(isCanonicalLanguageTag, 'expected a canonical BCP 47 language tag, for example "en", "es" or "uz-Latn"');

/** Brand overlay identifier, the same shape as the hub contract's `brandOverlay`. */
export const BrandIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'expected a brand overlay id: lower-case letters, digits and hyphens');

export const DeploymentConfigSchema = z.strictObject({
  /** Optional pointer to a JSON Schema for editors; ignored by the engine. */
  $schema: z.string().optional(),
  schemaVersion: z.literal(DEPLOYMENT_CONFIG_SCHEMA_VERSION),
  revision: z.strictObject({ number: z.int().positive(), note: z.string().max(500).optional() }).optional(),
  countries: z
    .strictObject({
      /** The country of a visitor who has not chosen one; `null` or absent: none (the visitor chooses, ADR 012 decision 11). */
      default: CountryCodeSchema.nullable().optional(),
      /** Countries a visitor may choose: `"all"` (every country that is not a restricted place, the default) or a list. */
      offered: z.union([z.literal('all'), z.array(CountryCodeSchema).min(1)]).optional(),
      /** Countries with a pack shown first in the selector, in this order; absent: every enabled pack. */
      featured: z.array(CountryCodeSchema).optional(),
    })
    .optional(),
  languages: z
    .strictObject({
      /** Language of a visitor whose browser asks for nothing offered and who has not chosen a country; absent: `en` (ADR 012 decision 27). */
      default: LanguageTagSchema.optional(),
      /** Languages offered: `"all"` (every language with a dictionary, the default) or a list. */
      enabled: z.union([z.literal('all'), z.array(LanguageTagSchema).min(1)]).optional(),
      /** Default language per country, overriding the pack's `defaultLocale`. */
      byCountry: z.record(CountryCodeSchema, LanguageTagSchema).optional(),
    })
    .optional(),
  brand: z
    .strictObject({
      /** Brand overlay id (`apps/web/brand` or `<dataDir>/brands/<id>.json`); `null`: Trustwork in every language. */
      overlay: BrandIdSchema.nullable(),
    })
    .optional(),
  site: z
    .strictObject({
      /** Public origin and path used for absolute links and metadata, for example `https://build.example.org`. */
      url: z.url({ protocol: /^https?$/ }).optional(),
    })
    .optional(),
  /** Data directory with country packs, dictionaries, demo-content overrides and brand overlays, relative to this file. */
  dataDir: z.string().min(1).optional(),
});
export type DeploymentConfigFile = z.infer<typeof DeploymentConfigSchema>;

/** The configuration after defaults and environment overrides; what the engine reads. */
export type Deployment = {
  readonly schemaVersion: typeof DEPLOYMENT_CONFIG_SCHEMA_VERSION;
  readonly revision: number | null;
  readonly countries: {
    readonly default: string | null;
    readonly offered: 'all' | readonly string[];
    readonly featured: readonly string[] | null;
  };
  readonly languages: {
    readonly default: string;
    readonly enabled: 'all' | readonly string[];
    readonly byCountry: Readonly<Record<string, string>>;
  };
  /** `undefined`: not configured, the application's own default applies; `null`: no overlay. */
  readonly brand: { readonly overlay: string | null } | undefined;
  readonly site: { readonly url: string | null };
  /** As written (file: relative to the file; environment: relative to the working directory); the server loader resolves it. */
  readonly dataDir: string | null;
  /** Where each value came from, for the start-up log and error messages. */
  readonly source: { readonly file: string | null };
};
