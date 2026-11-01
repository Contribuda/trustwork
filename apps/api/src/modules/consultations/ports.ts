import type { Money, Party } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import { screeningState } from '../screening/port.js';
import { commissionOn, type CommissionQuote, type ConsultationKind } from './deps.js';

/* ---------- Hub commission (BILL-003) ---------- */

/**
 * The hub's commission on one consultation booking (ADR 010 decision 21): a versioned hub price setting with a
 * second-person activation, an effective date and public disclosure, the same for every expert in a category. Billing
 * settings are BILL-003, not built yet: until then the port answers `none_published` and nothing is added. The quote is
 * frozen into the proposed terms (and so into the booked digest); payment never changes ranking, matching or reputation.
 */
export interface ConsultationCommissionPort {
  quote(trx: Transaction, input: { kind: ConsultationKind; price: Money; expert: Party; at: Date }): Promise<CommissionQuote>;
}
/** Default until BILL-003: no commission is published, so none is charged or shown as owed. */
export class NoPublishedCommission implements ConsultationCommissionPort {
  async quote(): Promise<CommissionQuote> {
    return { status: 'none_published' };
  }
}
/** Fake for tests and demos: one published setting for every kind. */
export class FixedRateCommission implements ConsultationCommissionPort {
  constructor(private readonly setting: { id: string; version: number; rateBps: number; fixedFee: Money | null; payer: 'client' | 'expert' }) {}
  async quote(_trx: Transaction, input: { price: Money }): Promise<CommissionQuote> {
    return commissionOn(input.price, this.setting);
  }
}

/* ---------- Screening gate (SANC-004) ---------- */

/**
 * The screening gate a consultation commitment passes before it binds (ADR 014 decision 13): no agreement is accepted
 * or confirmed while either party is held, matched, unscreened or screened against stale lists, and the gate fails
 * closed when the screening state cannot be read. SANC-004 (`apps/api/src/modules/screening-gates`, not merged yet)
 * provides `requireTransactable(subjects, purpose)`; until it lands this port reads SANC-003's `screeningState`
 * directly. The counterparty learns only that the other side cannot transact now; the subject is pointed to its own
 * compliance status page.
 */
export type ConsultationGatePurpose = 'consultation.accept' | 'consultation.confirm';
export interface ConsultationScreeningGate {
  /** Throws `ApiError` (403) when any subject cannot bind a commitment now; `self` is the acting side. */
  requireTransactable(trx: Transaction, subjects: readonly { party: Party; self: boolean }[], purpose: ConsultationGatePurpose, now: Date): Promise<void>;
}
export class ScreeningStateGate implements ConsultationScreeningGate {
  async requireTransactable(trx: Transaction, subjects: readonly { party: Party; self: boolean }[], purpose: ConsultationGatePurpose, now: Date): Promise<void> {
    for (const subject of subjects) {
      let held: boolean;
      try {
        held = (await screeningState(trx, { kind: subject.party.kind, id: subject.party.id }, now)).moneyHeld;
      } catch {
        // Fail closed: an unreadable state is never "clear".
        throw new ApiError('access.forbidden', 'the commitment cannot be checked now', { reason: 'screening_unavailable', purpose });
      }
      if (held) {
        throw subject.self
          ? new ApiError('access.forbidden', 'your account has a compliance check pending', { reason: 'screening_review_pending', purpose })
          : new ApiError('access.forbidden', 'the other party cannot take on commitments right now', { reason: 'party_cannot_transact_now', purpose });
      }
    }
  }
}
/** Fake for tests: refuses exactly the listed subjects (as the real gate words it), allows everyone else. */
export class ListScreeningGate implements ConsultationScreeningGate {
  readonly checks: { subjects: string[]; purpose: ConsultationGatePurpose }[] = [];
  constructor(private readonly held: ReadonlySet<string> = new Set(), private readonly unavailable = false) {}
  async requireTransactable(_trx: Transaction, subjects: readonly { party: Party; self: boolean }[], purpose: ConsultationGatePurpose): Promise<void> {
    this.checks.push({ subjects: subjects.map((s) => s.party.id), purpose });
    if (this.unavailable) throw new ApiError('access.forbidden', 'the commitment cannot be checked now', { reason: 'screening_unavailable', purpose });
    for (const s of subjects) {
      if (this.held.has(s.party.id)) {
        throw new ApiError('access.forbidden', s.self ? 'your account has a compliance check pending' : 'the other party cannot take on commitments right now', { reason: s.self ? 'screening_review_pending' : 'party_cannot_transact_now', purpose });
      }
    }
  }
}
