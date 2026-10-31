import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type { AttestedGateMode, DeploymentLocationAttestationRow, DeploymentLocationAttestationSummaryRow } from '../schema/attestation.js';
import type { CommandContext } from './admin.js';

/**
 * Deployment-location attestation repository (SANC-009, migration packages/data/migrations/attestation; ADR 014
 * decisions 3 to 5).
 *
 * - **Staff ports** under `withPrincipal` with a `CommandContext` (BE-004 elevation): attest or renew, record the
 *   denied audit row of a refused attempt (its own transaction), and read the full history (node staff only, RLS).
 * - **Reader ports** for every other consumer (launch gate, node manifest, our own services): the current attestation
 *   without the attesting person, and the SQL "in force" check.
 */
export interface AttestationInput {
  operatorEntityCountry: string;
  operatorEntityRegion: string | null;
  hostingCountry: string;
  hostingRegion: string | null;
  gateMode: AttestedGateMode;
}

const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

export const deploymentAttestations = {
  /**
   * Attests (`supersedes` null, the first time) or renews (`supersedes` = the current attestation). Refused places
   * raise `attestation.restricted_place` or `attestation.region_required`; a predecessor that is no longer current
   * raises `attestation.stale`. Audited in the same transaction.
   */
  async attest(trx: Transaction, ctx: CommandContext, input: AttestationInput & { supersedes: string | null; statementVersion: string }): Promise<DeploymentLocationAttestationRow> {
    const { rows } = await sql<DeploymentLocationAttestationRow>`SELECT * FROM trustwork.attestation_attest(${ctxJson(ctx)}::jsonb, ${input.operatorEntityCountry}::text,
      ${input.operatorEntityRegion}::text, ${input.hostingCountry}::text, ${input.hostingRegion}::text, ${input.gateMode}::text, ${input.supersedes}::uuid, ${input.statementVersion}::text)`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('attestation_attest returned no row');
    return row;
  },
  /** The denied audit row of a refused attempt; returns its audit sequence. Call in a transaction of its own. */
  async recordRefusal(trx: Transaction, ctx: CommandContext, input: AttestationInput): Promise<number> {
    const { rows } = await sql<{ v: string }>`SELECT trustwork.attestation_record_refusal(${ctxJson(ctx)}::jsonb, ${input.operatorEntityCountry}::text, ${input.operatorEntityRegion}::text,
      ${input.hostingCountry}::text, ${input.hostingRegion}::text, ${input.gateMode}::text) AS v`.execute(trx);
    return Number(rows[0]?.v);
  },
  /** The full chain, newest first, as row-level security lets the caller see it (node staff; nobody else sees a row). */
  history(trx: Transaction, limit = 50): Promise<DeploymentLocationAttestationRow[]> {
    return trx.selectFrom('deployment_location_attestation').selectAll().orderBy('attested_at', 'desc').orderBy('id').limit(limit).execute();
  },
  /** The current attestation without the attesting person, or null before the first one. Any caller. */
  async current(trx: Transaction): Promise<DeploymentLocationAttestationSummaryRow | null> {
    const { rows } = await sql<DeploymentLocationAttestationSummaryRow>`SELECT * FROM trustwork.attestation_current()`.execute(trx);
    return rows[0] ?? null;
  },
  /** The same on the pool, without a principal (node manifest, services that run before any session). */
  async currentOnPool(pool: DataPool): Promise<DeploymentLocationAttestationSummaryRow | null> {
    const { rows } = await pool.query<DeploymentLocationAttestationSummaryRow>('SELECT * FROM trustwork.attestation_current()');
    return rows[0] ?? null;
  },
  /** SQL view of "in force" at a time: current, unexpired, and naming no place refused now. Any caller. */
  async inForce(pool: DataPool, at: Date): Promise<boolean> {
    const { rows } = await pool.query<{ v: boolean }>('SELECT trustwork.attestation_in_force($1) AS v', [at]);
    return rows[0]?.v === true;
  },
};
