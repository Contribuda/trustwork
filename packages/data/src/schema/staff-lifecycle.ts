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
  function_key: string | null;
  function_title: string | null;
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
  function_key: string | null;
  function_title: string | null;
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

/* ---------- Part 5: accountability and offboarding ---------- */

export type AccountabilityKind = 'function_owner' | 'agent_role';
export type AccountabilityStatus = 'active' | 'suspended' | 'ended';

export interface StaffAccountabilityTable {
  id: Generated<string>;
  hub_id: string;
  function_key: string;
  kind: AccountabilityKind;
  agent_role_key: string | null;
  person_id: string;
  required_role: string | null;
  status: Generated<AccountabilityStatus>;
  suspended_reason: 'holder_lost_role' | 'offboarding' | null;
  assigned_by: string;
  reason: string;
  predecessor_id: string | null;
  ended_at: Date | null;
  ended_by: string | null;
  end_reason: 'ended' | 'handed_over' | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffAccountabilityRow = Selectable<StaffAccountabilityTable>;

export interface StaffAccountabilityOfferTable {
  id: Generated<string>;
  accountability_id: string;
  to_person_id: string;
  offered_by: string;
  offboarding_id: string | null;
  reason: string;
  status: Generated<'pending' | 'accepted' | 'declined' | 'withdrawn'>;
  decided_at: Date | null;
  successor_id: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffAccountabilityOfferRow = Selectable<StaffAccountabilityOfferTable>;

export interface StaffOffboardingTable {
  id: Generated<string>;
  person_id: string;
  scope_kind: 'platform' | 'node' | 'hub';
  node_id: string | null;
  hub_id: string | null;
  reason: string;
  started_by: string;
  status: Generated<'open' | 'completed' | 'cancelled'>;
  completed_at: Date | null;
  completed_by: string | null;
  cancelled_by: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type StaffOffboardingRow = Selectable<StaffOffboardingTable>;

/** One row of `trustwork.staff_accountabilities(hub)`: the row, whether its holder holds the needed role now, and their name. */
export interface StaffAccountabilityReadRow {
  accountability: StaffAccountabilityRow;
  holder_ok: boolean;
  holder_name: string;
}

export interface StaffLifecycleDatabase {
  staff_invitation: StaffInvitationTable;
  staff_eligible_role: StaffEligibleRoleTable;
  staff_activation: StaffActivationTable;
  staff_access_review_campaign: StaffAccessReviewCampaignTable;
  staff_access_review_item: StaffAccessReviewItemTable;
  staff_accountability: StaffAccountabilityTable;
  staff_accountability_offer: StaffAccountabilityOfferTable;
  staff_offboarding: StaffOffboardingTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends StaffLifecycleDatabase {}
}

const columns = columnsOf<StaffLifecycleDatabase>();
export const TABLE_COLUMNS: TableColumns<StaffLifecycleDatabase> = {
  staff_invitation: columns('staff_invitation', [
    'id', 'scope_kind', 'node_id', 'hub_id', 'role', 'definition_version', 'email_normalized', 'person_id', 'valid_for_seconds', 'sensitive', 'invited_by', 'reason', 'status',
    'expires_at', 'responded_at', 'approval_id', 'assignment_id', 'withdrawn_by', 'revision', 'created_at', 'updated_at', 'function_key', 'function_title',
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
  staff_accountability: columns('staff_accountability', [
    'id', 'hub_id', 'function_key', 'kind', 'agent_role_key', 'person_id', 'required_role', 'status', 'suspended_reason', 'assigned_by', 'reason', 'predecessor_id', 'ended_at', 'ended_by',
    'end_reason', 'revision', 'created_at', 'updated_at',
  ]),
  staff_accountability_offer: columns('staff_accountability_offer', [
    'id', 'accountability_id', 'to_person_id', 'offered_by', 'offboarding_id', 'reason', 'status', 'decided_at', 'successor_id', 'revision', 'created_at', 'updated_at',
  ]),
  staff_offboarding: columns('staff_offboarding', [
    'id', 'person_id', 'scope_kind', 'node_id', 'hub_id', 'reason', 'started_by', 'status', 'completed_at', 'completed_by', 'cancelled_by', 'revision', 'created_at', 'updated_at',
  ]),
};
