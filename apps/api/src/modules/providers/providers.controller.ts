import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { RunConnectionTestCommandSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import {
  ActivateRouteCommandSchema, CreateCapCommandSchema, CreateConnectionCommandSchema, DraftRouteCommandSchema, EnableConnectionCommandSchema, EngageProviderKillCommandSchema,
  ExplainCallCommandSchema, PROVIDER_CHANGE_OBJECTS, ProviderSecretSubmitCommandSchema, RecordModelPricingCommandSchema, ReleaseProviderKillCommandSchema,
  RevisionedProvidersCommandSchema, SetEgressRuleCommandSchema, UpdateCapCommandSchema, UpdateConnectionCommandSchema,
} from './deps.js';
import { ProvidersService, type Elevated } from './providers.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const ConnectionParams = z.strictObject({ hubId: Uuid, connectionId: Uuid });
const RouteParams = z.strictObject({ hubId: Uuid, routeId: Uuid });
const CapParams = z.strictObject({ hubId: Uuid, budgetId: Uuid });
const KillParams = z.strictObject({ hubId: Uuid, killSwitchId: Uuid });
const UsageQuery = z.strictObject({ from: z.iso.datetime({ offset: false }), to: z.iso.datetime({ offset: false }) })
  .refine((q) => Date.parse(q.to) > Date.parse(q.from) && Date.parse(q.to) - Date.parse(q.from) <= 400 * 86_400_000, { message: 'a window of at most 400 days', path: ['to'] });
const ChangesQuery = z.strictObject({ objectType: z.enum(PROVIDER_CHANGE_OBJECTS).optional(), objectId: Uuid.optional() });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Keys, providers and models of one hub (KEYS-001): connections, the write-only secret endpoint, synthetic connection
 * tests, enabling, the egress matrix, routes scoped by job, module or extension, caps, cost records, kill switches,
 * usage by cohort-free dimensions, the change log and a preview of the call gate. Every route needs a signed-in
 * session, a staff role and a live elevation (BE-004 `ElevationGuard`); every mutation carries the CSRF header and a
 * console command body with a staff reason, and is authorized again by the database at the hub. Two-person actions
 * called without an approval answer `pending_second_person` with the approval request a second person decides through
 * `/v1/admin/approvals`. The secret route is deliberately not idempotent: a secret is never stored in a record.
 */
@Controller('v1/admin/hubs/:hubId/providers')
@Authenticated()
@UseGuards(ElevationGuard)
export class ProvidersController {
  constructor(@Inject(ProvidersService) private readonly providers: ProvidersService) {}

  /* ---------- Connections and secrets ---------- */

  @Get('connections')
  connections(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.providers.connections(state, p.hubId);
  }

  @Post('connections') @HttpCode(201) @Idempotent('providers.connection_create')
  createConnection(@Params(HubParams) p: P<typeof HubParams>, @Body(CreateConnectionCommandSchema) body: P<typeof CreateConnectionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.createConnection(elevated(state, e, r), p.hubId, body);
  }

  @Get('connections/:connectionId')
  connection(@Params(ConnectionParams) p: P<typeof ConnectionParams>, @ReqState() state: RequestState) {
    return this.providers.connection(state, p.hubId, p.connectionId);
  }

  @Post('connections/:connectionId/update') @HttpCode(200) @Idempotent('providers.connection_update')
  updateConnection(@Params(ConnectionParams) p: P<typeof ConnectionParams>, @Body(UpdateConnectionCommandSchema) body: P<typeof UpdateConnectionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.updateConnection(elevated(state, e, r), p.hubId, p.connectionId, body);
  }

  /** Write-only: accepts a secret value once and answers with its reference; no idempotency record keeps the body. */
  @Post('connections/:connectionId/secret') @HttpCode(201)
  submitSecret(@Params(ConnectionParams) p: P<typeof ConnectionParams>, @Body(ProviderSecretSubmitCommandSchema) body: P<typeof ProviderSecretSubmitCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.submitSecret(elevated(state, e, r), p.hubId, p.connectionId, body);
  }

  @Post('connections/:connectionId/secret/revoke') @HttpCode(200) @Idempotent('providers.secret_revoke')
  revokeSecret(@Params(ConnectionParams) p: P<typeof ConnectionParams>, @Body(RevisionedProvidersCommandSchema) body: P<typeof RevisionedProvidersCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.revokeSecret(elevated(state, e, r), p.hubId, p.connectionId, body);
  }

  @Post('connections/:connectionId/test') @HttpCode(200) @Idempotent('providers.connection_test')
  test(@Params(ConnectionParams) p: P<typeof ConnectionParams>, @Body(RunConnectionTestCommandSchema) body: P<typeof RunConnectionTestCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.testConnection(elevated(state, e, r), p.hubId, p.connectionId, body);
  }

  @Post('connections/:connectionId/enable') @HttpCode(200) @Idempotent('providers.connection_enable')
  enable(@Params(ConnectionParams) p: P<typeof ConnectionParams>, @Body(EnableConnectionCommandSchema) body: P<typeof EnableConnectionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.enableConnection(elevated(state, e, r), p.hubId, p.connectionId, body);
  }

  @Post('connections/:connectionId/disable') @HttpCode(200) @Idempotent('providers.connection_disable')
  disable(@Params(ConnectionParams) p: P<typeof ConnectionParams>, @Body(RevisionedProvidersCommandSchema) body: P<typeof RevisionedProvidersCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.disableConnection(elevated(state, e, r), p.hubId, p.connectionId, body);
  }

  /* ---------- Egress ---------- */

  @Get('egress')
  egress(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.providers.egress(state, p.hubId);
  }

  @Post('egress') @HttpCode(200) @Idempotent('providers.egress_set')
  setEgress(@Params(HubParams) p: P<typeof HubParams>, @Body(SetEgressRuleCommandSchema) body: P<typeof SetEgressRuleCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.setEgress(elevated(state, e, r), p.hubId, body);
  }

  /* ---------- Routes ---------- */

  @Get('routes')
  routes(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.providers.routes(state, p.hubId);
  }

  @Post('routes') @HttpCode(201) @Idempotent('providers.route_draft')
  draftRoute(@Params(HubParams) p: P<typeof HubParams>, @Body(DraftRouteCommandSchema) body: P<typeof DraftRouteCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.draftRoute(elevated(state, e, r), p.hubId, body);
  }

  @Post('routes/:routeId/activate') @HttpCode(200) @Idempotent('providers.route_activate')
  activateRoute(@Params(RouteParams) p: P<typeof RouteParams>, @Body(ActivateRouteCommandSchema) body: P<typeof ActivateRouteCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.activateRoute(elevated(state, e, r), p.hubId, p.routeId, body);
  }

  @Post('routes/:routeId/disable') @HttpCode(200) @Idempotent('providers.route_disable')
  disableRoute(@Params(RouteParams) p: P<typeof RouteParams>, @Body(RevisionedProvidersCommandSchema) body: P<typeof RevisionedProvidersCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.disableRoute(elevated(state, e, r), p.hubId, p.routeId, body);
  }

  /** A preview of the call gate for a described call; reserves nothing. */
  @Post('explain') @HttpCode(200)
  explain(@Params(HubParams) p: P<typeof HubParams>, @Body(ExplainCallCommandSchema) body: P<typeof ExplainCallCommandSchema>, @ReqState() state: RequestState) {
    return this.providers.explain(state, p.hubId, body);
  }

  /* ---------- Caps, cost records, usage ---------- */

  @Get('caps')
  caps(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.providers.caps(state, p.hubId);
  }

  @Post('caps') @HttpCode(201) @Idempotent('providers.cap_create')
  createCap(@Params(HubParams) p: P<typeof HubParams>, @Body(CreateCapCommandSchema) body: P<typeof CreateCapCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.createCap(elevated(state, e, r), p.hubId, body);
  }

  @Post('caps/:budgetId/update') @HttpCode(200) @Idempotent('providers.cap_update')
  updateCap(@Params(CapParams) p: P<typeof CapParams>, @Body(UpdateCapCommandSchema) body: P<typeof UpdateCapCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.updateCap(elevated(state, e, r), p.hubId, p.budgetId, body);
  }

  @Post('caps/:budgetId/retire') @HttpCode(200) @Idempotent('providers.cap_retire')
  retireCap(@Params(CapParams) p: P<typeof CapParams>, @Body(RevisionedProvidersCommandSchema) body: P<typeof RevisionedProvidersCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.retireCap(elevated(state, e, r), p.hubId, p.budgetId, body);
  }

  @Get('pricing')
  pricing(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.providers.pricing(state, p.hubId);
  }

  @Post('pricing') @HttpCode(201) @Idempotent('providers.pricing_record')
  recordPricing(@Params(HubParams) p: P<typeof HubParams>, @Body(RecordModelPricingCommandSchema) body: P<typeof RecordModelPricingCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.recordPricing(elevated(state, e, r), p.hubId, body);
  }

  @Get('usage')
  usage(@Params(HubParams) p: P<typeof HubParams>, @Query(UsageQuery) q: P<typeof UsageQuery>, @ReqState() state: RequestState) {
    return this.providers.usage(state, p.hubId, new Date(q.from), new Date(q.to));
  }

  @Get('changes')
  changes(@Params(HubParams) p: P<typeof HubParams>, @Query(ChangesQuery) q: P<typeof ChangesQuery>, @ReqState() state: RequestState) {
    return this.providers.changes(state, p.hubId, q);
  }

  /* ---------- Kill switches ---------- */

  @Get('kill-switches')
  killSwitches(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.providers.killSwitches(state, p.hubId);
  }

  @Post('kill-switches') @HttpCode(201) @Idempotent('providers.kill_engage')
  engageKill(@Params(HubParams) p: P<typeof HubParams>, @Body(EngageProviderKillCommandSchema) body: P<typeof EngageProviderKillCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.engageKill(elevated(state, e, r), p.hubId, body);
  }

  @Post('kill-switches/:killSwitchId/release') @HttpCode(200) @Idempotent('providers.kill_release')
  releaseKill(@Params(KillParams) p: P<typeof KillParams>, @Body(ReleaseProviderKillCommandSchema) body: P<typeof ReleaseProviderKillCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.providers.releaseKill(elevated(state, e, r), p.hubId, p.killSwitchId, body);
  }
}
