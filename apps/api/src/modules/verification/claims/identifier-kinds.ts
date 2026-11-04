import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Identifier kinds of the country packs (`registrationIdentifier` and the `identifiers` facet of the country and its
 * regions). Every country-specific rule is data: the `US-EIN` pattern lives in packages/country-packs/packs/us.json, not
 * here. The API reads the pack files, as the plans and jurisdiction modules do. A format check only catches mistyped
 * values, because a value proves nothing; without the pack files it is skipped rather than blocking the page. A country
 * without a pack uses the kind `other`, with a free-form value.
 *
 * Whether a kind may be public follows the pack's `role` and `appliesTo`, and fails closed. The company record cannot say
 * whether its holder is a sole proprietor, so a kind that can belong to a person stays private for every holder.
 */
interface IdentifierFact { kind?: unknown; pattern?: unknown; role?: unknown; appliesTo?: unknown }
interface PackFile { registrationIdentifier?: IdentifierFact; facets?: { identifiers?: IdentifierFact[] }; regions?: Array<{ facets?: { identifiers?: IdentifierFact[] } }> }
interface KindFact { pattern: RegExp; role: string | null; appliesTo: readonly string[] }

/** Roles whose values are tax or licence numbers: a licence is a credential of REP-001, not a public identifier here. */
const PRIVATE_ROLES: ReadonlySet<string> = new Set(['tax', 'vat', 'licence']);
/** Private until the owner decides whether an EIN may be public (see the CLM-001 pull request). */
const HELD_PRIVATE: ReadonlySet<string> = new Set(['US-EIN']);

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
  private readonly cache = new Map<string, Map<string, KindFact>>();

  constructor(private readonly directory: string | null = findPacksDirectory()) {}

  private kindsOf(country: string): Map<string, KindFact> {
    const hit = this.cache.get(country);
    if (hit) return hit;
    const kinds = new Map<string, KindFact>();
    const path = join(this.directory as string, `${country.toLowerCase()}.json`);
    if (existsSync(path)) {
      const pack = JSON.parse(readFileSync(path, 'utf8')) as PackFile;
      const facts = [pack.registrationIdentifier, ...(pack.facets?.identifiers ?? []), ...(pack.regions ?? []).flatMap((r) => r.facets?.identifiers ?? [])];
      for (const fact of facts) {
        if (typeof fact?.kind !== 'string' || typeof fact.pattern !== 'string') continue;
        kinds.set(fact.kind, { pattern: new RegExp(fact.pattern), role: typeof fact.role === 'string' ? fact.role : null, appliesTo: Array.isArray(fact.appliesTo) ? fact.appliesTo as string[] : [] });
      }
    }
    this.cache.set(country, kinds);
    return kinds;
  }

  private fact(kind: string): KindFact | undefined {
    return this.directory ? this.kindsOf(kind.slice(0, 2)).get(kind) : undefined;
  }

  /** Whether the value fits its kind: a kind of the country's pack with its pattern, or `other`. */
  accepts(kind: string, value: string): boolean {
    if (kind === 'other' || !this.directory) return true;
    return this.fact(kind)?.pattern.test(value.trim()) ?? false;
  }

  /** Private unless the pack shows the kind belongs to a legal entity alone. `other` and an unknown kind are private. */
  isPrivate(kind: string): boolean {
    const fact = this.fact(kind);
    if (!fact || HELD_PRIVATE.has(kind)) return true;
    if (fact.role !== null && PRIVATE_ROLES.has(fact.role)) return true;
    return fact.appliesTo.some((holder) => holder !== 'legal-entity');
  }
}
