import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { Body, Params, Query } from '../../../common/zod.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { PlainCommandSchema } from '../schemas.js';
import {
  AssignAccountabilityCommandSchema, DecideAccessReviewItemCommandSchema, DecideActivationCommandSchema, EffectiveAccessQuerySchema, GrantEligibleRoleCommandSchema, InviteStaffCommandSchema,
  OfferAccountabilityCommandSchema, OpenAccessReviewCommandSchema, RequestActivationCommandSchema, RespondAccountabilityOfferCommandSchema, RespondStaffInvitationSchema,
  RoleChangeApplyCommandSchema, RoleChangePreviewRequestSchema, StaffDirectoryQuerySchema, StartOffboardingCommandSchema,
} from './deps.js';
import { StaffLifecycleService } from './staff-lifecycle.service.js';

const IdParams = z.strictObject({ id: z.uuid() });
const HubQuery = z.strictObject({ hubId: z.uuid() });
const HubPersonQuery = z.strictObject({ hubId: z.uuid(), personId: z.uuid().optional() });

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

  /* ---------- Part 3: eligible roles and just-in-time activation ---------- */

  /** Eligible roles covering the hub: one's own, and everyone's with `admin.staff.read` at the scope. */
  @Get('eligible-roles')
  eligibleRoles(@Query(HubPersonQuery) q: z.infer<typeof HubPersonQuery>, @ReqState() state: RequestState) {
    return this.staff.eligibleRoles(state, q.hubId, q.personId);
  }

  @Post('eligible-roles') @HttpCode(201) @Idempotent('admin.staff.eligible_grant')
  grantEligible(@Body(GrantEligibleRoleCommandSchema) body: z.infer<typeof GrantEligibleRoleCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.grantEligible(elevated(state, e, r), body);
  }

  @Post('eligible-roles/:id/revoke') @HttpCode(200) @Idempotent('admin.staff.eligible_revoke', 'id')
  revokeEligible(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.revokeEligible(elevated(state, e, r), p.id, body);
  }

  /** Activations covering the hub, with their state now; pending ones are the second person's queue. */
  @Get('activations')
  activations(@Query(HubPersonQuery) q: z.infer<typeof HubPersonQuery>, @ReqState() state: RequestState) {
    return this.staff.activations(state, q.hubId, q.personId);
  }

  /** The eligible person activates a role for a window; the second factor must be fresh. */
  @Post('activations') @HttpCode(201) @Idempotent('admin.staff.activation_request')
  requestActivation(@Body(RequestActivationCommandSchema) body: z.infer<typeof RequestActivationCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.requestActivation(elevated(state, e, r), body);
  }

  @Post('activations/:id/decide') @HttpCode(200) @Idempotent('admin.staff.activation_decide', 'id')
  decideActivation(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(DecideActivationCommandSchema) body: z.infer<typeof DecideActivationCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.decideActivation(elevated(state, e, r), p.id, body);
  }

  @Post('activations/:id/end') @HttpCode(200) @Idempotent('admin.staff.activation_end', 'id')
  endActivation(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.endActivation(elevated(state, e, r), p.id, body);
  }

  /* ---------- Part 4: access reviews ---------- */

  /** Campaigns covering the hub with their tallies (`admin.staff.read` at the scope). */
  @Get('access-reviews')
  accessReviews(@Query(HubQuery) q: z.infer<typeof HubQuery>, @ReqState() state: RequestState) {
    return this.staff.accessReviews(state, q.hubId);
  }

  @Get('access-reviews/:id')
  accessReview(@Params(IdParams) p: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    return this.staff.accessReview(state, p.id);
  }

  /** Opens a campaign over the standing assignments held at the scope; needs `admin.staff.revoke` there. */
  @Post('access-reviews') @HttpCode(201) @Idempotent('admin.staff.access_review_open')
  openAccessReview(@Body(OpenAccessReviewCommandSchema) body: z.infer<typeof OpenAccessReviewCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.openAccessReview(elevated(state, e, r), body);
  }

  @Post('access-reviews/:id/withdraw') @HttpCode(200) @Idempotent('admin.staff.access_review_withdraw', 'id')
  withdrawAccessReview(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.withdrawAccessReview(elevated(state, e, r), p.id, body);
  }

  /** Keep or remove one assignment, by a reviewer who is not its holder; after the deadline only the scope's owner role. */
  @Post('access-reviews/items/:id/decide') @HttpCode(200) @Idempotent('admin.staff.access_review_decide', 'id')
  decideAccessReviewItem(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(DecideAccessReviewItemCommandSchema) body: z.infer<typeof DecideAccessReviewItemCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.decideAccessReviewItem(elevated(state, e, r), p.id, body);
  }

  /* ---------- Part 5: accountability and offboarding ---------- */

  /** Who answers for each function and agent role of the hub (one's own rows; all with `admin.staff.read`). */
  @Get('accountability')
  accountabilities(@Query(HubQuery) q: z.infer<typeof HubQuery>, @ReqState() state: RequestState) {
    return this.staff.accountabilities(state, q.hubId);
  }

  @Post('accountability') @HttpCode(201) @Idempotent('admin.staff.accountability_assign')
  assignAccountability(@Body(AssignAccountabilityCommandSchema) body: z.infer<typeof AssignAccountabilityCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.assignAccountability(elevated(state, e, r), body);
  }

  @Post('accountability/:id/end') @HttpCode(200) @Idempotent('admin.staff.accountability_end', 'id')
  endAccountability(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.endAccountability(elevated(state, e, r), p.id, body);
  }

  @Post('accountability/:id/resume') @HttpCode(200) @Idempotent('admin.staff.accountability_resume', 'id')
  resumeAccountability(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.resumeAccountability(elevated(state, e, r), p.id, body);
  }

  /** Offer the hand-over to a named person (the holder, or `admin.staff.assign` at the hub); they must accept. */
  @Post('accountability/:id/offer') @HttpCode(201) @Idempotent('admin.staff.accountability_offer', 'id')
  offerAccountability(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(OfferAccountabilityCommandSchema) body: z.infer<typeof OfferAccountabilityCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.offerAccountability(elevated(state, e, r), p.id, body);
  }

  /** The offers waiting for the signed-in staff member. */
  @Get('accountability/offers')
  myAccountabilityOffers(@ReqState() state: RequestState) {
    return this.staff.myAccountabilityOffers(state);
  }

  @Post('accountability/offers/:id/respond') @HttpCode(200) @Idempotent('admin.staff.accountability_respond', 'id')
  respondAccountabilityOffer(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(RespondAccountabilityOfferCommandSchema) body: z.infer<typeof RespondAccountabilityOfferCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.respondAccountabilityOffer(elevated(state, e, r), p.id, body);
  }

  @Get('offboardings')
  offboardings(@Query(HubQuery) q: z.infer<typeof HubQuery>, @ReqState() state: RequestState) {
    return this.staff.offboardings(state, q.hubId);
  }

  /** The offboarding with its checklist (`admin.staff.read` at its scope). */
  @Get('offboardings/:id')
  offboarding(@Params(IdParams) p: z.infer<typeof IdParams>, @ReqState() state: RequestState) {
    return this.staff.offboarding(state, p.id);
  }

  @Post('offboardings') @HttpCode(201) @Idempotent('admin.staff.offboarding_start')
  startOffboarding(@Body(StartOffboardingCommandSchema) body: z.infer<typeof StartOffboardingCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.startOffboarding(elevated(state, e, r), body);
  }

  @Post('offboardings/:id/complete') @HttpCode(200) @Idempotent('admin.staff.offboarding_complete', 'id')
  completeOffboarding(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.completeOffboarding(elevated(state, e, r), p.id, body);
  }

  @Post('offboardings/:id/cancel') @HttpCode(200) @Idempotent('admin.staff.offboarding_cancel', 'id')
  cancelOffboarding(@Params(IdParams) p: z.infer<typeof IdParams>, @Body(PlainCommandSchema) body: z.infer<typeof PlainCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.cancelOffboarding(elevated(state, e, r), p.id, body);
  }

  /* ---------- Part 3: role change with preview ---------- */

  /** A read with a body: the difference a role change would make, computed from the rows as they are now and never stored. */
  @Post('role-changes/preview') @HttpCode(200)
  previewRoleChange(@Body(RoleChangePreviewRequestSchema) body: z.infer<typeof RoleChangePreviewRequestSchema>, @ReqState() state: RequestState) {
    return this.staff.previewRoleChange(state, body);
  }

  @Post('role-changes/apply') @HttpCode(200) @Idempotent('admin.staff.role_change_apply')
  applyRoleChange(@Body(RoleChangeApplyCommandSchema) body: z.infer<typeof RoleChangeApplyCommandSchema>, @ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Req() r: TrustworkRequest) {
    return this.staff.applyRoleChange(elevated(state, e, r), body);
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
