import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  HubConfigDomainSchema,
} from '../../deps/contracts.js';
import {
  AcceptLegalDocumentCommandSchema, ActivateConfigVersionCommandSchema, ActivateCredentialCommandSchema, ActivateLegalDocumentCommandSchema, AddTerritoryCommandSchema, CheckLaunchGateCommandSchema, CreateHubCommandSchema, DraftConfigVersionCommandSchema, DraftLegalDocumentCommandSchema, ImportDeploymentCommandSchema, InvalidateLaunchGateCommandSchema, PlainHubCommandSchema, RecordCounselApprovalCommandSchema, RegisterCredentialCommandSchema, TransitionHubCommandSchema, UpdateHubProfileCommandSchema,
} from './deps.js';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../common/request.js';
import { Body, Params, Query } from '../../common/zod.js';
import { Elevation, ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../identity/second-factor/deps.js';
import { HubsService, type Elevated } from './hubs.service.js';

const Uuid = z.uuid();
const HubParams = z.strictObject({ hubId: Uuid });
const VersionParams = z.strictObject({ hubId: Uuid, versionId: Uuid });
const TerritoryParams = z.strictObject({ hubId: Uuid, territoryId: Uuid });
const DocumentParams = z.strictObject({ hubId: Uuid, documentId: Uuid });
const CredentialParams = z.strictObject({ hubId: Uuid, credentialId: Uuid });
const VersionsQuery = z.strictObject({ domain: HubConfigDomainSchema.optional() });
type P<S extends z.ZodType> = z.infer<S>;

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest): Elevated {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * Hub console routes (HUB-001). Every route needs a signed-in session, a staff role and a live elevation of the acting
 * session (BE-004 `ElevationGuard`); every mutation carries the CSRF header, an `Idempotency-Key` restated in the
 * console command body (completed in the request transaction, BE-005) and a staff reason, and is authorized again by
 * the database at the hub (or the node, for creating a hub). Two-person actions called without an approval answer
 * `pending_second_person` with the approval request a second person decides through `/v1/admin/approvals`.
 */
@Controller('v1/admin/hubs')
@Authenticated()
@UseGuards(ElevationGuard)
export class AdminHubsController {
  constructor(@Inject(HubsService) private readonly hubs: HubsService) {}

  @Get()
  list(@ReqState() state: RequestState) {
    return this.hubs.list(state);
  }

  @Post() @HttpCode(201) @Idempotent('hub.create')
  create(@Body(CreateHubCommandSchema) body: P<typeof CreateHubCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.create(elevated(state, e, r), body);
  }

  @Get(':hubId')
  get(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.hubs.get(state, p.hubId);
  }

  @Post(':hubId/profile') @HttpCode(200) @Idempotent('hub.profile_update')
  profile(@Params(HubParams) p: P<typeof HubParams>, @Body(UpdateHubProfileCommandSchema) body: P<typeof UpdateHubProfileCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.updateProfile(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/territories') @HttpCode(201) @Idempotent('hub.territory_add')
  addTerritory(@Params(HubParams) p: P<typeof HubParams>, @Body(AddTerritoryCommandSchema) body: P<typeof AddTerritoryCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.addTerritory(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/territories/:territoryId/remove') @HttpCode(200) @Idempotent('hub.territory_remove')
  removeTerritory(@Params(TerritoryParams) p: P<typeof TerritoryParams>, @Body(PlainHubCommandSchema) body: P<typeof PlainHubCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.removeTerritory(elevated(state, e, r), p.hubId, p.territoryId, body);
  }

  /* ---------- Configuration ---------- */

  @Get(':hubId/config')
  versions(@Params(HubParams) p: P<typeof HubParams>, @Query(VersionsQuery) q: P<typeof VersionsQuery>, @ReqState() state: RequestState) {
    return this.hubs.versions(state, p.hubId, q.domain);
  }

  @Get(':hubId/config/current')
  current(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.hubs.current(state, p.hubId);
  }

  @Post(':hubId/config') @HttpCode(201) @Idempotent('hub.config_draft')
  draft(@Params(HubParams) p: P<typeof HubParams>, @Body(DraftConfigVersionCommandSchema) body: P<typeof DraftConfigVersionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.draft(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/config/import-deployment') @HttpCode(201) @Idempotent('hub.config_import_deployment')
  importDeployment(@Params(HubParams) p: P<typeof HubParams>, @Body(ImportDeploymentCommandSchema) body: P<typeof ImportDeploymentCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.importDeployment(elevated(state, e, r), p.hubId, body);
  }

  @Get(':hubId/config/:versionId')
  version(@Params(VersionParams) p: P<typeof VersionParams>, @ReqState() state: RequestState) {
    return this.hubs.version(state, p.hubId, p.versionId);
  }

  @Post(':hubId/config/:versionId/activate') @HttpCode(200) @Idempotent('hub.config_activate')
  activate(@Params(VersionParams) p: P<typeof VersionParams>, @Body(ActivateConfigVersionCommandSchema) body: P<typeof ActivateConfigVersionCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.activate(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  @Post(':hubId/config/:versionId/cancel') @HttpCode(200) @Idempotent('hub.config_cancel')
  cancel(@Params(VersionParams) p: P<typeof VersionParams>, @Body(PlainHubCommandSchema) body: P<typeof PlainHubCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.cancel(elevated(state, e, r), p.hubId, p.versionId, body);
  }

  /* ---------- Launch gates and the lifecycle ---------- */

  @Get(':hubId/launch')
  checklist(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.hubs.checklist(state, p.hubId);
  }

  @Post(':hubId/launch/check') @HttpCode(200) @Idempotent('hub.gate_check')
  checkGate(@Params(HubParams) p: P<typeof HubParams>, @Body(CheckLaunchGateCommandSchema) body: P<typeof CheckLaunchGateCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.checkGate(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/launch/invalidate') @HttpCode(200) @Idempotent('hub.gate_invalidate')
  invalidateGate(@Params(HubParams) p: P<typeof HubParams>, @Body(InvalidateLaunchGateCommandSchema) body: P<typeof InvalidateLaunchGateCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.invalidateGate(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/lifecycle') @HttpCode(200) @Idempotent('hub.transition')
  transition(@Params(HubParams) p: P<typeof HubParams>, @Body(TransitionHubCommandSchema) body: P<typeof TransitionHubCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.transition(elevated(state, e, r), p.hubId, body);
  }

  /* ---------- Legal documents ---------- */

  @Get(':hubId/legal')
  legal(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.hubs.legal(state, p.hubId);
  }

  @Post(':hubId/legal') @HttpCode(201) @Idempotent('hub.legal_draft')
  draftLegal(@Params(HubParams) p: P<typeof HubParams>, @Body(DraftLegalDocumentCommandSchema) body: P<typeof DraftLegalDocumentCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.draftLegal(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/legal/counsel-approvals') @HttpCode(201) @Idempotent('hub.legal_counsel_record')
  counsel(@Params(HubParams) p: P<typeof HubParams>, @Body(RecordCounselApprovalCommandSchema) body: P<typeof RecordCounselApprovalCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.recordCounselApproval(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/legal/:documentId/activate') @HttpCode(200) @Idempotent('hub.legal_activate')
  activateLegal(@Params(DocumentParams) p: P<typeof DocumentParams>, @Body(ActivateLegalDocumentCommandSchema) body: P<typeof ActivateLegalDocumentCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.activateLegal(elevated(state, e, r), p.hubId, p.documentId, body);
  }

  /* ---------- Provider credential references ---------- */

  @Get(':hubId/credentials')
  credentials(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.hubs.credentials(state, p.hubId);
  }

  @Post(':hubId/credentials') @HttpCode(201) @Idempotent('hub.credential_register')
  registerCredential(@Params(HubParams) p: P<typeof HubParams>, @Body(RegisterCredentialCommandSchema) body: P<typeof RegisterCredentialCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.registerCredential(elevated(state, e, r), p.hubId, body);
  }

  @Post(':hubId/credentials/:credentialId/activate') @HttpCode(200) @Idempotent('hub.credential_activate')
  activateCredential(@Params(CredentialParams) p: P<typeof CredentialParams>, @Body(ActivateCredentialCommandSchema) body: P<typeof ActivateCredentialCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.activateCredential(elevated(state, e, r), p.hubId, p.credentialId, body);
  }

  @Post(':hubId/credentials/:credentialId/retire') @HttpCode(200) @Idempotent('hub.credential_retire')
  retireCredential(@Params(CredentialParams) p: P<typeof CredentialParams>, @Body(PlainHubCommandSchema) body: P<typeof PlainHubCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.hubs.retireCredential(elevated(state, e, r), p.hubId, p.credentialId, body);
  }
}

/**
 * The active legal texts of the hub this API serves, for everyone (QA-002 D4): the web's terms and privacy pages and the
 * terms version sign-up records. No session; a legal page is an open door of the jurisdiction gate (ADR 014 decision 6).
 */
@Controller('v1/legal')
export class PublicLegalController {
  constructor(@Inject(HubsService) private readonly hubs: HubsService) {}

  @Get()
  legal() {
    return this.hubs.servedLegal();
  }
}

/** Participant routes: the active legal texts of a launched hub, and accepting one (proof of the exact text). */
@Controller('v1/hubs')
export class HubsParticipantController {
  constructor(@Inject(HubsService) private readonly hubs: HubsService) {}

  @Get(':hubId/legal')
  @Authenticated()
  legal(@Params(HubParams) p: P<typeof HubParams>, @ReqState() state: RequestState) {
    return this.hubs.publicLegal(state, p.hubId);
  }

  @Post(':hubId/legal/:documentId/accept') @HttpCode(200) @Idempotent('hub.legal_accept')
  @Authenticated()
  accept(@Params(DocumentParams) p: P<typeof DocumentParams>, @Body(AcceptLegalDocumentCommandSchema) body: P<typeof AcceptLegalDocumentCommandSchema>, @ReqState() state: RequestState) {
    return this.hubs.accept(state, p.hubId, p.documentId, body);
  }
}
