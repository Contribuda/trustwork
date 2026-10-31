import { Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import {
  AcceptTermsRequestSchema, CancelOrderRequestSchema, DecideOrderChangeRequestSchema, PlaceOrderRequestSchema, ProposeOrderChangeRequestSchema, SaveAgreementPrivateCommandSchema,
  SellerAcceptRequestSchema, SellerDeclineRequestSchema, WithdrawAgreementRequestSchema,
} from '../sales/deps.js';
import { TransactionsService } from './transactions.service.js';

const IdParams = z.strictObject({ id: IdSchema });
const ChangeParams = z.strictObject({ id: IdSchema, changeId: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;
/** Acceptance events record the request's idempotency key (the interceptor has already required and scoped it). */
function keyOf(header: string | undefined): string {
  if (!header || !/^[A-Za-z0-9._:-]{1,200}$/.test(header)) throw new ApiError('validation.schema', 'an Idempotency-Key header is required', { reason: 'idempotency_key' });
  return header;
}

/**
 * Agreements (COM-002) under `/v1/agreements`: the buyer side accepts terms and places the order, the seller accepts or
 * declines it, each side keeps its private half. Only the two parties find an agreement.
 */
@Controller('v1/agreements')
export class AgreementsController {
  constructor(@Inject(TransactionsService) private readonly transactions: TransactionsService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.transactions.listAgreements(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('agreement.accept_terms')
  accept(@Body(AcceptTermsRequestSchema) body: P<typeof AcceptTermsRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.acceptTerms(body, keyOf(key), state);
  }

  @Get(':id')
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.transactions.getAgreement(params.id, state);
  }

  @Post(':id/orders') @HttpCode(201) @Authenticated() @Idempotent('order.place', 'id')
  placeOrder(@Params(IdParams) params: P<typeof IdParams>, @Body(PlaceOrderRequestSchema) body: P<typeof PlaceOrderRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.placeOrder(params.id, body, keyOf(key), state);
  }

  @Post(':id/accept') @HttpCode(200) @Authenticated() @Idempotent('agreement.seller_accept', 'id')
  sellerAccept(@Params(IdParams) params: P<typeof IdParams>, @Body(SellerAcceptRequestSchema) body: P<typeof SellerAcceptRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.sellerAccept(params.id, body, keyOf(key), state);
  }

  @Post(':id/decline') @HttpCode(200) @Authenticated() @Idempotent('agreement.seller_decline', 'id')
  sellerDecline(@Params(IdParams) params: P<typeof IdParams>, @Body(SellerDeclineRequestSchema) body: P<typeof SellerDeclineRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.sellerDecline(params.id, body, keyOf(key), state);
  }

  @Post(':id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('agreement.withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawAgreementRequestSchema) body: P<typeof WithdrawAgreementRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.withdraw(params.id, body, keyOf(key), state);
  }

  @Post(':id/private') @HttpCode(200) @Authenticated() @Idempotent('agreement.private_save', 'id')
  savePrivate(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveAgreementPrivateCommandSchema) body: P<typeof SaveAgreementPrivateCommandSchema>, @ReqState() state: RequestState) {
    return this.transactions.savePrivate(params.id, body, state);
  }
}

/** Orders (COM-002) under `/v1/orders`: the buyer cancels before acceptance; either party proposes and decides changes. */
@Controller('v1/orders')
export class OrdersController {
  constructor(@Inject(TransactionsService) private readonly transactions: TransactionsService) {}

  @Post(':id/cancel') @HttpCode(200) @Authenticated() @Idempotent('order.cancel', 'id')
  cancel(@Params(IdParams) params: P<typeof IdParams>, @Body(CancelOrderRequestSchema) body: P<typeof CancelOrderRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.cancelOrder(params.id, body, keyOf(key), state);
  }

  @Post(':id/changes') @HttpCode(201) @Authenticated() @Idempotent('order.change_propose', 'id')
  proposeChange(@Params(IdParams) params: P<typeof IdParams>, @Body(ProposeOrderChangeRequestSchema) body: P<typeof ProposeOrderChangeRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.proposeChange(params.id, body, keyOf(key), state);
  }

  @Post(':id/changes/:changeId') @HttpCode(200) @Authenticated() @Idempotent('order.change_decide', 'changeId')
  decideChange(@Params(ChangeParams) params: P<typeof ChangeParams>, @Body(DecideOrderChangeRequestSchema) body: P<typeof DecideOrderChangeRequestSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.transactions.decideChange(params.id, params.changeId, body, keyOf(key), state);
  }
}
