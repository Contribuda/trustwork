import { Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import {
  AcceptProposalCommandSchema, CancelBookingCommandSchema, ChangeMentoringCommandSchema, CloseAvailabilityCommandSchema, ConfirmBookingCommandSchema, CreateAvailabilityCommandSchema,
  CreateConsultationRequestCommandSchema, DeclineAgreementCommandSchema, DeclineConsultationRequestCommandSchema, DeclineProposalCommandSchema, DecideDeliverableCommandSchema,
  ProposeConsultationCommandSchema, ProposeMentoringCommandSchema, PublicOfferingQuerySchema, PublishDeliverableCommandSchema, RecordDeliverableCommandSchema, RecordSessionCommandSchema,
  RegisterConsultationOfferingCommandSchema, RespondMentoringCommandSchema, SaveRequestPrivateCommandSchema, UpdateConsultationOfferingCommandSchema, WithdrawAcceptanceCommandSchema,
  WithdrawConsultationRequestCommandSchema, WithdrawProposalCommandSchema,
} from './deps.js';
import { ConsultationsService } from './consultations.service.js';

const IdParams = z.strictObject({ id: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;
/** Acceptance events record the request's idempotency key (the interceptor has already required and scoped it). */
function keyOf(header: string | undefined): string {
  if (!header || !/^[A-Za-z0-9._:-]{1,200}$/.test(header)) throw new ApiError('validation.schema', 'an Idempotency-Key header is required', { reason: 'idempotency_key' });
  return header;
}

/** Consultation offerings (CONS-001): the expert side registers catalogue services offerings; anyone reads active ones. */
@Controller('v1/consultation-offerings')
export class ConsultationOfferingsController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.consultations.listOfferings(state);
  }

  /** Public (anonymous too): active offerings of one owner, with allowlisted fields and the licence label. */
  @Get('public')
  publicList(@Query(PublicOfferingQuerySchema) query: P<typeof PublicOfferingQuerySchema>, @ReqState() state: RequestState) {
    return this.consultations.publicOfferings({ kind: query.ownerKind, id: query.ownerId }, state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('consultation.offering_register')
  register(@Body(RegisterConsultationOfferingCommandSchema) body: P<typeof RegisterConsultationOfferingCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.registerOffering(body, state);
  }

  @Post(':id') @HttpCode(200) @Authenticated() @Idempotent('consultation.offering_update', 'id')
  update(@Params(IdParams) params: P<typeof IdParams>, @Body(UpdateConsultationOfferingCommandSchema) body: P<typeof UpdateConsultationOfferingCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.updateOffering(params.id, body, state);
  }
}

/** The named expert's availability windows; requesters see free windows inside their request view. */
@Controller('v1/consultation-availability')
export class ConsultationAvailabilityController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.consultations.listWindows(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('consultation.window_open')
  open(@Body(CreateAvailabilityCommandSchema) body: P<typeof CreateAvailabilityCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.openWindow(body, state);
  }

  @Post(':id/close') @HttpCode(200) @Authenticated() @Idempotent('consultation.window_close', 'id')
  close(@Params(IdParams) params: P<typeof IdParams>, @Body(CloseAvailabilityCommandSchema) body: P<typeof CloseAvailabilityCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.closeWindow(params.id, body, state);
  }
}

/**
 * Consultation requests under `/v1/consultation-requests`: the requester asks one offering (from a plan item or
 * directly) and accepts one exact proposal; the expert side reads the brief, proposes or declines. Everyone else gets
 * not found.
 */
@Controller('v1/consultation-requests')
export class ConsultationRequestsController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.consultations.listRequests(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('consultation.request_create')
  create(@Body(CreateConsultationRequestCommandSchema) body: P<typeof CreateConsultationRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.createRequest(body, state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.consultations.getRequest(params.id, state);
  }

  @Post(':id/private') @HttpCode(200) @Authenticated() @Idempotent('consultation.private_save', 'id')
  setPrivate(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveRequestPrivateCommandSchema) body: P<typeof SaveRequestPrivateCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.setRequestPrivate(params.id, body, state);
  }

  @Post(':id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('consultation.request_withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawConsultationRequestCommandSchema) body: P<typeof WithdrawConsultationRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.withdrawRequest(params.id, body, state);
  }

  @Post(':id/decline') @HttpCode(200) @Authenticated() @Idempotent('consultation.request_decline', 'id')
  decline(@Params(IdParams) params: P<typeof IdParams>, @Body(DeclineConsultationRequestCommandSchema) body: P<typeof DeclineConsultationRequestCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.declineRequest(params.id, body, state);
  }

  @Post(':id/proposals') @HttpCode(201) @Authenticated() @Idempotent('consultation.propose', 'id')
  propose(@Params(IdParams) params: P<typeof IdParams>, @Body(ProposeConsultationCommandSchema) body: P<typeof ProposeConsultationCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.propose(params.id, body, state);
  }

  @Post(':id/acceptances') @HttpCode(201) @Authenticated() @Idempotent('consultation.accept', 'id')
  accept(@Params(IdParams) params: P<typeof IdParams>, @Body(AcceptProposalCommandSchema) body: P<typeof AcceptProposalCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.consultations.acceptProposal(params.id, body, keyOf(key), state);
  }
}

/** Consultation agreements (terms_kind `consultation`): the expert side confirms or declines; the client withdraws before that. */
@Controller('v1/consultation-agreements')
export class ConsultationAgreementsController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Post(':id/confirm') @HttpCode(201) @Authenticated() @Idempotent('consultation.confirm', 'id')
  confirm(@Params(IdParams) params: P<typeof IdParams>, @Body(ConfirmBookingCommandSchema) body: P<typeof ConfirmBookingCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.consultations.confirmBooking(params.id, body, keyOf(key), state);
  }

  @Post(':id/decline') @HttpCode(200) @Authenticated() @Idempotent('consultation.agreement_decline', 'id')
  decline(@Params(IdParams) params: P<typeof IdParams>, @Body(DeclineAgreementCommandSchema) body: P<typeof DeclineAgreementCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.consultations.declineAgreement(params.id, body, keyOf(key), state);
  }

  @Post(':id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('consultation.acceptance_withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawAcceptanceCommandSchema) body: P<typeof WithdrawAcceptanceCommandSchema>, @Headers('idempotency-key') key: string | undefined, @ReqState() state: RequestState) {
    return this.consultations.withdrawAcceptance(params.id, body, keyOf(key), state);
  }
}

/** Proposals and bookings under `/v1/consultation-bookings`: the two parties only. */
@Controller('v1/consultation-bookings')
export class ConsultationBookingsController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.consultations.listBookings(state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.consultations.getBooking(params.id, state);
  }

  @Get(':id/calendar') @Authenticated()
  calendar(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.consultations.calendar(params.id, state);
  }

  @Post(':id/withdraw') @HttpCode(200) @Authenticated() @Idempotent('consultation.proposal_withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawProposalCommandSchema) body: P<typeof WithdrawProposalCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.withdrawProposal(params.id, body, state);
  }

  @Post(':id/decline') @HttpCode(200) @Authenticated() @Idempotent('consultation.proposal_decline', 'id')
  decline(@Params(IdParams) params: P<typeof IdParams>, @Body(DeclineProposalCommandSchema) body: P<typeof DeclineProposalCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.declineProposal(params.id, body, state);
  }

  @Post(':id/cancel') @HttpCode(200) @Authenticated() @Idempotent('consultation.cancel', 'id')
  cancel(@Params(IdParams) params: P<typeof IdParams>, @Body(CancelBookingCommandSchema) body: P<typeof CancelBookingCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.cancel(params.id, body, state);
  }

  @Post(':id/session') @HttpCode(200) @Authenticated() @Idempotent('consultation.session_record', 'id')
  session(@Params(IdParams) params: P<typeof IdParams>, @Body(RecordSessionCommandSchema) body: P<typeof RecordSessionCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.recordSession(params.id, body, state);
  }

  @Post(':id/deliverables') @HttpCode(201) @Authenticated() @Idempotent('consultation.deliver', 'id')
  deliver(@Params(IdParams) params: P<typeof IdParams>, @Body(RecordDeliverableCommandSchema) body: P<typeof RecordDeliverableCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.deliver(params.id, body, state);
  }
}

/** Deliverables: the client decides in person; the author publishes; a published one is public. */
@Controller('v1/consultation-deliverables')
export class ConsultationDeliverablesController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Get(':id/public')
  publicOne(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.consultations.publicDeliverable(params.id, state);
  }

  @Post(':id/decision') @HttpCode(200) @Authenticated() @Idempotent('consultation.deliverable_decide', 'id')
  decide(@Params(IdParams) params: P<typeof IdParams>, @Body(DecideDeliverableCommandSchema) body: P<typeof DecideDeliverableCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.decideDeliverable(params.id, body, state);
  }

  @Post(':id/publish') @HttpCode(200) @Authenticated() @Idempotent('consultation.deliverable_publish', 'id')
  publish(@Params(IdParams) params: P<typeof IdParams>, @Body(PublishDeliverableCommandSchema) body: P<typeof PublishDeliverableCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.publishDeliverable(params.id, body, state);
  }
}

/** Mentoring relationships between two people: double opt-in; either side pauses, resumes or ends. */
@Controller('v1/mentoring')
export class MentoringController {
  constructor(@Inject(ConsultationsService) private readonly consultations: ConsultationsService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.consultations.listMentoring(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('consultation.mentoring_propose')
  propose(@Body(ProposeMentoringCommandSchema) body: P<typeof ProposeMentoringCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.proposeMentoring(body, state);
  }

  @Post(':id/respond') @HttpCode(200) @Authenticated() @Idempotent('consultation.mentoring_respond', 'id')
  respond(@Params(IdParams) params: P<typeof IdParams>, @Body(RespondMentoringCommandSchema) body: P<typeof RespondMentoringCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.respondMentoring(params.id, body, state);
  }

  @Post(':id/change') @HttpCode(200) @Authenticated() @Idempotent('consultation.mentoring_change', 'id')
  change(@Params(IdParams) params: P<typeof IdParams>, @Body(ChangeMentoringCommandSchema) body: P<typeof ChangeMentoringCommandSchema>, @ReqState() state: RequestState) {
    return this.consultations.changeMentoring(params.id, body, state);
  }
}
