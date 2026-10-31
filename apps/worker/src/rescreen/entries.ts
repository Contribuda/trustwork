import type { Transaction } from '@trustwork/data';
import type { ScreeningEntryType } from '../../../../packages/contracts/src/sanctions.js';
import type { CandidateEntry } from '../../../../packages/compliance/src/matching/index.js';
import { rescreenWorker, type RescreenVersionFacts } from '../../../../packages/data/src/repositories/rescreen.js';

/**
 * The worker's in-memory view of activated list versions (SANC-005). List versions and their entries are immutable
 * (SANC-002), so a loaded version never goes stale; the cache only bounds memory.
 *
 * - `ActiveIndex`: the entries of the active versions by name-key token (and token initial, for the fuzzy layer). Its
 *   candidates for a subject are exactly what `screening_candidates` (SANC-003) answers: entries of the subject's types
 *   sharing a token (every engine-rule match shares one) or, with the fuzzy layer, a token initial.
 * - `DeltaTokens`: the tokens of the name keys that are in the active versions but not in the versions a subject was
 *   last screened against (per entry type, per list). The matcher compares each name key on its own (engine rule and
 *   fuzzy layer alike), so a key the earlier versions already had cannot change a `clear` for the same names; only a
 *   key added or changed can, and it can only when the subject shares a token (or, fuzzy, a token initial) with it.
 */

const SEP = '\u0000';
const initialOf = (token: string): string => [...token][0] as string;

interface LoadedVersion {
  facts: RescreenVersionFacts;
  entries: CandidateEntry[];
  /** `${entryType}\0${nameKey}` of every entry. */
  keys: Set<string>;
}

export interface ActiveIndex {
  readonly versionIds: readonly string[];
  readonly entryCount: number;
  candidates(types: readonly ScreeningEntryType[], tokens: readonly string[], initials: readonly string[]): CandidateEntry[];
}

export interface DeltaTokens {
  /** Tokens of added or changed name keys, by entry type. */
  readonly tokens: ReadonlyMap<ScreeningEntryType, ReadonlySet<string>>;
  readonly initials: ReadonlyMap<ScreeningEntryType, ReadonlySet<string>>;
  readonly keyCount: number;
}

/** True when the subject's tokens (or, with the fuzzy layer, their initials) meet a delta key of one of its types. */
export function touchesDelta(delta: DeltaTokens, types: readonly ScreeningEntryType[], tokens: readonly string[], fuzzy: boolean): boolean {
  for (const type of types) {
    const set = delta.tokens.get(type);
    if (set && tokens.some((t) => set.has(t))) return true;
    if (fuzzy) {
      const initials = delta.initials.get(type);
      if (initials && tokens.some((t) => initials.has(initialOf(t)))) return true;
    }
  }
  return false;
}

function buildIndex(versions: readonly LoadedVersion[]): ActiveIndex {
  const byToken = new Map<string, CandidateEntry[]>();
  const byInitial = new Map<string, CandidateEntry[]>();
  let entryCount = 0;
  for (const version of versions) {
    for (const entry of version.entries) {
      entryCount += 1;
      const tokens = new Set(entry.nameKeys.flatMap((k) => k.split(' ')).filter((t) => t !== ''));
      for (const token of tokens) {
        const list = byToken.get(token) ?? [];
        list.push(entry);
        byToken.set(token, list);
      }
      for (const initial of new Set([...tokens].map(initialOf))) {
        const list = byInitial.get(initial) ?? [];
        list.push(entry);
        byInitial.set(initial, list);
      }
    }
  }
  return {
    versionIds: versions.map((v) => v.facts.versionId).sort(),
    entryCount,
    candidates(types, tokens, initials) {
      const wanted = new Set(types);
      const found = new Map<string, CandidateEntry>();
      const add = (entries: readonly CandidateEntry[] | undefined) => {
        for (const e of entries ?? []) if (wanted.has(e.entryType)) found.set(`${e.listCode}${SEP}${e.entryUid}`, e);
      };
      for (const token of tokens) add(byToken.get(token));
      for (const initial of initials) add(byInitial.get(initial));
      return [...found.values()];
    },
  };
}

export class VersionCache {
  private readonly loaded = new Map<string, LoadedVersion>();
  private readonly facts = new Map<string, RescreenVersionFacts>();
  private readonly indexes = new Map<string, ActiveIndex>();
  private readonly deltas = new Map<string, DeltaTokens>();

  constructor(private readonly maxVersions = 8, private readonly maxDeltas = 32) {}

  /** Versions loaded from the database since this cache was created (for tests and logs). */
  loads = 0;

  private async factsOf(trx: Transaction, ids: readonly string[]): Promise<Map<string, RescreenVersionFacts>> {
    const missing = [...new Set(ids)].filter((id) => !this.facts.has(id));
    if (missing.length) for (const f of await rescreenWorker.versions(trx, missing)) this.facts.set(f.versionId, f);
    return new Map(ids.filter((id) => this.facts.has(id)).map((id) => [id, this.facts.get(id) as RescreenVersionFacts]));
  }

  private async version(trx: Transaction, facts: RescreenVersionFacts): Promise<LoadedVersion> {
    const hit = this.loaded.get(facts.versionId);
    if (hit) {
      this.loaded.delete(facts.versionId);
      this.loaded.set(facts.versionId, hit);
      return hit;
    }
    const rows = await rescreenWorker.entries(trx, facts.versionId);
    this.loads += 1;
    const entries: CandidateEntry[] = rows.map((r) => ({
      listCode: facts.listCode, listVersionId: facts.versionId, entryUid: r.entryUid, entryType: r.entryType, primaryName: r.primaryName, programs: r.programs, nameKeys: r.nameKeys, entryDigest: r.entryDigest,
    }));
    const loaded: LoadedVersion = { facts, entries, keys: new Set(entries.flatMap((e) => e.nameKeys.map((k) => `${e.entryType}${SEP}${k}`))) };
    this.loaded.set(facts.versionId, loaded);
    while (this.loaded.size > this.maxVersions) this.loaded.delete(this.loaded.keys().next().value as string);
    return loaded;
  }

  /** The index of the active versions (`screening_lists_now`). */
  async active(trx: Transaction, versionIds: readonly string[]): Promise<ActiveIndex> {
    const key = [...versionIds].sort().join(',');
    const hit = this.indexes.get(key);
    if (hit) return hit;
    const facts = await this.factsOf(trx, versionIds);
    if (facts.size !== new Set(versionIds).size) throw new Error('an active list version is unknown');
    const versions: LoadedVersion[] = [];
    for (const f of facts.values()) versions.push(await this.version(trx, f)); // one connection: load in turn
    const index = buildIndex(versions);
    this.indexes.clear(); // one active set at a time is enough
    this.indexes.set(key, index);
    return index;
  }

  /**
   * The name-key tokens in `active` that `base` lacked, per entry type. A list of `active` without a version in `base`
   * contributes every key; a base version of a list that is no longer active contributes nothing (removals never add a
   * match). Several base versions of one list (never written by SANC-003, but tolerated) all count as known.
   */
  async delta(trx: Transaction, base: readonly string[], active: readonly string[]): Promise<DeltaTokens> {
    const key = `${[...base].sort().join(',')}>${[...active].sort().join(',')}`;
    const hit = this.deltas.get(key);
    if (hit) return hit;
    const facts = await this.factsOf(trx, [...base, ...active]);
    const tokens = new Map<ScreeningEntryType, Set<string>>();
    const initials = new Map<ScreeningEntryType, Set<string>>();
    let keyCount = 0;
    for (const id of new Set(active)) {
      const a = facts.get(id);
      if (!a) throw new Error('an active list version is unknown');
      if (base.includes(id)) continue; // the subject already saw this version
      const known: LoadedVersion[] = [];
      for (const b of new Set(base)) {
        const f = facts.get(b);
        if (f && f.listId === a.listId) known.push(await this.version(trx, f));
      }
      const current = await this.version(trx, a);
      for (const entry of current.entries) {
        for (const nameKey of entry.nameKeys) {
          const k = `${entry.entryType}${SEP}${nameKey}`;
          if (known.some((v) => v.keys.has(k))) continue;
          keyCount += 1;
          const set = tokens.get(entry.entryType) ?? new Set<string>();
          const initialSet = initials.get(entry.entryType) ?? new Set<string>();
          for (const token of nameKey.split(' ')) {
            if (token === '') continue;
            set.add(token);
            initialSet.add(initialOf(token));
          }
          tokens.set(entry.entryType, set);
          initials.set(entry.entryType, initialSet);
        }
      }
    }
    const delta: DeltaTokens = { tokens, initials, keyCount };
    this.deltas.set(key, delta);
    while (this.deltas.size > this.maxDeltas) this.deltas.delete(this.deltas.keys().next().value as string);
    return delta;
  }
}
