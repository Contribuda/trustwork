import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import {
  AccountCardQuerySchema, CasePersonParams, CasesQuerySchema, ExplainQuerySchema, LookupQuerySchema, OpenCaseCommandSchema, OpenOwnCaseSchema, OwnCaseUpdateSchema, OwnNoteSchema,
  PlainCommandSchema, RequestActionCommandSchema, ShareDiagnosticsSchema, StaffNoteCommandSchema, UpdateCaseCommandSchema, UuidParams,
} from './schemas.js';
import { SupportService, type Elevated } from './support.service.js';

type Id = z.infer<typeof UuidParams>;
type Plain = z.infer<typeof PlainCommandSchema>;

/** The verified elevation plus the `Idempotency-Key` header the console command must restate. */
function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Staff routes of the support workspace (SUP-001). Every route needs a signed-in session, a staff role covering this
 * deployment and a live elevation of the acting session (BE-004 `ElevationGuard`); every mutation carries the CSRF
 * header, an `Idempotency-Key` (completed in the request transaction, BE-005) and a staff reason, and is authorized
 * again by the database at the case's hub. Lookup, the account card and the access explainer are recorded queries
 * (POST so the query never sits in a URL). There is no route that issues a session for, or acts as, another person.
 */
@Controller('v1/admin/support')
@Authenticated()
@UseGuards(ElevationGuard)
export class SupportStaffController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get('cases')
  cases(@Query(CasesQuerySchema) q: z.infer<typeof CasesQuerySchema>, @ReqState() state: RequestState) {
    return this.support.cases(state, q.status);
  }

  @Post('cases') @HttpCode(201) @Idempotent('support.case_open')
  openCase(@Body(OpenCaseCommandSchema) body: z.infer<typeof OpenCaseCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.openCase(elevated(state, elevation, request), body);
  }

  @Get('cases/:id')
  caseDetail(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.support.caseDetail(state, params.id);
  }

  @Post('cases/:id/update') @HttpCode(200) @Idempotent('support.case_update', 'id')
  updateCase(@Params(UuidParams) params: Id, @Body(UpdateCaseCommandSchema) body: z.infer<typeof UpdateCaseCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.updateCase(elevated(state, elevation, request), params.id, body);
  }

  @Post('cases/:id/notes') @HttpCode(201) @Idempotent('support.case_note', 'id')
  addNote(@Params(UuidParams) params: Id, @Body(StaffNoteCommandSchema) body: z.infer<typeof StaffNoteCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.addNote(elevated(state, elevation, request), params.id, body);
  }

  @Post('lookup') @HttpCode(200)
  lookup(@Body(LookupQuerySchema) body: z.infer<typeof LookupQuerySchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.lookup(elevated(state, elevation, request), body);
  }

  @Post('cases/:id/people/:personId/account') @HttpCode(200)
  accountCard(@Params(CasePersonParams) params: z.infer<typeof CasePersonParams>, @Body(AccountCardQuerySchema) body: z.infer<typeof AccountCardQuerySchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.accountCard(elevated(state, elevation, request), params.id, params.personId, body);
  }

  @Post('cases/:id/explain') @HttpCode(200)
  explain(@Params(UuidParams) params: Id, @Body(ExplainQuerySchema) body: z.infer<typeof ExplainQuerySchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.explain(elevated(state, elevation, request), params.id, body);
  }

  @Post('cases/:id/actions') @HttpCode(201) @Idempotent('support.action_request', 'id')
  requestAction(@Params(UuidParams) params: Id, @Body(RequestActionCommandSchema) body: z.infer<typeof RequestActionCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.requestAction(elevated(state, elevation, request), params.id, body);
  }

  @Get('actions/:id')
  action(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.support.action(state, params.id);
  }

  @Post('actions/:id/activate') @HttpCode(200) @Idempotent('support.action_activate', 'id')
  activate(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.activateAction(elevated(state, elevation, request), params.id, body);
  }

  @Post('actions/:id/execute') @HttpCode(200) @Idempotent('support.action_execute', 'id')
  execute(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.executeAction(elevated(state, elevation, request), params.id, body);
  }

  @Post('actions/:id/cancel') @HttpCode(200) @Idempotent('support.action_cancel', 'id')
  cancel(@Params(UuidParams) params: Id, @Body(PlainCommandSchema) body: Plain, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow, @Req() request: TrustworkRequest) {
    return this.support.cancelAction(elevated(state, elevation, request), params.id, body);
  }
}

/**
 * The person's own support path (no staff role, no elevation): their cases and replies inside the case (not a generic
 * inbox), diagnostics they choose to share, the servicing actions on their account with the right to stop a sign-in
 * factor change before it takes effect, and when support looked at their account.
 */
@Controller('v1/support')
@Authenticated()
export class SupportParticipantController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get('cases')
  cases(@ReqState() state: RequestState) {
    return this.support.ownCases(state);
  }

  @Post('cases') @HttpCode(201) @Idempotent('support.own_case_open')
  open(@Body(OpenOwnCaseSchema) body: z.infer<typeof OpenOwnCaseSchema>, @ReqState() state: RequestState) {
    return this.support.openOwnCase(state, body);
  }

  @Get('cases/:id')
  case(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.support.ownCase(state, params.id);
  }

  @Post('cases/:id/notes') @HttpCode(201) @Idempotent('support.own_case_note', 'id')
  note(@Params(UuidParams) params: Id, @Body(OwnNoteSchema) body: z.infer<typeof OwnNoteSchema>, @ReqState() state: RequestState) {
    return this.support.ownNote(state, params.id, body);
  }

  @Post('cases/:id/status') @HttpCode(200) @Idempotent('support.own_case_update', 'id')
  status(@Params(UuidParams) params: Id, @Body(OwnCaseUpdateSchema) body: z.infer<typeof OwnCaseUpdateSchema>, @ReqState() state: RequestState) {
    return this.support.ownCaseUpdate(state, params.id, body);
  }

  @Post('cases/:id/diagnostics') @HttpCode(201) @Idempotent('support.diagnostics_share', 'id')
  diagnostics(@Params(UuidParams) params: Id, @Body(ShareDiagnosticsSchema) body: z.infer<typeof ShareDiagnosticsSchema>, @ReqState() state: RequestState) {
    return this.support.shareDiagnostics(state, params.id, body);
  }

  @Get('actions')
  actions(@ReqState() state: RequestState) {
    return this.support.ownActions(state);
  }

  @Post('actions/:id/cancel') @HttpCode(200) @Authenticated('step_up') @Idempotent('support.own_action_cancel', 'id')
  cancel(@Params(UuidParams) params: Id, @ReqState() state: RequestState) {
    return this.support.cancelOwnAction(state, params.id);
  }

  @Get('access')
  access(@ReqState() state: RequestState) {
    return this.support.ownAccessRecords(state);
  }
}
