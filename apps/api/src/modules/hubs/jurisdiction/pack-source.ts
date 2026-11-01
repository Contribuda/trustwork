import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { JurisdictionCodeSchema, jurisdictionRestricted } from '../../../../../../packages/contracts/src/hub.js';
import { JurisdictionSourceSchema, type JurisdictionSource, type JurisdictionBaselineResult } from '../../../../../../packages/contracts/src/jurisdiction.js';
import { findRepositoryRoot } from '../../plans/facets.js';
import { restrictedPlacesFromPacks } from '../../assistant/policy.js';

/** Read-only evidence, not executable law. Keep source claims and counsel status exactly as recorded. */
const Fact = z.object({
  executable: JurisdictionSourceSchema.optional(),
  id: z.string(), topic: z.enum(['disclosure', 'liability', 'consent', 'record-keeping', 'action-limit', 'other']),
  summary: z.record(z.string(), z.string()),
  verification: z.enum(['official', 'secondary', 'candidate', 'pending']),
  counselReview: z.enum(['pending', 'done']).optional(),
  sources: z.array(z.object({ url: z.url(), what: z.string(), accessed: z.string() })).min(1),
}).passthrough();
const Facets = z.object({ agentLaw: z.array(Fact).optional() }).passthrough();
const Pack = z.object({
  code: z.string(), enabled: z.boolean(), layers: z.array(z.string().regex(/^[A-Z][A-Z0-9-]{1,15}$/)).optional(),
  facets: Facets.optional(),
  regions: z.array(z.object({ code: z.string(), parent: z.string().optional(), facets: Facets.optional() }).passthrough()),
}).passthrough();
export interface JurisdictionFactEvidence {
  scope: string;
  layer: string | null;
  fact: z.infer<typeof Fact>;
}
export interface JurisdictionPackInspection {
  jurisdiction: string;
  baseline: JurisdictionBaselineResult;
  facts: JurisdictionFactEvidence[];
  executableSource?: JurisdictionSource;
}
export interface JurisdictionPackSource {
  inspect(jurisdiction: string): JurisdictionPackInspection;
}

/**
 * Prose facts remain evidence only. A complete explicit ADR022 executable source can be read only when its
 * jurisdiction, provenance, official verification, counsel review and effective interval all match. No current
 * country pack is promoted to executable law by this adapter; missing reviewed records stay UNKNOWN.
 */
export class RepositoryJurisdictionPacks implements JurisdictionPackSource {
  constructor(private readonly root: string | null = findRepositoryRoot()) {}

  inspect(jurisdiction: string): JurisdictionPackInspection {
    const facts: JurisdictionFactEvidence[] = [];
    const reasons: string[] = [];
    const unknown = (): JurisdictionPackInspection => ({ jurisdiction, facts, baseline: { status: 'unknown', reasons: [...new Set(reasons)].sort() } });
    if (!JurisdictionCodeSchema.safeParse(jurisdiction).success || jurisdictionRestricted(jurisdiction, restrictedPlacesFromPacks(this.root))) {
      reasons.push('jurisdiction_refused'); return unknown();
    }
    if (!this.root) { reasons.push('pack_unavailable'); return unknown(); }
    const country = jurisdiction.slice(0, 2);
    const path = join(this.root, 'packages/country-packs/packs', `${country.toLowerCase()}.json`);
    if (!existsSync(path)) { reasons.push('pack_unavailable'); return unknown(); }
    try {
      const pack = Pack.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (!pack.enabled || pack.code !== country) { reasons.push('pack_unavailable'); return unknown(); }
      const byId = new Map<string, JurisdictionFactEvidence>();
      for (const layer of pack.layers ?? []) {
        // Layers contribute evidence only; invalid or missing layer data cannot be silently skipped.
        const raw = z.object({ code: z.string(), facets: Facets }).passthrough().parse(JSON.parse(readFileSync(join(this.root, 'packages/country-packs/layers', `${layer.toLowerCase()}.json`), 'utf8')));
        if (raw.code !== layer) throw new Error('layer code mismatch');
        for (const fact of raw.facets.agentLaw ?? []) byId.set(fact.id, { scope: country, layer, fact });
      }
      for (const fact of pack.facets?.agentLaw ?? []) byId.set(fact.id, { scope: country, layer: null, fact });
      const region = jurisdiction.split(':')[0]!;
      const ancestors: typeof pack.regions = [];
      const visited = new Set<string>();
      let cursor = region === country ? undefined : region;
      while (cursor) {
        if (visited.has(cursor)) throw new Error('region cycle');
        visited.add(cursor);
        const found = pack.regions.find((r) => r.code === cursor);
        if (!found) { reasons.push('region_unknown'); break; }
        ancestors.unshift(found);
        cursor = found.parent;
      }
      for (const ancestor of ancestors) for (const fact of ancestor.facets?.agentLaw ?? []) byId.set(fact.id, { scope: ancestor.code, layer: null, fact });
      facts.push(...[...byId.values()].sort((a, b) => a.fact.id.localeCompare(b.fact.id, 'en')));
      const executable = facts.filter(({ fact }) => fact.executable?.jurisdiction === jurisdiction);
      if (executable.length === 1) {
        const entry = executable[0]!; const rule = entry.fact.executable!;
        const now = new Date().toISOString();
        const provenanceMatches = rule.provenance.some((ref) => ref.factKey === entry.fact.id && ref.packCode === (entry.layer ?? country)
          && entry.fact.sources.some((source) => source.url === ref.url && source.accessed === ref.accessed));
        if (!reasons.length && entry.fact.verification === 'official' && entry.fact.counselReview === 'done' && provenanceMatches
          && rule.effectiveFrom <= now && (rule.effectiveUntil === null || rule.effectiveUntil > now)) {
          const packDefaults = [...rule.mandatoryAreas, ...rule.advisoryAreas].flatMap((area) => rule.provenance.map((ref) => ({
            area, fact: { packCode: country, packVersion: ref.packVersion, factKey: ref.factKey },
          })));
          return { jurisdiction, facts, executableSource: rule, baseline: { status: 'known', baseline: {
            jurisdiction, policy: rule.policy, mandatoryAreas: rule.mandatoryAreas, packDefaults,
          } } };
        }
        reasons.push('executable_source_unreviewed_or_stale');
      } else if (executable.length > 1) reasons.push('executable_source_ambiguous');
      if (jurisdiction.includes(':')) reasons.push('place_applicability_unknown');
      if (!facts.length) reasons.push('agent_law_facts_missing');
      if (facts.some((entry) => entry.fact.counselReview !== 'done')) reasons.push('counsel_review_pending');
      if (facts.some((entry) => entry.fact.verification !== 'official')) reasons.push('facts_not_official');
      reasons.push('mandatory_baseline_not_representable', 'action_applicability_not_representable', 'liability_allocation_not_representable', 'retention_bounds_not_representable');
    } catch {
      facts.splice(0);
      reasons.push('pack_invalid');
    }
    return unknown();
  }
}
