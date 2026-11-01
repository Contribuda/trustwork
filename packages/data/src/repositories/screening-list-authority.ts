import { sql } from 'kysely';
import type { z } from 'zod';
import { ScreeningListAuthoritySchema, type ScreeningListConfigurationSchema, type ScreeningListDecisionSchema } from '../../../contracts/src/sanctions.js';
import type { Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';

export interface RegisteredListSource {
  packCode: string; packVersion: string; factId: string; code: string; name: string; authority: string;
  sourceUrl: string; adapter: string; sourceDigest: string; snapshot: unknown;
}

/** Maintenance identity only, after validated pack/adapter resolution. No HTTP or worker grant can install facts. */
export async function syncScreeningListSources(trx: Transaction, sources: readonly RegisteredListSource[]) {
  await sql`SELECT pg_advisory_xact_lock(hashtext('screening_list_sources'))`.execute(trx);
  await sql`UPDATE trustwork.screening_list_source SET current = false WHERE current`.execute(trx);
  for (const s of sources) await sql`
    INSERT INTO trustwork.screening_list_source(pack_code,pack_version,fact_id,code,name,authority,source_url,adapter,source_digest,snapshot)
    VALUES(${s.packCode},${s.packVersion},${s.factId},${s.code},${s.name},${s.authority},${s.sourceUrl},${s.adapter},${s.sourceDigest},${JSON.stringify(s.snapshot)}::jsonb)
    ON CONFLICT(source_digest) DO UPDATE SET current = true
  `.execute(trx);
}

export async function screeningListAuthority(trx: Transaction, hubId: string) {
  const sources = await sql`SELECT id,pack_code AS "packCode",pack_version AS "packVersion",fact_id AS "factId",code,
    source_digest AS "sourceDigest",adapter FROM trustwork.screening_list_source WHERE current ORDER BY pack_code,fact_id`.execute(trx);
  const proposals = await sql<{ createdAt: Date; expiresAt: Date }>`SELECT id,hub_id AS "hubId",source_id AS "sourceId",requested_by AS "requestedBy",
    action_digest AS "actionDigest",state,created_at AS "createdAt",expires_at AS "expiresAt",cadence_seconds AS "cadenceSeconds",
    warn_after_seconds AS "warnAfterSeconds",stale_after_seconds AS "staleAfterSeconds",reason,evidence
    FROM trustwork.screening_list_proposal WHERE hub_id=${hubId}::uuid ORDER BY created_at DESC,id LIMIT 50`.execute(trx);
  return ScreeningListAuthoritySchema.parse({sources:sources.rows,proposals:proposals.rows.map((p)=>({...p,createdAt:p.createdAt.toISOString(),expiresAt:p.expiresAt.toISOString()}))});
}
export async function proposeScreeningList(trx: Transaction, ctx: CommandContext, input: z.infer<typeof ScreeningListConfigurationSchema>) {
  const {rows} = await sql<{id:string}>`SELECT trustwork.screening_list_propose(${JSON.stringify(ctx)}::jsonb,${JSON.stringify(input)}::jsonb) AS id`.execute(trx);
  return rows[0]!;
}
export async function decideScreeningList(trx: Transaction, ctx: CommandContext, id: string, input: z.infer<typeof ScreeningListDecisionSchema>) {
  const {rows} = await sql<{id:string}>`SELECT trustwork.screening_list_decide(${JSON.stringify(ctx)}::jsonb,${id}::uuid,${input.decision},${input.actionDigest},${input.reason}) AS id`.execute(trx);
  return rows[0]!;
}
