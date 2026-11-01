import type { Transaction } from '../../deps/data.js';
import { LocalApiError } from '../../common/errors.js';
import { gateVerdict, screeningGates, type GateState, type GateSubject, type GateVerdict, type ScreeningGatePurpose } from './deps.js';

/** Messages of the refusals (English API text; the web shows the locale key `error.<code>`). The counterparty's never says why. */
const MESSAGES: Record<Exclude<GateVerdict, { ok: true }>['code'], string> = {
  'screening.unavailable': 'compliance screening is temporarily unavailable; no payment or commitment can be made now',
  'jurisdiction.restricted': 'this is not available in your location',
  'screening.review_pending': 'payments and commitments on your side are paused until a compliance check is complete',
  'commercial.counterparty_unavailable': 'the other party cannot transact right now',
};

/** The refusal a gate throws: a local API code (`SCREENING_GATE_ERROR_STATUS`) with the caller's own words only. */
export function gateRefusal(verdict: Exclude<GateVerdict, { ok: true }>, purpose: ScreeningGatePurpose): LocalApiError {
  if (verdict.code === 'screening.review_pending') return new LocalApiError(verdict.code, MESSAGES[verdict.code], { purpose, subject: verdict.details.subject, messageKeys: verdict.details.messageKeys });
  // Nothing about anyone: not the subject, not the reason, not even the purpose for a counterparty refusal.
  if (verdict.code === 'commercial.counterparty_unavailable') return new LocalApiError(verdict.code, MESSAGES[verdict.code]);
  return new LocalApiError(verdict.code, MESSAGES[verdict.code], { purpose });
}

/**
 * The money and commitment gate (SANC-004; ADR 014 decision 13). `requireTransactable(trx, subjects, purpose)` runs
 * inside the transaction that binds the commitment or moves the money, after the caller's own authority (and an
 * agent's mandate) was checked and before anything is written:
 *
 * - it reads every subject's effective screening state and open jurisdiction hold through
 *   `trustwork.screening_gate_check`, which locks what a racing decision, result, list activation or hold writes until
 *   this transaction ends, so the commitment never binds on a stale answer;
 * - it refuses unless every subject is clear (`gateVerdict`), and it refuses when the state cannot be read at all
 *   (`screening.unavailable`): a gate without an answer never lets money move;
 * - a counterparty refusal carries no detail (`commercial.counterparty_unavailable`).
 *
 * There is no switch: no setting, mandate, extension or staff role turns it off (ADR 014 decision 16).
 */
export class ScreeningGate {
  constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async requireTransactable(trx: Transaction, subjects: readonly GateSubject[], purpose: ScreeningGatePurpose): Promise<void> {
    const verdict = gateVerdict(subjects, await this.read(trx, subjects), this.clock.now());
    if (!verdict.ok) throw gateRefusal(verdict, purpose);
  }

  /** The states, or null when they cannot be read (the transaction is then failed: the caller must refuse and roll back). */
  private async read(trx: Transaction, subjects: readonly GateSubject[]): Promise<GateState[] | null> {
    if (subjects.length === 0) return null;
    try {
      return await screeningGates.check(trx, subjects.map((s) => s.subject));
    } catch {
      return null;
    }
  }
}
