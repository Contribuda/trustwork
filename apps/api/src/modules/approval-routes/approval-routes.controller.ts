import { Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { ApprovalRoutesService } from './approval-routes.service.js';
import {
  ActivateRouteBodySchema, DecideBodySchema, DelegateBodySchema, DraftRouteBodySchema, IdParamsSchema, RequestsQuerySchema, RevokeDelegationBodySchema, RoutesQuerySchema, WithdrawBodySchema,
} from './schemas.js';

type P<T extends z.ZodType> = z.infer<T>;

/**
 * Approval routes, requests, decisions and delegation (PRC-001) under `/v1/approvals`. Every route needs a session;
 * mutations carry CSRF metadata and an `Idempotency-Key` and complete inside their request transaction. Deciding and
 * activating are the person's own act on the first-party surface (activation additionally needs a recent
 * authentication, approving money too); an agent actor is refused. Requests are created by the subject modules
 * through `port.ts`, never by this controller.
 */
@Controller('v1/approvals')
@Authenticated()
export class ApprovalRoutesController {
  constructor(@Inject(ApprovalRoutesService) private readonly approvals: ApprovalRoutesService) {}

  @Get('templates')
  templates() {
    return this.approvals.templates();
  }

  @Get('routes')
  routes(@Query(RoutesQuerySchema) query: P<typeof RoutesQuerySchema>, @ReqState() state: RequestState) {
    return this.approvals.listRoutes(state, query.subjectKind ?? null);
  }

  @Post('routes') @HttpCode(201) @Idempotent('approval.route_draft')
  draft(@Body(DraftRouteBodySchema) body: P<typeof DraftRouteBodySchema>, @ReqState() state: RequestState) {
    return this.approvals.draftRoute(state, body);
  }

  @Get('routes/:id')
  route(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.approvals.getRoute(state, params.id);
  }

  @Post('routes/:id/activate') @HttpCode(200) @Authenticated('step_up') @Idempotent('approval.route_activate', 'id')
  activate(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(ActivateRouteBodySchema) body: P<typeof ActivateRouteBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.approvals.activateRoute(state, params.id, body, key);
  }

  @Get('requests')
  requests(@Query(RequestsQuerySchema) query: P<typeof RequestsQuerySchema>, @ReqState() state: RequestState) {
    return this.approvals.listRequests(state, query);
  }

  @Get('requests/waiting')
  waiting(@ReqState() state: RequestState) {
    return this.approvals.waiting(state);
  }

  @Get('requests/:id')
  request(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.approvals.getRequest(state, params.id);
  }

  @Post('requests/:id/decide') @HttpCode(200) @Idempotent('approval.decide', 'id')
  decide(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(DecideBodySchema) body: P<typeof DecideBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.approvals.decide(state, params.id, body, key);
  }

  @Post('requests/:id/withdraw') @HttpCode(200) @Idempotent('approval.withdraw', 'id')
  withdraw(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(WithdrawBodySchema) body: P<typeof WithdrawBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.approvals.withdraw(state, params.id, body, key);
  }

  @Get('delegations')
  delegations(@ReqState() state: RequestState) {
    return this.approvals.listDelegations(state);
  }

  @Post('delegations') @HttpCode(201) @Idempotent('approval.delegate')
  delegate(@Body(DelegateBodySchema) body: P<typeof DelegateBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.approvals.delegate(state, body, key);
  }

  @Post('delegations/:id/revoke') @HttpCode(200) @Idempotent('approval.delegation_revoke', 'id')
  revoke(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(RevokeDelegationBodySchema) body: P<typeof RevokeDelegationBodySchema>, @ReqState() state: RequestState, @Headers('idempotency-key') key?: string) {
    return this.approvals.revokeDelegation(state, params.id, body, key);
  }
}
