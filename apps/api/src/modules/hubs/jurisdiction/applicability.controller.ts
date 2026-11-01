import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { JurisdictionApplicabilityReviewCommandSchema } from '../../../../../../packages/contracts/src/jurisdiction.js';
import { JurisdictionApplicabilityService } from './applicability.service.js';

const Evidence = z.strictObject({ evidenceId: z.uuid() });
const Review = z.strictObject({ reviewId: z.uuid() });
type Command = z.infer<typeof JurisdictionApplicabilityReviewCommandSchema>;

@Controller('v1/admin/jurisdiction-applicability')
@Authenticated()
@UseGuards(ElevationGuard)
export class JurisdictionApplicabilityController {
  constructor(@Inject(JurisdictionApplicabilityService) private readonly service: JurisdictionApplicabilityService) {}

  @Post('evidence/:evidenceId/review') @HttpCode(200) @Idempotent('jurisdiction.applicability_propose')
  propose(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(Evidence) p: z.infer<typeof Evidence>, @Body(JurisdictionApplicabilityReviewCommandSchema) body: Command) {
    return this.service.propose(state, elevation.id, p.evidenceId, body);
  }

  @Post('reviews/:reviewId/activate') @HttpCode(200) @Idempotent('jurisdiction.applicability_activate')
  activate(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(Review) p: z.infer<typeof Review>, @Body(JurisdictionApplicabilityReviewCommandSchema) body: Command) {
    return this.service.activate(state, elevation.id, p.reviewId, body);
  }
}
