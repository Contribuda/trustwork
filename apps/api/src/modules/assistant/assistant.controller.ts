import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { AssistantService } from './assistant.service.js';
import {
  BacklogStatusCommandSchema, CancelRunCommandSchema, ConfirmProposalCommandSchema, ConversationCommandSchema, CreateMandateCommandSchema, DeclineCommandSchema, DecideCommandSchema,
  IdParamsSchema, NarrowMandateCommandSchema, ReviseMandateCommandSchema,
} from './schemas.js';

type P<T extends z.ZodType> = z.infer<T>;

/**
 * The person's assistant under `/v1/assistant` (AST-001). Governance routes take no `actor` field (strict bodies): a
 * mandate is created, revised or confirmed only by the signed-in person with a recent authentication (step-up), a
 * decision is approved by the person with the exact digest they were shown, and the stop control is one request that
 * is never refused for lack of step-up. Agents and connections reach none of these routes' effects: the agent side
 * can only propose (`POST /v1/assistant/conversation`).
 */
@Controller('v1/assistant')
export class AssistantController {
  constructor(@Inject(AssistantService) private readonly assistant: AssistantService) {}

  @Get('mandates') @Authenticated()
  listMandates(@ReqState() state: RequestState) {
    return this.assistant.listMandates(state);
  }

  @Post('mandates') @HttpCode(201) @Authenticated('step_up') @Idempotent('assistant.mandate_create')
  createMandate(@Body(CreateMandateCommandSchema) body: P<typeof CreateMandateCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.createMandate(body, state);
  }

  @Get('mandates/:id') @Authenticated()
  getMandate(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.assistant.getMandate(params.id, state);
  }

  @Post('mandates/:id/confirm') @HttpCode(200) @Authenticated('step_up') @Idempotent('assistant.mandate_revise', 'id')
  reviseMandate(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(ReviseMandateCommandSchema) body: P<typeof ReviseMandateCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.reviseMandate(params.id, body, state);
  }

  @Post('mandates/:id/suspend') @HttpCode(200) @Authenticated() @Idempotent('assistant.mandate_suspend', 'id')
  suspendMandate(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(NarrowMandateCommandSchema) body: P<typeof NarrowMandateCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.narrowMandate(params.id, 'suspended', body, state);
  }

  @Post('mandates/:id/revoke') @HttpCode(200) @Authenticated() @Idempotent('assistant.mandate_revoke', 'id')
  revokeMandate(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(NarrowMandateCommandSchema) body: P<typeof NarrowMandateCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.narrowMandate(params.id, 'revoked', body, state);
  }

  @Get('mandate-proposals') @Authenticated()
  listProposals(@ReqState() state: RequestState) {
    return this.assistant.listProposals(state);
  }

  @Post('mandate-proposals/:id/confirm') @HttpCode(200) @Authenticated('step_up') @Idempotent('assistant.proposal_confirm', 'id')
  confirmProposal(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(ConfirmProposalCommandSchema) body: P<typeof ConfirmProposalCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.confirmProposal(params.id, body, state);
  }

  @Post('mandate-proposals/:id/decline') @HttpCode(200) @Authenticated() @Idempotent('assistant.proposal_decline', 'id')
  declineProposal(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.assistant.declineProposal(params.id, state);
  }

  @Get('decisions') @Authenticated()
  listDecisions(@ReqState() state: RequestState) {
    return this.assistant.listDecisions(state);
  }

  @Post('decisions/:id/approve') @HttpCode(200) @Authenticated() @Idempotent('assistant.decision_approve', 'id')
  approve(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(DecideCommandSchema) body: P<typeof DecideCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.approveDecision(params.id, body, state);
  }

  @Post('decisions/:id/decline') @HttpCode(200) @Authenticated() @Idempotent('assistant.decision_decline', 'id')
  decline(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(DeclineCommandSchema) body: P<typeof DeclineCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.declineDecision(params.id, body, state);
  }

  @Get('runs') @Authenticated()
  listRuns(@ReqState() state: RequestState) {
    return this.assistant.listRuns(state);
  }

  @Get('runs/:id') @Authenticated()
  getRun(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @ReqState() state: RequestState) {
    return this.assistant.getRun(params.id, state);
  }

  @Post('runs/:id/cancel') @HttpCode(200) @Authenticated() @Idempotent('assistant.run_cancel', 'id')
  cancelRun(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(CancelRunCommandSchema) body: P<typeof CancelRunCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.cancelRun(params.id, body, state);
  }

  @Get('stop') @Authenticated()
  stopState(@ReqState() state: RequestState) {
    return this.assistant.stopState(state);
  }

  @Post('stop') @HttpCode(200) @Authenticated() @Idempotent('assistant.stop_engage')
  engageStop(@ReqState() state: RequestState) {
    return this.assistant.engageStop(state);
  }

  @Post('stop/release') @HttpCode(200) @Authenticated() @Idempotent('assistant.stop_release')
  releaseStop(@ReqState() state: RequestState) {
    return this.assistant.releaseStop(state);
  }

  @Get('conversation') @Authenticated()
  conversation(@ReqState() state: RequestState) {
    return this.assistant.conversation(state);
  }

  @Post('conversation') @HttpCode(200) @Authenticated() @Idempotent('assistant.conversation_turn')
  converse(@Body(ConversationCommandSchema) body: P<typeof ConversationCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.converse(body, state);
  }

  @Get('backlog') @Authenticated()
  backlog(@ReqState() state: RequestState) {
    return this.assistant.backlog(state);
  }

  @Post('backlog/:id/status') @HttpCode(200) @Authenticated() @Idempotent('assistant.backlog_status', 'id')
  backlogStatus(@Params(IdParamsSchema) params: P<typeof IdParamsSchema>, @Body(BacklogStatusCommandSchema) body: P<typeof BacklogStatusCommandSchema>, @ReqState() state: RequestState) {
    return this.assistant.setBacklogStatus(params.id, body, state);
  }
}
