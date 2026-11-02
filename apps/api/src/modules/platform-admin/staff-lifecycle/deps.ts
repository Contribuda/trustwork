/**
 * Relative re-exports of the ADM-004 slice: the module imports its repository, schema and contract files directly so the
 * shared package entries stay untouched (exporting them from the barrels is integrator bookkeeping).
 */
export { staffLifecycle } from '../../../../../../packages/data/src/repositories/staff-lifecycle.js';
export type { MyStaffInvitationRow, StaffDirectoryRow, StaffInvitationRow } from '../../../../../../packages/data/src/schema/staff-lifecycle.js';
export {
  EffectiveAccessQuerySchema, EffectiveAccessSchema, InviteStaffCommandSchema, RespondStaffInvitationSchema, StaffDirectoryQuerySchema, StaffDirectorySchema,
  type EffectiveAccess, type MyStaffInvitation, type StaffDirectory, type StaffInvitationView,
} from '../../../../../../packages/contracts/src/staff-lifecycle.js';
