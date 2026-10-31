import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import {
  AddDiaryEntryCommandSchema, ApprovePlanVersionCommandSchema, CreateDraftVersionCommandSchema, CreatePlanCommandSchema, DecidePlanChangeCommandSchema, PlanItemKeySchema,
  PreviewPlanShareCommandSchema, ProposePlanVersionCommandSchema, RecordPermitCommandSchema, RecordPlanChangeCommandSchema, ReturnPlanVersionCommandSchema, RevokePlanShareCommandSchema,
  SaveDraftContentCommandSchema, SetProjectLocationCommandSchema, SharePlanItemCommandSchema, UpdatePlanItemStateCommandSchema,
} from './deps.js';
import { PlansService } from './plans.service.js';

const ProjectParams = z.strictObject({ id: IdSchema });
const VersionParams = z.strictObject({ id: IdSchema, versionId: IdSchema });
const ItemParams = z.strictObject({ id: IdSchema, itemKey: PlanItemKeySchema });
const ChangeParams = z.strictObject({ id: IdSchema, changeId: IdSchema });
const ShareParams = z.strictObject({ id: IdSchema, shareId: IdSchema });
type P<T extends z.ZodType> = z.infer<T>;

/**
 * Project plans (PLAN-001) under `/v1/projects/:id/plan`. Every mutation needs a session, the CSRF header and an
 * `Idempotency-Key`; reads of a private plan by anyone outside the owner side and the listed invitees are not found.
 */
@Controller('v1/projects/:id/plan')
export class PlansController {
  constructor(@Inject(PlansService) private readonly plans: PlansService) {}

  @Get()
  get(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.get(params.id, state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('plan.create', 'id')
  create(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(CreatePlanCommandSchema) body: P<typeof CreatePlanCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.create(params.id, body, state);
  }

  @Get('shared') @Authenticated()
  shared(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.sharedWithMe(params.id, state);
  }

  @Post('versions') @HttpCode(201) @Authenticated() @Idempotent('plan.draft_create', 'id')
  createDraft(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(CreateDraftVersionCommandSchema) body: P<typeof CreateDraftVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.createDraft(params.id, body, state);
  }

  @Get('versions/:versionId') @Authenticated()
  version(@Params(VersionParams) params: P<typeof VersionParams>, @ReqState() state: RequestState) {
    return this.plans.getVersion(params.id, params.versionId, state);
  }

  @Post('versions/:versionId/content') @HttpCode(200) @Authenticated() @Idempotent('plan.draft_save', 'versionId')
  save(@Params(VersionParams) params: P<typeof VersionParams>, @Body(SaveDraftContentCommandSchema) body: P<typeof SaveDraftContentCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.saveDraft(params.id, params.versionId, body, state);
  }

  @Post('versions/:versionId/propose') @HttpCode(200) @Authenticated() @Idempotent('plan.version_propose', 'versionId')
  propose(@Params(VersionParams) params: P<typeof VersionParams>, @Body(ProposePlanVersionCommandSchema) body: P<typeof ProposePlanVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.propose(params.id, params.versionId, body, state);
  }

  @Post('versions/:versionId/approve') @HttpCode(200) @Authenticated() @Idempotent('plan.version_approve', 'versionId')
  approve(@Params(VersionParams) params: P<typeof VersionParams>, @Body(ApprovePlanVersionCommandSchema) body: P<typeof ApprovePlanVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.approve(params.id, params.versionId, body, state);
  }

  @Post('versions/:versionId/return') @HttpCode(200) @Authenticated() @Idempotent('plan.version_return', 'versionId')
  returnVersion(@Params(VersionParams) params: P<typeof VersionParams>, @Body(ReturnPlanVersionCommandSchema) body: P<typeof ReturnPlanVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.returnVersion(params.id, params.versionId, body, state);
  }

  @Get('items/states') @Authenticated()
  states(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.listItemStates(params.id, state);
  }

  @Post('items/:itemKey/state') @HttpCode(200) @Authenticated() @Idempotent('plan.item_state', 'id')
  itemState(@Params(ItemParams) params: P<typeof ItemParams>, @Body(UpdatePlanItemStateCommandSchema) body: P<typeof UpdatePlanItemStateCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.updateItemState(params.id, params.itemKey, body, state);
  }

  @Get('changes') @Authenticated()
  changes(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.listChanges(params.id, state);
  }

  @Post('changes') @HttpCode(201) @Authenticated() @Idempotent('plan.change_record', 'id')
  recordChange(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(RecordPlanChangeCommandSchema) body: P<typeof RecordPlanChangeCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.recordChange(params.id, body, state);
  }

  @Post('changes/:changeId/decide') @HttpCode(200) @Authenticated() @Idempotent('plan.change_decide', 'changeId')
  decideChange(@Params(ChangeParams) params: P<typeof ChangeParams>, @Body(DecidePlanChangeCommandSchema) body: P<typeof DecidePlanChangeCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.decideChange(params.id, params.changeId, body, state);
  }

  @Get('timing') @Authenticated()
  timing(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.timingFacts(params.id, state);
  }

  @Get('shares') @Authenticated()
  shares(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.listShares(params.id, state);
  }

  /** A read with a body: what the share would reveal and the digest to confirm. */
  @Post('shares/preview') @HttpCode(200) @Authenticated()
  preview(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(PreviewPlanShareCommandSchema) body: P<typeof PreviewPlanShareCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.previewShare(params.id, body, state);
  }

  @Post('shares') @HttpCode(201) @Authenticated() @Idempotent('plan.item_share', 'id')
  share(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(SharePlanItemCommandSchema) body: P<typeof SharePlanItemCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.share(params.id, body, state);
  }

  @Post('shares/:shareId/revoke') @HttpCode(200) @Authenticated() @Idempotent('plan.share_revoke', 'shareId')
  revoke(@Params(ShareParams) params: P<typeof ShareParams>, @Body(RevokePlanShareCommandSchema) body: P<typeof RevokePlanShareCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.revokeShare(params.id, params.shareId, body, state);
  }

  @Get('licensing') @Authenticated()
  licensing(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.licensing(params.id, state);
  }
}

/** Owner-private project records beside the plan: site location, permit records and the diary. */
@Controller('v1/projects/:id')
export class ProjectRecordsController {
  constructor(@Inject(PlansService) private readonly plans: PlansService) {}

  @Get('location') @Authenticated()
  location(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.getLocation(params.id, state).then((location) => ({ location }));
  }

  @Post('location') @HttpCode(200) @Authenticated() @Idempotent('project.location_set', 'id')
  setLocation(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(SetProjectLocationCommandSchema) body: P<typeof SetProjectLocationCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.setLocation(params.id, body, state);
  }

  @Get('permits') @Authenticated()
  permits(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.listPermits(params.id, state);
  }

  @Post('permits') @HttpCode(201) @Authenticated() @Idempotent('project.permit_record', 'id')
  recordPermit(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(RecordPermitCommandSchema) body: P<typeof RecordPermitCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.recordPermit(params.id, body, state);
  }

  @Get('diary') @Authenticated()
  diary(@Params(ProjectParams) params: P<typeof ProjectParams>, @ReqState() state: RequestState) {
    return this.plans.listDiary(params.id, state);
  }

  @Post('diary') @HttpCode(201) @Authenticated() @Idempotent('project.diary_add', 'id')
  addDiary(@Params(ProjectParams) params: P<typeof ProjectParams>, @Body(AddDiaryEntryCommandSchema) body: P<typeof AddDiaryEntryCommandSchema>, @ReqState() state: RequestState) {
    return this.plans.addDiaryEntry(params.id, body, state);
  }
}
