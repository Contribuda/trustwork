import { sql } from 'kysely';
import { computeDigest, conversionRule, UNIT_CATALOGUE, type Quantity, type RoundingMode, type UnitDefinition } from '../../../contracts/src/index.js';
import type { Transaction } from '../pool.js';
import type {
  EvidenceArtifact, EvidenceClassification, EvidenceParentKind, ExchangeRateSnapshotRow, Hub, HubLifecycle, HubTerritory, HubTerritoryLevel,
  Jurisdiction, JurisdictionLevel, JurisdictionSource, ScanState, StepRelation, TaxonomyScheme, TaxonomyStatus, TaxonomyTerm, Unit, UnitConversionRule,
} from '../schema/kernel.js';

/**
 * Kernel repository (DATA-003). Two halves:
 *
 * - **Reference data, maintenance only.** `kernelReference.*` builds rows from the sources of truth (restricted places
 *   and country packs from @trustwork/country-packs, units from the contract catalogue, the plan-step taxonomy from
 *   data/taxonomy) and `kernelSync.apply` writes them inside `withMaintenance`. Nothing real-world is a SQL literal; the
 *   command is `node packages/data/bin/kernel-sync.mjs`. Builders take plain structural inputs, so this package does
 *   not import the country packs; the command passes them in.
 * - **Runtime ports** used under `withPrincipal` (or without identity for public reference data): units, explicit
 *   conversion and same-unit addition (executed by the database functions, so SQL callers get the same rule), selectable
 *   jurisdictions, released taxonomy, public hubs, exchange-rate snapshots and evidence artifacts under their policies.
 */

/* ---------- Reference inputs ---------- */

export interface RestrictedPlaceInput { code: string; basis: string }
export interface UnitInput { code: string; dimension: Unit['dimension']; system: Unit['system']; symbol: string; toBase: string | null; definition: string }
export interface ConversionRuleInput { from: string; to: string; numerator: bigint; denominator: bigint; source: string }
export interface JurisdictionInput {
  code: string;
  parent: string | null;
  level: JurisdictionLevel;
  regionKind: string | null;
  source: JurisdictionSource;
  packCode: string | null;
  packVersion: string;
  selectable: boolean;
}
export interface TaxonomyReleaseInput { version: string; payload: Record<string, unknown>; digest: string }
export interface TaxonomyTermInput { scheme: TaxonomyScheme; code: string; parent: string | null; status: TaxonomyStatus; release: string | null; attributes: Record<string, unknown> }
export interface TaxonomyRelationInput { from: string; relation: StepRelation; to: string }
export interface KernelReferenceData {
  restricted: RestrictedPlaceInput[];
  units: UnitInput[];
  conversionRules: ConversionRuleInput[];
  jurisdictions: JurisdictionInput[];
  taxonomy: { releases: TaxonomyReleaseInput[]; terms: TaxonomyTermInput[]; relations: TaxonomyRelationInput[] };
}

/** The pack fields the jurisdiction builder reads (structural subset of `CountryPack`). */
export interface PackLike { code: string; enabled: boolean; regions: readonly { code: string; kind: string; parent?: string | undefined }[] }
/** The taxonomy fields the builder reads (structural subset of `loadTaxonomy()` in data/taxonomy/validate.mjs). */
export interface TaxonomyLike {
  manifest: { schemes: readonly { id: string }[] };
  schemes: Record<string, { terms: readonly Record<string, unknown>[] }>;
  releases: readonly Record<string, unknown>[];
}

const PLAN_SCHEMES: ReadonlySet<string> = new Set<TaxonomyScheme>(['project_type', 'work_type', 'trade', 'material', 'stage', 'skill', 'permit_type', 'inspection_type', 'decision']);
const RELATIONS: ReadonlySet<string> = new Set<StepRelation>(['requires_trade', 'uses_material', 'precedes_stage', 'needs_permit_type', 'teaches', 'precedes', 'in_stage']);

/** Pack region kinds (REGION_KINDS in packages/country-packs/src/schema.ts) mapped to the model's jurisdiction levels. */
const LEVEL_OF_KIND: Readonly<Record<string, JurisdictionLevel>> = {
  state: 'subdivision', territory: 'subdivision', province: 'subdivision', region: 'subdivision', republic: 'subdivision', 'autonomous-republic': 'subdivision',
  district: 'district', rayon: 'district', municipality: 'district', city: 'city',
};

/** Every code a restriction check must see (placeCodes in packages/contracts/src/hub.ts). */
function placeCodes(code: string): string[] {
  const area = code.split(':')[0] ?? code;
  return [...new Set([code.slice(0, 2), area, code].map((c) => c.toUpperCase()))];
}
export function restrictedBy(restricted: readonly RestrictedPlaceInput[]): (code: string) => boolean {
  const set = new Set(restricted.map((r) => r.code.toUpperCase()));
  return (code) => placeCodes(code).some((c) => set.has(c));
}

/** Content version of a source document: `sha256:` + 32 hex of its trustwork-digest-1 (fits HubSchema.countryPack.version). */
export function contentVersion(document: unknown): string {
  return `sha256:${computeDigest(document).value.slice(0, 32)}`;
}

export const kernelReference = {
  /** Units and every explicit rule between convertible units of one dimension, from the contract catalogue. */
  units(catalogue: readonly UnitDefinition[] = UNIT_CATALOGUE): { units: UnitInput[]; conversionRules: ConversionRuleInput[] } {
    const units = catalogue.map((u) => ({ code: u.code, dimension: u.dimension, system: u.system, symbol: u.symbol, toBase: u.toBase, definition: u.definition }));
    const conversionRules: ConversionRuleInput[] = [];
    for (const from of catalogue) {
      for (const to of catalogue) {
        if (from.code === to.code || from.dimension !== to.dimension || from.toBase === null || to.toBase === null) continue;
        const rule = conversionRule(from.code, to.code);
        conversionRules.push({ from: from.code, to: to.code, numerator: rule.numerator, denominator: rule.denominator, source: 'UNIT_CATALOGUE, packages/contracts/src/common/units.ts' });
      }
    }
    return { units, conversionRules };
  },

  /**
   * Jurisdictions: the full tree of every contributed pack (source `pack`, version = content version of the pack) and
   * the country row of every other selectable country of the ISO dataset (source `dataset`). Restricted codes are
   * dropped here as well; the database refuses them regardless. Parents come before children.
   */
  jurisdictions(input: { packs: readonly { pack: PackLike; version: string }[]; countries: readonly { code: string }[]; datasetVersion: string; restricted: readonly RestrictedPlaceInput[] }): JurisdictionInput[] {
    const isRestricted = restrictedBy(input.restricted);
    const rows: JurisdictionInput[] = [];
    const packCodes = new Set(input.packs.map((p) => p.pack.code));
    for (const { pack, version } of input.packs) {
      if (isRestricted(pack.code)) continue;
      rows.push({ code: pack.code, parent: null, level: 'country', regionKind: null, source: 'pack', packCode: pack.code, packVersion: version, selectable: pack.enabled });
    }
    for (const country of input.countries) {
      if (packCodes.has(country.code) || isRestricted(country.code)) continue;
      rows.push({ code: country.code, parent: null, level: 'country', regionKind: null, source: 'dataset', packCode: null, packVersion: input.datasetVersion, selectable: true });
    }
    for (const { pack, version } of input.packs) {
      if (isRestricted(pack.code)) continue;
      const byCode = new Map(pack.regions.map((r) => [r.code, r]));
      const depth = (code: string, seen = new Set<string>()): number => {
        const parent = byCode.get(code)?.parent;
        if (!parent || seen.has(parent)) return 0;
        seen.add(parent);
        return 1 + depth(parent, seen);
      };
      const regions = [...pack.regions].filter((r) => !isRestricted(r.code)).sort((a, b) => depth(a.code) - depth(b.code) || a.code.localeCompare(b.code));
      for (const region of regions) {
        const level = LEVEL_OF_KIND[region.kind];
        if (!level) throw new Error(`kernel: unknown region kind ${region.kind} in pack ${pack.code}`);
        rows.push({ code: region.code, parent: region.parent ?? pack.code, level, regionKind: region.kind, source: 'pack', packCode: pack.code, packVersion: version, selectable: pack.enabled });
      }
    }
    return rows;
  },

  /**
   * Everything from the repository's sources of truth: RESTRICTED, PACKS and COUNTRIES of @trustwork/country-packs, the
   * contract unit catalogue and data/taxonomy. The packs and the taxonomy are loaded from source at run time (tsx) by
   * URL, so @trustwork/data keeps no build-time dependency on them; the shapes are checked structurally here.
   */
  async fromRepository(): Promise<KernelReferenceData> {
    const packsUrl = new URL('../../../country-packs/src/index.ts', import.meta.url).href;
    const taxonomyUrl = new URL('../../../../data/taxonomy/validate.mjs', import.meta.url).href;
    const packsModule = (await import(packsUrl)) as {
      RESTRICTED: { places: readonly { code: string; basis: string }[] };
      PACKS: readonly (PackLike & Record<string, unknown>)[];
      COUNTRIES: readonly { code: string }[];
    };
    const taxonomyModule = (await import(taxonomyUrl)) as {
      loadTaxonomy(): TaxonomyLike;
      validateTaxonomy(tax: TaxonomyLike): string[];
      relations(tax: TaxonomyLike): { from: string; relation: string; to: string }[];
    };
    const restricted = packsModule.RESTRICTED.places.map((p) => ({ code: p.code, basis: p.basis }));
    const tax = taxonomyModule.loadTaxonomy();
    const problems = taxonomyModule.validateTaxonomy(tax);
    if (problems.length) throw new KernelSyncError(`kernel: data/taxonomy is invalid: ${problems.slice(0, 5).join('; ')}`);
    return {
      restricted,
      ...kernelReference.units(),
      jurisdictions: kernelReference.jurisdictions({
        packs: packsModule.PACKS.map((pack) => ({ pack, version: contentVersion(pack) })),
        countries: packsModule.COUNTRIES,
        datasetVersion: contentVersion(packsModule.COUNTRIES.map((c) => c.code)),
        restricted,
      }),
      taxonomy: kernelReference.taxonomy(tax, taxonomyModule.relations(tax)),
    };
  },

  /** Terms, releases and relations of the plan-step taxonomy; `relations` is `relations(tax)` from data/taxonomy/validate.mjs. */
  taxonomy(tax: TaxonomyLike, relations: readonly { from: string; relation: string; to: string }[]): KernelReferenceData['taxonomy'] {
    const releases = [...tax.releases]
      .map((file) => {
        const { file: _file, ...payload } = file as { file?: unknown } & Record<string, unknown>;
        void _file;
        return { version: String(payload.version), payload, digest: computeDigest({ payload }).value };
      })
      .sort((a, b) => compareSemver(a.version, b.version));
    const firstRelease = new Map<string, string>();
    for (const release of releases) for (const code of (release.payload.codes as string[] | undefined) ?? []) if (!firstRelease.has(code)) firstRelease.set(code, release.version);
    const terms: TaxonomyTermInput[] = [];
    for (const { id } of tax.manifest.schemes) {
      if (!PLAN_SCHEMES.has(id)) throw new Error(`kernel: taxonomy scheme ${id} is not in the taxonomy_term scheme vocabulary`);
      for (const raw of tax.schemes[id]?.terms ?? []) {
        const term = raw as { code: string; parent?: string; status?: TaxonomyStatus; kind?: string; produces?: string[]; crosswalks?: Record<string, unknown> };
        const status = term.status ?? 'released';
        const release = status === 'draft' ? null : (firstRelease.get(term.code) ?? null);
        if (status !== 'draft' && !release) throw new Error(`kernel: taxonomy term ${term.code} is ${status} but in no release`);
        const attributes: Record<string, unknown> = {};
        if (term.kind !== undefined) attributes.kind = term.kind;
        if (term.produces !== undefined) attributes.produces = term.produces;
        if (term.crosswalks !== undefined) attributes.crosswalks = term.crosswalks;
        terms.push({ scheme: id as TaxonomyScheme, code: term.code, parent: term.parent ?? null, status, release, attributes });
      }
    }
    // Parents first: depth along the explicit parent chain (a parent is not always a code prefix).
    const parentOf = new Map(terms.map((t) => [t.code, t.parent]));
    const depth = (code: string): number => {
      let d = 0;
      for (let p = parentOf.get(code); p; p = parentOf.get(p)) if (++d > 64) throw new Error(`kernel: taxonomy parent cycle at ${code}`);
      return d;
    };
    terms.sort((a, b) => depth(a.code) - depth(b.code) || a.code.localeCompare(b.code));
    for (const r of relations) if (!RELATIONS.has(r.relation)) throw new Error(`kernel: unknown taxonomy relation ${r.relation}`);
    return { releases, terms, relations: relations.map((r) => ({ from: r.from, relation: r.relation as StepRelation, to: r.to })) };
  },
};

function compareSemver(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/* ---------- Maintenance sync ---------- */

export interface KernelSyncReport {
  restricted: number;
  restrictionChanges: number;
  units: number;
  conversionRules: number;
  jurisdictions: number;
  jurisdictionsRetired: number;
  releases: number;
  terms: number;
  relations: number;
}

export class KernelSyncError extends Error {
  readonly code = 'kernel.sync_conflict' as const;
}

export const kernelSync = {
  /**
   * Writes reference data. Must run inside `withMaintenance`: the owner role with the transaction-local flag (the
   * runtime role has no write grant on any reference table). Serialized by an exclusive advisory lock that hub and
   * territory restriction checks take shared, so no check sees a half-synced restricted list. Idempotent.
   */
  async apply(trx: Transaction, data: KernelReferenceData): Promise<KernelSyncReport> {
    if (data.restricted.length === 0) throw new KernelSyncError('kernel: the restricted-places list is empty; refusing to sync');
    await sql`SELECT pg_advisory_xact_lock(hashtext('trustwork.kernel_restrictions'))`.execute(trx);

    // 1. Restricted places, then recompute every stored flag.
    const codes = data.restricted.map((r) => r.code.toUpperCase());
    for (const place of data.restricted) {
      await trx.insertInto('restricted_place').values({ code: place.code.toUpperCase(), basis: place.basis })
        .onConflict((oc) => oc.column('code').doUpdateSet({ basis: place.basis, synced_at: sql`now()` })).execute();
    }
    await trx.deleteFrom('restricted_place').where('code', 'not in', codes).execute();
    const recomputed = await sql<{ n: number }>`SELECT trustwork.kernel_recompute_restrictions() AS n`.execute(trx);

    // 2. Units and explicit conversion rules (units are never deleted: rows may be referenced).
    for (const u of data.units) {
      const values = { dimension: u.dimension, system: u.system, symbol: u.symbol, to_base: u.toBase, definition: u.definition };
      await trx.insertInto('unit').values({ code: u.code, ...values }).onConflict((oc) => oc.column('code').doUpdateSet(values)).execute();
    }
    const ruleKeys = new Set(data.conversionRules.map((r) => `${r.from}>${r.to}`));
    const existingRules = await trx.selectFrom('unit_conversion_rule').select(['from_unit', 'to_unit']).execute();
    for (const r of existingRules) {
      if (!ruleKeys.has(`${r.from_unit}>${r.to_unit}`)) await trx.deleteFrom('unit_conversion_rule').where('from_unit', '=', r.from_unit).where('to_unit', '=', r.to_unit).execute();
    }
    for (const r of data.conversionRules) {
      const values = { numerator: r.numerator.toString(), denominator: r.denominator.toString(), exact: true, source: r.source };
      await trx.insertInto('unit_conversion_rule').values({ from_unit: r.from, to_unit: r.to, ...values })
        .onConflict((oc) => oc.columns(['from_unit', 'to_unit']).doUpdateSet(values)).execute();
    }

    // 3. Jurisdictions (parents first); codes that left their source are retired, never deleted.
    for (const j of data.jurisdictions) {
      const values = { parent_code: j.parent, level: j.level, region_kind: j.regionKind, source: j.source, pack_code: j.packCode, pack_version: j.packVersion, selectable: j.selectable, retired_at: null };
      await trx.insertInto('jurisdiction').values({ code: j.code, ...values }).onConflict((oc) => oc.column('code').doUpdateSet(values)).execute();
    }
    const live = data.jurisdictions.map((j) => j.code);
    const retired = await trx.updateTable('jurisdiction').set({ retired_at: sql`now()`, selectable: false })
      .where('retired_at', 'is', null).$if(live.length > 0, (q) => q.where('code', 'not in', live)).executeTakeFirst();

    // 4. Taxonomy: releases are append-only (same version, other digest = conflict); terms upserted parents first;
    //    engine relations mirror the source exactly.
    const releaseIds = new Map<string, string>();
    for (const r of data.taxonomy.releases) {
      await trx.insertInto('taxonomy_release').values({ hub_id: null, version: r.version, payload: JSON.stringify(r.payload), digest: r.digest })
        .onConflict((oc) => oc.column('version').where('hub_id', 'is', null).doNothing()).execute();
      const stored = await trx.selectFrom('taxonomy_release').select(['id', 'digest']).where('hub_id', 'is', null).where('version', '=', r.version).executeTakeFirstOrThrow();
      if (stored.digest !== r.digest) throw new KernelSyncError(`kernel: taxonomy release ${r.version} is already recorded with another digest`);
      releaseIds.set(r.version, stored.id);
    }
    const termIds = new Map<string, string>();
    for (const t of data.taxonomy.terms) {
      const parentId = t.parent === null ? null : termIds.get(t.parent);
      if (parentId === undefined) throw new KernelSyncError(`kernel: parent ${t.parent} of ${t.code} is not loaded`);
      const releaseId = t.release === null ? null : releaseIds.get(t.release);
      if (releaseId === undefined) throw new KernelSyncError(`kernel: release ${t.release} of ${t.code} is not loaded`);
      const values = { scheme: t.scheme, parent_id: parentId, status: t.status, release_id: releaseId, attributes: JSON.stringify(t.attributes) };
      const row = await trx.insertInto('taxonomy_term').values({ hub_id: null, code: t.code, ...values })
        .onConflict((oc) => oc.column('code').where('hub_id', 'is', null).doUpdateSet(values)).returning('id').executeTakeFirstOrThrow();
      termIds.set(t.code, row.id);
    }
    const wanted = new Set<string>();
    for (const r of data.taxonomy.relations) {
      const from = termIds.get(r.from);
      const to = termIds.get(r.to);
      if (!from || !to) throw new KernelSyncError(`kernel: relation ${r.from} ${r.relation} ${r.to} names an unknown term`);
      wanted.add(`${from}|${r.relation}|${to}`);
      await trx.insertInto('step_term_relation').values({ hub_id: null, from_term_id: from, relation: r.relation, to_term_id: to })
        .onConflict((oc) => oc.columns(['from_term_id', 'relation', 'to_term_id']).doNothing()).execute();
    }
    const engineRelations = await trx.selectFrom('step_term_relation').select(['id', 'from_term_id', 'relation', 'to_term_id']).where('hub_id', 'is', null).execute();
    const stale = engineRelations.filter((r) => !wanted.has(`${r.from_term_id}|${r.relation}|${r.to_term_id}`)).map((r) => r.id);
    if (stale.length) await trx.deleteFrom('step_term_relation').where('id', 'in', stale).execute();

    return {
      restricted: data.restricted.length,
      restrictionChanges: recomputed.rows[0]?.n ?? 0,
      units: data.units.length,
      conversionRules: data.conversionRules.length,
      jurisdictions: data.jurisdictions.length,
      jurisdictionsRetired: Number(retired.numUpdatedRows),
      releases: data.taxonomy.releases.length,
      terms: data.taxonomy.terms.length,
      relations: data.taxonomy.relations.length,
    };
  },
};

/* ---------- Runtime ports ---------- */

export class KernelError extends Error {
  constructor(readonly code: 'validation.unit_mismatch' | 'validation.unit_conversion' | 'validation.decimal', message: string) {
    super(message);
  }
}
async function mapKernelError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const hint = (error as { hint?: string }).hint;
    if (hint === 'validation.unit_mismatch' || hint === 'validation.unit_conversion' || hint === 'validation.decimal') throw new KernelError(hint, (error as Error).message);
    throw error;
  }
}

export const units = {
  list(trx: Transaction): Promise<Unit[]> {
    return trx.selectFrom('unit').selectAll().orderBy('dimension').orderBy('code').execute();
  },
  rule(trx: Transaction, from: string, to: string): Promise<UnitConversionRule | undefined> {
    return trx.selectFrom('unit_conversion_rule').selectAll().where('from_unit', '=', from).where('to_unit', '=', to).executeTakeFirst();
  },
};

export const quantities = {
  /** Same-unit addition (database function `kernel_quantity_add`); different units raise `validation.unit_mismatch`. */
  add(trx: Transaction, a: Quantity, b: Quantity): Promise<Quantity> {
    return mapKernelError(async () => {
      const row = await sql<{ value: string }>`SELECT trustwork.kernel_quantity_add(${a.value}, ${a.unit}, ${b.value}, ${b.unit}) AS value`.execute(trx);
      return { value: row.rows[0]?.value as string, unit: a.unit };
    });
  },
  /** Conversion only through a stored rule, with the caller's scale and rounding (no default that could hide a loss). */
  convert(trx: Transaction, quantity: Quantity, to: string, options: { scale: number; rounding: RoundingMode }): Promise<Quantity> {
    return mapKernelError(async () => {
      const row = await sql<{ value: string }>`SELECT trustwork.kernel_quantity_convert(${quantity.value}, ${quantity.unit}, ${to}, ${options.scale}::integer, ${options.rounding}) AS value`.execute(trx);
      return { value: row.rows[0]?.value as string, unit: to };
    });
  },
};

export const jurisdictions = {
  get(trx: Transaction, code: string): Promise<Jurisdiction | undefined> {
    return trx.selectFrom('jurisdiction').selectAll().where('code', '=', code).executeTakeFirst();
  },
  /** Selectable, live jurisdictions of one country (the country row and its subdivisions); restricted rows are never visible. */
  selectable(trx: Transaction, country: string): Promise<Jurisdiction[]> {
    return trx.selectFrom('jurisdiction').selectAll()
      .where(sql<string>`left(code, 2)`, '=', country.toUpperCase())
      .where('selectable', '=', true).where('retired_at', 'is', null)
      .orderBy('code').execute();
  },
  countries(trx: Transaction): Promise<Jurisdiction[]> {
    return trx.selectFrom('jurisdiction').selectAll().where('level', '=', 'country').where('selectable', '=', true).where('retired_at', 'is', null).orderBy('code').execute();
  },
};

export const taxonomy = {
  terms(trx: Transaction, scheme: TaxonomyScheme, hubId: string | null = null): Promise<TaxonomyTerm[]> {
    return trx.selectFrom('taxonomy_term').selectAll().where('scheme', '=', scheme)
      .where((eb) => (hubId === null ? eb('hub_id', 'is', null) : eb.or([eb('hub_id', 'is', null), eb('hub_id', '=', hubId)])))
      .orderBy('code').execute();
  },
  term(trx: Transaction, code: string): Promise<TaxonomyTerm | undefined> {
    return trx.selectFrom('taxonomy_term').selectAll().where('code', '=', code).where('hub_id', 'is', null).executeTakeFirst();
  },
  /** Relations from one term, with the target codes (for example the trades and materials of a plan step). */
  relationsFrom(trx: Transaction, code: string): Promise<{ relation: StepRelation; to_code: string; to_scheme: TaxonomyScheme }[]> {
    return trx.selectFrom('step_term_relation as r')
      .innerJoin('taxonomy_term as f', 'f.id', 'r.from_term_id')
      .innerJoin('taxonomy_term as t', 't.id', 'r.to_term_id')
      .select(['r.relation', 't.code as to_code', 't.scheme as to_scheme'])
      .where('f.code', '=', code).where('f.hub_id', 'is', null)
      .orderBy('r.relation').orderBy('t.code').execute();
  },
};

export const hubs = {
  get(trx: Transaction, id: string): Promise<Hub | undefined> {
    return trx.selectFrom('hub').selectAll().where('id', '=', id).executeTakeFirst();
  },
  bySlug(trx: Transaction, slug: string): Promise<Hub | undefined> {
    return trx.selectFrom('hub').selectAll().where('slug', '=', slug).executeTakeFirst();
  },
  territories(trx: Transaction, hubId: string): Promise<HubTerritory[]> {
    return trx.selectFrom('hub_territory').selectAll().where('hub_id', '=', hubId).orderBy('code').execute();
  },
  /** Maintenance only (HUB-001 adds the governed console command): the anchor row. */
  create(trx: Transaction, input: { slug: string; lifecycle?: HubLifecycle; packCode: string | null; packVersion: string | null }): Promise<Hub> {
    return trx.insertInto('hub').values({ slug: input.slug, lifecycle: input.lifecycle ?? 'draft', pack_code: input.packCode, pack_version: input.packVersion }).returningAll().executeTakeFirstOrThrow();
  },
  /** Maintenance only: the database refuses restricted, unknown or unselectable places (`kernel.restricted_place`, ...). */
  addTerritory(trx: Transaction, input: { hubId: string; level: HubTerritoryLevel; code: string }): Promise<HubTerritory> {
    const placeKey = input.level === 'place' ? (input.code.split(':')[1] ?? null) : null;
    return trx.insertInto('hub_territory').values({ hub_id: input.hubId, level: input.level, code: input.code, place_key: placeKey }).returningAll().executeTakeFirstOrThrow();
  },
};

export const exchangeRates = {
  latest(trx: Transaction, base: string, quote: string): Promise<ExchangeRateSnapshotRow | undefined> {
    return trx.selectFrom('exchange_rate_snapshot').selectAll().where('base_currency', '=', base).where('quote_currency', '=', quote)
      .orderBy('observed_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  },
  get(trx: Transaction, id: string): Promise<ExchangeRateSnapshotRow | undefined> {
    return trx.selectFrom('exchange_rate_snapshot').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Maintenance only (a rate adapter): append-only snapshot. */
  record(trx: Transaction, input: { base: string; quote: string; rate: string; source: string; observedAt: Date | string }): Promise<ExchangeRateSnapshotRow> {
    return trx.insertInto('exchange_rate_snapshot').values({ base_currency: input.base, quote_currency: input.quote, rate: input.rate, source: input.source, observed_at: input.observedAt })
      .returningAll().executeTakeFirstOrThrow();
  },
};

export interface NewEvidenceInput {
  owner: { personId: string } | { companyId: string };
  parent: { kind: EvidenceParentKind; id: string };
  classification: Exclude<EvidenceClassification, 'restricted'>;
  storageKey: string;
  sha256: string;
  bytes: number | bigint;
  mediaType: string;
  uploadedBy: string;
}

export const evidenceArtifacts = {
  /** Runtime upload record (scan pending); the policy re-checks uploader, owner party and the right to attach to the parent. */
  create(trx: Transaction, input: NewEvidenceInput): Promise<{ id: string; sha256: string }> {
    return trx.insertInto('evidence_artifact').values({
      owner_person_id: 'personId' in input.owner ? input.owner.personId : null,
      owner_company_id: 'companyId' in input.owner ? input.owner.companyId : null,
      parent_kind: input.parent.kind, parent_id: input.parent.id, classification: input.classification,
      storage_key: input.storageKey, sha256: input.sha256, bytes: input.bytes.toString(), media_type: input.mediaType, uploaded_by: input.uploadedBy,
    }).returning(['id', 'sha256']).executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<EvidenceArtifact | undefined> {
    return trx.selectFrom('evidence_artifact').selectAll().where('id', '=', id).executeTakeFirst();
  },
  forParent(trx: Transaction, kind: EvidenceParentKind, id: string): Promise<EvidenceArtifact[]> {
    return trx.selectFrom('evidence_artifact').selectAll().where('parent_kind', '=', kind).where('parent_id', '=', id).orderBy('created_at').orderBy('id').execute();
  },
  /** Maintenance only (the scanner worker). */
  setScanState(trx: Transaction, id: string, state: ScanState): Promise<EvidenceArtifact | undefined> {
    return trx.updateTable('evidence_artifact').set({ scan_state: state }).where('id', '=', id).returningAll().executeTakeFirst();
  },
};
