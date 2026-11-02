import { sql } from 'kysely';
import type { DataPool } from '@trustwork/data';
import type { AllowedUses } from '../../../../packages/contracts/src/hub.js';
import type { RslReading } from '../../../../packages/contracts/src/sources.js';
import type { CollectionDecision } from '../../../../packages/contracts/src/collection-policy.js';
import { inTransaction } from '../db.js';
import type { PipelineStepRegistry, StepContext } from '../pipelines/engine.js';
import type { Collector, CollectSource } from './collector.js';

/**
 * The pipeline `fetch` step (SRC-002 part 2): every source of the run's version goes through the pre-collection gate
 * before anything is requested. Allowed content is carried to the next step with the uses it may serve; a denied or
 * waiting source contributes nothing. A changed robots, terms, RSL, TDMRep or Content-Usage digest pauses every
 * pipeline that uses the source (PIPE-001 `pipelines_source_changed`, with an alert) until a person re-checks it in
 * the registry. The step never writes to the registry itself.
 */
export interface SourceRow {
  id: string; hub_id: string; kind: string; url: string | null; status: string; allowed_uses: AllowedUses; terms_automated_access: CollectSource['termsAutomatedAccess'];
  personal_data: boolean; legal_basis: string | null; terms_digest: string | null; rsl_status: string; rsl_ceiling: AllowedUses | null; rsl_digest: string | null; robots_digest: string | null;
}
export interface CollectionPort {
  source(id: string): Promise<SourceRow | null>;
  /** Pauses the pipelines of the source until a person re-checks it; returns how many schedules were paused. */
  changed(id: string, reason: 'robots' | 'terms' | 'licence'): Promise<number>;
}
export interface FetchedItem { sourceId: string; url: string; body: string; contentType: string | null; allowedUses: AllowedUses; decision: CollectionDecision }
export const FETCHED = 'collect.fetched';

/** The database side of the port, on the worker role. */
export function collectionPort(pool: DataPool): CollectionPort {
  return {
    source: (id) => inTransaction(pool, async (trx) => (await sql<SourceRow>`SELECT * FROM trustwork.sources_collection_view(${id}::uuid)`.execute(trx)).rows[0] ?? null),
    changed: (id, reason) => inTransaction(pool, async (trx) => (await sql<{ v: number }>`SELECT trustwork.pipelines_source_changed(${id}::uuid, ${reason}::text) AS v`.execute(trx)).rows[0]?.v ?? 0),
  };
}

function rslOf(row: SourceRow): RslReading | null {
  if (row.rsl_status === 'absent' || row.rsl_ceiling === null) return null;
  // The registry already holds the reading; the gate needs its status and ceiling.
  return { status: row.rsl_status as RslReading['status'], permittedUsages: [], ceiling: row.rsl_ceiling, suggested: row.rsl_ceiling, problem: null };
}

const ROBOTS_REASONS = new Set(['robots_disallow', 'robots_unavailable']);

export function fetchStep(deps: { collector: Collector; port: CollectionPort; isRestrictedHost?: (host: string) => boolean }) {
  return async (ctx: StepContext): Promise<void> => {
    const items: FetchedItem[] = [];
    for (const sourceId of ctx.version.source_ids) {
      const row = await deps.port.source(sourceId);
      if (!row || row.hub_id !== ctx.run.hub_id || !row.url) { ctx.counts.failed += 1; continue; }
      const source: CollectSource = {
        id: row.id, status: row.status, allowedUses: row.allowed_uses, termsAutomatedAccess: row.terms_automated_access, personalData: row.personal_data, legalBasis: row.legal_basis,
        rsl: rslOf(row), recorded: { robots: row.robots_digest, terms: row.terms_digest, rsl: row.rsl_digest, tdm: null, contentUsage: null },
      };
      const result = await deps.collector.collect({ url: row.url, source, restrictedPlace: deps.isRestrictedHost?.(new URL(row.url).host) ?? false });
      const d = result.decision;
      if (d.changed.length > 0) {
        await deps.port.changed(row.id, d.changed.includes('robots') ? 'robots' : d.changed.includes('terms') ? 'terms' : 'licence');
        continue;
      }
      if (d.verdict === 'allow' && result.body !== null) {
        ctx.counts.fetched += 1;
        items.push({ sourceId: row.id, url: row.url, body: result.body, contentType: result.contentType, allowedUses: d.allowedUses, decision: d });
      } else if (d.verdict === 'deny') {
        if (d.reasons.some((r) => ROBOTS_REASONS.has(r))) ctx.counts.skippedByRobots += 1;
        else ctx.counts.skippedByLicence += 1;
      }
      // A wait contributes nothing to this run; the host's next slot comes with the next run.
    }
    ctx.carry.set(FETCHED, items);
  };
}

/** Registers the `fetch` step on a pipeline step registry. */
export function registerFetchStep(registry: PipelineStepRegistry, deps: Parameters<typeof fetchStep>[0]): PipelineStepRegistry {
  return registry.on('fetch', fetchStep(deps));
}
