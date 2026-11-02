import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { BindAdapterCommandSchema, EndLinkCommandSchema, FakeRunCommandSchema, GoLiveCommandSchema, LinkRecordCommandSchema, RetireAdapterCommandSchema } from './commands.js';
import { RegistersService, type Elevated } from './registers.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const AdapterParams = z.strictObject({ hubId: Uuid, adapterId: Uuid });
const CompanyParams = z.strictObject({ hubId: Uuid, companyId: Uuid });
const LinkParams = z.strictObject({ hubId: Uuid, linkId: Uuid });
const PublicCompanyParams = z.strictObject({ companyId: Uuid });
const DigestQuery = z.strictObject({ credentialRefId: Uuid });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Register facts routes of the hub console (REG-001). Every route needs a signed-in session, a staff role and a live
 * elevation (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated in the
 * console command body (completed in the request transaction, BE-005) and a staff reason, and is authorized again by
 * the database at the hub.
 */
@Controller('v1/admin/hubs/:hubId/registers')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminRegistersController {
  constructor(@Inject(RegistersService) private readonly service: RegistersService) {}

  @Get()
  overview(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.overview(state, p.hubId);
  }

  @Get('adapters/:adapterId/facts')
  adapterFacts(@Params(AdapterParams) p: P<typeof AdapterParams>, @ReqState() state: RequestState) {
    return this.service.adapterFacts(state, p.hubId, p.adapterId);
  }

  @Get('companies/:companyId/facts')
  companyFacts(@Params(CompanyParams) p: P<typeof CompanyParams>, @ReqState() state: RequestState) {
    return this.service.companyFacts(state, p.hubId, p.companyId);
  }

  @Get('adapters/:adapterId/live-digest')
  liveDigest(@Params(AdapterParams) p: P<typeof AdapterParams>, @Query(DigestQuery) q: P<typeof DigestQuery>, @ReqState() state: RequestState) {
    return this.service.liveDigest(state, p.hubId, p.adapterId, q.credentialRefId);
  }

  @Post('adapters') @HttpCode(201) @Idempotent('registers.adapter_bind')
  bind(@Params(HubParams) p: P<typeof HubParams>, @Body(BindAdapterCommandSchema) body: P<typeof BindAdapterCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.bindAdapter(elevated(state, e, r), p.hubId, body);
  }

  @Post('adapters/:adapterId/live') @HttpCode(200) @Idempotent('registers.adapter_live', 'adapterId')
  goLive(@Params(AdapterParams) p: P<typeof AdapterParams>, @Body(GoLiveCommandSchema) body: P<typeof GoLiveCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.goLive(elevated(state, e, r), p.hubId, p.adapterId, body);
  }

  @Post('adapters/:adapterId/retire') @HttpCode(200) @Idempotent('registers.adapter_retire', 'adapterId')
  retire(@Params(AdapterParams) p: P<typeof AdapterParams>, @Body(RetireAdapterCommandSchema) body: P<typeof RetireAdapterCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.retireAdapter(elevated(state, e, r), p.hubId, p.adapterId, body);
  }

  @Post('adapters/:adapterId/fake-runs') @HttpCode(201) @Idempotent('registers.fake_run', 'adapterId')
  fakeRun(@Params(AdapterParams) p: P<typeof AdapterParams>, @Body(FakeRunCommandSchema) body: P<typeof FakeRunCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.fakeRun(elevated(state, e, r), p.hubId, p.adapterId, body);
  }

  @Post('links') @HttpCode(201) @Idempotent('registers.link_record')
  link(@Params(HubParams) p: P<typeof HubParams>, @Body(LinkRecordCommandSchema) body: P<typeof LinkRecordCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.linkRecord(elevated(state, e, r), p.hubId, body);
  }

  @Post('links/:linkId/end') @HttpCode(200) @Idempotent('registers.link_end', 'linkId')
  endLink(@Params(LinkParams) p: P<typeof LinkParams>, @Body(EndLinkCommandSchema) body: P<typeof EndLinkCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.endLink(elevated(state, e, r), p.hubId, p.linkId, body);
  }
}

/**
 * Public and company routes (REG-001): what the served hub may show about a company (no session; organisations only,
 * display allowed, stale past expiry), and a company administrator's expiry reminders.
 */
@Controller('v1/companies/:companyId')
export class CompanyRegistersController {
  constructor(@Inject(RegistersService) private readonly service: RegistersService) {}

  @Get('sourced-facts')
  publicFacts(@Params(PublicCompanyParams) p: P<typeof PublicCompanyParams>) {
    return this.service.publicFacts(p.companyId);
  }

  @Get('register-reminders') @Authenticated()
  reminders(@Params(PublicCompanyParams) p: P<typeof PublicCompanyParams>, @ReqState() state: RequestState) {
    return this.service.ownReminders(state, p.companyId);
  }
}
