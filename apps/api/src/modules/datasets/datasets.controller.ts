import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import {
  ActivateDatasetCommandSchema, BatchDecisionCommandSchema, ContactUseCommandSchema, DatasetLicenceCommandSchema, DatasetStatusCommandSchema, DecideLinkCommandSchema,
  DoNotCollectCommandSchema, IngestCommandSchema, LinksQuerySchema, MarkContactCommandSchema, MarkDistinctCommandSchema, ProposeDatasetCommandSchema, ProposeLinkCommandSchema,
  ResolveCommandSchema,
} from './commands.js';
import { DatasetsService, type Elevated } from './datasets.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const DatasetParams = z.strictObject({ hubId: Uuid, datasetId: Uuid });
const RecordParams = z.strictObject({ hubId: Uuid, recordId: Uuid });
const ProposalParams = z.strictObject({ hubId: Uuid, proposalId: Uuid });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Local data mining routes of the hub console (MINE-001). Every route needs a signed-in session, a staff role and a
 * live elevation (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated in
 * the console command body (completed in the request transaction, BE-005) and a staff reason, and is authorized again
 * by the database at the hub.
 */
@Controller('v1/admin/hubs/:hubId/datasets')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminDatasetsController {
  constructor(@Inject(DatasetsService) private readonly service: DatasetsService) {}

  @Get()
  list(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.list(state, p.hubId);
  }

  @Get('links')
  proposals(@Params(HubParams) p: P<typeof HubParams>, @Query(LinksQuerySchema) q: P<typeof LinksQuerySchema>, @ReqState() state: RequestState) {
    return this.service.proposals(state, p.hubId, q.state);
  }

  @Get(':datasetId')
  detail(@Params(DatasetParams) p: P<typeof DatasetParams>, @ReqState() state: RequestState) {
    return this.service.detail(state, p.hubId, p.datasetId);
  }

  @Get(':datasetId/records')
  records(@Params(DatasetParams) p: P<typeof DatasetParams>, @ReqState() state: RequestState) {
    return this.service.records(state, p.hubId, p.datasetId);
  }

  @Get(':datasetId/contact-points')
  contactPoints(@Params(DatasetParams) p: P<typeof DatasetParams>, @ReqState() state: RequestState) {
    return this.service.contactPoints(state, p.hubId, p.datasetId);
  }

  @Get(':datasetId/activation-digest')
  activationDigest(@Params(DatasetParams) p: P<typeof DatasetParams>, @ReqState() state: RequestState) {
    return this.service.activationDigest(state, p.hubId, p.datasetId);
  }

  @Post() @HttpCode(201) @Idempotent('datasets.propose')
  propose(@Params(HubParams) p: P<typeof HubParams>, @Body(ProposeDatasetCommandSchema) body: P<typeof ProposeDatasetCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.propose(elevated(state, e, r), p.hubId, body);
  }

  @Post('do-not-collect') @HttpCode(200) @Idempotent('datasets.do_not_collect')
  doNotCollect(@Params(HubParams) p: P<typeof HubParams>, @Body(DoNotCollectCommandSchema) body: P<typeof DoNotCollectCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.addDoNotCollect(elevated(state, e, r), p.hubId, body);
  }

  @Post('links') @HttpCode(201) @Idempotent('datasets.link_propose')
  proposeLink(@Params(HubParams) p: P<typeof HubParams>, @Body(ProposeLinkCommandSchema) body: P<typeof ProposeLinkCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.proposeLink(elevated(state, e, r), p.hubId, body);
  }

  @Post('links/batch') @HttpCode(200) @Idempotent('datasets.link_batch')
  batch(@Params(HubParams) p: P<typeof HubParams>, @Body(BatchDecisionCommandSchema) body: P<typeof BatchDecisionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.batchDecide(elevated(state, e, r), p.hubId, body);
  }

  @Post('links/distinct') @HttpCode(200) @Idempotent('datasets.mark_distinct')
  distinct(@Params(HubParams) p: P<typeof HubParams>, @Body(MarkDistinctCommandSchema) body: P<typeof MarkDistinctCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.markDistinct(elevated(state, e, r), p.hubId, body);
  }

  @Post('links/:proposalId/decide') @HttpCode(200) @Idempotent('datasets.link_decide', 'proposalId')
  decide(@Params(ProposalParams) p: P<typeof ProposalParams>, @Body(DecideLinkCommandSchema) body: P<typeof DecideLinkCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.decideLink(elevated(state, e, r), p.hubId, p.proposalId, body);
  }

  @Post('records/:recordId/contact') @HttpCode(200) @Idempotent('datasets.mark_contact', 'recordId')
  markContact(@Params(RecordParams) p: P<typeof RecordParams>, @Body(MarkContactCommandSchema) body: P<typeof MarkContactCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.markContact(elevated(state, e, r), p.hubId, p.recordId, body);
  }

  @Post(':datasetId/activate') @HttpCode(200) @Idempotent('datasets.activate', 'datasetId')
  activate(@Params(DatasetParams) p: P<typeof DatasetParams>, @Body(ActivateDatasetCommandSchema) body: P<typeof ActivateDatasetCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.activate(elevated(state, e, r), p.hubId, p.datasetId, body);
  }

  @Post(':datasetId/status') @HttpCode(200) @Idempotent('datasets.status', 'datasetId')
  status(@Params(DatasetParams) p: P<typeof DatasetParams>, @Body(DatasetStatusCommandSchema) body: P<typeof DatasetStatusCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setStatus(elevated(state, e, r), p.hubId, p.datasetId, body);
  }

  @Post(':datasetId/licences') @HttpCode(201) @Idempotent('datasets.licence', 'datasetId')
  licence(@Params(DatasetParams) p: P<typeof DatasetParams>, @Body(DatasetLicenceCommandSchema) body: P<typeof DatasetLicenceCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.recordLicence(elevated(state, e, r), p.hubId, p.datasetId, body);
  }

  @Post(':datasetId/contact-use') @HttpCode(200) @Idempotent('datasets.contact_use', 'datasetId')
  contactUse(@Params(DatasetParams) p: P<typeof DatasetParams>, @Body(ContactUseCommandSchema) body: P<typeof ContactUseCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setContactUse(elevated(state, e, r), p.hubId, p.datasetId, body);
  }

  @Post(':datasetId/records') @HttpCode(200) @Idempotent('datasets.ingest', 'datasetId')
  ingest(@Params(DatasetParams) p: P<typeof DatasetParams>, @Body(IngestCommandSchema) body: P<typeof IngestCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.ingest(elevated(state, e, r), p.hubId, p.datasetId, body);
  }

  @Post(':datasetId/resolve') @HttpCode(200) @Idempotent('datasets.resolve', 'datasetId')
  resolve(@Params(DatasetParams) p: P<typeof DatasetParams>, @Body(ResolveCommandSchema) body: P<typeof ResolveCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.resolve(elevated(state, e, r), p.hubId, p.datasetId, body);
  }
}
