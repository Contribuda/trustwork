import type { AccessInventory } from '../inventory.js';

/**
 * ADM-004 (packages/data/migrations/staff-lifecycle): the staff directory, the effective-access read (part 1), staff
 * invitations (part 2), eligible roles and just-in-time activations (part 3).
 */
export default {
  package: 'ADM-004',
  forcedTables: ['staff_invitation', 'staff_eligible_role', 'staff_activation'],
  apiDefiners: [
    'staff_require_hub_staff', 'staff_directory', 'staff_effective_assignments',
    'staff_invite', 'staff_invitation_respond', 'staff_invitation_apply', 'staff_invitation_withdraw', 'staff_my_invitations',
    'staff_grant_eligible_role', 'staff_revoke_eligible_role', 'staff_activation_request', 'staff_activation_decide', 'staff_activation_end',
  ],
  workerDefiners: [],
} satisfies AccessInventory;
