import { Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import {
  AcceptTaskOfferCommandSchema, CancelTaskRequestCommandSchema, ConfirmTaskAgreementCommandSchema, CreateTaskOfferCommandSchema, CreateTaskRequestCommandSchema,
  DeclineTaskAgreementCommandSchema, InviteTaskOfferorCommandSchema, PublishTaskRequestCommandSchema, RecordTaskExecutionCommandSchema, SaveTaskOfferDraftCommandSchema,
  SaveTaskRequestDraftCommandSchema, SaveTaskRequestPrivateCommandSchema, SendTaskOfferCommandSchema, SubmitTaskReviewCommandSchema, WithdrawTaskAgreementCommandSchema,
  WithdrawTaskOfferCommandSchema,
} from './deps.js';
import { TasksService } from './tasks.service.js';

const IdParams = z.strictObject({ id: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;
/** Acceptance events record the request's idempotency key (the interceptor has already required and scoped it). */
function keyOf(header: string | undefined): string {
  if (!header || !/^[A-Za-z0-9._:-]{1,200}$/.test(header)) throw new ApiError('validation.schema', 'an Idempotency-Key header is required', { reason: 'idempotency_key' });
  return header;
}

/**
 * Task requests (TASK-001) under `/v1/task-requests`: the owner cuts a request from an approved plan item, publishes
 * immutable versions, invites offerors and accepts one exact offer version. Invitees and offerors read the published
 * brief; everyone else gets not found. `GET /v1/task-requests/open` is the open board.
 */
@Controller('v1/task-requests')
export class TaskRequestsController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.tasks.listRequests(state);
  }

  @Get('open') @Authenticated()
  open(@ReqState() state: RequestState) {
    return this.tasks.listOpen(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('task.request_create')
  create(@Body(CreateTaskRequestCommandSchema) body: P<typeof CreateTaskRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.createRequest(body, state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.tasks.getRequest(params.id, state);
  }

  @Post(':id/draft') @HttpCode(200) @Authenticated() @Idempotent('task.draft_save', 'id')
  saveDraft(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveTaskRequestDraftCommandSchema) body: P<typeof SaveTaskRequestDraftCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.saveDraft(params.id, body, state);
  }

  @Post(':id/publish') @HttpCode(200) @Authenticated() @Idempotent('task.version_publish', 'id')
  publish(@Params(IdParams) params: P<typeof IdParams>, @Body(PublishTaskRequestCommandSchema) body: P<typeof PublishTaskRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.publish(params.id, body, state);
  }

  @Post(':id/private') @HttpCode(200) @Authenticated() @Idempotent('task.private_save', 'id')
  setPrivate(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveTaskRequestPrivateCommandSchema) body: P<typeof SaveTaskRequestPrivateCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.setPrivate(params.id, body, state);
  }

  @Post(':id/invitations') @HttpCode(201) @Authenticated() @Idempotent('task.invite', 'id')
  invite(@Params(IdParams) params: P<typeof IdParams>, @Body(InviteTaskOfferorCommandSchema) body: P<typeof InviteTaskOfferorCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.invite(params.id, body, state);
  }

  @Post(':id/cancel') @HttpCode(200) @Authenticated() @Idempotent('task.request_cancel', 'id')
  cancel(@Params(IdParams) params: P<typeof IdParams>, @Body(CancelTaskRequestCommandSchema) body: P<typeof CancelTaskRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.cancel(params.id, body, state);
  }

  @Post(':id/acceptances') @HttpCode(201) @Authenticated() @Idempotent('task.offer_accept', 'id')
  accept(@Params(IdParams) params: P<typeof IdParams>, @Body(AcceptTaskOfferCommandSchema) body: P<typeof AcceptTaskOfferCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.tasks.acceptOffer(params.id, body, keyOf(key), state);
  }
}

/** Invitations addressed to the principal or the company it acts for. */
@Controller('v1/task-invitations')
export class TaskInvitationsController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.tasks.listInvitations(state);
  }
}

/** Offers (TASK-001) under `/v1/task-offers`: the offeror's desk; the owner reads sent offers in its request view. */
@Controller('v1/task-offers')
export class TaskOffersController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.tasks.listOffers(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('task.offer_create')
  create(@Body(CreateTaskOfferCommandSchema) body: P<typeof CreateTaskOfferCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.createOffer(body, state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.tasks.getOffer(params.id, state);
  }

  @Post(':id') @HttpCode(200) @Authenticated() @Idempotent('task.offer_save', 'id')
  save(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveTaskOfferDraftCommandSchema) body: P<typeof SaveTaskOfferDraftCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.saveOffer(params.id, body, state);
  }

  @Post(':id/send') @HttpCode(200) @Authenticated() @Idempotent('task.offer_send', 'id')
  send(@Params(IdParams) params: P<typeof IdParams>, @Body(SendTaskOfferCommandSchema) body: P<typeof SendTaskOfferCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.sendOffer(params.id, body, state);
  }

  @Post(':id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('task.offer_withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawTaskOfferCommandSchema) body: P<typeof WithdrawTaskOfferCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.withdrawOffer(params.id, body, state);
  }
}

/** Task agreements (terms_kind `task`) under `/v1/task-agreements`: the offeror confirms or declines; the owner withdraws before that. */
@Controller('v1/task-agreements')
export class TaskAgreementsController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Post(':id/confirm') @HttpCode(201) @Authenticated() @Idempotent('task.agreement_confirm', 'id')
  confirm(@Params(IdParams) params: P<typeof IdParams>, @Body(ConfirmTaskAgreementCommandSchema) body: P<typeof ConfirmTaskAgreementCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.tasks.confirmAgreement(params.id, body, keyOf(key), state);
  }

  @Post(':id/decline') @HttpCode(200) @Authenticated() @Idempotent('task.agreement_decline', 'id')
  decline(@Params(IdParams) params: P<typeof IdParams>, @Body(DeclineTaskAgreementCommandSchema) body: P<typeof DeclineTaskAgreementCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.tasks.declineAgreement(params.id, body, keyOf(key), state);
  }

  @Post(':id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('task.agreement_withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawTaskAgreementCommandSchema) body: P<typeof WithdrawTaskAgreementCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.tasks.withdrawAcceptance(params.id, body, keyOf(key), state);
  }
}

/** Assignments under `/v1/task-assignments`: the two parties only; execution records and reviews of completed tasks. */
@Controller('v1/task-assignments')
export class TaskAssignmentsController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.tasks.listAssignments(state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.tasks.getAssignment(params.id, state);
  }

  @Post(':id/records') @HttpCode(201) @Authenticated() @Idempotent('task.record', 'id')
  record(@Params(IdParams) params: P<typeof IdParams>, @Body(RecordTaskExecutionCommandSchema) body: P<typeof RecordTaskExecutionCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.record(params.id, body, state);
  }

  @Post(':id/reviews') @HttpCode(201) @Authenticated() @Idempotent('task.review', 'id')
  review(@Params(IdParams) params: P<typeof IdParams>, @Body(SubmitTaskReviewCommandSchema) body: P<typeof SubmitTaskReviewCommandSchema>, @ReqState() state: RequestState) {
    return this.tasks.review(params.id, body, state);
  }
}
