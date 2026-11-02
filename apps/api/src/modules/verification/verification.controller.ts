import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import {
  ActivateRecipeCommandSchema, DecideAppealCommandSchema, DraftRecipeCommandSchema, FileAppealCommandSchema, GoLiveCommandSchema, RecordCheckCommandSchema, RecordScreeningCommandSchema, RegisterProviderCommandSchema, StandingQuerySchema,
} from './commands.js';
import { VerificationService, type Elevated } from './verification.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const ProviderParams = z.strictObject({ hubId: Uuid, providerId: Uuid });
const RecipeParams = z.strictObject({ hubId: Uuid, recipeId: Uuid });
const SubjectParams = z.strictObject({ hubId: Uuid, subjectKind: z.enum(['company', 'person']), subjectId: Uuid });
const DigestQuery = z.strictObject({ credentialRefId: Uuid });
const AppealParams = z.strictObject({ hubId: Uuid, appealId: Uuid });
const CheckParams = z.strictObject({ checkId: Uuid });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Counterparty verification routes of the hub console (HUB-003). Every route needs a signed-in session, a staff role
 * and a live elevation (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated
 * in the console command body (completed in the request transaction, BE-005) and a staff reason, and is authorized
 * again by the database at the hub.
 */
@Controller('v1/admin/hubs/:hubId/verification')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminVerificationController {
  constructor(@Inject(VerificationService) private readonly service: VerificationService) {}

  @Get()
  overview(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.overview(state, p.hubId);
  }

  @Get('standing')
  standing(@Params(HubParams) p: P<typeof HubParams>, @Query(StandingQuerySchema) q: P<typeof StandingQuerySchema>, @ReqState() state: RequestState) {
    return this.service.standing(state, p.hubId, { kind: q.subjectKind, id: q.subjectId }, q.recipeId);
  }

  @Get('subjects/:subjectKind/:subjectId/checks')
  checks(@Params(SubjectParams) p: P<typeof SubjectParams>, @ReqState() state: RequestState) {
    return this.service.checksOf(state, p.hubId, { kind: p.subjectKind, id: p.subjectId });
  }

  @Get('providers/:providerId/live-digest')
  liveDigest(@Params(ProviderParams) p: P<typeof ProviderParams>, @Query(DigestQuery) q: P<typeof DigestQuery>, @ReqState() state: RequestState) {
    return this.service.liveDigest(state, p.hubId, p.providerId, q.credentialRefId);
  }

  @Post('providers') @HttpCode(201) @Idempotent('verification.provider_register')
  registerProvider(@Params(HubParams) p: P<typeof HubParams>, @Body(RegisterProviderCommandSchema) body: P<typeof RegisterProviderCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.registerProvider(elevated(state, e, r), p.hubId, body);
  }

  @Post('providers/:providerId/live') @HttpCode(200) @Idempotent('verification.provider_live', 'providerId')
  goLive(@Params(ProviderParams) p: P<typeof ProviderParams>, @Body(GoLiveCommandSchema) body: P<typeof GoLiveCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.goLive(elevated(state, e, r), p.hubId, p.providerId, body);
  }

  @Post('recipes') @HttpCode(201) @Idempotent('verification.recipe_draft')
  draftRecipe(@Params(HubParams) p: P<typeof HubParams>, @Body(DraftRecipeCommandSchema) body: P<typeof DraftRecipeCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.draftRecipe(elevated(state, e, r), p.hubId, body);
  }

  @Post('recipes/:recipeId/activate') @HttpCode(200) @Idempotent('verification.recipe_activate', 'recipeId')
  activateRecipe(@Params(RecipeParams) p: P<typeof RecipeParams>, @Body(ActivateRecipeCommandSchema) body: P<typeof ActivateRecipeCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.activateRecipe(elevated(state, e, r), p.hubId, p.recipeId, body);
  }

  @Post('checks') @HttpCode(201) @Idempotent('verification.check_record')
  recordCheck(@Params(HubParams) p: P<typeof HubParams>, @Body(RecordCheckCommandSchema) body: P<typeof RecordCheckCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.recordCheck(elevated(state, e, r), p.hubId, body);
  }

  @Post('checks/screening') @HttpCode(201) @Idempotent('verification.screening_record')
  recordScreening(@Params(HubParams) p: P<typeof HubParams>, @Body(RecordScreeningCommandSchema) body: P<typeof RecordScreeningCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.recordScreening(elevated(state, e, r), p.hubId, body);
  }

  @Get('appeals')
  appeals(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.service.appeals(state, p.hubId);
  }

  @Post('appeals/:appealId/decide') @HttpCode(200) @Idempotent('verification.appeal_decide', 'appealId')
  decideAppeal(@Params(AppealParams) p: P<typeof AppealParams>, @Body(DecideAppealCommandSchema) body: P<typeof DecideAppealCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.decideAppeal(elevated(state, e, r), p.hubId, p.appealId, body);
  }
}

/**
 * The subject's own path (HUB-003): a person, or an active administrator of the company, appeals an adverse result
 * about them and reads their own appeals. A signed-in session is enough; anyone else finds nothing.
 */
@Controller('v1/verification')
export class OwnVerificationController {
  constructor(@Inject(VerificationService) private readonly service: VerificationService) {}

  @Post('checks/:checkId/appeals') @HttpCode(201) @Authenticated() @Idempotent('verification.appeal_file', 'checkId')
  fileAppeal(@Params(CheckParams) p: P<typeof CheckParams>, @Body(FileAppealCommandSchema) body: P<typeof FileAppealCommandSchema>, @ReqState() state: RequestState) {
    return this.service.fileAppeal(state, p.checkId, body);
  }

  @Get('appeals') @Authenticated()
  ownAppeals(@ReqState() state: RequestState) {
    return this.service.ownAppeals(state);
  }
}
