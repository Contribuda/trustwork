import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import {
  ArchiveOfferingCommandSchema, CreateOfferingCommandSchema, OpenOfferingDraftCommandSchema, PublicCatalogueQuerySchema, PublishOfferingVersionCommandSchema, SaveOfferingDraftCommandSchema,
  SetOfferingPrivateKnowledgeCommandSchema,
} from '../procurement/deps.js';
import { CatalogueService } from './catalogue.service.js';

const OfferingParams = z.strictObject({ id: IdSchema });
const VersionParams = z.strictObject({ id: IdSchema, versionId: IdSchema });
const VersionQuery = z.strictObject({ version: z.string().regex(/^[1-9][0-9]{0,8}$/).optional() });
type P<T extends z.ZodType> = z.infer<T>;

/**
 * The catalogue (COM-001) under `/v1/catalogue`. Mutations need a session, the CSRF header and an `Idempotency-Key`;
 * the public listing and the public projection of an offering need neither.
 */
@Controller('v1/catalogue')
export class CatalogueController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get()
  list(@Query(PublicCatalogueQuerySchema) query: P<typeof PublicCatalogueQuerySchema>, @ReqState() state: RequestState) {
    return this.catalogue.publicCatalogue({ kind: query.ownerKind, id: query.ownerId }, state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('offering.create')
  create(@Body(CreateOfferingCommandSchema) body: P<typeof CreateOfferingCommandSchema>, @ReqState() state: RequestState) {
    return this.catalogue.create(body, state);
  }

  @Get(':id')
  get(@Params(OfferingParams) params: P<typeof OfferingParams>, @Query(VersionQuery) query: P<typeof VersionQuery>, @ReqState() state: RequestState) {
    return this.catalogue.get(params.id, query.version ? Number(query.version) : null, state);
  }

  @Post(':id/versions') @HttpCode(201) @Authenticated() @Idempotent('offering.draft_open', 'id')
  openDraft(@Params(OfferingParams) params: P<typeof OfferingParams>, @Body(OpenOfferingDraftCommandSchema) body: P<typeof OpenOfferingDraftCommandSchema>, @ReqState() state: RequestState) {
    return this.catalogue.openDraft(params.id, body, state);
  }

  @Post(':id/versions/:versionId') @HttpCode(200) @Authenticated() @Idempotent('offering.draft_save', 'versionId')
  saveDraft(@Params(VersionParams) params: P<typeof VersionParams>, @Body(SaveOfferingDraftCommandSchema) body: P<typeof SaveOfferingDraftCommandSchema>, @ReqState() state: RequestState) {
    return this.catalogue.saveDraft(params.id, params.versionId, body, state);
  }

  @Post(':id/versions/:versionId/private') @HttpCode(200) @Authenticated() @Idempotent('offering.private_save', 'versionId')
  setPrivate(@Params(VersionParams) params: P<typeof VersionParams>, @Body(SetOfferingPrivateKnowledgeCommandSchema) body: P<typeof SetOfferingPrivateKnowledgeCommandSchema>, @ReqState() state: RequestState) {
    return this.catalogue.setPrivateKnowledge(params.id, params.versionId, body, state);
  }

  @Post(':id/versions/:versionId/publish') @HttpCode(200) @Authenticated() @Idempotent('offering.version_publish', 'versionId')
  publish(@Params(VersionParams) params: P<typeof VersionParams>, @Body(PublishOfferingVersionCommandSchema) body: P<typeof PublishOfferingVersionCommandSchema>, @ReqState() state: RequestState) {
    return this.catalogue.publish(params.id, params.versionId, body, state);
  }

  @Post(':id/archive') @HttpCode(200) @Authenticated() @Idempotent('offering.archive', 'id')
  archive(@Params(OfferingParams) params: P<typeof OfferingParams>, @Body(ArchiveOfferingCommandSchema) body: P<typeof ArchiveOfferingCommandSchema>, @ReqState() state: RequestState) {
    return this.catalogue.archive(params.id, body, state);
  }
}
