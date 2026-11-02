import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Row shapes of ADM-004 staff lifecycle (migration packages/data/migrations/staff-lifecycle). Part 1 reads the staff
 * directory through SECURITY DEFINER functions; part 2 adds staff invitations, read by staff with `admin.staff.read`
 * under row-level security and changed only through the `staff_invite`, `staff_invitation_*` commands.
 */

/** One row of `trustwork.staff_directory(hub)`; `roles` and `second_factor` are null without `admin.staff.read`. */
export interface StaffDirectoryRow {
  person_id: string;
  display_name: string;
  detail: boolean;
  roles: Array<{ assignmentId: string; role: string; scope: { kind: 'platform' } | { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string }; validUntil: string | null; breakglass: boolean }> | null;
  second_factor: 'enrolled' | 'none' | null;
}

export type StaffInvitationStatus = 'pending' | 'accepted' | 'declined' | 'applied' | 'withdrawn';

export interface StaffInvitationTable {
  id: Generated<string>;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  role: string;
  definition_version: number;
  email_normalized: string;
  person_id: string | null;
  valid_for_seconds: string | null;
  sensitive: boolean;
  invited_by: string;
  reason: string;
  status: Generated<StaffInvitationStatus>;
  expires_at: Date;
  responded_at: Date | null;
  approval_id: string | null;
  assignment_id: string | null;
  withdrawn_by: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffInvitationRow = Selectable<StaffInvitationTable>;

/** One row of `trustwork.staff_my_invitations()`: the invitee's own open invitations. */
export interface MyStaffInvitationRow {
  id: string;
  role: string;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  valid_for_seconds: string | null;
  reason: string;
  inviter_name: string;
  expires_at: Date;
  status: StaffInvitationStatus;
}

export interface StaffLifecycleDatabase {
  staff_invitation: StaffInvitationTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends StaffLifecycleDatabase {}
}

const columns = columnsOf<StaffLifecycleDatabase>();
export const TABLE_COLUMNS: TableColumns<StaffLifecycleDatabase> = {
  staff_invitation: columns('staff_invitation', [
    'id', 'scope_kind', 'node_id', 'hub_id', 'role', 'definition_version', 'email_normalized', 'person_id', 'valid_for_seconds', 'sensitive', 'invited_by', 'reason', 'status',
    'expires_at', 'responded_at', 'approval_id', 'assignment_id', 'withdrawn_by', 'revision', 'created_at', 'updated_at',
  ]),
};
