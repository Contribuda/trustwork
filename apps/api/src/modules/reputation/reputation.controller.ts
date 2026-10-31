import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import {
  AnswerConfirmationCommandSchema, AppealLimitationCommandSchema, CheckCredentialCommandSchema, CreatePortfolioEntryCommandSchema, DeclareRelationCommandSchema,
  FileReputationAppealCommandSchema, RecordCredentialCommandSchema, RemindConfirmationCommandSchema, RequestConfirmationCommandSchema, WithdrawConfirmationCommandSchema,
} from './deps.js';
import { ReputationService } from './reputation.service.js';

const IdParams = z.strictObject({ id: IdSchema });
const SubjectParams = z.strictObject({ kind: z.enum(['people', 'companies']), id: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;
const subjectOf = (params: P<typeof SubjectParams>) => ({ kind: params.kind === 'people' ? 'person' as const : 'company' as const, id: params.id });

/**
 * The reputation builder under `/v1/reputation-builder` (REP-001): the subject's own view and its tools, the
 * confirmation inbox of an addressed party, the public view, and appeals. Every mutation is the person's own act.
 */
@Controller('v1/reputation-builder')
export class ReputationBuilderController {
  constructor(@Inject(ReputationService) private readonly reputation: ReputationService) {}

  @Get(':kind/:id/own') @Authenticated()
  own(@Params(SubjectParams) params: P<typeof SubjectParams>, @ReqState() state: RequestState) {
    return this.reputation.own(subjectOf(params), state);
  }

  @Get(':kind/:id/inbox') @Authenticated()
  inbox(@Params(SubjectParams) params: P<typeof SubjectParams>, @ReqState() state: RequestState) {
    return this.reputation.inbox(subjectOf(params), state);
  }

  @Get(':kind/:id')
  public(@Params(SubjectParams) params: P<typeof SubjectParams>, @ReqState() state: RequestState) {
    return this.reputation.publicView(subjectOf(params), state);
  }

  @Post('credentials') @HttpCode(201) @Authenticated() @Idempotent('reputation.credential_record')
  recordCredential(@Body(RecordCredentialCommandSchema) body: P<typeof RecordCredentialCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.recordCredential(body, state);
  }

  @Post('credentials/:id/checks') @HttpCode(201) @Authenticated() @Idempotent('reputation.credential_check', 'id')
  checkCredential(@Params(IdParams) params: P<typeof IdParams>, @Body(CheckCredentialCommandSchema) _body: P<typeof CheckCredentialCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.checkCredential(params.id, state);
  }

  @Post('portfolio') @HttpCode(201) @Authenticated() @Idempotent('reputation.portfolio_add')
  addPortfolioEntry(@Body(CreatePortfolioEntryCommandSchema) body: P<typeof CreatePortfolioEntryCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.addPortfolioEntry(body, state);
  }

  @Post('relations') @HttpCode(201) @Authenticated() @Idempotent('reputation.relation_declare')
  declareRelation(@Body(DeclareRelationCommandSchema) body: P<typeof DeclareRelationCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.declareRelation(body, state);
  }

  @Post('confirmations') @HttpCode(201) @Authenticated() @Idempotent('reputation.confirmation_request')
  requestConfirmation(@Body(RequestConfirmationCommandSchema) body: P<typeof RequestConfirmationCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.requestConfirmation(body, state);
  }

  @Post('confirmations/:id/reminder') @HttpCode(200) @Authenticated() @Idempotent('reputation.confirmation_remind', 'id')
  remind(@Params(IdParams) params: P<typeof IdParams>, @Body(RemindConfirmationCommandSchema) _body: P<typeof RemindConfirmationCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.remind(params.id, state);
  }

  @Post('confirmations/:id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('reputation.confirmation_withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawConfirmationCommandSchema) _body: P<typeof WithdrawConfirmationCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.withdraw(params.id, state);
  }

  @Post('confirmations/:id/response') @HttpCode(201) @Authenticated() @Idempotent('reputation.confirmation_answer', 'id')
  answer(@Params(IdParams) params: P<typeof IdParams>, @Body(AnswerConfirmationCommandSchema) body: P<typeof AnswerConfirmationCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.answer(params.id, body, state);
  }

  @Post('appeals') @HttpCode(201) @Authenticated() @Idempotent('reputation.appeal_file')
  appeal(@Body(FileReputationAppealCommandSchema) body: P<typeof FileReputationAppealCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.fileAppeal(body, state);
  }

  @Post('limitations/appeals') @HttpCode(201) @Authenticated() @Idempotent('reputation.limitation_appeal')
  appealLimitation(@Body(AppealLimitationCommandSchema) body: P<typeof AppealLimitationCommandSchema>, @ReqState() state: RequestState) {
    return this.reputation.appealLimitation(body, state);
  }
}
