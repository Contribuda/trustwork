import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { Body, Params, Query } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import {
  AddRecordCommandSchema, CorrectCountryCommandSchema, RECORD_KINDS, RetireRecordCommandSchema, SetProfileCommandSchema, SourceRecordCommandSchema, VerifyIdentifierCommandSchema,
  BindEvidenceCommandSchema, ClaimListQuerySchema, ClaimSettingsCommandSchema, ConfirmDisputeCommandSchema, DecideClaimCommandSchema, HandoverListQuerySchema, ProposeDisputeCommandSchema, RecheckVerificationCommandSchema, RecipeListQuerySchema,
  RevokeHandoverCommandSchema, SubmitClaimCommandSchema, VerificationListQuerySchema, WithdrawClaimCommandSchema,
} from './commands.js';
import { ClaimsService, type Elevated } from './claims.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const ClaimParams = z.strictObject({ hubId: Uuid, claimId: Uuid });
const DisputeParams = z.strictObject({ hubId: Uuid, disputeId: Uuid });
const HandoverParams = z.strictObject({ hubId: Uuid, handoverId: Uuid });
const OwnClaimParams = z.strictObject({ claimId: Uuid });
const VerificationParams = z.strictObject({ hubId: Uuid, verificationId: Uuid });
const CompanyParams = z.strictObject({ companyId: Uuid });
const HubCompanyParams = z.strictObject({ hubId: Uuid, companyId: Uuid });
const IdentifierParams = z.strictObject({ hubId: Uuid, identifierId: Uuid });
const RecordParams = z.strictObject({ companyId: Uuid, recordKind: z.enum(RECORD_KINDS), recordId: Uuid });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Claim routes of the hub console (CLM-001). Every route needs a signed-in session, a staff role and a live elevation
 * (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated in the console
 * command body (completed in the request transaction, BE-005) and a staff reason, and is authorized again by the
 * database at the hub.
 */
@Controller('v1/admin/hubs/:hubId/claims')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminClaimsController {
  constructor(@Inject(ClaimsService) private readonly service: ClaimsService) {}

  @Get()
  overview(@Params(HubParams) p: P<typeof HubParams>, @Query(ClaimListQuerySchema) q: P<typeof ClaimListQuerySchema>, @ReqState() state: RequestState) {
    return this.service.overview(state, p.hubId, q.state ?? null);
  }

  @Get('requests/:claimId')
  claim(@Params(ClaimParams) p: P<typeof ClaimParams>, @ReqState() state: RequestState) {
    return this.service.claim(state, p.hubId, p.claimId);
  }

  @Get('handovers')
  handovers(@Params(HubParams) p: P<typeof HubParams>, @Query(HandoverListQuerySchema) q: P<typeof HandoverListQuerySchema>, @ReqState() state: RequestState) {
    return this.service.handovers(state, p.hubId, q.companyId ?? null);
  }

  @Get('verifications')
  verifications(@Params(HubParams) p: P<typeof HubParams>, @Query(VerificationListQuerySchema) q: P<typeof VerificationListQuerySchema>, @ReqState() state: RequestState) {
    return this.service.verifications(state, p.hubId, { ...(q.companyId ? { companyId: q.companyId } : {}), ...(q.dueDays !== undefined ? { dueDays: q.dueDays } : {}) });
  }

  @Post('verifications/:verificationId/recheck') @HttpCode(201) @Idempotent('claims.verification_recheck', 'verificationId')
  recheck(@Params(VerificationParams) p: P<typeof VerificationParams>, @Body(RecheckVerificationCommandSchema) body: P<typeof RecheckVerificationCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.recheck(elevated(state, e, r), p.hubId, p.verificationId, body);
  }

  @Get('companies/:companyId/records')
  records(@Params(HubCompanyParams) p: P<typeof HubCompanyParams>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow) {
    return this.service.staffRecords({ state, elevationId: e.id, idempotencyKey: undefined }, p.hubId, p.companyId);
  }

  @Post('companies/:companyId/records') @HttpCode(201) @Idempotent('claims.record_source', 'companyId')
  sourceRecord(@Params(HubCompanyParams) p: P<typeof HubCompanyParams>, @Body(SourceRecordCommandSchema) body: P<typeof SourceRecordCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.sourceRecord(elevated(state, e, r), p.hubId, p.companyId, body);
  }

  @Post('companies/:companyId/country') @HttpCode(200) @Idempotent('claims.company_country_correct', 'companyId')
  correctCountry(@Params(HubCompanyParams) p: P<typeof HubCompanyParams>, @Body(CorrectCountryCommandSchema) body: P<typeof CorrectCountryCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.correctCountry(elevated(state, e, r), p.hubId, p.companyId, body);
  }

  @Post('identifiers/:identifierId/verify') @HttpCode(200) @Idempotent('claims.identifier_verify', 'identifierId')
  verifyIdentifier(@Params(IdentifierParams) p: P<typeof IdentifierParams>, @Body(VerifyIdentifierCommandSchema) body: P<typeof VerifyIdentifierCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.verifyIdentifier(elevated(state, e, r), p.hubId, p.identifierId, body);
  }

  @Post('requests/:claimId/decide') @HttpCode(200) @Idempotent('claims.decide', 'claimId')
  decide(@Params(ClaimParams) p: P<typeof ClaimParams>, @Body(DecideClaimCommandSchema) body: P<typeof DecideClaimCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.decide(elevated(state, e, r), p.hubId, p.claimId, body);
  }

  @Post('requests/:claimId/evidence') @HttpCode(200) @Idempotent('claims.evidence_bind', 'claimId')
  bindEvidence(@Params(ClaimParams) p: P<typeof ClaimParams>, @Body(BindEvidenceCommandSchema) body: P<typeof BindEvidenceCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.bindEvidence(elevated(state, e, r), p.hubId, p.claimId, body);
  }

  @Post('disputes/:disputeId/propose') @HttpCode(200) @Idempotent('claims.dispute_propose', 'disputeId')
  proposeDispute(@Params(DisputeParams) p: P<typeof DisputeParams>, @Body(ProposeDisputeCommandSchema) body: P<typeof ProposeDisputeCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.proposeDispute(elevated(state, e, r), p.hubId, p.disputeId, body);
  }

  @Post('disputes/:disputeId/confirm') @HttpCode(200) @Idempotent('claims.dispute_confirm', 'disputeId')
  confirmDispute(@Params(DisputeParams) p: P<typeof DisputeParams>, @Body(ConfirmDisputeCommandSchema) body: P<typeof ConfirmDisputeCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.confirmDispute(elevated(state, e, r), p.hubId, p.disputeId, body);
  }

  @Post('handovers/:handoverId/revoke') @HttpCode(200) @Idempotent('claims.handover_revoke', 'handoverId')
  revoke(@Params(HandoverParams) p: P<typeof HandoverParams>, @Body(RevokeHandoverCommandSchema) body: P<typeof RevokeHandoverCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.revoke(elevated(state, e, r), p.hubId, p.handoverId, body);
  }

  @Post('settings') @HttpCode(200) @Idempotent('claims.settings_set')
  setSettings(@Params(HubParams) p: P<typeof HubParams>, @Body(ClaimSettingsCommandSchema) body: P<typeof ClaimSettingsCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.service.setSettings(elevated(state, e, r), p.hubId, body);
  }
}

/**
 * The claimant's own path (CLM-001): a signed-in session reads what a hub offers, submits and withdraws a claim and
 * reads its own claims and hand-overs. A claim of someone else is not found.
 */
@Controller('v1/claims')
export class OwnClaimsController {
  constructor(@Inject(ClaimsService) private readonly service: ClaimsService) {}

  @Get('recipes') @Authenticated()
  recipes(@Query(RecipeListQuerySchema) q: P<typeof RecipeListQuerySchema>, @ReqState() state: RequestState) {
    return this.service.recipes(state, q.hubId);
  }

  @Get() @Authenticated()
  own(@ReqState() state: RequestState) {
    return this.service.own(state);
  }

  @Post() @HttpCode(201) @Authenticated() @Idempotent('claims.submit')
  submit(@Body(SubmitClaimCommandSchema) body: P<typeof SubmitClaimCommandSchema>, @ReqState() state: RequestState) {
    return this.service.submit(state, body);
  }

  @Post(':claimId/withdraw') @HttpCode(200) @Authenticated() @Idempotent('claims.withdraw', 'claimId')
  withdraw(@Params(OwnClaimParams) p: P<typeof OwnClaimParams>, @Body(WithdrawClaimCommandSchema) _body: P<typeof WithdrawClaimCommandSchema>, @ReqState() state: RequestState) {
    return this.service.withdraw(state, p.claimId);
  }
}

/**
 * The company's page (CLM-001). Badges and public records need no session; the company's own people read the rest; a
 * company administrator states records; a holder of a hand-over edits descriptive fields.
 */
@Controller('v1/companies')
export class CompanyBadgesController {
  constructor(@Inject(ClaimsService) private readonly service: ClaimsService) {}

  @Get(':companyId/badges')
  badges(@Params(CompanyParams) p: P<typeof CompanyParams>) {
    return this.service.badges(p.companyId);
  }

  @Get(':companyId/public-records')
  publicRecords(@Params(CompanyParams) p: P<typeof CompanyParams>) {
    return this.service.publicRecords(p.companyId);
  }

  @Get(':companyId/records') @Authenticated()
  records(@Params(CompanyParams) p: P<typeof CompanyParams>, @ReqState() state: RequestState) {
    return this.service.companyRecords(state, p.companyId);
  }

  @Post(':companyId/records') @HttpCode(201) @Authenticated() @Idempotent('claims.record_add', 'companyId')
  addRecord(@Params(CompanyParams) p: P<typeof CompanyParams>, @Body(AddRecordCommandSchema) body: P<typeof AddRecordCommandSchema>, @ReqState() state: RequestState) {
    return this.service.addRecord(state, p.companyId, body);
  }

  @Post(':companyId/records/:recordKind/:recordId/retire') @HttpCode(200) @Authenticated() @Idempotent('claims.record_retire', 'recordId')
  retireRecord(@Params(RecordParams) p: P<typeof RecordParams>, @Body(RetireRecordCommandSchema) _body: P<typeof RetireRecordCommandSchema>, @ReqState() state: RequestState) {
    return this.service.retireRecord(state, p.companyId, p.recordKind, p.recordId);
  }

  @Post(':companyId/page-profile') @HttpCode(200) @Authenticated() @Idempotent('claims.profile_set', 'companyId')
  setProfile(@Params(CompanyParams) p: P<typeof CompanyParams>, @Body(SetProfileCommandSchema) body: P<typeof SetProfileCommandSchema>, @ReqState() state: RequestState) {
    return this.service.setProfile(state, p.companyId, body);
  }
}
