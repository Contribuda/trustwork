import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import {
  ComparisonQuerySchema, CreateAmendmentRequestCommandSchema, CreateQuoteCommandSchema, OpenQuoteVersionCommandSchema, SaveQuoteDraftCommandSchema, SaveQuotePrivateCommandSchema,
  SendQuoteCommandSchema, WithdrawAmendmentRequestCommandSchema, WithdrawQuoteCommandSchema,
} from './deps.js';
import { SalesService } from './sales.service.js';

const IdParams = z.strictObject({ id: IdSchema });
const VersionParams = z.strictObject({ id: IdSchema, versionId: IdSchema });
const RequestParams = z.strictObject({ id: IdSchema, requestId: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;

/**
 * Quotes (COM-002) under `/v1/quotes`: the seller drafts, revises and sends immutable versions pinned to the current
 * RFQ version; the buyer side reads sent versions and negotiates with structured amendment requests. Everyone else does
 * not find a quote.
 */
@Controller('v1/quotes')
export class QuotesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.sales.listQuotes(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('quote.create')
  create(@Body(CreateQuoteCommandSchema) body: P<typeof CreateQuoteCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.createQuote(body, state);
  }

  @Get(':id')
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.sales.getQuote(params.id, state);
  }

  @Post(':id/versions') @HttpCode(201) @Authenticated() @Idempotent('quote.version_open', 'id')
  openVersion(@Params(IdParams) params: P<typeof IdParams>, @Body(OpenQuoteVersionCommandSchema) body: P<typeof OpenQuoteVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.openVersion(params.id, body, state);
  }

  @Post(':id/versions/:versionId') @HttpCode(200) @Authenticated() @Idempotent('quote.draft_save', 'versionId')
  saveDraft(@Params(VersionParams) params: P<typeof VersionParams>, @Body(SaveQuoteDraftCommandSchema) body: P<typeof SaveQuoteDraftCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.saveDraft(params.id, params.versionId, body, state);
  }

  @Post(':id/private') @HttpCode(200) @Authenticated() @Idempotent('quote.private_save', 'id')
  setPrivate(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveQuotePrivateCommandSchema) body: P<typeof SaveQuotePrivateCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.setPrivate(params.id, body, state);
  }

  @Post(':id/send') @HttpCode(200) @Authenticated() @Idempotent('quote.send', 'id')
  send(@Params(IdParams) params: P<typeof IdParams>, @Body(SendQuoteCommandSchema) body: P<typeof SendQuoteCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.send(params.id, body, state);
  }

  @Post(':id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('quote.withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawQuoteCommandSchema) body: P<typeof WithdrawQuoteCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.withdraw(params.id, body, state);
  }

  @Post(':id/amendment-requests') @HttpCode(201) @Authenticated() @Idempotent('quote.amendment_request', 'id')
  requestAmendment(@Params(IdParams) params: P<typeof IdParams>, @Body(CreateAmendmentRequestCommandSchema) body: P<typeof CreateAmendmentRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.requestAmendment(params.id, body, state);
  }

  @Post(':id/amendment-requests/:requestId/withdraw') @HttpCode(200) @Authenticated() @Idempotent('quote.amendment_request_withdraw', 'requestId')
  withdrawAmendmentRequest(@Params(RequestParams) params: P<typeof RequestParams>, @Body(WithdrawAmendmentRequestCommandSchema) body: P<typeof WithdrawAmendmentRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.sales.withdrawAmendmentRequest(params.id, params.requestId, body, state);
  }
}

/** Comparison of the quotes on an RFQ (buyer side only): `GET /v1/rfqs/:id/comparison?mode=current|historical`. */
@Controller('v1/rfqs')
export class RfqComparisonController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  @Get(':id/comparison') @Authenticated()
  compare(@Params(IdParams) params: P<typeof IdParams>, @Query(ComparisonQuerySchema) query: P<typeof ComparisonQuerySchema>, @ReqState() state: RequestState) {
    return this.sales.compare(params.id, query, state);
  }
}
