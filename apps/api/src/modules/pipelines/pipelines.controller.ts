import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import {
  ActivatePipelineVersionCommandSchema, CancelRunCommandSchema, CreatePipelineCommandSchema, DecideAlertCommandSchema, DraftPipelineVersionCommandSchema, PauseScheduleCommandSchema,
  ResumeScheduleCommandSchema, SetPipelineScheduleCommandSchema, SetRoleCapCommandSchema, StartRunCommandSchema,
} from './commands.js';
import { PipelinesService, type Elevated } from './pipelines.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const PipelineParams = z.strictObject({ hubId: Uuid, pipelineId: Uuid });
const VersionParams = z.strictObject({ hubId: Uuid, versionId: Uuid });
const ScheduleParams = z.strictObject({ hubId: Uuid, scheduleId: Uuid });
const RunParams = z.strictObject({ hubId: Uuid, runId: Uuid });
const AlertParams = z.strictObject({ hubId: Uuid, alertId: Uuid });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Pipeline engine routes of the hub console (PIPE-001). Every route needs a signed-in session, a staff role and a live
 * elevation (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated in the
 * console command body (completed in the request transaction, BE-005) and a staff reason, and is authorized again by
 * the database at the hub.
 */
@Controller('v1/admin/hubs/:hubId')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminPipelinesController {
  constructor(@Inject(PipelinesService) private readonly service: PipelinesService) {}

  @Get('pipelines')
  list(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.list(state, p.hubId);
  }

  @Post('pipelines') @HttpCode(201) @Idempotent('pipelines.create')
  create(@Params(HubParams) p: P<typeof HubParams>, @Body(CreatePipelineCommandSchema) body: P<typeof CreatePipelineCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.create(elevated(state, e, r), p.hubId, body);
  }

  @Get('pipelines/:pipelineId')
  detail(@Params(PipelineParams) p: P<typeof PipelineParams>, @ReqState() state: RequestState) {
    return this.service.detail(state, p.hubId, p.pipelineId);
  }

  @Post('pipelines/:pipelineId/versions') @HttpCode(201) @Idempotent('pipelines.version_draft')
  draft(@Params(PipelineParams) p: P<typeof PipelineParams>, @Body(DraftPipelineVersionCommandSchema) body: P<typeof DraftPipelineVersionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.draftVersion(elevated(state, e, r), p.hubId, p.pipelineId, body);
  }

  @Post('pipeline-versions/:versionId/activate') @HttpCode(200) @Idempotent('pipelines.version_activate')
  activate(@Params(VersionParams) p: P<typeof VersionParams>, @Body(ActivatePipelineVersionCommandSchema) body: P<typeof ActivatePipelineVersionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.activateVersion(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  @Post('pipelines/:pipelineId/schedule') @HttpCode(200) @Idempotent('pipelines.schedule_set')
  schedule(@Params(PipelineParams) p: P<typeof PipelineParams>, @Body(SetPipelineScheduleCommandSchema) body: P<typeof SetPipelineScheduleCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setSchedule(elevated(state, e, r), p.hubId, p.pipelineId, body);
  }

  @Post('pipeline-schedules/:scheduleId/pause') @HttpCode(200) @Idempotent('pipelines.schedule_pause')
  pause(@Params(ScheduleParams) p: P<typeof ScheduleParams>, @Body(PauseScheduleCommandSchema) body: P<typeof PauseScheduleCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.pauseSchedule(elevated(state, e, r), p.hubId, p.scheduleId, body, true);
  }

  @Post('pipeline-schedules/:scheduleId/resume') @HttpCode(200) @Idempotent('pipelines.schedule_resume')
  resume(@Params(ScheduleParams) p: P<typeof ScheduleParams>, @Body(ResumeScheduleCommandSchema) body: P<typeof ResumeScheduleCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.pauseSchedule(elevated(state, e, r), p.hubId, p.scheduleId, body, false);
  }

  @Post('pipeline-versions/:versionId/runs') @HttpCode(201) @Idempotent('pipelines.run_start')
  start(@Params(VersionParams) p: P<typeof VersionParams>, @Body(StartRunCommandSchema) body: P<typeof StartRunCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.startRun(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  @Get('pipeline-runs/:runId')
  run(@Params(RunParams) p: P<typeof RunParams>, @ReqState() state: RequestState) {
    return this.service.run(state, p.hubId, p.runId);
  }

  @Post('pipeline-runs/:runId/cancel') @HttpCode(200) @Idempotent('pipelines.run_cancel')
  cancel(@Params(RunParams) p: P<typeof RunParams>, @Body(CancelRunCommandSchema) body: P<typeof CancelRunCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.cancelRun(elevated(state, e, r), p.hubId, p.runId, body);
  }

  @Get('pipeline-alerts')
  alerts(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.alerts(state, p.hubId);
  }

  @Post('pipeline-alerts/:alertId/decide') @HttpCode(200) @Idempotent('pipelines.alert_decide')
  decide(@Params(AlertParams) p: P<typeof AlertParams>, @Body(DecideAlertCommandSchema) body: P<typeof DecideAlertCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.decideAlert(elevated(state, e, r), p.hubId, p.alertId, body);
  }

  @Get('pipeline-role-caps')
  roleCaps(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.roleCaps(state, p.hubId);
  }

  @Post('pipeline-role-caps') @HttpCode(200) @Idempotent('pipelines.role_cap_set')
  setRoleCap(@Params(HubParams) p: P<typeof HubParams>, @Body(SetRoleCapCommandSchema) body: P<typeof SetRoleCapCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setRoleCap(elevated(state, e, r), p.hubId, body);
  }
}
