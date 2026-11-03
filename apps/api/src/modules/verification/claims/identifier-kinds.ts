import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Identifier kinds of the country packs (`registrationIdentifier` and the `identifiers` facet of the country and its
 * regions). Every country-specific rule is data: the `US-EIN` pattern lives in packages/country-packs/packs/us.json, not
 * here. The API reads the pack files, as the plans and jurisdiction modules do. A format check only catches mistyped
 * values, because a value proves nothing; without the pack files it is skipped rather than blocking the page. A country
 * without a pack uses the kind `other`, with a free-form value.
 */
interface IdentifierFact { kind?: unknown; pattern?: unknown }
interface PackFile { registrationIdentifier?: IdentifierFact; facets?: { identifiers?: IdentifierFact[] }; regions?: Array<{ facets?: { identifiers?: IdentifierFact[] } }> }

function findPacksDirectory(start: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'packages', 'country-packs', 'packs');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export class IdentifierKinds {
  private readonly cache = new Map<string, Map<string, RegExp>>();

  constructor(private readonly directory: string | null = findPacksDirectory()) {}

  private kindsOf(country: string): Map<string, RegExp> {
    const hit = this.cache.get(country);
    if (hit) return hit;
    const kinds = new Map<string, RegExp>();
    const path = join(this.directory as string, `${country.toLowerCase()}.json`);
    if (existsSync(path)) {
      const pack = JSON.parse(readFileSync(path, 'utf8')) as PackFile;
      const facts = [pack.registrationIdentifier, ...(pack.facets?.identifiers ?? []), ...(pack.regions ?? []).flatMap((r) => r.facets?.identifiers ?? [])];
      for (const fact of facts) if (typeof fact?.kind === 'string' && typeof fact.pattern === 'string') kinds.set(fact.kind, new RegExp(fact.pattern));
    }
    this.cache.set(country, kinds);
    return kinds;
  }

  /** Whether the value fits its kind: a kind of the country's pack with its pattern, or `other`. */
  accepts(kind: string, value: string): boolean {
    if (kind === 'other' || !this.directory) return true;
    return this.kindsOf(kind.slice(0, 2)).get(kind)?.test(value.trim()) ?? false;
  }
}
