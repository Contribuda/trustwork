import { sql } from 'kysely';
import { GateStateSchema, type GateState } from '../../../contracts/src/screening-gates.js';
import type { ScreeningSubjectRef } from '../../../contracts/src/sanctions.js';
import type { Transaction } from '../pool.js';

/**
 * Screening gates repository (SANC-004, migration packages/data/migrations/screening-gates; ADR 014 decision 13).
 *
 * - `check(trx, subjects)`: the gate's read inside the transaction that binds the commitment or moves the money. It
 *   locks what a racing decision, result, list activation or hold would write (until the caller's transaction ends)
 *   and then reads with a fresh snapshot, so no commitment binds on a stale answer. It raises when the state cannot be
 *   read; the caller must then refuse.
 * - `declarePlace(trx, place, source)`: the caller declares their own place; answers whether it is restricted and, if
 *   so, holds the caller. Run it in a transaction of its own that commits before the refusal.
 */
interface GateRow { subject_kind: 'person' | 'company'; subject_id: string; money_held: boolean; suspended: boolean; reasons: string[]; appealable: boolean; place_hold: boolean }

export const screeningGates = {
  async check(trx: Transaction, subjects: readonly ScreeningSubjectRef[]): Promise<GateState[]> {
    const { rows } = await sql<GateRow>`SELECT * FROM trustwork.screening_gate_check(${subjects.map((s) => s.kind)}::text[], ${subjects.map((s) => s.id)}::uuid[])`.execute(trx);
    return rows.map((r) => GateStateSchema.parse({
      subject: { kind: r.subject_kind, id: r.subject_id }, moneyHeld: r.money_held, suspended: r.suspended, reasons: [...new Set(r.reasons)], appealable: r.appealable, placeHold: r.place_hold,
    }));
  },
  async declarePlace(trx: Transaction, place: string, source: 'self_declared' | 'payout_country'): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.screening_gate_declare_place(${place}::text, ${source}::text) AS v`.execute(trx);
    return rows[0]?.v === true;
  },
};
