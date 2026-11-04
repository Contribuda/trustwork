import { Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import {
  CancelAwardBodySchema, DraftSheetBodySchema, ExecuteAwardBodySchema, FreezeSheetBodySchema, IdParamsSchema, NotifyOutcomesBodySchema, ProposeAwardBodySchema, SaveEligibilityBodySchema, SaveSheetBodySchema,
} from './schemas.js';
import { SourcingService } from './sourcing.service.js';

type P<T extends z.ZodType> = z.infer<T>;

/**
 * Sourcing events (PRC-004) under `/v1/sourcing`. Every route needs a session; mutations carry CSRF metadata and an
 * `Idempotency-Key` and complete inside their request transaction. Everything here answers the buyer side only (a
 * seller, another company or an anonymous caller gets `404` for the existence of a sheet or an award), except
 * `outcome-notices`, where a bidder reads the notices addressed to it.
 */
@Controller('v1/sourcing')
@Authenticated()
export class SourcingController {
  constructor(@Inject(SourcingService) private readonly sourcing: SourcingService) {}

  @Get('rfqs/:id')
  event(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.sourcing.getEvent(state, params.id);
  }

  @Post('rfqs/:id/eligibility') @HttpCode(200) @Idempotent('sourcing.eligibility_save', 'id')
  saveEligibility(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(SaveEligibilityBodySchema) body: P<typeof SaveEligibilityBodySchema>, @ReqState() state: RequestState) {
    return this.sourcing.saveEligibility(state, params.id, body);
  }

  @Get('rfqs/:id/candidates')
  candidates(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.sourcing.listCandidates(state, params.id);
  }

  @Get('rfqs/:id/level-sheet/template')
  template(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.sourcing.sheetTemplate(state, params.id);
  }

  @Post('rfqs/:id/level-sheet/versions') @HttpCode(201) @Idempotent('sourcing.sheet_draft', 'id')
  openDraft(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(DraftSheetBodySchema) body: P<typeof DraftSheetBodySchema>, @ReqState() state: RequestState) {
    return this.sourcing.openSheetDraft(state, params.id, body);
  }

  @Get('level-sheet-versions/:id')
  sheetVersion(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.sourcing.getSheetVersion(state, params.id);
  }

  @Post('level-sheet-versions/:id') @HttpCode(200) @Idempotent('sourcing.sheet_save', 'id')
  saveDraft(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(SaveSheetBodySchema) body: P<typeof SaveSheetBodySchema>, @ReqState() state: RequestState) {
    return this.sourcing.saveSheetDraft(state, params.id, body);
  }

  @Post('level-sheet-versions/:id/freeze') @HttpCode(200) @Idempotent('sourcing.sheet_freeze', 'id')
  freeze(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(FreezeSheetBodySchema) body: P<typeof FreezeSheetBodySchema>, @ReqState() state: RequestState) {
    return this.sourcing.freezeSheet(state, params.id, body);
  }

  @Post('rfqs/:id/awards') @HttpCode(201) @Idempotent('sourcing.award_propose', 'id')
  proposeAward(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(ProposeAwardBodySchema) body: P<typeof ProposeAwardBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.sourcing.proposeAward(state, params.id, body, key);
  }

  @Get('awards/:id')
  award(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.sourcing.getAward(state, params.id);
  }

  @Post('awards/:id/execute') @HttpCode(200) @Idempotent('sourcing.award_execute', 'id')
  executeAward(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(ExecuteAwardBodySchema) body: P<typeof ExecuteAwardBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.sourcing.executeAward(state, params.id, body, key);
  }

  @Post('awards/:id/cancel') @HttpCode(200) @Idempotent('sourcing.award_cancel', 'id')
  cancelAward(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(CancelAwardBodySchema) body: P<typeof CancelAwardBodySchema>, @ReqState() state: RequestState) {
    return this.sourcing.cancelAward(state, params.id, body);
  }

  @Post('rfqs/:id/outcome-notices') @HttpCode(201) @Idempotent('sourcing.outcome_notify', 'id')
  notify(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(NotifyOutcomesBodySchema) body: P<typeof NotifyOutcomesBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.sourcing.notifyOutcomes(state, params.id, body, key);
  }

  @Get('outcome-notices')
  myNotices(@ReqState() state: RequestState) {
    return this.sourcing.listMyNotices(state);
  }
}
