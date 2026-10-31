import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { AssignLeaderCommandSchema, CapabilitySchema, CreateProjectCommandSchema, GrantAudienceSchema, IdSchema, PartySchema, PublishProjectCommandSchema, RevisionSchema, ShortTextSchema, TimestampSchema, TransferOwnershipCommandSchema } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { ProjectsService } from './projects.service.js';

const IdParams = z.strictObject({ id: IdSchema });
const TransferParams = z.strictObject({ id: IdSchema, transferId: IdSchema });
const ParticipantParams = z.strictObject({ id: IdSchema, participationId: IdSchema });
/** Local command shapes (requested from FND-002): participant grant/revoke. */
export const GrantParticipationCommandSchema = z.strictObject({
  party: PartySchema, side: z.enum(['buyer', 'seller', 'participant']), capabilities: z.array(CapabilitySchema).min(1), audience: GrantAudienceSchema, validUntil: TimestampSchema.nullable(),
});
export const RevokeParticipationCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: ShortTextSchema });

@Controller('v1/projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projectsService: ProjectsService) {}

  @Post() @HttpCode(201) @Authenticated() @Idempotent('project.create')
  create(@Body(CreateProjectCommandSchema) body: z.infer<typeof CreateProjectCommandSchema>, @ReqState() state: RequestState) {
    return this.projectsService.create(body, state);
  }

  @Get(':id')
  get(@Params(IdParams) params: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    return this.projectsService.get(params.id, state);
  }

  @Post(':id/leader') @HttpCode(200) @Authenticated() @Idempotent('project.assign_leader', 'id')
  leader(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(AssignLeaderCommandSchema) body: z.infer<typeof AssignLeaderCommandSchema>, @ReqState() state: RequestState) {
    if (body.projectId !== params.id) throw new ApiError('validation.schema', 'projectId does not match the route');
    return this.projectsService.assignLeader(params.id, body, state);
  }

  @Post(':id/publish') @HttpCode(200) @Authenticated() @Idempotent('project.publish', 'id')
  publish(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(PublishProjectCommandSchema) body: z.infer<typeof PublishProjectCommandSchema>, @ReqState() state: RequestState) {
    if (body.projectId !== params.id) throw new ApiError('validation.schema', 'projectId does not match the route');
    return this.projectsService.publish(params.id, body, state);
  }

  @Get(':id/transfers') @Authenticated()
  transfers(@Params(IdParams) params: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    return this.projectsService.listTransfers(params.id, state);
  }

  @Post(':id/transfers') @HttpCode(201) @Authenticated('step_up') @Idempotent('project.transfer_propose', 'id')
  propose(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(TransferOwnershipCommandSchema) body: z.infer<typeof TransferOwnershipCommandSchema>, @ReqState() state: RequestState) {
    if (body.projectId !== params.id) throw new ApiError('validation.schema', 'projectId does not match the route');
    return this.projectsService.proposeTransfer(params.id, body, state);
  }

  @Post(':id/transfers/:transferId/consent') @HttpCode(200) @Authenticated('step_up') @Idempotent('project.transfer_consent', 'transferId')
  consent(@Params(TransferParams) params: z.infer<typeof TransferParams>, @ReqState() state: RequestState) {
    return this.projectsService.answerTransfer(params.id, params.transferId, 'accepted_by_recipient', state);
  }

  @Post(':id/transfers/:transferId/reject') @HttpCode(200) @Authenticated() @Idempotent('project.transfer_reject', 'transferId')
  reject(@Params(TransferParams) params: z.infer<typeof TransferParams>, @ReqState() state: RequestState) {
    return this.projectsService.answerTransfer(params.id, params.transferId, 'rejected', state);
  }

  @Post(':id/transfers/:transferId/withdraw') @HttpCode(200) @Authenticated() @Idempotent('project.transfer_withdraw', 'transferId')
  withdraw(@Params(TransferParams) params: z.infer<typeof TransferParams>, @ReqState() state: RequestState) {
    return this.projectsService.answerTransfer(params.id, params.transferId, 'withdrawn', state);
  }

  @Post(':id/transfers/:transferId/apply') @HttpCode(200) @Authenticated('step_up') @Idempotent('project.transfer_apply', 'transferId')
  apply(@Params(TransferParams) params: z.infer<typeof TransferParams>, @ReqState() state: RequestState) {
    return this.projectsService.applyTransfer(params.id, params.transferId, state);
  }

  @Get(':id/participants') @Authenticated()
  participants(@Params(IdParams) params: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    return this.projectsService.listParticipants(params.id, state);
  }

  @Post(':id/participants') @HttpCode(201) @Authenticated() @Idempotent('project.participant_grant', 'id')
  grant(@Params(IdParams) params: z.infer<typeof IdParams>, @Body(GrantParticipationCommandSchema) body: z.infer<typeof GrantParticipationCommandSchema>, @ReqState() state: RequestState) {
    return this.projectsService.grantParticipant(params.id, body, state);
  }

  @Post(':id/participants/:participationId/revoke') @HttpCode(200) @Authenticated() @Idempotent('project.participant_revoke', 'participationId')
  revoke(@Params(ParticipantParams) params: z.infer<typeof ParticipantParams>, @Body(RevokeParticipationCommandSchema) body: z.infer<typeof RevokeParticipationCommandSchema>, @ReqState() state: RequestState) {
    return this.projectsService.revokeParticipant(params.id, params.participationId, body, state);
  }
}
