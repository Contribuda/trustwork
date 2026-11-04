import type { AccessInventory } from '../inventory.js';

/**
 * ADM-005 (packages/data/migrations/console-services): flag rollout, saved views and notification settings. The lookup
 * and the work-item read are invoker functions under row-level security; the definers here answer about the caller.
 */
export default {
  package: 'ADM-005',
  forcedTables: ['feature_flag_rollout', 'console_saved_view', 'console_notification_setting'],
  apiDefiners: [
    'console_is_staff', 'console_role_holding', 'console_conflicted', 'console_approval_decidable', 'console_holds_role',
    'console_flag_set_stage', 'console_view_create', 'console_view_update', 'console_view_remove', 'console_notifications_set',
  ],
  workerDefiners: [],
} satisfies AccessInventory;
