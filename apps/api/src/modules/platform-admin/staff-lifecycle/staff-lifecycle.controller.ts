import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { Body, Params, Query } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { PlainCommandSchema } from '../schemas.js';
import { EffectiveAccessQuerySchema, InviteStaffCommandSchema, RespondStaffInvitationSchema, StaffDirectoryQuerySchema } from './deps.js';
import { StaffLifecycleService } from './staff-lifecycle.service.js';

const IdParams = z.strictObject({ id: z.uuid() });
const HubQuery = z.strictObject({ hubId: z.uuid() });

function elevated(state: RequestState, elevation: SessionElevationRow, request: TrustworkRequest) {
  const header = request.headers['idempotency-key'];
  return { state, elevationId: elevation.id, idempotencyKey: Array.isArray(header) ? header[0] : header };
}

/**
 * ADM-004 staff routes (docs/engine/hub-console/console-design.md, section 4.2), like every console route only in an
 * elevated staff session. Nothing here reports what a staff member did.
 */
@Controller('v1/admin/staff')
@Authenticated()
@UseGuards(ElevationGuard)
export class StaffLifecycleController {
  constructor(@Inject(StaffLifecycleService) private readonly staff: StaffLifecycleService) {}

  /** Names of the staff covering the hub; roles and second-factor state with `admin.staff.read`. */
  @Get('directory')
  directory(@Query(StaffDirectoryQuerySchema) q: z.infer<typeof StaffDirectoryQuerySchema>, @ReqState() state: RequestState) {
    return this.staff.directory(state, q.hubId);
  }

  /** What one staff member may do at the hub now, from released definitions and active assignments. */
  @Get('effective-access')
  effectiveAccess(@Query(EffectiveAccessQuerySchema) q: z.infer<typeof EffectiveAccessQuerySchema>, @ReqState() state: RequestState) {
    return this.staff.effectiveAccess(state, q.hubId, q.personId);
  }

  /** Invitations of the hub (and of the node and platform) the reader may see with `admin.staff.read`. */
  @Get('invitations')
  invitations(@Query(HubQuery) q: z.infer<typeof HubQuery>, @ReqState() state: RequestState) {
    return this.staff.invitations(state, q.hubId);
  }

  @Post('invitations') @HttpCode(201) @Idempotent('admin.staff.invite')
  invite(@Body(InviteStaffCommandSchema) body: z.infer<typeof InviteStaffCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.invite(elevated(state, e, r), body);
  }

  /** The inviter turns an accepted invitation into the role; a sensitive role asks a second person first. */
  @Post('invitations/:id/apply') @HttpCode(200) @Idempotent('admin.staff.invitation_apply', 'id')
  apply(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.apply(elevated(state, e, r), p.id, body);
  }

  @Post('invitations/:id/withdraw') @HttpCode(200) @Idempotent('admin.staff.invitation_withdraw', 'id')
  withdraw(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.withdraw(elevated(state, e, r), p.id, body);
  }
}

/** The invitee's side: any signed-in person sees and answers only invitations to their own verified addresses. */
@Controller('v1/me/staff-invitations')
@Authenticated()
export class MyStaffInvitationsController {
  constructor(@Inject(StaffLifecycleService) private readonly staff: StaffLifecycleService) {}

  @Get()
  mine(@ReqState() state: RequestState) {
    return this.staff.mine(state);
  }

  @Post(':id/respond') @HttpCode(200) @Idempotent('admin.staff.invitation_respond', 'id')
  respond(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(RespondStaffInvitationSchema) body: z.infer<typeof RespondStaffInvitationSchema>, @ReqState() state: RequestState) {
    return this.staff.respond(state, p.id, body.accept);
  }
}
