import type { Transaction } from '../../../deps/data.js';
import type { RequestState } from '../../../common/request.js';
import { ApiError } from '../../../common/errors.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { jurisdictionConsent } from '../../../../../../packages/data/src/repositories/jurisdiction-policy.js';
import { hubsRefusal } from '../errors.js';

/** No request body can select the acting session, subject, legal authority or a company mandate. */
export class JurisdictionConsentService {
  constructor(private readonly principals: PrincipalService) {}

  private run<T>(state: RequestState, fn: (trx: Transaction) => Promise<T>): Promise<T> {
    if (!state.session) throw new ApiError('auth.session_invalid', 'authentication required');
    return this.principals.runAs(state, fn, { refreshStale: false }).catch((error: unknown) => { throw hubsRefusal(error) ?? error; });
  }

  preview(state: RequestState, quoteId: string) {
    return this.run<Awaited<ReturnType<typeof jurisdictionConsent.preview>>>(state, trx => jurisdictionConsent.preview(trx, state.session!.id, quoteId));
  }

  grant(state: RequestState, quoteId: string, input: { noticeDigest: string; locale: string }) {
    return this.run<Awaited<ReturnType<typeof jurisdictionConsent.grant>>>(state, trx => jurisdictionConsent.grant(trx, state.session!.id, quoteId, input.noticeDigest, input.locale));
  }

  revoke(state: RequestState, receiptId: string) {
    return this.run<Awaited<ReturnType<typeof jurisdictionConsent.revoke>>>(state, trx => jurisdictionConsent.revoke(trx, state.session!.id, receiptId));
  }
}
