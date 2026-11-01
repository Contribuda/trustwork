import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import type { Elevated } from '../hubs/hubs.service.js';
import {
  ActingForSchema, ActivateAgentPolicyCommandSchema, DraftAgentPolicyCommandSchema, EngageAgentKillSwitchCommandSchema, PreviewAgentPolicyCommandSchema,
  ReleaseAgentKillSwitchCommandSchema, TurnOnJobCommandSchema,
} from './contracts.js';
import { AgentJobsService } from './jobs.service.js';
import { AgentPolicyService } from './policy.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const VersionParams = z.strictObject({ hubId: Uuid, versionId: Uuid });
const SwitchParams = z.strictObject({ hubId: Uuid, killSwitchId: Uuid });
const CapabilityParams = z.strictObject({ capabilityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100) });
const JobParams = z.strictObject({ id: Uuid });
const ActingForQuery = z.strictObject({ for: ActingForSchema.default('self') });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Agent product administration (AGT-003, ADR 010 decision 25): the module registry, the hub agent policy with its stored
 * preview and second-person activation, and the agent kill switches. Staff routes need a session, a staff role covering
 * the hub and a live elevation; mutations carry the CSRF header, an `Idempotency-Key` restated in the console command and
 * a reason. There is deliberately no route here that names a participant: staff manage policy for everyone and never read
 * or change one person's agent, mandates, settings, goals, job subscriptions or connections.
 */
@Controller('v1/admin/agent-modules/:hubId')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminAgentModulesController {
  constructor(@Inject(AgentPolicyService) private readonly policies: AgentPolicyService) {}

  @Get('registry')
  registry(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.policies.registryView(state, p.hubId);
  }

  @Get('policy')
  policy(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.policies.current(state, p.hubId);
  }

  /** Computes the preview of a candidate document; stores nothing. */
  @Post('policy/preview') @HttpCode(200)
  preview(@Params(HubParams) p: P<typeof HubParams>, @Body(PreviewAgentPolicyCommandSchema) body: P<typeof PreviewAgentPolicyCommandSchema>, @ReqState() state: RequestState) {
    return this.policies.preview(state, p.hubId, body.document);
  }

  @Post('policy') @HttpCode(201) @Idempotent('agent_modules.policy_draft')
  draft(@Params(HubParams) p: P<typeof HubParams>, @Body(DraftAgentPolicyCommandSchema) body: P<typeof DraftAgentPolicyCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.policies.draft(elevated(state, e, r), p.hubId, body);
  }

  @Get('policy/:versionId')
  version(@Params(VersionParams) p: P<typeof VersionParams>, @ReqState() state: RequestState) {
    return this.policies.version(state, p.hubId, p.versionId);
  }

  @Post('policy/:versionId/activate') @HttpCode(200) @Idempotent('agent_modules.policy_activate')
  activate(@Params(VersionParams) p: P<typeof VersionParams>, @Body(ActivateAgentPolicyCommandSchema) body: P<typeof ActivateAgentPolicyCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.policies.activate(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  @Get('kill-switches')
  killSwitches(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.policies.killSwitches(state, p.hubId);
  }

  @Post('kill-switches') @HttpCode(201) @Idempotent('agent_modules.kill_switch_engage')
  engage(@Params(HubParams) p: P<typeof HubParams>, @Body(EngageAgentKillSwitchCommandSchema) body: P<typeof EngageAgentKillSwitchCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.policies.engage(elevated(state, e, r), p.hubId, body);
  }

  @Post('kill-switches/:killSwitchId/release') @HttpCode(200) @Idempotent('agent_modules.kill_switch_release')
  release(@Params(SwitchParams) p: P<typeof SwitchParams>, @Body(ReleaseAgentKillSwitchCommandSchema) body: P<typeof ReleaseAgentKillSwitchCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.policies.release(elevated(state, e, r), p.hubId, p.killSwitchId, body);
  }
}

/**
 * The participant's side (AGT-003): the capabilities of their one agent in this hub (the interface surface of the shared
 * authority check), the hub's defaults and maximums for their agent settings, the jobs modules offer and turning one on
 * (a mandate proposal only). Every route acts for the signed-in person only.
 */
@Controller('v1/assistant')
@Authenticated()
export class AgentJobsController {
  constructor(@Inject(AgentJobsService) private readonly jobs: AgentJobsService) {}

  @Get('capabilities')
  capabilities(@Query(ActingForQuery) q: P<typeof ActingForQuery>, @ReqState() state: RequestState) {
    return this.jobs.capabilities(state, q.for);
  }

  @Get('capabilities/:capabilityId')
  capability(@Params(CapabilityParams) p: P<typeof CapabilityParams>, @Query(ActingForQuery) q: P<typeof ActingForQuery>, @ReqState() state: RequestState) {
    return this.jobs.capability(state, p.capabilityId, q.for);
  }

  @Get('agent-settings/bounds')
  bounds(@ReqState() state: RequestState) {
    return this.jobs.bounds(state);
  }

  @Get('job-templates')
  templates(@Query(ActingForQuery) q: P<typeof ActingForQuery>, @ReqState() state: RequestState) {
    return this.jobs.templates(state, q.for);
  }

  @Get('jobs')
  list(@ReqState() state: RequestState) {
    return this.jobs.list(state);
  }

  /** Turning a job on creates only a mandate proposal; the person confirms it at /v1/assistant/mandate-proposals/:id/confirm. */
  @Post('jobs') @HttpCode(201) @Idempotent('agent_modules.job_turn_on')
  turnOn(@Body(TurnOnJobCommandSchema) body: P<typeof TurnOnJobCommandSchema>, @ReqState() state: RequestState) {
    return this.jobs.turnOn(state, body);
  }

  @Post('jobs/:id/run') @HttpCode(200) @Idempotent('agent_modules.job_run_now')
  runNow(@Params(JobParams) p: P<typeof JobParams>, @ReqState() state: RequestState) {
    return this.jobs.runNow(state, p.id);
  }
}
