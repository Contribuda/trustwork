import type { AccessInventory } from '../inventory.js';

/**
 * ADM-004 (packages/data/migrations/staff-lifecycle): the staff directory, the effective-access read (part 1), staff
 * invitations (part 2), eligible roles and just-in-time activations (part 3), access-review campaigns (part 4), function accountability and offboarding (part 5).
 */
export default {
  package: 'ADM-004',
  forcedTables: ['staff_invitation', 'staff_eligible_role', 'staff_activation', 'staff_access_review_campaign', 'staff_access_review_item', 'staff_accountability', 'staff_accountability_offer', 'staff_offboarding'],
  apiDefiners: [
    'staff_require_hub_staff', 'staff_directory', 'staff_effective_assignments',
    'staff_invite', 'staff_invitation_respond', 'staff_invitation_apply', 'staff_invitation_withdraw', 'staff_my_invitations', 'staff_invitations_of_self', 'staff_invitation_scope', 'staff_sod_state',
    'staff_grant_eligible_role', 'staff_revoke_eligible_role', 'staff_activation_request', 'staff_activation_decide', 'staff_activation_end',
    'staff_access_review_open', 'staff_access_review_decide', 'staff_access_review_withdraw',
    'staff_accountability_assign', 'staff_accountability_end', 'staff_accountability_resume', 'staff_accountability_offer', 'staff_accountability_respond', 'staff_accountabilities',
    'staff_offboarding_start', 'staff_offboarding_checklist', 'staff_offboarding_complete', 'staff_offboarding_cancel',
  ],
  workerDefiners: [],
} satisfies AccessInventory;
