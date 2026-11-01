import { payments } from '../../../../../packages/data/src/repositories/payments.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { PrincipalService } from '../identity/principal.service.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const requireId = (id: string) => { if (!UUID.test(id)) throw new ApiError('access.not_found'); };

/** All writes complete BE-005 in the same transaction as their durable intent. No provider on the request path. */
export class PaymentsService {
  constructor(private readonly principals: PrincipalService) {}
  request(input: { agreementId: string; budgetId: string }, state: RequestState) {
    requireId(input.agreementId); requireId(input.budgetId);
    return this.principals.runAs(state, async (trx) => {
      if (!state.session) throw new ApiError('auth.session_invalid');
      return payments.request(trx, input.agreementId, input.budgetId, state.session.id);
    }, { refreshStale: false });
  }
  read(id: string, state: RequestState) { requireId(id); return this.principals.runAs(state, (trx) => payments.read(trx, id)); }
  action(id: string, kind: 'confirm' | 'refund' | 'payout' | 'connected_account', state: RequestState) {
    requireId(id);
    return this.principals.runAs(state, async (trx) => {
      if (!state.session) throw new ApiError('auth.session_invalid');
      return payments.action(trx, id, kind, state.session.id);
    }, { refreshStale: false });
  }
}
