import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PaymentAuthorizationAcceptCommandSchema, PaymentAuthorizationDraftCommandSchema, PaymentSourceActivateCommandSchema,
  PaymentSourceChallengeCommandSchema, PaymentSourceReviewCommandSchema, PaymentSourceRevokeCommandSchema, PaymentSourceStaffRevokeCommandSchema } from '../../../../../packages/contracts/src/payment-sources.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { PaymentSourcesService } from './payment-sources.service.js';
const IdParams = z.strictObject({ id: z.uuid() });
type Input<S extends z.ZodType> = z.infer<S>;
@Controller('v1/payments/sources')
@Authenticated()
export class PaymentSourcesController {
  constructor(@Inject(PaymentSourcesService) private readonly sources: PaymentSourcesService) {}
  @Post('challenges') @HttpCode(201) @Authenticated('step_up') @Idempotent('payments.source_challenge')
  challenge(@Body(PaymentSourceChallengeCommandSchema) body: Input<typeof PaymentSourceChallengeCommandSchema>, @ReqState() state: RequestState) { return this.sources.challenge(body, state); }
  @Get('bindings')
  bindings(@ReqState() state: RequestState) { return this.sources.ownBindings(state); }
  @Post('authorizations') @HttpCode(201) @Authenticated('step_up') @Idempotent('payments.authorization_draft')
  draft(@Body(PaymentAuthorizationDraftCommandSchema) body: Input<typeof PaymentAuthorizationDraftCommandSchema>, @ReqState() state: RequestState) { return this.sources.draft(body, state); }
  @Get('authorizations/:id')
  read(@Params(IdParams) p: Input<typeof IdParams>, @ReqState() state: RequestState) { return this.sources.read(p.id, state); }
  @Post('authorizations/:id/accept') @HttpCode(200) @Authenticated('step_up') @Idempotent('payments.authorization_accept', 'id')
  accept(@Params(IdParams) p: Input<typeof IdParams>, @Body(PaymentAuthorizationAcceptCommandSchema) body: Input<typeof PaymentAuthorizationAcceptCommandSchema>, @ReqState() state: RequestState) { return this.sources.accept(p.id, body.digest, state); }
  @Post(':id/revoke') @HttpCode(200) @Authenticated('step_up') @Idempotent('payments.source_revoke', 'id')
  revoke(@Params(IdParams) p: Input<typeof IdParams>, @Body(PaymentSourceRevokeCommandSchema) body: Input<typeof PaymentSourceRevokeCommandSchema>, @ReqState() state: RequestState) { return this.sources.revoke(p.id, body.kind, state); }
}
@Controller('v1/admin/payments/source-bindings')
@Authenticated()
@UseGuards(ElevationGuard)
export class PaymentSourceReviewsController {
  constructor(@Inject(PaymentSourcesService) private readonly sources: PaymentSourcesService) {}
  @Post(':id/revoke') @HttpCode(200) @Idempotent('payments.source_staff_revoke', 'id')
  revoke(@Params(IdParams) p: Input<typeof IdParams>, @Body(PaymentSourceStaffRevokeCommandSchema) body: Input<typeof PaymentSourceStaffRevokeCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow) { return this.sources.staffRevoke(p.id, body, state, e.id); }
  @Post(':id/review') @HttpCode(200) @Idempotent('payments.source_review_material', 'id')
  review(@Params(IdParams) p: Input<typeof IdParams>, @Body(PaymentSourceReviewCommandSchema) body: Input<typeof PaymentSourceReviewCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow) { return this.sources.review(p.id, body, state, e.id); }
  @Post(':id/activate') @HttpCode(200) @Idempotent('payments.source_review_activate', 'id')
  activate(@Params(IdParams) p: Input<typeof IdParams>, @Body(PaymentSourceActivateCommandSchema) body: Input<typeof PaymentSourceActivateCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow) { return this.sources.review(p.id, body, state, e.id); }
}
