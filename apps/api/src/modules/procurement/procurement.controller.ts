import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import {
  CloseRfqCommandSchema, ConvertNeedCommandSchema, CreateNeedCommandSchema, CreateRfqCommandSchema, InviteSupplierRequestSchema, OpenRfqAmendmentCommandSchema, PublishRfqCommandSchema,
  RespondToInvitationCommandSchema, RevalidateInvitationCommandSchema, SaveNeedCommandSchema, SaveRfqDraftCommandSchema, SaveRfqPrivateConstraintCommandSchema, SetRfqProjectionCommandSchema,
  WithdrawInvitationCommandSchema,
} from './deps.js';
import { ProcurementService } from './procurement.service.js';

const IdParams = z.strictObject({ id: IdSchema });
const VersionParams = z.strictObject({ id: IdSchema, versionId: IdSchema });
const InvitationParams = z.strictObject({ id: IdSchema, invitationId: IdSchema });
const InvitationOnlyParams = z.strictObject({ invitationId: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;

/** Needs (COM-001) under `/v1/needs`: owner-private intake that converts once into an RFQ draft. */
@Controller('v1/needs')
export class NeedsController {
  constructor(@Inject(ProcurementService) private readonly procurement: ProcurementService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.procurement.listNeeds(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('need.create')
  create(@Body(CreateNeedCommandSchema) body: P<typeof CreateNeedCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.createNeed(body, state);
  }

  @Get(':id') @Authenticated()
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.procurement.getNeed(params.id, state);
  }

  @Post(':id') @HttpCode(200) @Authenticated() @Idempotent('need.save', 'id')
  save(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveNeedCommandSchema) body: P<typeof SaveNeedCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.saveNeed(params.id, body, state);
  }

  @Post(':id/convert') @HttpCode(201) @Authenticated() @Idempotent('need.convert', 'id')
  convert(@Params(IdParams) params: P<typeof IdParams>, @Body(ConvertNeedCommandSchema) body: P<typeof ConvertNeedCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.convertNeed(params.id, body, state);
  }
}

/**
 * RFQs (COM-001) under `/v1/rfqs`: drafts, immutable published versions, the buyer-private record, invitations pinned
 * to the exact version and amendments that flag earlier invitations stale. Reads by anyone outside the buyer side and
 * the invited parties are not found; the public projection is a separate read.
 */
@Controller('v1/rfqs')
export class RfqsController {
  constructor(@Inject(ProcurementService) private readonly procurement: ProcurementService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.procurement.listRfqs(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('rfq.create')
  create(@Body(CreateRfqCommandSchema) body: P<typeof CreateRfqCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.createRfq(body, state);
  }

  @Get(':id')
  get(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.procurement.getRfq(params.id, state);
  }

  @Get(':id/public')
  publicView(@Params(IdParams) params: P<typeof IdParams>, @ReqState() state: RequestState) {
    return this.procurement.publicRfq(params.id, state);
  }

  @Post(':id/versions') @HttpCode(201) @Authenticated() @Idempotent('rfq.amendment_open', 'id')
  openAmendment(@Params(IdParams) params: P<typeof IdParams>, @Body(OpenRfqAmendmentCommandSchema) body: P<typeof OpenRfqAmendmentCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.openAmendment(params.id, body, state);
  }

  @Post(':id/versions/:versionId') @HttpCode(200) @Authenticated() @Idempotent('rfq.draft_save', 'versionId')
  saveDraft(@Params(VersionParams) params: P<typeof VersionParams>, @Body(SaveRfqDraftCommandSchema) body: P<typeof SaveRfqDraftCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.saveDraft(params.id, params.versionId, body, state);
  }

  @Post(':id/publish') @HttpCode(200) @Authenticated() @Idempotent('rfq.version_publish', 'id')
  publish(@Params(IdParams) params: P<typeof IdParams>, @Body(PublishRfqCommandSchema) body: P<typeof PublishRfqCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.publish(params.id, body, state);
  }

  @Post(':id/private') @HttpCode(200) @Authenticated() @Idempotent('rfq.private_save', 'id')
  setPrivate(@Params(IdParams) params: P<typeof IdParams>, @Body(SaveRfqPrivateConstraintCommandSchema) body: P<typeof SaveRfqPrivateConstraintCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.setPrivateConstraint(params.id, body, state);
  }

  @Post(':id/invitations') @HttpCode(201) @Authenticated() @Idempotent('rfq.invite', 'id')
  invite(@Params(IdParams) params: P<typeof IdParams>, @Body(InviteSupplierRequestSchema) body: P<typeof InviteSupplierRequestSchema>, @ReqState() state: RequestState) {
    return this.procurement.invite(params.id, body, state);
  }

  @Post(':id/invitations/:invitationId/revalidate') @HttpCode(201) @Authenticated() @Idempotent('rfq.invitation_revalidate', 'invitationId')
  revalidate(@Params(InvitationParams) params: P<typeof InvitationParams>, @Body(RevalidateInvitationCommandSchema) body: P<typeof RevalidateInvitationCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.revalidate(params.id, params.invitationId, body, state);
  }

  @Post(':id/invitations/:invitationId/withdraw') @HttpCode(200) @Authenticated() @Idempotent('rfq.invitation_withdraw', 'invitationId')
  withdraw(@Params(InvitationParams) params: P<typeof InvitationParams>, @Body(WithdrawInvitationCommandSchema) body: P<typeof WithdrawInvitationCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.withdraw(params.id, params.invitationId, body, state);
  }

  @Post(':id/close') @HttpCode(200) @Authenticated() @Idempotent('rfq.close', 'id')
  close(@Params(IdParams) params: P<typeof IdParams>, @Body(CloseRfqCommandSchema) body: P<typeof CloseRfqCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.close(params.id, body, state);
  }

  @Post(':id/projection') @HttpCode(200) @Authenticated() @Idempotent('rfq.projection_set', 'id')
  setProjection(@Params(IdParams) params: P<typeof IdParams>, @Body(SetRfqProjectionCommandSchema) body: P<typeof SetRfqProjectionCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.setProjection(params.id, body, state);
  }
}

/** The supplier side of invitations (COM-001) under `/v1/rfq-invitations`: only invitations addressed to the principal or its employer. */
@Controller('v1/rfq-invitations')
export class RfqInvitationsController {
  constructor(@Inject(ProcurementService) private readonly procurement: ProcurementService) {}

  @Get() @Authenticated()
  list(@ReqState() state: RequestState) {
    return this.procurement.listInvitations(state);
  }

  @Post(':invitationId/respond') @HttpCode(200) @Authenticated() @Idempotent('rfq.invitation_respond', 'invitationId')
  respond(@Params(InvitationOnlyParams) params: P<typeof InvitationOnlyParams>, @Body(RespondToInvitationCommandSchema) body: P<typeof RespondToInvitationCommandSchema>, @ReqState() state: RequestState) {
    return this.procurement.respond(params.invitationId, body, state);
  }
}
