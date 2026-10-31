import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { PlatformAdminService, targetFrom } from './platform-admin.service.js';
import {
  AccessLogQuerySchema, ApplySanctionCommandSchema, ApprovalsQuerySchema, ApproveCommandSchema, AssignmentsQuerySchema, AssignRoleCommandSchema, AuditQuerySchema, BreakglassCommandSchema,
  CoverageQuerySchema, DecideAppealCommandSchema, DecideCaseGrantCommandSchema, DecideModerationCaseCommandSchema, DeclareConflictCommandSchema, FileAppealCommandSchema, FlagsQuerySchema,
  HubQuerySchema, OpenIncidentCommandSchema, OpenModerationCaseCommandSchema, PlainCommandSchema, ReportContentCommandSchema, RequestApprovalCommandSchema, RequestCaseGrantCommandSchema,
  SetFlagCommandSchema, TargetQuerySchema, UuidParams,
} from './schemas.js';

type Id = z.infer<typeof UuidParams>;
type Plain = z.infer<typeof PlainCommandSchema>;

/** The verified elevation plus the `Idempotency-Key` header the console command must restate. */
function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest) {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Staff routes of the platform administration module (ADM-001). Every route needs a signed-in session, a staff role
 * covering this deployment and a live elevation of the acting session (BE-004 `ElevationGuard`); every mutation
 * carries the CSRF header, an `Idempotency-Key` (completed in the request transaction, BE-005) and a staff reason, and
 * is authorized again by the database at its scope. There is no route that issues a session for, or acts as, another
 * person: case access grants are scoped, time-boxed and logged read rights, never a login.
 */
@Controller('v1/admin')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminStaffController {
  constructor(@Inject(PlatformAdminService) private readonly admin: PlatformAdminService) {}

  @Get('node')
  node(@ReqState() state: RequestState) {
    return this.admin.node(state);
  }

  @Get('access')
  access(@Query(TargetQuerySchema) q: z.infer<typeof TargetQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.access(state, targetFrom(q));
  }

  @Get('staff/sod')
  sod(@Query(TargetQuerySchema) q: z.infer<typeof TargetQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.sod(state, targetFrom(q));
  }

  @Get('staff/definitions')
  definitions(@ReqState() state: RequestState) {
    return this.admin.definitions(state);
  }

  @Get('staff/assignments')
  assignments(@Query(AssignmentsQuerySchema) q: z.infer<typeof AssignmentsQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.assignments(state, { personId: q.personId, activeOnly: q.activeOnly === 'true' });
  }

  @Post('staff/assignments') @HttpCode(201) @Idempotent('admin.staff.assign')
  assign(@Body(AssignRoleCommandSchema) body: z.infer<typeof AssignRoleCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.assign(elevated(state, elevation, request), body);
  }

  @Post('staff/assignments/:id/revoke') @HttpCode(200) @Idempotent('admin.staff.revoke', 'id')
  revoke(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.revoke(elevated(state, elevation, request), params.id, body);
  }

  @Post('staff/breakglass') @HttpCode(201) @Idempotent('admin.staff.breakglass')
  breakglass(@Body(BreakglassCommandSchema) body: z.infer<typeof BreakglassCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.breakglass(elevated(state, elevation, request), body);
  }

  @Get('staff/conflicts')
  conflicts(@ReqState() state: RequestState) {
    return this.admin.conflicts(state);
  }

  @Post('staff/conflicts') @HttpCode(201) @Idempotent('admin.staff.conflict_declare')
  declareConflict(@Body(DeclareConflictCommandSchema) body: z.infer<typeof DeclareConflictCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.declareConflict(elevated(state, elevation, request), body);
  }

  @Post('staff/conflicts/:id/end') @HttpCode(200) @Idempotent('admin.staff.conflict_end', 'id')
  endConflict(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.endConflict(elevated(state, elevation, request), params.id, body);
  }

  @Get('incidents')
  incidents(@ReqState() state: RequestState) {
    return this.admin.incidents(state);
  }

  @Post('incidents') @HttpCode(201) @Idempotent('admin.incident.open')
  openIncident(@Body(OpenIncidentCommandSchema) body: z.infer<typeof OpenIncidentCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.openIncident(elevated(state, elevation, request), body);
  }

  /* ---------- Second-person approvals ---------- */

  @Get('approvals')
  approvals(@Query(ApprovalsQuerySchema) q: z.infer<typeof ApprovalsQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.approvalsFor(state, q);
  }

  @Get('approvals/:id')
  approval(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.admin.approval(state, params.id);
  }

  @Post('approvals') @HttpCode(201) @Idempotent('admin.approval.request')
  requestApproval(@Body(RequestApprovalCommandSchema) body: z.infer<typeof RequestApprovalCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.requestApproval(elevated(state, elevation, request), body);
  }

  @Post('approvals/:id/approve') @HttpCode(200) @Idempotent('admin.approval.approve', 'id')
  approve(@Params(UuidParams) params: Id, @Body(ApproveCommandSchema) body: z.infer<typeof ApproveCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.approve(elevated(state, elevation, request), params.id, body);
  }

  @Post('approvals/:id/decline') @HttpCode(200) @Idempotent('admin.approval.decline', 'id')
  decline(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.decline(elevated(state, elevation, request), params.id, body);
  }

  @Post('approvals/:id/withdraw') @HttpCode(200) @Idempotent('admin.approval.withdraw', 'id')
  withdraw(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.withdraw(elevated(state, elevation, request), params.id, body);
  }

  /* ---------- Case access grants ---------- */

  @Post('case-grants') @HttpCode(201) @Idempotent('admin.case_grant.request')
  requestCaseGrant(@Body(RequestCaseGrantCommandSchema) body: z.infer<typeof RequestCaseGrantCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.requestCaseGrant(elevated(state, elevation, request), body);
  }

  @Get('case-grants/coverage')
  coverage(@Query(CoverageQuerySchema) q: z.infer<typeof CoverageQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.coverage(state, q.objectType, q.objectId);
  }

  @Get('case-grants/:id')
  caseGrant(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.admin.caseGrant(state, params.id);
  }

  @Get('support-cases/:id/case-grants')
  caseGrantsOf(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.admin.caseGrantsOf(state, params.id);
  }

  @Post('case-grants/:id/decide') @HttpCode(200) @Idempotent('admin.case_grant.decide', 'id')
  decideCaseGrant(@Params(UuidParams) params: Id, @Body(DecideCaseGrantCommandSchema) body: z.infer<typeof DecideCaseGrantCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.decideCaseGrant(elevated(state, elevation, request), params.id, body);
  }

  @Post('case-grants/:id/revoke') @HttpCode(200) @Idempotent('admin.case_grant.revoke', 'id')
  revokeCaseGrant(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.revokeCaseGrant(elevated(state, elevation, request), params.id, body);
  }

  @Get('access-log')
  accessLog(@Query(AccessLogQuerySchema) q: z.infer<typeof AccessLogQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.accessLog(state, q);
  }

  /* ---------- Audit ---------- */

  @Get('audit')
  audit(@Query(AuditQuerySchema) q: z.infer<typeof AuditQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.audit(state, q);
  }

  @Get('audit/continuity')
  continuity(@ReqState() state: RequestState) {
    return this.admin.continuity(state);
  }

  /* ---------- Moderation ---------- */

  @Get('moderation/reports')
  reports(@Query(HubQuerySchema) q: z.infer<typeof HubQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.reports(state, q.hubId);
  }

  @Get('moderation/cases')
  cases(@Query(HubQuerySchema) q: z.infer<typeof HubQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.cases(state, q.hubId);
  }

  @Get('moderation/cases/:id')
  moderationCase(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.admin.moderationCase(state, params.id);
  }

  @Post('moderation/cases') @HttpCode(201) @Idempotent('admin.moderation.case_open')
  openCase(@Body(OpenModerationCaseCommandSchema) body: z.infer<typeof OpenModerationCaseCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.openCase(elevated(state, elevation, request), body);
  }

  @Post('moderation/cases/:id/decide') @HttpCode(200) @Idempotent('admin.moderation.decide', 'id')
  decideCase(@Params(UuidParams) params: Id, @Body(DecideModerationCaseCommandSchema) body: z.infer<typeof DecideModerationCaseCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.decideCase(elevated(state, elevation, request), params.id, body);
  }

  @Post('moderation/cases/:id/sanctions') @HttpCode(201) @Idempotent('admin.moderation.sanction_apply', 'id')
  applySanction(@Params(UuidParams) params: Id, @Body(ApplySanctionCommandSchema) body: z.infer<typeof ApplySanctionCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.applySanction(elevated(state, elevation, request), params.id, body);
  }

  @Post('moderation/sanctions/:id/lift') @HttpCode(200) @Idempotent('admin.moderation.sanction_lift', 'id')
  liftSanction(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.liftSanction(elevated(state, elevation, request), params.id, body);
  }

  @Get('moderation/appeals')
  appeals(@Query(HubQuerySchema) q: z.infer<typeof HubQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.appealsOf(state, q.hubId);
  }

  @Post('moderation/appeals/:id/decide') @HttpCode(200) @Idempotent('admin.moderation.appeal_decide', 'id')
  decideAppeal(@Params(UuidParams) params: Id, @Body(DecideAppealCommandSchema) body: z.infer<typeof DecideAppealCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.decideAppeal(elevated(state, elevation, request), params.id, body);
  }

  /* ---------- Feature flags ---------- */

  @Get('flags')
  flags(@Query(FlagsQuerySchema) q: z.infer<typeof FlagsQuerySchema>, @ReqState() state: RequestState) {
    return this.admin.flags(state, q);
  }

  @Post('flags') @HttpCode(200) @Idempotent('admin.flag.set')
  setFlag(@Body(SetFlagCommandSchema) body: z.infer<typeof SetFlagCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.admin.setFlag(elevated(state, elevation, request), body);
  }
}

/**
 * Participant side of moderation (no staff role, no elevation): report content against a published clause, see the
 * cases, sanctions and appeals about oneself (or one's employer), appeal a sanction or a moderation decision.
 */
@Controller('v1/moderation')
@Authenticated()
export class ModerationParticipantController {
  constructor(@Inject(PlatformAdminService) private readonly admin: PlatformAdminService) {}

  @Post('reports') @HttpCode(201) @Idempotent('moderation.report')
  report(@Body(ReportContentCommandSchema) body: z.infer<typeof ReportContentCommandSchema>, @ReqState() state: RequestState) {
    return this.admin.report(state, body);
  }

  @Get('me')
  mine(@ReqState() state: RequestState) {
    return this.admin.ownModeration(state);
  }

  @Post('appeals') @HttpCode(201) @Idempotent('moderation.appeal_file')
  appeal(@Body(FileAppealCommandSchema) body: z.infer<typeof FileAppealCommandSchema>, @ReqState() state: RequestState) {
    return this.admin.fileAppeal(state, body);
  }
}
