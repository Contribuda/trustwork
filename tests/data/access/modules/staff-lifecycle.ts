import type { AccessInventory } from '../inventory.js';

/**
 * ADM-004 (packages/data/migrations/staff-lifecycle): the staff directory, the effective-access read (part 1) and staff
 * invitations (part 2).
 */
export default {
  package: 'ADM-004',
  forcedTables: ['staff_invitation'],
  apiDefiners: [
    'staff_require_hub_staff', 'staff_directory', 'staff_effective_assignments',
    'staff_invite', 'staff_invitation_respond', 'staff_invitation_apply', 'staff_invitation_withdraw', 'staff_my_invitations',
  ],
  workerDefiners: [],
} satisfies AccessInventory;
