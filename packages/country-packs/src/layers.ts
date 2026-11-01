import { z } from 'zod';
import type { EngineAdapter } from './adapters.js';
import { FACET_NAMES, FacetsSchema, FactIdSchema, FactText, SourceSchema, VerificationLevelSchema, listFacts, type AnyFact, type FacetName, type FactOf, type Source } from './facets.js';
import { factsFor, type ScopedFact } from './facts.js';
import { isRestricted } from './restricted.js';
import { LayerCodeSchema, type CountryPack, type CountryPackInput } from './schema.js';
import { facetProblems, packProblems, type LayerResolution, type PackCheck } from './validate.js';
import eu from '../layers/eu.json' with { type: 'json' };

/**
 * Shared layers (CTRY-EU). Some law is the same for a group of countries: a union's regulations and directives, a
 * customs union, a regional standards body. A layer states those facts once, with sources; a pack lists the layers it
 * inherits (`layers` in the pack file) and adds only what is national.
 *
 * Rules, enforced by the validator:
 * - a layer fact applies to every pack that lists the layer, unless the pack (or one of its subdivisions) declares a
 *   fact with the same id; that override must be the same facet and kind and must cite at least one source the layer
 *   fact does not cite, so a member pack can never contradict a layer fact silently;
 * - a layer that lists its members accepts only those packs, and can never list a restricted place: a layer cannot
 *   enable a restricted place, and a restricted pack stays refused whatever layers it lists;
 * - every layer fact cites at least one page on the layer's official hosts (for the EU: europa.eu);
 * - what members vary (rates, national mandates, national annexes, holidays) is recorded in `memberVaries` and left to
 *   the member packs; the layer states no fact for it.
 *
 * Engine code never branches on a layer code or on membership: it reads facts with `layeredFactsFor`, which answers the
 * same way for a member pack and for any other pack. Layer data lives in `packages/country-packs/layers` and is reached
 * only through this module (`@trustwork/country-packs/layers`), which the package index does not re-export, so layer
 * data stays on the server side and out of browser bundles.
 */

/** Hostnames such as `europa.eu`; a source counts as official when its host is one of them or a subdomain of one. */
const HostSchema = z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/, 'host name in lower case');

export const LayerMembersSchema = z.strictObject({
  /** ISO 3166-1 alpha-2 codes of the members. */
  codes: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
  verification: VerificationLevelSchema,
  sources: z.array(SourceSchema).min(1),
});

/** A topic the layer leaves to its members (no layer fact is stated for it), with the reason and, where it exists, the source. */
export const MemberVariesSchema = z.strictObject({
  facet: z.enum(FACET_NAMES as [FacetName, ...FacetName[]]),
  topic: FactIdSchema,
  summary: FactText,
  sources: z.array(SourceSchema).optional(),
});

export const CountryLayerSchema = z.strictObject({
  layerVersion: z.literal(1),
  code: LayerCodeSchema,
  name: FactText,
  summary: FactText,
  /** Hosts whose pages count as the layer's official sources; every fact cites at least one of them. */
  officialHosts: z.array(HostSchema).min(1),
  members: LayerMembersSchema.optional(),
  memberVaries: z.array(MemberVariesSchema).default([]),
  /** Verification level of the layer-wide statements (name, summary, members) cited in `sources`. */
  verificationLevel: VerificationLevelSchema,
  facets: FacetsSchema,
  notes: z.array(z.string()).optional(),
  sources: z.array(SourceSchema).min(1),
});
export type CountryLayer = z.infer<typeof CountryLayerSchema>;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function onOfficialHost(source: Source, hosts: readonly string[]): boolean {
  const host = hostOf(source.url);
  return hosts.some((official) => host === official || host.endsWith(`.${official}`));
}

/** URL identity for the own-source rule: case-insensitive host, no fragment, no trailing slash. */
function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

export type LayerCheck = { layer: CountryLayer | null; problems: string[] };

/** Every problem of a layer file; `layer` is the parsed layer when there are none. */
export function layerProblems(raw: unknown, options: { adapters?: readonly EngineAdapter[] } = {}): LayerCheck {
  const parsed = CountryLayerSchema.safeParse(raw);
  if (!parsed.success) return { layer: null, problems: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(layer)'}: ${issue.message}`) };
  const layer = parsed.data;
  const problems: string[] = [];
  const at = `layer ${layer.code}`;

  if (isRestricted(layer.code)) problems.push(`${at}: the code is a restricted place and cannot name a layer`);
  if (layer.members) {
    const seen = new Set<string>();
    for (const code of layer.members.codes) {
      if (isRestricted(code)) problems.push(`${at}: member ${code} is a restricted place; a layer cannot enable a restricted place`);
      if (seen.has(code)) problems.push(`${at}: member ${code} is listed twice`);
      seen.add(code);
    }
  }

  const official = (sources: readonly Source[]) => sources.some((source) => onOfficialHost(source, layer.officialHosts));
  const hosts = layer.officialHosts.join(', ');
  if (!official(layer.sources)) problems.push(`${at}: sources cite no page on ${hosts}`);
  if (layer.members && !official(layer.members.sources)) problems.push(`${at}: members cite no page on ${hosts}`);

  const facts = listFacts(layer.facets);
  for (const { facet, fact } of facts) {
    if (!official(fact.sources)) problems.push(`${at} ${facet}/${fact.id}: cites no official source (a page on ${hosts})`);
  }
  const identifierKinds = new Set(facts.filter((e) => e.facet === 'identifiers').map((e) => (e.fact as { kind: string }).kind));
  problems.push(...facetProblems(layer.facets, { scope: layer.code, wider: [], identifierKinds, countryScope: true, ...(options.adapters ? { adapters: options.adapters } : {}) }));

  const factIds = new Set(facts.map((e) => e.fact.id));
  const topics = new Set<string>();
  for (const varies of layer.memberVaries) {
    const key = `${varies.facet}/${varies.topic}`;
    if (topics.has(key)) problems.push(`${at}: memberVaries ${key} is listed twice`);
    topics.add(key);
    if (factIds.has(varies.topic)) problems.push(`${at}: memberVaries ${key} is also stated as a layer fact; a topic is either the layer's or the members'`);
    if (varies.sources && !official(varies.sources)) problems.push(`${at}: memberVaries ${key} cites no page on ${hosts}`);
  }

  return { layer: problems.length ? null : layer, problems };
}

/** Parses and checks a layer; any problem throws, so a malformed layer never ships. */
export function validateLayer(raw: unknown, options: { adapters?: readonly EngineAdapter[] } = {}): CountryLayer {
  const { layer, problems } = layerProblems(raw, options);
  if (!layer) {
    const code = typeof raw === 'object' && raw && 'code' in raw ? String(raw.code) : '?';
    throw new Error(`layer ${code}: ${problems.join('; ')}`);
  }
  return layer;
}

/** The layers that ship with the engine (`packages/country-packs/layers`). */
export const BUILT_IN_LAYERS: readonly CountryLayer[] = [eu].map((raw) => validateLayer(raw));

export function getLayer(code: string, layers: readonly CountryLayer[] = BUILT_IN_LAYERS): CountryLayer | null {
  return layers.find((layer) => layer.code === code.toUpperCase()) ?? null;
}

/**
 * Resolves the layers a pack lists for the pack validator: their facts become wider than the country, and every
 * layer rule (known layer, membership, no fact declared by two layers, overrides with their own source) is checked.
 */
export function layerResolver(layers: readonly CountryLayer[] = BUILT_IN_LAYERS): (pack: CountryPackInput) => LayerResolution {
  return (pack) => {
    const problems: string[] = [];
    const wider: LayerResolution['wider'] = [];
    const byFactId = new Map<string, { layer: string; facet: FacetName; fact: AnyFact }>();
    const listed = new Set<string>();
    for (const code of pack.layers ?? []) {
      if (listed.has(code)) {
        problems.push(`layer ${code} is listed twice`);
        continue;
      }
      listed.add(code);
      const layer = getLayer(code, layers);
      if (!layer) {
        problems.push(`layer ${code} is not a known layer`);
        continue;
      }
      if (layer.members?.codes.some((member) => isRestricted(member))) problems.push(`layer ${code} lists a restricted place and cannot be inherited`);
      if (layer.members && !layer.members.codes.includes(pack.code)) problems.push(`${pack.code} is not a member of layer ${code}`);
      for (const entry of listFacts(layer.facets)) {
        const earlier = byFactId.get(entry.fact.id);
        if (earlier) {
          problems.push(`layers ${earlier.layer} and ${code} both declare ${entry.facet}/${entry.fact.id}`);
          continue;
        }
        byFactId.set(entry.fact.id, { layer: code, ...entry });
        wider.push(entry);
      }
    }

    // An override needs its own source: at least one source the layer fact does not cite.
    const scopes = [{ scope: pack.code, facets: pack.facets }, ...pack.regions.map((region) => ({ scope: region.code, facets: region.facets }))];
    for (const { scope, facets } of scopes) {
      for (const { facet, fact } of listFacts(facets)) {
        const base = byFactId.get(fact.id);
        if (!base) continue;
        const cited = new Set(base.fact.sources.map((source) => sourceKey(source.url)));
        if (!fact.sources.some((source) => !cited.has(sourceKey(source.url)))) {
          problems.push(`${scope} ${facet}/${fact.id}: overrides layer ${base.layer} fact ${base.facet}/${fact.id} without its own source (cite at least one source the layer fact does not cite)`);
        }
      }
    }
    return { wider, problems };
  };
}

/** Every problem of a pack file, with the layers it lists resolved against the layer registry. */
export function layeredPackProblems(raw: unknown, options: { adapters?: readonly EngineAdapter[]; layers?: readonly CountryLayer[] } = {}): PackCheck {
  return packProblems(raw, { ...(options.adapters ? { adapters: options.adapters } : {}), layers: layerResolver(options.layers) });
}

/** Parses and cross-checks a pack together with its layers; any problem throws. */
export function validateLayeredPack(raw: unknown, options: { adapters?: readonly EngineAdapter[]; layers?: readonly CountryLayer[] } = {}): CountryPack {
  const { pack, problems } = layeredPackProblems(raw, options);
  if (!pack) {
    const code = typeof raw === 'object' && raw && 'code' in raw ? String(raw.code) : '?';
    throw new Error(`${code}: ${problems.join('; ')}`);
  }
  return pack;
}

/** A fact with the scope it came from; `layer` names the shared layer when the fact is inherited, otherwise null. */
export type LayeredFact<F extends FacetName> = ScopedFact<F> & { layer: string | null };

/**
 * Facts of one facet that hold in a scope, layers included: the facts of each listed layer, then the pack's own chain
 * (country, enclosing subdivisions, the subdivision). A narrower fact with the same id replaces the wider one. Throws
 * when a listed layer is not available, so a layer fact is never dropped silently.
 */
export function layeredFactsFor<F extends FacetName>(pack: CountryPack, facet: F, regionCode?: string, layers: readonly CountryLayer[] = BUILT_IN_LAYERS): LayeredFact<F>[] {
  const byId = new Map<string, LayeredFact<F>>();
  for (const code of pack.layers ?? []) {
    const layer = getLayer(code, layers);
    if (!layer) throw new Error(`${pack.code}: layer ${code} is not available`);
    for (const entry of listFacts(layer.facets)) {
      if (entry.facet !== facet) continue;
      byId.set(entry.fact.id, { scope: layer.code, layer: layer.code, fact: entry.fact as FactOf<F> });
    }
  }
  for (const { scope, fact } of factsFor(pack, facet, regionCode)) {
    byId.delete(fact.id);
    byId.set(fact.id, { scope, layer: null, fact });
  }
  return [...byId.values()];
}

/** Topics the pack's layers leave to the pack (rates, national mandates, national annexes, holidays). */
export function memberVariesFor(pack: CountryPack, layers: readonly CountryLayer[] = BUILT_IN_LAYERS): (CountryLayer['memberVaries'][number] & { layer: string })[] {
  return (pack.layers ?? []).flatMap((code) => getLayer(code, layers)?.memberVaries.map((varies) => ({ ...varies, layer: code })) ?? []);
}
