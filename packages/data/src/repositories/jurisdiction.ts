import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type { JurisdictionHoldEvidence, JurisdictionHoldRow, JurisdictionRefusalCountRow } from '../schema/jurisdiction.js';
import type { CommandContext } from './admin.js';

/**
 * Jurisdiction repository (SANC-001, migration packages/data/migrations/jurisdiction; ADR 014 decisions 6 to 9).
 *
 * - **Gate ports** (`jurisdictionGate`), called by the API's gate hook on the pool before or beside principal
 *   resolution: they take the SHA-256 of the presented session token, so only someone holding a live session can hold
 *   or ask about its person. No address is ever passed.
 * - **Sign-in port** (`jurisdictionHolds.callerHeld`), inside the principal transaction of the person being signed in.
 * - **Staff ports**: list and clear under `withPrincipal` with a `CommandContext` (BE-004 elevation); the database
 *   checks the compliance-officer role at the node, refuses the subject and declared conflicts, and audits the clear.
 */
const hash = (hex: string): Buffer => Buffer.from(hex, 'hex');

export const jurisdictionGate = {
  /** Holds the person of the live session; true when this call opened the hold (false: not live, or already held). */
  async holdSession(pool: DataPool, input: { tokenHashHex: string; place: string; source: 'geolocation' | 'edge_header'; dataset: string }): Promise<boolean> {
    const { rows } = await pool.query<{ v: boolean }>('SELECT trustwork.jurisdiction_hold_session($1, $2, $3, $4) AS v', [hash(input.tokenHashHex), input.place, input.source, input.dataset]);
    return rows[0]?.v === true;
  },
  /** Is the person of this live session held? */
  async sessionHeld(pool: DataPool, tokenHashHex: string): Promise<boolean> {
    const { rows } = await pool.query<{ v: boolean }>('SELECT trustwork.jurisdiction_session_held($1) AS v', [hash(tokenHashHex)]);
    return rows[0]?.v === true;
  },
  /** One refusal for today's counter of the place and door. */
  async countRefusal(pool: DataPool, input: { place: string; door: 'web' | 'api'; held: boolean }): Promise<void> {
    await pool.query('SELECT trustwork.jurisdiction_count_refusal($1, $2, $3)', [input.place, input.door, input.held]);
  },
  /** The synced kernel list of restricted places (empty when the maintenance command has not run). */
  async restrictedPlaces(pool: DataPool): Promise<string[]> {
    const { rows } = await pool.query<{ code: string }>('SELECT code FROM trustwork.restricted_place ORDER BY code');
    return rows.map((r) => r.code);
  },
};

export const jurisdictionHolds = {
  /** Inside the principal transaction of the person being signed in: is the caller held? */
  async callerHeld(trx: Transaction): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.jurisdiction_hold_open() AS v`.execute(trx);
    return rows[0]?.v === true;
  },
  /** Holds visible to the caller (compliance officers and auditors of the node; nobody else sees any). */
  list(trx: Transaction, filter: { open?: boolean; personId?: string } = {}, limit = 200): Promise<JurisdictionHoldRow[]> {
    let query = trx.selectFrom('jurisdiction_hold').selectAll();
    if (filter.open === true) query = query.where('cleared_at', 'is', null);
    if (filter.open === false) query = query.where('cleared_at', 'is not', null);
    if (filter.personId) query = query.where('person_id', '=', filter.personId);
    return query.orderBy('placed_at', 'desc').orderBy('id').limit(limit).execute();
  },
  /** Clears a hold as a compliance officer of the node (never the subject); audited in the same transaction. */
  async clear(trx: Transaction, ctx: CommandContext, input: { holdId: string; reason: string; evidence: JurisdictionHoldEvidence }): Promise<JurisdictionHoldRow> {
    const { rows } = await sql<JurisdictionHoldRow>`SELECT * FROM trustwork.jurisdiction_clear_hold(${JSON.stringify(ctx)}::jsonb, ${input.holdId}::uuid, ${input.reason}::text, ${input.evidence}::text)`.execute(trx);
    return rows[0] as JurisdictionHoldRow;
  },
  refusalCounts(trx: Transaction, sinceDay: Date): Promise<JurisdictionRefusalCountRow[]> {
    return trx.selectFrom('jurisdiction_refusal_count').selectAll().where('day', '>=', sinceDay).orderBy('day').orderBy('place').orderBy('door').execute();
  },
};
