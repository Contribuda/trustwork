import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { CreatePaymentCommandSchema } from '../../../../../packages/contracts/src/payments.js';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { PaymentsService } from './payments.service.js';
const EmptyAction = z.strictObject({}).optional();
const IdParams = z.strictObject({ id: IdSchema });
@Controller('v1/payments')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}
  @Post() @HttpCode(201) @Authenticated() @Idempotent('payments.create')
  create(@Body(CreatePaymentCommandSchema) body: z.infer<typeof CreatePaymentCommandSchema>, @ReqState() state: RequestState) { return this.payments.request(body, state); }
  @Get(':id') @Authenticated()
  read(@Params(IdParams) p: z.infer<typeof IdParams>, @ReqState() state: RequestState) { return this.payments.read(p.id, state); }
  @Post(':id/confirm') @HttpCode(200) @Authenticated() @Idempotent('payments.confirm', 'id')
  confirm(@Body(EmptyAction) _body: z.infer<typeof EmptyAction>, @Params(IdParams) p: z.infer<typeof IdParams>, @ReqState() state: RequestState) { return this.payments.action(p.id, 'confirm', state); }
  @Post(':id/refund') @HttpCode(200) @Authenticated() @Idempotent('payments.refund', 'id')
  refund(@Body(EmptyAction) _body: z.infer<typeof EmptyAction>, @Params(IdParams) p: z.infer<typeof IdParams>, @ReqState() state: RequestState) { return this.payments.action(p.id, 'refund', state); }
  @Post(':id/payout') @HttpCode(200) @Authenticated() @Idempotent('payments.payout', 'id')
  payout(@Body(EmptyAction) _body: z.infer<typeof EmptyAction>, @Params(IdParams) p: z.infer<typeof IdParams>, @ReqState() state: RequestState) { return this.payments.action(p.id, 'payout', state); }
  @Post(':id/connected-account') @HttpCode(200) @Authenticated() @Idempotent('payments.connected_account', 'id')
  connectedAccount(@Body(EmptyAction) _body: z.infer<typeof EmptyAction>, @Params(IdParams) p: z.infer<typeof IdParams>, @ReqState() state: RequestState) { return this.payments.action(p.id, 'connected_account', state); }
}
