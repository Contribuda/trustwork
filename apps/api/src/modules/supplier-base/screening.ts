import { sql } from 'kysely';
import type { Transaction } from '../../deps/data.js';
import { screeningAllowsMoney } from '../screening/port.js';

/**
 * Counterparty screening for the supplier card and the onboarding checklist, through SANC-003's gate port only
 * (`screeningState`). The buyer learns one fact, as every counterparty does: whether the supplier can transact now.
 * Reasons, matches and list entries are never shown to the buyer. Fail closed: an unreadable state is `unavailable`
 * and counts as not clear; an external counterparty is not a platform subject and is `not_screenable` (the hub screens
 * a company when it joins).
 */
export type ScreeningView = 'clear' | 'cannot_transact_now' | 'not_screenable' | 'unavailable';

export interface SupplierScreeningPort {
  /** True only when the company may receive money or bind a commitment now; throws when the state cannot be read. */
  canTransact(trx: Transaction, company: string, now: Date): Promise<boolean>;
}

export const sanctionsScreening: SupplierScreeningPort = {
  canTransact: (trx, company, now) => screeningAllowsMoney(trx, { kind: 'company', id: company }, now),
};

/** Reads the port inside a savepoint, so a refusal of the port never aborts the caller's transaction. */
export async function screeningOf(trx: Transaction, port: SupplierScreeningPort, company: string | null, now: Date): Promise<ScreeningView> {
  if (company === null) return 'not_screenable';
  await sql`SAVEPOINT supplier_base_screening`.execute(trx);
  try {
    const clear = await port.canTransact(trx, company, now);
    await sql`RELEASE SAVEPOINT supplier_base_screening`.execute(trx);
    return clear ? 'clear' : 'cannot_transact_now';
  } catch {
    await sql`ROLLBACK TO SAVEPOINT supplier_base_screening`.execute(trx);
    return 'unavailable';
  }
}
