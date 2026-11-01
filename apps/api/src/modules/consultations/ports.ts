import type { Money, Party } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ScreeningGate } from '../screening-gates/gate.js';
import { commissionOn, type CommissionQuote, type ConsultationKind } from './deps.js';

/* ---------- Hub commission (BILL-003) ---------- */

/**
 * The hub's commission on one consultation booking (ADR 010 decision 21): a versioned hub price setting with a
 * second-person activation, an effective date and public disclosure, the same for every expert in a category. Billing
 * settings are BILL-003, not built yet: until then the port answers `none_published` and nothing is added. The quote is
 * frozen into the proposed terms (and so into the booked digest); payment never changes ranking, matching or reputation.
 */
export interface ConsultationCommissionPort {
  quote(trx: Transaction, input: { kind: ConsultationKind; price: Money | null; expert: Party; at: Date; requestId: string }): Promise<CommissionQuote>;
  origin?(trx: Transaction, kind: 'offering' | 'request', id: string): Promise<void>;
  proposed?(trx: Transaction, bookingId: string): Promise<void>;
  confirmed?(trx: Transaction, bookingId: string, side: 'buyer' | 'seller'): Promise<void>;
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
  async quote(_trx: Transaction, input: { price: Money | null }): Promise<CommissionQuote> {
    return input.price ? commissionOn(input.price, this.setting) : { status: 'none_published' };
  }
}

/* ---------- Screening gate (SANC-004) ---------- */

/** The shared SANC-004 gate holds its locks until the consultation transaction ends. */
export type ConsultationGatePurpose = 'consultation.propose' | 'consultation.accept' | 'consultation.confirm';
export interface ConsultationScreeningGate {
  requireTransactable(trx: Transaction, subjects: readonly { party: Party; self: boolean }[], purpose: ConsultationGatePurpose, now: Date): Promise<void>;
}
export class ScreeningCommitmentGate implements ConsultationScreeningGate {
  async requireTransactable(trx: Transaction, subjects: readonly { party: Party; self: boolean }[], purpose: ConsultationGatePurpose, now: Date): Promise<void> {
    const purposes = { 'consultation.propose': 'quote_send', 'consultation.accept': 'terms_accept', 'consultation.confirm': 'order_accept' } as const;
    await new ScreeningGate({ now: () => now }).requireTransactable(
      trx, subjects.map(({ party, self }) => ({ subject: party, side: self ? 'own' : 'counterparty' })), purposes[purpose],
    );
  }
}
