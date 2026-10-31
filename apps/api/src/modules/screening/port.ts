import type { Transaction } from '../../deps/data.js';
import { screeningStates, type ScreeningState, type ScreeningSubjectRef } from './deps.js';

/**
 * The internal `screeningState(subject)` port the gates read (SANC-004; ADR 014 decision 13). It answers the effective
 * state: money is held while the subject is unscreened, has an `insufficient_name` result, an open or confirmed
 * match, a result older than the active baseline versions, or while the baseline is missing or stale.
 *
 * Fail closed: when the state cannot be read this throws, and a gate that catches it must refuse. Callers never show
 * the reasons to anyone but the subject's own status page; a counterparty learns only that the other side cannot
 * transact now.
 */
export function screeningState(trx: Transaction, subject: ScreeningSubjectRef, now: Date = new Date()): Promise<ScreeningState> {
  return screeningStates.state(trx, subject, now);
}

/** Convenience for gates: true only when the subject may receive money or bind a commitment now. */
export async function screeningAllowsMoney(trx: Transaction, subject: ScreeningSubjectRef, now: Date = new Date()): Promise<boolean> {
  return !(await screeningState(trx, subject, now)).moneyHeld;
}
