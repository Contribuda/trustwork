import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import {
  AssistItemCommandSchema, CheckRobotsCommandSchema, CheckRslCommandSchema, DecideBatchCommandSchema, DecideItemCommandSchema, DecideLinkCommandSchema, ImportBatchStatusSchema,
  LinkStateSchema, ProposeLinkCommandSchema, RecordTermsCheckCommandSchema, RegisterSourceCommandSchema, SetSourceTermsCommandSchema, SetSponsoredPolicyCommandSchema,
  SourcedRecordKindSchema, SourceStatusCommandSchema, SourceStatusSchema, StageBatchCommandSchema, TakedownCommandSchema,
} from './deps.js';
import { SourcesService, type Elevated } from './sources.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const SourceParams = z.strictObject({ hubId: Uuid, sourceId: Uuid });
const BatchParams = z.strictObject({ hubId: Uuid, batchId: Uuid });
const ItemParams = z.strictObject({ hubId: Uuid, itemId: Uuid });
const LinkParams = z.strictObject({ hubId: Uuid, linkId: Uuid });
const TakedownParams = z.strictObject({ hubId: Uuid, takedownId: Uuid });
const RecordParams = z.strictObject({ hubId: Uuid, recordKind: SourcedRecordKindSchema, recordId: Uuid });
const SourcesQuery = z.strictObject({ status: SourceStatusSchema.optional() });
const BatchesQuery = z.strictObject({ status: ImportBatchStatusSchema.optional() });
const LinksQuery = z.strictObject({ state: LinkStateSchema.optional() });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Hub source registry routes (SRC-001). Every route needs a signed-in session, a staff role and a live elevation of the
 * acting session (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated in the
 * console command body (completed in the request transaction, BE-005) and a staff reason, and is authorized again by
 * the database at the hub. Switching sponsored content on without an approval answers `pending_second_person`.
 */
@Controller('v1/admin/hubs/:hubId')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminSourcesController {
  constructor(@Inject(SourcesService) private readonly service: SourcesService) {}

  /* ---------- Sources ---------- */

  @Get('sources')
  list(@Params(HubParams) p: P<typeof HubParams>, @Query(SourcesQuery) q: P<typeof SourcesQuery>, @ReqState() state: RequestState) {
    return this.service.listSources(state, p.hubId, q.status);
  }

  @Post('sources') @HttpCode(201) @Idempotent('sources.register')
  register(@Params(HubParams) p: P<typeof HubParams>, @Body(RegisterSourceCommandSchema) body: P<typeof RegisterSourceCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.register(elevated(state, e, r), p.hubId, body);
  }

  @Get('sources/:sourceId')
  get(@Params(SourceParams) p: P<typeof SourceParams>, @ReqState() state: RequestState) {
    return this.service.getSource(state, p.hubId, p.sourceId);
  }

  @Post('sources/:sourceId/terms') @HttpCode(200) @Idempotent('sources.terms_set')
  setTerms(@Params(SourceParams) p: P<typeof SourceParams>, @Body(SetSourceTermsCommandSchema) body: P<typeof SetSourceTermsCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setTerms(elevated(state, e, r), p.hubId, p.sourceId, body);
  }

  @Post('sources/:sourceId/terms-check') @HttpCode(200) @Idempotent('sources.terms_record')
  recordTerms(@Params(SourceParams) p: P<typeof SourceParams>, @Body(RecordTermsCheckCommandSchema) body: P<typeof RecordTermsCheckCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.recordTerms(elevated(state, e, r), p.hubId, p.sourceId, body);
  }

  @Post('sources/:sourceId/robots-check') @HttpCode(200) @Idempotent('sources.robots_check')
  checkRobots(@Params(SourceParams) p: P<typeof SourceParams>, @Body(CheckRobotsCommandSchema) body: P<typeof CheckRobotsCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.checkRobots(elevated(state, e, r), p.hubId, p.sourceId, body);
  }

  @Post('sources/:sourceId/rsl-check') @HttpCode(200) @Idempotent('sources.rsl_check')
  checkRsl(@Params(SourceParams) p: P<typeof SourceParams>, @Body(CheckRslCommandSchema) body: P<typeof CheckRslCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.checkRsl(elevated(state, e, r), p.hubId, p.sourceId, body);
  }

  @Post('sources/:sourceId/status') @HttpCode(200) @Idempotent('sources.status')
  status(@Params(SourceParams) p: P<typeof SourceParams>, @Body(SourceStatusCommandSchema) body: P<typeof SourceStatusCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setStatus(elevated(state, e, r), p.hubId, p.sourceId, body);
  }

  @Post('sources/:sourceId/takedown') @HttpCode(200) @Idempotent('sources.takedown')
  takedown(@Params(SourceParams) p: P<typeof SourceParams>, @Body(TakedownCommandSchema) body: P<typeof TakedownCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.takedownSource(elevated(state, e, r), p.hubId, p.sourceId, body);
  }

  @Post('sources/:sourceId/batches') @HttpCode(201) @Idempotent('sources.batch_stage')
  stage(@Params(SourceParams) p: P<typeof SourceParams>, @Body(StageBatchCommandSchema) body: P<typeof StageBatchCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.stageBatch(elevated(state, e, r), p.hubId, p.sourceId, body);
  }

  /* ---------- Import batches and the review queue ---------- */

  @Get('import-batches')
  batches(@Params(HubParams) p: P<typeof HubParams>, @Query(BatchesQuery) q: P<typeof BatchesQuery>, @ReqState() state: RequestState) {
    return this.service.listBatches(state, p.hubId, q.status);
  }

  @Get('import-batches/:batchId')
  batch(@Params(BatchParams) p: P<typeof BatchParams>, @ReqState() state: RequestState) {
    return this.service.getBatch(state, p.hubId, p.batchId);
  }

  @Post('import-batches/:batchId/decide') @HttpCode(200) @Idempotent('sources.batch_decide')
  decideBatch(@Params(BatchParams) p: P<typeof BatchParams>, @Body(DecideBatchCommandSchema) body: P<typeof DecideBatchCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.decideBatch(elevated(state, e, r), p.hubId, p.batchId, body);
  }

  @Get('source-items/queue')
  queue(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.queue(state, p.hubId);
  }

  @Get('source-items/:itemId')
  item(@Params(ItemParams) p: P<typeof ItemParams>, @ReqState() state: RequestState) {
    return this.service.getItem(state, p.hubId, p.itemId);
  }

  @Post('source-items/:itemId/decide') @HttpCode(200) @Idempotent('sources.item_decide')
  decideItem(@Params(ItemParams) p: P<typeof ItemParams>, @Body(DecideItemCommandSchema) body: P<typeof DecideItemCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.decideItem(elevated(state, e, r), p.hubId, p.itemId, body);
  }

  @Post('source-items/:itemId/assisted-summary') @HttpCode(200) @Idempotent('sources.item_assist')
  assist(@Params(ItemParams) p: P<typeof ItemParams>, @Body(AssistItemCommandSchema) body: P<typeof AssistItemCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.assistItem(elevated(state, e, r), p.hubId, p.itemId, body);
  }

  @Post('source-items/:itemId/takedown') @HttpCode(200) @Idempotent('sources.item_takedown')
  takedownItem(@Params(ItemParams) p: P<typeof ItemParams>, @Body(TakedownCommandSchema) body: P<typeof TakedownCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.takedownItem(elevated(state, e, r), p.hubId, p.itemId, body);
  }

  @Get('source-takedowns/:takedownId')
  getTakedown(@Params(TakedownParams) p: P<typeof TakedownParams>, @ReqState() state: RequestState) {
    return this.service.getTakedown(state, p.hubId, p.takedownId);
  }

  /* ---------- Record links ---------- */

  @Get('record-links')
  links(@Params(HubParams) p: P<typeof HubParams>, @Query(LinksQuery) q: P<typeof LinksQuery>, @ReqState() state: RequestState) {
    return this.service.listLinks(state, p.hubId, q.state);
  }

  @Post('record-links') @HttpCode(201) @Idempotent('sources.link_propose')
  proposeLink(@Params(HubParams) p: P<typeof HubParams>, @Body(ProposeLinkCommandSchema) body: P<typeof ProposeLinkCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.proposeLink(elevated(state, e, r), p.hubId, body);
  }

  @Post('record-links/:linkId/decide') @HttpCode(200) @Idempotent('sources.link_decide')
  decideLink(@Params(LinkParams) p: P<typeof LinkParams>, @Body(DecideLinkCommandSchema) body: P<typeof DecideLinkCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.decideLink(elevated(state, e, r), p.hubId, p.linkId, body);
  }

  /* ---------- Sponsored content policy ---------- */

  @Get('sponsored-policy')
  sponsoredPolicy(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.getSponsoredPolicy(state, p.hubId);
  }

  @Post('sponsored-policy') @HttpCode(200) @Idempotent('sources.sponsored_policy_set')
  setSponsoredPolicy(@Params(HubParams) p: P<typeof HubParams>, @Body(SetSponsoredPolicyCommandSchema) body: P<typeof SetSponsoredPolicyCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setSponsoredPolicy(elevated(state, e, r), p.hubId, body);
  }
}

/** Public projections: field provenance of a sourced record ("from sources") and the labelled sponsored slot; identical for every caller. */
@Controller('v1/hubs/:hubId')
export class PublicSourcesController {
  constructor(@Inject(SourcesService) private readonly service: SourcesService) {}

  @Get('sourced-records/:recordKind/:recordId/provenance')
  provenance(@Params(RecordParams) p: P<typeof RecordParams>) {
    return this.service.provenance(p.hubId, p.recordKind, p.recordId);
  }

  @Get('sponsored-slot')
  sponsoredSlot(@Params(HubParams) p: P<typeof HubParams>) {
    return this.service.sponsoredSlot(p.hubId);
  }
}
