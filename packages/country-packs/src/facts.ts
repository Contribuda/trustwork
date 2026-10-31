import { listFacts, type FacetName, type FactOf, type IdentifierFact, type VerificationLevel } from './facets.js';
import type { CountryPack } from './schema.js';
import { scopeChain } from './validate.js';

/**
 * Reading facts from a validated pack (CTRY-002). Engine code asks these functions for a fact and never branches on a
 * country code: the same call answers for a unitary country and for one state of a federal country.
 */

/** A fact together with the scope it came from (the country code or a subdivision code). */
export type ScopedFact<F extends FacetName> = { scope: string; fact: FactOf<F> };

/**
 * Facts of one facet that hold in a scope: country facts, then facts of each enclosing subdivision, then the
 * subdivision's own facts. A narrower fact with the same id replaces the wider one (it cites its own sources).
 */
export function factsFor<F extends FacetName>(pack: CountryPack, facet: F, regionCode?: string): ScopedFact<F>[] {
  const byId = new Map<string, ScopedFact<F>>();
  for (const { scope, facets } of scopeChain(pack, regionCode)) {
    for (const entry of listFacts(facets)) {
      if (entry.facet !== facet) continue;
      byId.delete(entry.fact.id);
      byId.set(entry.fact.id, { scope, fact: entry.fact as FactOf<F> });
    }
  }
  return [...byId.values()];
}

/** The IANA time zones of the country, or of one subdivision when it lists its own. */
export function packTimeZones(pack: CountryPack, regionCode?: string): string[] {
  const region = regionCode ? pack.regions.find((r) => r.code === regionCode) : undefined;
  return region?.timeZones ?? pack.timeZones;
}

/** One identifier kind in a uniform shape, whether it is the v1 primary identifier or an `identifiers` fact. */
export type IdentifierKindInfo = Pick<IdentifierFact, 'kind' | 'role' | 'label' | 'pattern' | 'example' | 'issuer' | 'sources'> & {
  scope: string;
  primary: boolean;
  verification: VerificationLevel;
};

function primaryKind(pack: CountryPack): IdentifierKindInfo {
  const ri = pack.registrationIdentifier;
  return { kind: ri.kind, role: 'registration', label: ri.label, pattern: ri.pattern, example: ri.example, issuer: ri.issuer, sources: ri.sources, scope: pack.code, primary: true, verification: ri.verificationLevel };
}

function info(scope: string, fact: IdentifierFact): IdentifierKindInfo {
  return { kind: fact.kind, role: fact.role, label: fact.label, pattern: fact.pattern, example: fact.example, issuer: fact.issuer, sources: fact.sources, scope, primary: false, verification: fact.verification };
}

/** Identifier kinds that apply in a scope: the primary one, further national kinds, then kinds of the subdivision chain. */
export function identifierKinds(pack: CountryPack, regionCode?: string): IdentifierKindInfo[] {
  return [primaryKind(pack), ...factsFor(pack, 'identifiers', regionCode).map(({ scope, fact }) => info(scope, fact))];
}

/** Any identifier kind declared anywhere in the pack, by its code. */
export function findIdentifierKind(pack: CountryPack, kind: string): IdentifierKindInfo | null {
  if (kind === pack.registrationIdentifier.kind) return primaryKind(pack);
  for (const { scope, facets } of [{ scope: pack.code, facets: pack.facets }, ...pack.regions.map((r) => ({ scope: r.code, facets: r.facets }))]) {
    const found = facets?.identifiers?.find((f) => f.kind === kind);
    if (found) return info(scope, found);
  }
  return null;
}
