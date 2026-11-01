import { withPrincipal, type DataPool, type Principal, type Transaction } from '../../deps/data.js';
import { ApiError, LocalApiError } from '../../common/errors.js';
import { ScreeningGate } from './gate.js';
import { PayeeSchema, PayoutCountrySchema, screeningGates, type GateSubject, type Payee } from './deps.js';

/**
 * Payee and payout-country helpers for PAY-001 and BILL-002 (SANC-004; ADR 014 decisions 9, 12 and 13). Trustwork
 * never holds money (ADR 010 decision 20); these run before a licensed provider is asked to create a payout account or
 * to pay out, in this order:
 *
 * 1. `requirePayoutCountry(declarer, country)`: a payout country in a restricted place is refused before any provider
 *    is called, and the declaring person is held (`jurisdiction_hold`, source `payout_country`). The hold is committed
 *    in a transaction of its own, so it outlives the refused request. A country that cannot be checked refuses.
 * 2. `requirePayee(trx, payee, purpose)`: inside the money transaction, the payee and the declaring person must be
 *    transactable (`ScreeningGate`); a payee is screened before a payout account is created and before every payout.
 * 3. Only then the provider (`guardPayout` runs the three steps and calls the provider last).
 */
export class PayoutGate {
  constructor(private readonly pool: DataPool, private readonly gate: ScreeningGate = new ScreeningGate()) {}

  async requirePayoutCountry(declarer: Principal, country: string): Promise<void> {
    const parsed = PayoutCountrySchema.safeParse(country);
    if (!parsed.success) throw new ApiError('validation.schema', 'a payout country is an ISO 3166 code', { reason: 'invalid_country' });
    let restricted: boolean;
    try {
      restricted = await withPrincipal(this.pool, declarer, (trx) => screeningGates.declarePlace(trx, parsed.data, 'payout_country'));
    } catch {
      throw new LocalApiError('screening.unavailable', 'the payout country could not be checked; nothing was sent to a provider', { purpose: 'payout_account' });
    }
    if (restricted) throw new LocalApiError('jurisdiction.restricted', 'payouts to this place are not available', { purpose: 'payout_account' });
  }

  async requirePayee(trx: Transaction, payee: Payee, purpose: 'payout_account' | 'payout'): Promise<void> {
    const p = PayeeSchema.parse(payee);
    const subjects: GateSubject[] = [{ subject: p.subject, side: 'own' }];
    if (!(p.subject.kind === 'person' && p.subject.id === p.declaredBy)) subjects.push({ subject: { kind: 'person', id: p.declaredBy }, side: 'own' });
    await this.gate.requireTransactable(trx, subjects, purpose);
  }

  /** The whole order for a payout account or a payout: country, then payee, then the provider (called last, at most once). */
  async guardPayout<T>(input: { declarer: Principal; trx: Transaction; payee: Payee; purpose: 'payout_account' | 'payout' }, provider: () => Promise<T>): Promise<T> {
    if (input.declarer.personId !== input.payee.declaredBy) throw new ApiError('access.forbidden', 'the declaring person is the caller', { reason: 'declarer_mismatch' });
    await this.requirePayoutCountry(input.declarer, input.payee.payoutCountry);
    await this.requirePayee(input.trx, input.payee, input.purpose);
    return provider();
  }
}
