import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { SetupRunRow } from '../schema/setup.js';

/** A candidate list entry for screening the operator entity (the shape the SANC-003 matcher compares). */
export interface SetupCandidateRow {
  listCode: string;
  listVersionId: string;
  entryUid: string;
  entryType: 'individual' | 'entity' | 'vessel' | 'aircraft';
  primaryName: string;
  programs: string[];
  nameKeys: string[];
  entryDigest: string;
}

/**
 * Setup wizard persistence (HUB-004, migration packages/data/migrations/setup). Every call takes the SHA-256 of the
 * setup token (never the token); the database finds the open run of that hash or raises `setup.not_found`.
 *
 * - **Owner-run** (`withMaintenance`, the installer or the migrate job): `issueToken`.
 * - **Token calls** (`withoutPrincipal` before the founding administrator exists, `withPrincipal` after): `open`,
 *   `save`, `claimAdmin`, the screening reads.
 * - **Founding administrator calls** (`withPrincipal` as that person): `bootstrapAdmin` (step 5b) and `finish`, which
 *   runs in the transaction that created the hub through HUB-001 and attested the deployment location (SANC-009).
 */
async function one(query: ReturnType<typeof sql<SetupRunRow>>, trx: Transaction, what: string): Promise<SetupRunRow> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export const setupRuns = {
  /** Owner-run: issue a token (or replace the current one); refused once setup finished (`setup.finished`). */
  issueToken(trx: Transaction, tokenHash: string, expiresAt: Date): Promise<SetupRunRow> {
    return one(sql<SetupRunRow>`SELECT * FROM trustwork.setup_issue_token(${tokenHash}::text, ${expiresAt}::timestamptz)`, trx, 'setup_issue_token');
  },
  /** The open run of a token hash, or null (unknown, expired, used, or setup finished). */
  async open(trx: Transaction, tokenHash: string): Promise<SetupRunRow | null> {
    const { rows } = await sql<SetupRunRow>`SELECT * FROM trustwork.setup_open(${tokenHash}::text)`.execute(trx);
    return rows[0] ?? null;
  },
  /** Stores one step's answer in order; refusals: `setup.step_out_of_order`, `setup.restricted_place`, `setup.first_admin_only`, ... */
  save(trx: Transaction, tokenHash: string, step: string, answer: Record<string, unknown>): Promise<SetupRunRow> {
    return one(sql<SetupRunRow>`SELECT * FROM trustwork.setup_save(${tokenHash}::text, ${step}::text, ${JSON.stringify(answer)}::jsonb)`, trx, 'setup_save');
  },
  /** Step 5a: the address of the founding administrator's new account. */
  claimAdmin(trx: Transaction, tokenHash: string, email: string): Promise<SetupRunRow> {
    return one(sql<SetupRunRow>`SELECT * FROM trustwork.setup_claim_admin(${tokenHash}::text, ${email}::text)`, trx, 'setup_claim_admin');
  },
  /** Step 5b, as the signed-in person: they become the founding administrator (second factor and recovery codes required). */
  bootstrapAdmin(trx: Transaction, tokenHash: string, secondFactor: 'totp' | 'webauthn'): Promise<SetupRunRow> {
    return one(sql<SetupRunRow>`SELECT * FROM trustwork.setup_bootstrap_admin(${tokenHash}::text, ${secondFactor}::text)`, trx, 'setup_bootstrap_admin');
  },
  /** Step 9 begins, as the founding administrator: locks the run (a simultaneous finish waits, then finds it finished). */
  beginFinish(trx: Transaction, tokenHash: string): Promise<SetupRunRow> {
    return one(sql<SetupRunRow>`SELECT * FROM trustwork.setup_begin_finish(${tokenHash}::text)`, trx, 'setup_begin_finish');
  },
  /** Step 9, as the founding administrator, after the hub was created and the location attested in this transaction. */
  finish(trx: Transaction, tokenHash: string, hubId: string): Promise<SetupRunRow> {
    return one(sql<SetupRunRow>`SELECT * FROM trustwork.setup_finish(${tokenHash}::text, ${hubId}::uuid)`, trx, 'setup_finish');
  },
  /** The active screening lists and whether screening is available (for screening the operator entity). */
  async screeningLists(trx: Transaction, tokenHash: string): Promise<{ available: boolean; versions: { listCode: string; baseline: boolean; versionId: string }[] }> {
    const { rows } = await sql<{ list_code: string; baseline: boolean; version_id: string; available: boolean }>`SELECT * FROM trustwork.setup_screening_lists(${tokenHash}::text)`.execute(trx);
    return { available: rows.length > 0 && rows.every((r) => r.available), versions: rows.map((r) => ({ listCode: r.list_code, baseline: r.baseline, versionId: r.version_id })) };
  },
  /** Candidate entries of the active versions sharing a name-key token (or an initial) with the operator's name. */
  async screeningCandidates(trx: Transaction, tokenHash: string, input: { entryTypes: readonly string[]; tokens: readonly string[]; initials: readonly string[] }): Promise<SetupCandidateRow[]> {
    const { rows } = await sql<{ list_code: string; list_version_id: string; entry_uid: string; entry_type: SetupCandidateRow['entryType']; primary_name: string; programs: string[]; name_keys: string[]; entry_digest: string }>`
      SELECT * FROM trustwork.setup_screening_candidates(${tokenHash}::text, ${[...input.entryTypes]}::text[], ${[...input.tokens]}::text[], ${[...input.initials]}::text[])`.execute(trx);
    return rows.map((r) => ({ listCode: r.list_code, listVersionId: r.list_version_id, entryUid: r.entry_uid, entryType: r.entry_type, primaryName: r.primary_name, programs: r.programs, nameKeys: r.name_keys, entryDigest: r.entry_digest }));
  },
};
