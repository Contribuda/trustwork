/**
 * Relative re-exports of the ADM-004 slice: the module imports its repository, schema and contract files directly so the
 * shared package entries stay untouched (exporting them from the barrels is integrator bookkeeping).
 */
export { staffLifecycle } from '../../../../../../packages/data/src/repositories/staff-lifecycle.js';
export type {
  MyStaffInvitationRow, StaffActivationJoinedRow, StaffActivationRow, StaffDirectoryRow, StaffEligibleRoleRow, StaffInvitationRow,
} from '../../../../../../packages/data/src/schema/staff-lifecycle.js';
export {
  DecideActivationCommandSchema, EffectiveAccessQuerySchema, EffectiveAccessSchema, GrantEligibleRoleCommandSchema, InviteStaffCommandSchema, RequestActivationCommandSchema,
  RespondStaffInvitationSchema, RoleChangeApplyCommandSchema, RoleChangePreviewRequestSchema, StaffDirectoryQuerySchema, StaffDirectorySchema,
  type EffectiveAccess, type MyStaffInvitation, type RoleChangePreview, type StaffActivationView, type StaffDirectory, type StaffEligibleRoleView, type StaffInvitationView,
} from '../../../../../../packages/contracts/src/staff-lifecycle.js';
