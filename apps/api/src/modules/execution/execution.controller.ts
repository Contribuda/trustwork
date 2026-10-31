import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { AppealDisputeCommandSchema, AttachEvidenceCommandSchema, DecideClaimCommandSchema, OpenDisputeCommandSchema, RecordClaimCommandSchema, ReportDefectCommandSchema } from './contracts.js';
import { ExecutionService } from './execution.service.js';

const IdParams = z.strictObject({ id: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;

/**
 * Execution of agreements accepted by both parties (EXE-001) under `/v1/execution`: the two parties only; everyone
 * else gets not found. Claims, evidence and defects accept an agent under a record_evidence mandate; decisions,
 * disputes and appeals are the person's own (their commands have no actor field).
 */
@Controller('v1/execution')
export class ExecutionController {
  constructor(@Inject(ExecutionService) private readonly execution: ExecutionService) {}

  @Get('agreements/:id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.execution.view(params.id, state);
  }

  @Post('agreements/:id/claims') @HttpCode(201) @Authenticated() @Idempotent('execution.claim_record', 'id')
  claim(@Params(IdParams) params: P<typeof IdParams>, @Body(RecordClaimCommandSchema) body: P<typeof RecordClaimCommandSchema>, @ReqState() state: RequestState) {
    return this.execution.recordClaim(params.id, body, state);
  }

  @Post('agreements/:id/evidence') @HttpCode(201) @Authenticated() @Idempotent('execution.evidence_attach', 'id')
  evidence(@Params(IdParams) params: P<typeof IdParams>, @Body(AttachEvidenceCommandSchema) body: P<typeof AttachEvidenceCommandSchema>, @ReqState() state: RequestState) {
    return this.execution.attachEvidence(params.id, body, state);
  }

  @Post('agreements/:id/defects') @HttpCode(201) @Authenticated() @Idempotent('execution.defect_report', 'id')
  defect(@Params(IdParams) params: P<typeof IdParams>, @Body(ReportDefectCommandSchema) body: P<typeof ReportDefectCommandSchema>, @ReqState() state: RequestState) {
    return this.execution.reportDefect(params.id, body, state);
  }

  @Post('agreements/:id/disputes') @HttpCode(201) @Authenticated() @Idempotent('execution.dispute_open', 'id')
  dispute(@Params(IdParams) params: P<typeof IdParams>, @Body(OpenDisputeCommandSchema) body: P<typeof OpenDisputeCommandSchema>, @ReqState() state: RequestState) {
    return this.execution.openDispute(params.id, body, state);
  }

  @Post('claims/:id/decision') @HttpCode(201) @Authenticated() @Idempotent('execution.claim_decide', 'id')
  decide(@Params(IdParams) params: P<typeof IdParams>, @Body(DecideClaimCommandSchema) body: P<typeof DecideClaimCommandSchema>, @ReqState() state: RequestState) {
    return this.execution.decideClaim(params.id, body, state);
  }

  @Post('disputes/:id/appeal') @HttpCode(200) @Authenticated() @Idempotent('execution.dispute_appeal', 'id')
  appeal(@Params(IdParams) params: P<typeof IdParams>, @Body(AppealDisputeCommandSchema) body: P<typeof AppealDisputeCommandSchema>, @ReqState() state: RequestState) {
    return this.execution.appealDispute(params.id, body, state);
  }
}
