import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Row shapes of ADM-004 staff lifecycle (migration packages/data/migrations/staff-lifecycle). Part 1 reads the staff
 * directory through SECURITY DEFINER functions; part 2 adds staff invitations, read by staff with `admin.staff.read`
 * under row-level security and changed only through the `staff_invite`, `staff_invitation_*` commands; part 3 adds
 * eligible roles and their just-in-time activations (`staff_grant_eligible_role`, `staff_activation_*`).
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

/* ---------- Part 3: eligible roles and activations ---------- */

export interface StaffEligibleRoleTable {
  id: Generated<string>;
  person_id: string;
  role: string;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  definition_version: number;
  max_activation_seconds: string;
  granted_by: string;
  reason: string;
  valid_from: Generated<Date>;
  valid_until: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffEligibleRoleRow = Selectable<StaffEligibleRoleTable>;

export type StaffActivationStatus = 'pending' | 'active' | 'declined' | 'withdrawn';

export interface StaffActivationTable {
  id: Generated<string>;
  eligible_role_id: string;
  person_id: string;
  role: string;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  window_seconds: string;
  sensitive: boolean;
  reason: string;
  requested_elevation_id: string;
  status: Generated<StaffActivationStatus>;
  approval_id: string | null;
  decided_by: string | null;
  assignment_id: string | null;
  active_from: Date | null;
  active_until: Date | null;
  withdrawn_by: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffActivationRow = Selectable<StaffActivationTable>;

/** An activation joined with what its assignment and approval say now (the computed state needs both). */
export interface StaffActivationJoinedRow extends StaffActivationRow {
  assignment_revoked_at: Date | null;
  assignment_valid_until: Date | null;
  approval_status: string | null;
  approval_request_expires_at: Date | null;
  approved_by: string | null;
}

/* ---------- Part 4: access reviews ---------- */

export type AccessReviewCampaignStatus = 'open' | 'closed' | 'withdrawn';

export interface StaffAccessReviewCampaignTable {
  id: Generated<string>;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  title: string;
  roles: string[] | null;
  due_at: Date;
  opened_by: string;
  reason: string;
  status: Generated<AccessReviewCampaignStatus>;
  closed_at: Date | null;
  closed_by: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffAccessReviewCampaignRow = Selectable<StaffAccessReviewCampaignTable>;

export interface StaffAccessReviewItemTable {
  id: Generated<string>;
  campaign_id: string;
  assignment_id: string;
  holder_person_id: string;
  role: string;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  verdict: 'keep' | 'remove' | null;
  effect: 'kept' | 'revoked' | 'already_ended' | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffAccessReviewItemRow = Selectable<StaffAccessReviewItemTable>;

export interface StaffLifecycleDatabase {
  staff_invitation: StaffInvitationTable;
  staff_eligible_role: StaffEligibleRoleTable;
  staff_activation: StaffActivationTable;
  staff_access_review_campaign: StaffAccessReviewCampaignTable;
  staff_access_review_item: StaffAccessReviewItemTable;
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
  staff_eligible_role: columns('staff_eligible_role', [
    'id', 'person_id', 'role', 'scope_kind', 'node_id', 'hub_id', 'definition_version', 'max_activation_seconds', 'granted_by', 'reason', 'valid_from', 'valid_until',
    'revoked_at', 'revoked_by', 'revoke_reason', 'revision', 'created_at', 'updated_at',
  ]),
  staff_activation: columns('staff_activation', [
    'id', 'eligible_role_id', 'person_id', 'role', 'scope_kind', 'node_id', 'hub_id', 'window_seconds', 'sensitive', 'reason', 'requested_elevation_id', 'status', 'approval_id',
    'decided_by', 'assignment_id', 'active_from', 'active_until', 'withdrawn_by', 'revision', 'created_at', 'updated_at',
  ]),
  staff_access_review_campaign: columns('staff_access_review_campaign', [
    'id', 'scope_kind', 'node_id', 'hub_id', 'title', 'roles', 'due_at', 'opened_by', 'reason', 'status', 'closed_at', 'closed_by', 'revision', 'created_at', 'updated_at',
  ]),
  staff_access_review_item: columns('staff_access_review_item', [
    'id', 'campaign_id', 'assignment_id', 'holder_person_id', 'role', 'scope_kind', 'node_id', 'hub_id', 'verdict', 'effect', 'decided_by', 'decided_at', 'decision_reason', 'revision',
    'created_at', 'updated_at',
  ]),
};
