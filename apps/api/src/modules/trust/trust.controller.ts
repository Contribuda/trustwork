import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { ComputeSnapshotCommandSchema, FileAppealCommandSchema, RespondToReviewCommandSchema, SubmitReviewCommandSchema } from './contracts.js';
import { TrustService } from './trust.service.js';

const IdParams = z.strictObject({ id: IdSchema });
const SubjectParams = z.strictObject({ kind: z.enum(['people', 'companies']), id: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;
const subjectOf = (params: P<typeof SubjectParams>) => ({ kind: params.kind === 'people' ? 'person' as const : 'company' as const, id: params.id });

/** Reviews of completed agreements and appeals under `/v1/trust`: the two parties only; the person's own acts. */
@Controller('v1/trust')
export class TrustController {
  constructor(@Inject(TrustService) private readonly trust: TrustService) {}

  @Get('agreements/:id/reviews') @Authenticated()
  list(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.trust.listReviews(params.id, state);
  }

  @Post('agreements/:id/reviews') @HttpCode(201) @Authenticated() @Idempotent('trust.review_submit', 'id')
  review(@Params(IdParams) params: P<typeof IdParams>, @Body(SubmitReviewCommandSchema) body: P<typeof SubmitReviewCommandSchema>, @ReqState() state: RequestState) {
    return this.trust.submitReview(params.id, body, state);
  }

  @Post('reviews/:id/response') @HttpCode(201) @Authenticated() @Idempotent('trust.review_respond', 'id')
  respond(@Params(IdParams) params: P<typeof IdParams>, @Body(RespondToReviewCommandSchema) body: P<typeof RespondToReviewCommandSchema>, @ReqState() state: RequestState) {
    return this.trust.respond(params.id, body, state);
  }

  @Post('appeals') @HttpCode(201) @Authenticated() @Idempotent('trust.appeal_file')
  appeal(@Body(FileAppealCommandSchema) body: P<typeof FileAppealCommandSchema>, @ReqState() state: RequestState) {
    return this.trust.fileAppeal(body, state);
  }
}

/**
 * Reputation snapshots under `/v1/reputation`: the subject computes and reads its own snapshot with the explanation;
 * anyone reads the masked public summary (no score, no evidence, no counterparties).
 */
@Controller('v1/reputation')
export class ReputationController {
  constructor(@Inject(TrustService) private readonly trust: TrustService) {}

  @Post('snapshots') @HttpCode(201) @Authenticated() @Idempotent('trust.snapshot_compute')
  compute(@Body(ComputeSnapshotCommandSchema) body: P<typeof ComputeSnapshotCommandSchema>, @ReqState() state: RequestState) {
    return this.trust.computeSnapshot(body, state);
  }

  @Get(':kind/:id/own') @Authenticated()
  own(@Params(SubjectParams) params: P<typeof SubjectParams>, @ReqState() state: RequestState) {
    return this.trust.ownSnapshot(subjectOf(params), state);
  }

  @Get(':kind/:id')
  public(@Params(SubjectParams) params: P<typeof SubjectParams>, @ReqState() state: RequestState) {
    return this.trust.publicSnapshot(subjectOf(params), state);
  }
}
