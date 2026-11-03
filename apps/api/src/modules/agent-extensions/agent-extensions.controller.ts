import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import type { Elevated } from '../hubs/hubs.service.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { AgentExtensionsService } from './agent-extensions.service.js';
import {
  ActivateExtensionsCommandSchema, DraftExtensionActivationCommandSchema, DraftExtensionVersionCommandSchema, RequestSafetyRunCommandSchema, RetireExtensionVersionCommandSchema, SuspendExtensionVersionCommandSchema,
} from './contracts.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const VersionParams = z.strictObject({ hubId: Uuid, versionId: Uuid });
const ActivationParams = z.strictObject({ hubId: Uuid, configVersionId: Uuid });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * The governed extension registry (AGT-023). Staff routes need a session, a staff role covering the hub and a live elevation;
 * mutations carry the CSRF header, an `Idempotency-Key` restated in the console command and a reason. No route names a
 * participant, and no route states that a safety suite passed.
 */
@Controller('v1/admin/agent-extensions/:hubId')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminAgentExtensionsController {
  constructor(@Inject(AgentExtensionsService) private readonly extensions: AgentExtensionsService) {}

  @Get()
  list(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.extensions.list(state, p.hubId);
  }

  @Get('versions/:versionId')
  version(@Params(VersionParams) p: P<typeof VersionParams>, @ReqState() state: RequestState) {
    return this.extensions.version(state, p.hubId, p.versionId);
  }

  @Post('versions') @HttpCode(201) @Idempotent('agent_extensions.version_draft')
  draft(@Params(HubParams) p: P<typeof HubParams>, @Body(DraftExtensionVersionCommandSchema) body: P<typeof DraftExtensionVersionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.extensions.draft(elevated(state, e, r), p.hubId, body);
  }

  @Post('versions/:versionId/safety-runs') @HttpCode(201) @Idempotent('agent_extensions.safety_run_request')
  requestRun(@Params(VersionParams) p: P<typeof VersionParams>, @Body(RequestSafetyRunCommandSchema) body: P<typeof RequestSafetyRunCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.extensions.requestRun(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  @Post('versions/:versionId/suspend') @HttpCode(200) @Idempotent('agent_extensions.version_suspend')
  suspend(@Params(VersionParams) p: P<typeof VersionParams>, @Body(SuspendExtensionVersionCommandSchema) body: P<typeof SuspendExtensionVersionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.extensions.suspend(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  @Post('versions/:versionId/retire') @HttpCode(200) @Idempotent('agent_extensions.version_retire')
  retire(@Params(VersionParams) p: P<typeof VersionParams>, @Body(RetireExtensionVersionCommandSchema) body: P<typeof RetireExtensionVersionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.extensions.retire(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  @Post('activations') @HttpCode(201) @Idempotent('agent_extensions.activation_draft')
  draftActivation(@Params(HubParams) p: P<typeof HubParams>, @Body(DraftExtensionActivationCommandSchema) body: P<typeof DraftExtensionActivationCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.extensions.draftActivation(elevated(state, e, r), p.hubId, body);
  }

  @Post('activations/:configVersionId/activate') @HttpCode(200) @Idempotent('agent_extensions.activation_activate')
  activate(@Params(ActivationParams) p: P<typeof ActivationParams>, @Body(ActivateExtensionsCommandSchema) body: P<typeof ActivateExtensionsCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.extensions.activate(elevated(state, e, r), p.hubId, p.configVersionId, body);
  }
}
