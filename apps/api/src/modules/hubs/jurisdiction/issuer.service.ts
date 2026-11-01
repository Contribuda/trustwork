import type { RequestState } from '../../../common/request.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { ApiError } from '../../../common/errors.js';
import { jurisdictionIssuers } from '../../../../../../packages/data/src/repositories/jurisdiction-source.js';
import type { JurisdictionIssuer } from '../../../../../../packages/contracts/src/jurisdiction.js';
import { hubsRefusal } from '../errors.js';
import type { Transaction } from '../../../deps/data.js';
import type { CommandContext } from '../../../../../../packages/data/src/repositories/admin.js';

export class JurisdictionIssuerService {
  constructor(private readonly principals: PrincipalService) {}
  private run<T>(state: RequestState, elevationId: string, reason: string, command: (trx: Transaction, session: string, ctx: CommandContext) => Promise<T>) {
    if (!state.session) throw new ApiError('auth.session_invalid', 'authentication required');
    const session = state.session.id;
    return this.principals.runAs(state, trx => command(trx, session, {
      elevationId, requestId: state.requestId, reasonCode: 'jurisdiction_source', reasonText: reason,
    }), { refreshStale: false }).catch((error: unknown) => { throw hubsRefusal(error) ?? error; });
  }
  propose(state: RequestState, elevation: string, body: { registration: JurisdictionIssuer; reason: string }) {
    return this.run(state, elevation, body.reason, (trx, session, ctx) => jurisdictionIssuers.propose(trx, session, ctx, body.registration));
  }
  activate(state: RequestState, elevation: string, id: string, body: { digest: string; reason: string }) {
    return this.run(state, elevation, body.reason, (trx, session, ctx) => jurisdictionIssuers.activate(trx, session, ctx, id, body.digest));
  }
  revoke(state: RequestState, elevation: string, kind: 'issuer' | 'source', id: string, body: { digest: string; reason: string }) {
    return this.run(state, elevation, body.reason, (trx, session, ctx) => jurisdictionIssuers.revoke(trx, session, ctx, kind, id, body.digest));
  }
}
