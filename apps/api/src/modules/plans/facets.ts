import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LicensingFacetsSchema, type LicensingFacets, type PackLicensingFact } from './deps.js';

/**
 * Where licensing answers come from (PLAN-001 step 4): the taxonomy's jurisdiction facets for trades
 * (data/taxonomy/jurisdictions/<PACK>.json, CC0) and the country pack's licensing facts for the country and the region
 * (packages/country-packs/packs/<pack>.json). Both are data, not code; a hub without a file for its pack gets
 * "unknown" everywhere. Nothing here calls the network.
 */
export interface LicensingFacetSource {
  load(regionCode: string | null): LicensingFacets;
}

const TaxonomyJurisdictionFile = z.object({
  pack: z.string(),
  trades: z.record(z.string(), z.object({ licensing: z.enum(['varies_by_state', 'unknown']), verification: z.enum(['unverified', 'secondary', 'verified']) }).loose()).optional(),
}).loose();
const LocalizedText = z.record(z.string(), z.string());
const LicensingFact = z.object({
  type: z.string(),
  id: z.string(),
  name: LocalizedText,
  authority: z.object({ name: LocalizedText, url: z.string().optional() }).loose().optional(),
  required: z.boolean().optional(),
  verification: z.string().optional(),
}).loose();
const PackFile = z.object({
  code: z.string(),
  facets: z.object({ licensing: z.array(LicensingFact).optional() }).loose().optional(),
  regions: z.array(z.object({ code: z.string(), facets: z.object({ licensing: z.array(LicensingFact).optional() }).loose().optional() }).loose()).optional(),
}).loose();

/** Walks up from this file to the repository root (works from sources under tsx and from the compiled dist tree). */
export function findRepositoryRoot(start: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'data', 'taxonomy', 'manifest.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const text = (value: Record<string, string>): string => value.en ?? Object.values(value)[0] ?? '';
function toFact(scope: string, fact: z.infer<typeof LicensingFact>): PackLicensingFact | null {
  if (fact.type !== 'activity') return null;
  return {
    factId: fact.id.slice(0, 120), scope, name: text(fact.name).slice(0, 500) || fact.id,
    authority: (fact.authority ? text(fact.authority.name) : 'unknown').slice(0, 500) || 'unknown',
    authorityUrl: fact.authority?.url && /^https?:\/\//.test(fact.authority.url) ? fact.authority.url : null,
    required: fact.required ?? false, verification: (fact.verification ?? 'unverified').slice(0, 40),
  };
}

/** Reads the shipped files once per pack; malformed or missing files yield no facts (unknown stays unknown). */
export class FileLicensingFacets implements LicensingFacetSource {
  private readonly cache = new Map<string, { trades: LicensingFacets['trades']; country: PackLicensingFact[]; regions: Map<string, PackLicensingFact[]> }>();
  constructor(private readonly root: string | null = findRepositoryRoot()) {}

  private pack(code: string) {
    const hit = this.cache.get(code);
    if (hit) return hit;
    const entry = { trades: {} as LicensingFacets['trades'], country: [] as PackLicensingFact[], regions: new Map<string, PackLicensingFact[]>() };
    if (this.root) {
      const taxonomyPath = join(this.root, 'data', 'taxonomy', 'jurisdictions', `${code}.json`);
      if (existsSync(taxonomyPath)) {
        const parsed = TaxonomyJurisdictionFile.safeParse(JSON.parse(readFileSync(taxonomyPath, 'utf8')));
        if (parsed.success && parsed.data.trades) {
          for (const [trade, facet] of Object.entries(parsed.data.trades)) entry.trades[trade] = { licensing: facet.licensing, verification: facet.verification };
        }
      }
      const packPath = join(this.root, 'packages', 'country-packs', 'packs', `${code.toLowerCase()}.json`);
      if (existsSync(packPath)) {
        const parsed = PackFile.safeParse(JSON.parse(readFileSync(packPath, 'utf8')));
        if (parsed.success) {
          entry.country = (parsed.data.facets?.licensing ?? []).map((f) => toFact(code, f)).filter((f): f is PackLicensingFact => f !== null);
          for (const region of parsed.data.regions ?? []) {
            entry.regions.set(region.code, (region.facets?.licensing ?? []).map((f) => toFact(region.code, f)).filter((f): f is PackLicensingFact => f !== null));
          }
        }
      }
    }
    this.cache.set(code, entry);
    return entry;
  }

  load(regionCode: string | null): LicensingFacets {
    if (!regionCode) return LicensingFacetsSchema.parse({ pack: null, regionCode: null, trades: {}, facts: [] });
    const pack = regionCode.slice(0, 2);
    const region = regionCode.split(':')[0] as string;
    const data = this.pack(pack);
    const facts = [...data.country, ...(region.length > 2 ? data.regions.get(region) ?? [] : [])];
    const known = Object.keys(data.trades).length > 0 || facts.length > 0;
    return LicensingFacetsSchema.parse({ pack: known ? pack : null, regionCode, trades: data.trades, facts });
  }
}
