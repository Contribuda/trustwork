/**
 * Relative re-exports of the ADM-004 slice: the module imports its repository, schema and contract files directly so the
 * shared package entries stay untouched (exporting them from the barrels is integrator bookkeeping).
 */
export { staffLifecycle } from '../../../../../../packages/data/src/repositories/staff-lifecycle.js';
export type {
  MyStaffInvitationRow, StaffAccessReviewCampaignRow, StaffAccessReviewItemRow, StaffAccountabilityOfferRow, StaffAccountabilityReadRow, StaffAccountabilityRow, StaffActivationJoinedRow,
  StaffActivationRow, StaffDirectoryRow, StaffEligibleRoleRow, StaffInvitationRow, StaffOffboardingRow,
} from '../../../../../../packages/data/src/schema/staff-lifecycle.js';
export {
  AssignAccountabilityCommandSchema, DecideAccessReviewItemCommandSchema, DecideActivationCommandSchema, EffectiveAccessQuerySchema, EffectiveAccessSchema, GrantEligibleRoleCommandSchema, InviteStaffCommandSchema, OfferAccountabilityCommandSchema, OffboardingChecklistSchema, OpenAccessReviewCommandSchema, RequestActivationCommandSchema, RespondAccountabilityOfferCommandSchema,
  RespondStaffInvitationSchema, RoleChangeApplyCommandSchema, RoleChangePreviewRequestSchema, StaffDirectoryQuerySchema, StaffDirectorySchema, StartOffboardingCommandSchema,
  type AccessReviewCampaign, type AccessReviewItem, type Accountability, type AccountabilityOffer, type EffectiveAccess, type Offboarding, type OffboardingChecklist, type MyStaffInvitation, type RoleChangePreview, type StaffActivationView, type StaffDirectory, type StaffEligibleRoleView, type StaffInvitationView,
} from '../../../../../../packages/contracts/src/staff-lifecycle.js';
