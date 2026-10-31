import type { AccessInventory } from '../inventory.js';

/** PRC-001 (packages/data/migrations/approval-routes): route versions, requests and their steps, decisions and delegations. */
export default {
  package: 'PRC-001',
  forcedTables: ['approval_decision', 'approval_delegation', 'approval_request', 'approval_request_step', 'approval_route_version'],
  apiDefiners: ['approval_member_of', 'approval_holds_permission', 'approval_request_visible', 'approval_draft_route', 'approval_activate_route', 'approval_submit',
    'approval_supersede', 'approval_withdraw', 'approval_decide', 'approval_delegate', 'approval_revoke_delegation', 'approval_viewer_options', 'approval_decisions_waiting'],
  workerDefiners: ['approval_escalate_due'],
} satisfies AccessInventory;
