import type { FastifyReply } from 'fastify';
import { finished } from 'node:stream/promises';
import { Controller, Get, Header, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import {
  PrivacyExportCommandSchema, PrivacyHoldCommandSchema, PrivacyHoldReleaseSchema, PrivacyIdParamsSchema, PrivacyPreferenceCommandSchema, PrivacyRequestCommandSchema, PrivacyMarketingObjectionSchema, PrivacySourceProofSchema, PrivacySourceSubmissionSchema,
  PrivacyFileParamsSchema, PrivacyExternalSourceCaseSchema, PrivacyPlanProposeSchema, PrivacyPlanApproveSchema, PrivacyPlanExecuteSchema,
} from '../../../../../../packages/contracts/src/privacy.js';
import { PrivacyService } from './privacy.service.js';

/** Always the same acknowledgement, including unknown contacts. No account or match lookup. */
@Controller('v1/privacy/public')
export class PrivacyPublicController {
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}
  @Post('marketing-objections') @HttpCode(202) @Header('Cache-Control', 'no-store')
  object(@Body(PrivacyMarketingObjectionSchema) body: z.infer<typeof PrivacyMarketingObjectionSchema>) {
    return this.privacy.objectToMarketing(body.address);
  }
  @Post('sourced-requests') @HttpCode(202) @Header('Cache-Control', 'no-store')
  submit(@Body(PrivacySourceSubmissionSchema) body: z.infer<typeof PrivacySourceSubmissionSchema>) { return this.privacy.sourceSubmission(body); }
}

@Controller('v1/privacy')
@Authenticated()
export class PrivacyController {
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}
  @Get('requests') @Header('Cache-Control', 'no-store')
  requests(@ReqState() state: RequestState) { return this.privacy.requests(state); }
  @Post('requests') @HttpCode(201) @Idempotent('privacy.request_create')
  request(@ReqState() state: RequestState, @Body(PrivacyRequestCommandSchema) body: z.infer<typeof PrivacyRequestCommandSchema>) { return this.privacy.request(state, body); }
  @Get('preferences') @Header('Cache-Control', 'no-store')
  preferences(@ReqState() state: RequestState) { return this.privacy.preferences(state); }
  @Post('preferences') @HttpCode(200) @Idempotent('privacy.preference_set')
  preference(@ReqState() state: RequestState, @Body(PrivacyPreferenceCommandSchema) body: z.infer<typeof PrivacyPreferenceCommandSchema>) { return this.privacy.preference(state, body); }
  @Post('exports') @HttpCode(201) @Idempotent('privacy.export_create')
  createExport(@ReqState() state: RequestState, @Body(PrivacyExportCommandSchema) body: z.infer<typeof PrivacyExportCommandSchema>) { return this.privacy.createExport(state, body.subject); }
  @Get('exports/:id/files/:fileId') @Header('Cache-Control', 'no-store')
  downloadFile(@ReqState() state: RequestState, @Params(PrivacyFileParamsSchema) params: z.infer<typeof PrivacyFileParamsSchema>, @Res() reply: FastifyReply) {
    return this.privacy.downloadFile(state, params.id, params.fileId, async (file) => {
      reply.type('application/octet-stream').header('Content-Disposition', 'attachment; filename="file"')
        .header('Content-Length', file.bytes).header('X-Content-SHA256', file.sha256).header('Cache-Control', 'no-store');
      const delivered = finished(reply.raw, { cleanup: true });
      reply.send(file.stream);
      await delivered;
    });
  }
  @Get('exports/:id') @Header('Cache-Control', 'no-store')
  download(@ReqState() state: RequestState, @Params(PrivacyIdParamsSchema) params: z.infer<typeof PrivacyIdParamsSchema>, @Res() reply: FastifyReply) {
    return this.privacy.download(state, params.id, async (result) => {
      const delivered = finished(reply.raw, { cleanup: true });
      reply.header('Cache-Control', 'no-store').send(result);
      await delivered;
    });
  }
}

/** Platform privacy permission and a live elevation; no subject payload is returned to staff. */
@Controller('v1/admin/privacy')
@Authenticated()
@UseGuards(ElevationGuard)
export class PrivacyStaffController {
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}
  @Post('plans') @HttpCode(201) @Idempotent('privacy.plan_propose')
  proposePlan(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Body(PrivacyPlanProposeSchema) body: z.infer<typeof PrivacyPlanProposeSchema>) {
    return this.privacy.proposePlan(state, elevation.id, body.requestId, body.grantId);
  }
  @Post('plans/:id/approve') @HttpCode(200) @Idempotent('privacy.plan_approve', 'id')
  approvePlan(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(PrivacyIdParamsSchema) params: z.infer<typeof PrivacyIdParamsSchema>,
    @Body(PrivacyPlanApproveSchema) body: z.infer<typeof PrivacyPlanApproveSchema>) { return this.privacy.approvePlan(state, elevation.id, params.id, body.grantId, body.digest); }
  @Post('plans/:id/execute') @HttpCode(200) @Idempotent('privacy.plan_execute', 'id')
  executePlan(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(PrivacyIdParamsSchema) params: z.infer<typeof PrivacyIdParamsSchema>,
    @Body(PrivacyPlanExecuteSchema) body: z.infer<typeof PrivacyPlanExecuteSchema>) { return this.privacy.executePlan(state, elevation.id, params.id, body.digest); }
  @Post('source-plans') @HttpCode(201) @Idempotent('privacy.source_plan_propose')
  proposeSourcePlan(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Body(PrivacyPlanProposeSchema) body: z.infer<typeof PrivacyPlanProposeSchema>) {
    return this.privacy.proposeSourcePlan(state, elevation.id, body.requestId, body.grantId);
  }
  @Post('source-plans/:id/approve') @HttpCode(200) @Idempotent('privacy.source_plan_approve', 'id')
  approveSourcePlan(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(PrivacyIdParamsSchema) params: z.infer<typeof PrivacyIdParamsSchema>,
    @Body(PrivacyPlanApproveSchema) body: z.infer<typeof PrivacyPlanApproveSchema>) { return this.privacy.approveSourcePlan(state, elevation.id, params.id, body.grantId, body.digest); }
  @Post('source-plans/:id/execute') @HttpCode(200) @Idempotent('privacy.source_plan_execute', 'id')
  executeSourcePlan(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(PrivacyIdParamsSchema) params: z.infer<typeof PrivacyIdParamsSchema>,
    @Body(PrivacyPlanExecuteSchema) body: z.infer<typeof PrivacyPlanExecuteSchema>) { return this.privacy.executeSourcePlan(state, elevation.id, params.id, body.digest); }
  @Post('external-source-cases') @HttpCode(201) @Idempotent('privacy.external_source_case')
  externalCase(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Body(PrivacyExternalSourceCaseSchema) body: z.infer<typeof PrivacyExternalSourceCaseSchema>) {
    return this.privacy.externalSourceCase(state, elevation.id, body);
  }
  @Post('source-proofs') @HttpCode(201) @Header('Cache-Control', 'no-store') @Idempotent('privacy.source_proof')
  proof(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Body(PrivacySourceProofSchema) body: z.infer<typeof PrivacySourceProofSchema>) {
    return this.privacy.sourceProof(state, elevation.id, body);
  }
  @Post('holds') @HttpCode(201) @Idempotent('privacy.hold_place')
  hold(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Body(PrivacyHoldCommandSchema) body: z.infer<typeof PrivacyHoldCommandSchema>) {
    return this.privacy.hold(state, elevation.id, body);
  }
  @Post('holds/:id/release') @HttpCode(200) @Idempotent('privacy.hold_release', 'id')
  release(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(PrivacyIdParamsSchema) params: z.infer<typeof PrivacyIdParamsSchema>,
    @Body(PrivacyHoldReleaseSchema) body: z.infer<typeof PrivacyHoldReleaseSchema>) { return this.privacy.releaseHold(state, elevation.id, params.id, body.reasonCode); }
  @Post('requests/:id/erasure-readiness') @HttpCode(200)
  erasureCheck(@ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Params(PrivacyIdParamsSchema) params: z.infer<typeof PrivacyIdParamsSchema>) {
    return this.privacy.erasureCheck(state, elevation.id, params.id);
  }
}
