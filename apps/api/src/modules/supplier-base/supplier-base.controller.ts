import { Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { SupplierBaseService } from './supplier-base.service.js';
import {
  CreateCounterpartyBodySchema, DraftAssessmentBodySchema, IdParamsSchema, ImportBodySchema, LimitQuerySchema, MaintainSupplierBodySchema, RecordAssessmentBodySchema, RespondBodySchema,
  SuppliersQuerySchema, UpdateCounterpartyBodySchema,
} from './schemas.js';

type P<T extends z.ZodType> = z.infer<T>;

/**
 * The company's private supplier base (PRC-003) under `/v1/supplier-base`. Every route needs a session; mutations
 * carry CSRF metadata and an `Idempotency-Key` and complete inside their request transaction. Buyer-side reads answer
 * only members of the buying company (`404` for everybody else, the supplier included); writes need
 * procurement.suppliers.manage. The supplier's only view is `shared-assessments`: assessments a buyer chose to share.
 */
@Controller('v1/supplier-base')
@Authenticated()
export class SupplierBaseController {
  constructor(@Inject(SupplierBaseService) private readonly suppliers: SupplierBaseService) {}

  @Get('suppliers')
  list(@Query(SuppliersQuerySchema) query: P<typeof SuppliersQuerySchema>, @ReqState() state: RequestState) {
    return this.suppliers.listSuppliers(state, query);
  }

  @Post('suppliers') @HttpCode(200) @Idempotent('supplier_base.maintain')
  maintain(@Body(MaintainSupplierBodySchema) body: P<typeof MaintainSupplierBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.suppliers.maintain(state, body, key);
  }

  @Get('suppliers/:id')
  get(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.suppliers.getSupplier(state, params.id);
  }

  @Get('suppliers/:id/card')
  card(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.suppliers.card(state, params.id);
  }

  @Get('suppliers/:id/assessments')
  assessments(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.suppliers.listAssessments(state, params.id);
  }

  @Post('suppliers/:id/assessments') @HttpCode(201) @Idempotent('supplier_base.assessment_draft', 'id')
  draftAssessment(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(DraftAssessmentBodySchema) body: P<typeof DraftAssessmentBodySchema>, @ReqState() state: RequestState) {
    return this.suppliers.draftAssessment(state, params.id, body);
  }

  @Post('assessments/:id/record') @HttpCode(200) @Idempotent('supplier_base.assessment_record', 'id')
  recordAssessment(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(RecordAssessmentBodySchema) body: P<typeof RecordAssessmentBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.suppliers.recordAssessment(state, params.id, body, key);
  }

  @Get('counterparties')
  counterparties(@Query(LimitQuerySchema) query: P<typeof LimitQuerySchema>, @ReqState() state: RequestState) {
    return this.suppliers.listCounterparties(state, query.limit ?? 50);
  }

  @Post('counterparties') @HttpCode(201) @Idempotent('supplier_base.counterparty_create')
  createCounterparty(@Body(CreateCounterpartyBodySchema) body: P<typeof CreateCounterpartyBodySchema>, @ReqState() state: RequestState) {
    return this.suppliers.createCounterparty(state, body);
  }

  @Get('counterparties/:id')
  counterparty(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.suppliers.getCounterparty(state, params.id);
  }

  @Post('counterparties/:id') @HttpCode(200) @Idempotent('supplier_base.counterparty_update', 'id')
  updateCounterparty(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(UpdateCounterpartyBodySchema) body: P<typeof UpdateCounterpartyBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.suppliers.updateCounterparty(state, params.id, body, key);
  }

  @Get('import/template')
  template() {
    return this.suppliers.importTemplate();
  }

  @Post('import') @HttpCode(200) @Idempotent('supplier_base.import')
  import(@Body(ImportBodySchema) body: P<typeof ImportBodySchema>, @ReqState() state: RequestState) {
    return this.suppliers.importSuppliers(state, body);
  }

  @Get('shared-assessments')
  shared(@Query(LimitQuerySchema) query: P<typeof LimitQuerySchema>, @ReqState() state: RequestState) {
    return this.suppliers.sharedWithMe(state, query.limit ?? 50);
  }

  @Post('shared-assessments/:id/respond') @HttpCode(200) @Idempotent('supplier_base.assessment_respond', 'id')
  respond(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(RespondBodySchema) body: P<typeof RespondBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.suppliers.respond(state, params.id, body, key);
  }
}
