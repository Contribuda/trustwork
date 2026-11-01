import { ENGINE_ADAPTERS, findAdapter, type EngineAdapter } from './adapters.js';
import { listFacts, type AnyFact, type FacetName, type Facets, type VerificationLevel } from './facets.js';
import { isRestricted } from './restricted.js';
import { CountryPackSchema, type CountryPack, type CountryPackInput, type Region } from './schema.js';

/**
 * Pack validation (CTRY-002). `packProblems` returns every problem it finds so a contributor sees them all at once;
 * `validatePack` throws on any problem and returns the pack in v2 form. The checks are engine invariants, not style:
 * restricted places are refused wherever a place can appear, every fact cites sources with a verification level,
 * rates are decimal strings, adapters must exist in engine code, identifier examples must match their patterns.
 */

const V2_ONLY = 'needs "schemaVersion": 2';

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function compiles(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The chain of scopes a region's facts resolve through, widest first: the country, then each enclosing subdivision. */
export function scopeChain(pack: Pick<CountryPackInput, 'code' | 'regions'>, regionCode?: string): { scope: string; facets: Facets | undefined }[] {
  const chain: Region[] = [];
  const byCode = new Map(pack.regions.map((r) => [r.code, r]));
  const seen = new Set<string>();
  let current = regionCode ? byCode.get(regionCode) : undefined;
  while (current && !seen.has(current.code)) {
    seen.add(current.code);
    chain.unshift(current);
    current = current.parent ? byCode.get(current.parent) : undefined;
  }
  return [{ scope: pack.code, facets: (pack as CountryPackInput).facets }, ...chain.map((r) => ({ scope: r.code, facets: r.facets }))];
}

export type FacetCheckContext = {
  /** Scope label used in messages and as the identifier-kind prefix: a country code, a region code or a layer code. */
  scope: string;
  /** Facts of wider scopes this scope may refer to or override (by id). */
  wider: { facet: FacetName; fact: AnyFact }[];
  /** Every identifier kind declared anywhere in the pack (for register and licence references). */
  identifierKinds: ReadonlySet<string>;
  /** Whether country-level-only facts (the country data-residency rule) are refused here. */
  countryScope: boolean;
  adapters?: readonly EngineAdapter[];
};

/** Checks the facts of one scope (a country, a subdivision or a shared layer). */
export function facetProblems(facets: Facets | undefined, context: FacetCheckContext): string[] {
  const problems: string[] = [];
  const where = (fact: AnyFact, facet: FacetName) => `${context.scope} ${facet}/${fact.id}`;
  const facts = listFacts(facets);
  const ids = new Map<string, FacetName>();
  const widerById = new Map(context.wider.map((entry) => [entry.fact.id, entry]));
  const registerIds = new Set([...context.wider, ...facts].filter((e) => e.facet === 'registers').map((e) => e.fact.id));
  for (const { facet, fact } of facts) {
    const at = where(fact, facet);
    if (ids.has(fact.id)) problems.push(`${at}: duplicate fact id in this scope`);
    ids.set(fact.id, facet);
    const wider = widerById.get(fact.id);
    if (wider && (wider.facet !== facet || ('type' in wider.fact ? wider.fact.type : undefined) !== ('type' in fact ? fact.type : undefined))) {
      problems.push(`${at}: overrides ${wider.facet}/${fact.id} of a wider scope with a different kind of fact`);
    }
    if (fact.effectiveFrom && fact.effectiveTo && fact.effectiveFrom > fact.effectiveTo) problems.push(`${at}: effectiveFrom is after effectiveTo`);
    if ('adapter' in fact && fact.adapter && !findAdapter(fact.adapter, context.adapters ?? ENGINE_ADAPTERS)) {
      problems.push(`${at}: adapter ${fact.adapter.capability}/${fact.adapter.id} does not exist in the engine; name it in candidateAdapters until it does`);
    }
    switch (facet) {
      case 'identifiers': {
        const f = fact as Extract<AnyFact, { kind: string; pattern: string }>;
        const name = f.kind.slice(context.scope.length + 1);
        if (!f.kind.startsWith(`${context.scope}-`) || !/^[A-Z][A-Z0-9]{1,11}$/.test(name)) problems.push(`${at}: kind ${f.kind} must be ${context.scope}-<NAME>`);
        const regex = compiles(f.pattern);
        if (!regex) problems.push(`${at}: pattern is not a valid regular expression`);
        else if (!regex.test(f.example)) problems.push(`${at}: example does not match its pattern`);
        if (f.register && !registerIds.has(f.register)) problems.push(`${at}: register ${f.register} is not declared in this or a wider scope`);
        break;
      }
      case 'registers': {
        const f = fact as Extract<AnyFact, { covers: string[] }>;
        for (const kind of f.covers) if (!context.identifierKinds.has(kind)) problems.push(`${at}: covers unknown identifier kind ${kind}`);
        break;
      }
      case 'licensing': {
        const f = fact as Extract<AnyFact, { type: 'activity' | 'profession' | 'insurance' }>;
        if ('register' in f && f.register && !registerIds.has(f.register)) problems.push(`${at}: register ${f.register} is not declared in this or a wider scope`);
        if ('identifierKind' in f && f.identifierKind && !context.identifierKinds.has(f.identifierKind)) problems.push(`${at}: unknown identifier kind ${f.identifierKind}`);
        break;
      }
      case 'tax': {
        const f = fact as Extract<AnyFact, { type: 'rate' | 'e-invoicing' }>;
        if (f.type === 'rate' && f.calculation === 'adapter' && !f.adapter && !f.candidateAdapters?.length) problems.push(`${at}: calculation "adapter" needs an adapter or candidateAdapters`);
        break;
      }
      case 'calendar': {
        const f = fact as Extract<AnyFact, { type: 'working-week' | 'fiscal-year' | 'holiday' }>;
        if (f.type === 'working-week' && new Set(f.days).size !== f.days.length) problems.push(`${at}: working week repeats a day`);
        if (f.type === 'fiscal-year' && f.startDay > DAYS_IN_MONTH[f.startMonth - 1]!) problems.push(`${at}: fiscal year starts on a day that does not exist`);
        if (f.type === 'holiday' && f.rule.kind === 'fixed' && f.rule.day > DAYS_IN_MONTH[f.rule.month - 1]!) problems.push(`${at}: fixed holiday on a day that does not exist`);
        break;
      }
      case 'privacy': {
        const f = fact as Extract<AnyFact, { type: 'data-residency' | 'law' | 'retention' }>;
        if (f.type === 'data-residency' && context.countryScope) problems.push(`${at}: the country data-residency rule belongs in dataResidency; privacy data-residency facts are for subdivisions`);
        break;
      }
      case 'agentLaw': {
        const f = fact as Extract<AnyFact, { counselReview: string }>;
        if (f.verification === 'official' && f.counselReview !== 'done') problems.push(`${at}: agent-law defaults stay unverified until counsel review (counselReview: done)`);
        break;
      }
      default:
        break;
    }
  }
  return problems;
}

function identifierKindsOf(pack: CountryPackInput): string[] {
  return [
    pack.registrationIdentifier.kind,
    ...listFacts(pack.facets).filter((e) => e.facet === 'identifiers').map((e) => (e.fact as { kind: string }).kind),
    ...pack.regions.flatMap((r) => listFacts(r.facets).filter((e) => e.facet === 'identifiers').map((e) => (e.fact as { kind: string }).kind)),
  ];
}

export type PackCheck = { pack: CountryPack | null; problems: string[] };

/** Facts a pack inherits from shared layers, and the problems found resolving them (`layerResolver` in `layers.ts`). */
export type LayerResolution = { wider: { facet: FacetName; fact: AnyFact }[]; problems: string[] };

export type PackCheckOptions = {
  adapters?: readonly EngineAdapter[];
  /**
   * Resolves the shared layers a pack lists (CTRY-EU). Without it a pack that lists layers is refused, so a layer can
   * never be skipped silently; packs that list no layer never call it.
   */
  layers?: (pack: CountryPackInput) => LayerResolution;
};

/** Every problem of a pack file (v1 or v2). `pack` is the upgraded v2 pack when there are no problems. */
export function packProblems(raw: unknown, options: PackCheckOptions = {}): PackCheck {
  const parsed = CountryPackSchema.safeParse(raw);
  if (!parsed.success) {
    const code = typeof raw === 'object' && raw && 'code' in raw && typeof raw.code === 'string' ? raw.code : null;
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(pack)'}: ${issue.message}`);
    if (code && isRestricted(code)) problems.unshift(`${code} is a restricted place and cannot exist as a pack`);
    return { pack: null, problems };
  }
  const pack = parsed.data;
  const problems: string[] = [];
  const v2 = pack.schemaVersion === 2;

  // Restricted places: the pack itself, every subdivision and every parent reference. No field can re-enable one.
  if (isRestricted(pack.code)) problems.push(`Country pack ${pack.code} is a restricted place and cannot exist`);
  for (const region of pack.regions) {
    if (isRestricted(region.code)) problems.push(`region ${region.code} is a restricted place and cannot be listed`);
    if (region.parent && isRestricted(region.parent)) problems.push(`region ${region.code}: parent ${region.parent} is a restricted place`);
  }

  // v1 invariants.
  if (!pack.locales.includes(pack.defaultLocale)) problems.push(`defaultLocale ${pack.defaultLocale} is not in locales`);
  if (!pack.locales.includes('en')) problems.push('en (engine fallback) must be listed in locales');
  const codes = new Set<string>();
  for (const region of pack.regions) {
    if (!region.code.startsWith(`${pack.code}-`)) problems.push(`region ${region.code} belongs to another country`);
    if (codes.has(region.code)) problems.push(`duplicate region ${region.code}`);
    codes.add(region.code);
    if (!region.name.en || !region.name[pack.defaultLocale]) problems.push(`region ${region.code} needs en and ${pack.defaultLocale} names`);
  }
  if (!pack.registrationIdentifier.kind.startsWith(`${pack.code}-`)) problems.push('identifier kind must be prefixed with the country code');
  const primary = compiles(pack.registrationIdentifier.pattern);
  if (!primary) problems.push('registrationIdentifier.pattern is not a valid regular expression');
  else if (!primary.test(pack.registrationIdentifier.example)) problems.push('identifier example does not match its pattern');
  const postal = compiles(pack.formats.postalCode.pattern);
  if (!postal) problems.push('postal code pattern is not a valid regular expression');
  else if (!postal.test(pack.formats.postalCode.example)) problems.push('postal code example does not match its pattern');

  // Version gate: v2 fields need the version marker, and v2 needs verification levels on the v1 facts.
  if (!v2) {
    if (pack.timeZones) problems.push(`timeZones ${V2_ONLY}`);
    if (pack.facets) problems.push(`facets ${V2_ONLY}`);
    if (pack.verificationLevel || pack.registrationIdentifier.verificationLevel || pack.dataResidency.verificationLevel) problems.push(`verificationLevel ${V2_ONLY}`);
    if (pack.address.lines.includes('street2')) problems.push(`address line street2 ${V2_ONLY}`);
    for (const region of pack.regions) if (region.parent || region.timeZones || region.facets) problems.push(`region ${region.code}: parent, timeZones and facets ${V2_ONLY}`);
    if (pack.layers) problems.push(`layers ${V2_ONLY}`);
  } else {
    if (!pack.verificationLevel) problems.push('verificationLevel is required in v2 (for formats, currency, entity types and regions)');
    if (!pack.registrationIdentifier.verificationLevel) problems.push('registrationIdentifier.verificationLevel is required in v2');
    if (!pack.dataResidency.verificationLevel) problems.push('dataResidency.verificationLevel is required in v2');
  }

  // Time zones.
  const zones = pack.timeZones ?? [pack.formats.timeZone];
  for (const zone of new Set([...zones, pack.formats.timeZone, ...pack.regions.flatMap((r) => r.timeZones ?? [])])) {
    if (!validTimeZone(zone)) problems.push(`time zone ${zone} is not a valid IANA time zone`);
  }
  if (new Set(zones).size !== zones.length) problems.push('timeZones repeats a zone');
  if (!zones.includes(pack.formats.timeZone)) problems.push(`timeZones must include formats.timeZone ${pack.formats.timeZone}`);
  for (const region of pack.regions) for (const zone of region.timeZones ?? []) if (!zones.includes(zone)) problems.push(`region ${region.code}: time zone ${zone} is not in the pack's timeZones`);

  // Subdivision hierarchy.
  for (const region of pack.regions) {
    if (!region.parent) continue;
    if (region.parent === region.code) problems.push(`region ${region.code} is its own parent`);
    else if (!codes.has(region.parent)) problems.push(`region ${region.code}: parent ${region.parent} is not a region of this pack`);
    const seen = new Set([region.code]);
    let next = pack.regions.find((r) => r.code === region.parent);
    while (next?.parent) {
      if (seen.has(next.code)) {
        problems.push(`region ${region.code}: parent chain has a cycle`);
        break;
      }
      seen.add(next.code);
      next = pack.regions.find((r) => r.code === next!.parent);
    }
  }

  // Identifier kinds are unique across the whole pack.
  const kinds = identifierKindsOf(pack);
  const kindSet = new Set(kinds);
  if (kindSet.size !== kinds.length) problems.push(`identifier kinds repeat: ${kinds.filter((k, i) => kinds.indexOf(k) !== i).join(', ')}`);

  // Shared layers (CTRY-EU): their facts are wider than the country; resolving them needs the layer registry.
  let inherited: LayerResolution['wider'] = [];
  if (pack.layers) {
    if (!options.layers) problems.push(`lists layers ${pack.layers.join(', ')}; validate it with the layer registry (validateLayeredPack in layers.ts)`);
    else {
      const resolved = options.layers(pack);
      inherited = resolved.wider;
      problems.push(...resolved.problems);
    }
  }

  // Facts at country and subdivision scope.
  const adapters = options.adapters ? { adapters: options.adapters } : {};
  problems.push(...facetProblems(pack.facets, { scope: pack.code, wider: inherited, identifierKinds: kindSet, countryScope: true, ...adapters }));
  for (const region of pack.regions) {
    if (!region.facets) continue;
    const chain = scopeChain(pack, region.code).slice(0, -1);
    const wider = [...inherited, ...chain.flatMap((s) => listFacts(s.facets))];
    problems.push(...facetProblems(region.facets, { scope: region.code, wider, identifierKinds: kindSet, countryScope: false, ...adapters }));
  }

  return { pack: problems.length ? null : upgradePack(pack), problems };
}

/** Parses and cross-checks a pack; any problem throws, so a restricted or malformed pack can never ship. */
export function validatePack(raw: unknown, options: PackCheckOptions = {}): CountryPack {
  const { pack, problems } = packProblems(raw, options);
  if (!pack) {
    const code = typeof raw === 'object' && raw && 'code' in raw ? String(raw.code) : '?';
    throw new Error(`${code}: ${problems.join('; ')}`);
  }
  return pack;
}

/**
 * Verification level for a v1 fact from its free-text notes. Conservative by construction: a v1 fact is never
 * upgraded to `official`; it is `secondary` when its notes say it rests on secondary sources, otherwise `pending`.
 */
export function levelFromNotes(notes: readonly (string | undefined)[]): VerificationLevel {
  return notes.some((note) => note && /secondary/i.test(note)) ? 'secondary' : 'pending';
}

/**
 * Lossless v1 -> v2 upgrade: every v1 field and source is kept verbatim; the upgrade only adds the version marker,
 * the time-zone list (the v1 zone), an empty facets object and verification levels derived from the v1 notes.
 * A v2 pack is returned with its optional collections filled in.
 */
export function upgradePack(pack: CountryPackInput): CountryPack {
  const ri = pack.registrationIdentifier;
  const dr = pack.dataResidency;
  return {
    ...pack,
    schemaVersion: 2,
    verificationLevel: pack.verificationLevel ?? levelFromNotes(pack.sources.map((s) => s.verification)),
    timeZones: pack.timeZones ?? [pack.formats.timeZone],
    facets: pack.facets ?? {},
    registrationIdentifier: { ...ri, verificationLevel: ri.verificationLevel ?? levelFromNotes([ri.verification, ...ri.sources.map((s) => s.verification)]) },
    dataResidency: { ...dr, verificationLevel: dr.verificationLevel ?? levelFromNotes(dr.sources.map((s) => s.verification)) },
  };
}
