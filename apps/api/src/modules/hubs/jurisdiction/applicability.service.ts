import type { RequestState } from '../../../common/request.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { ApiError } from '../../../common/errors.js';
import { jurisdictionApplicabilityReview } from '../../../../../../packages/data/src/repositories/jurisdiction-policy.js';
import { hubsRefusal } from '../errors.js';

type Input = { evidenceDigest: string; reason: string };
export class JurisdictionApplicabilityService {
  constructor(private readonly principals: PrincipalService) {}

  private run(state: RequestState, elevationId: string, id: string, body: Input, operation: 'propose' | 'activate') {
    if (!state.session) throw new ApiError('auth.session_invalid', 'authentication required');
    const sessionId = state.session.id;
    return this.principals.runAs(state, trx => jurisdictionApplicabilityReview[operation](trx, sessionId, {
      elevationId, requestId: state.requestId, reasonCode: 'jurisdiction_review', reasonText: body.reason,
    }, id, body.evidenceDigest)).catch((error: unknown) => { throw hubsRefusal(error) ?? error; });
  }

  propose(state: RequestState, elevationId: string, evidenceId: string, body: Input) { return this.run(state, elevationId, evidenceId, body, 'propose'); }
  activate(state: RequestState, elevationId: string, reviewId: string, body: Input) { return this.run(state, elevationId, reviewId, body, 'activate'); }
}
