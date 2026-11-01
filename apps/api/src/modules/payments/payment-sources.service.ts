import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { paymentSources } from '../../../../../packages/data/src/repositories/payment-sources.js';
import type { PaymentAuthorizationDraftCommandSchema, PaymentSourceChallengeCommand } from '../../../../../packages/contracts/src/payment-sources.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { PrincipalService } from '../identity/principal.service.js';

/** First-party source choices and bilateral consent. Never accepts a replacement actor or payment binding. */
export class PaymentSourcesService {
  constructor(private readonly principals: PrincipalService) {}
  private session(state: RequestState) { if (!state.session) throw new ApiError('auth.session_invalid'); return state.session.id; }
  challenge(input: PaymentSourceChallengeCommand, state: RequestState) {
    const nonce = randomBytes(32).toString('hex');
    return this.principals.runAs(state, (trx) => paymentSources.challenge(trx, this.session(state), input, nonce), { refreshStale: false });
  }
  ownBindings(state: RequestState) { return this.principals.runAs(state, (trx) => paymentSources.ownBindings(trx)); }
  draft(input: z.infer<typeof PaymentAuthorizationDraftCommandSchema>, state: RequestState) {
    return this.principals.runAs(state, (trx) => paymentSources.draftAuthorization(trx, this.session(state), input), { refreshStale: false });
  }
  read(id: string, state: RequestState) { return this.principals.runAs(state, (trx) => paymentSources.authorization(trx, id)); }
  accept(id: string, digest: string, state: RequestState) { return this.principals.runAs(state, (trx) => paymentSources.acceptAuthorization(trx, this.session(state), id, digest), { refreshStale: false }); }
  revoke(id: string, kind: string, state: RequestState) { return this.principals.runAs(state, (trx) => paymentSources.revoke(trx, this.session(state), kind, id), { refreshStale: false }); }
  staffRevoke(id: string, body: { reason: string; kind: string }, state: RequestState, elevationId: string) {
    const ctx = { elevationId, requestId: state.requestId, reasonCode: 'payment_source_revoke', reasonText: body.reason };
    return this.principals.runAs(state, (trx) => paymentSources.staffRevoke(trx, ctx, body.kind, id), { refreshStale: false });
  }
  review(id: string, body: { reason: string; approvalId?: string }, state: RequestState, elevationId: string) {
    const ctx = { elevationId, requestId: state.requestId, reasonCode: 'payment_source_review', reasonText: body.reason };
    return this.principals.runAs<Awaited<ReturnType<typeof paymentSources.acceptBinding>> | Awaited<ReturnType<typeof paymentSources.reviewMaterial>>>(state, (trx) => body.approvalId ? paymentSources.acceptBinding(trx, ctx, id, body.approvalId) : paymentSources.reviewMaterial(trx, ctx, id), { refreshStale: false });
  }
}
