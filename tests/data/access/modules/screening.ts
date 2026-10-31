import type { AccessInventory } from '../inventory.js';

/** SANC-003 (packages/data/migrations/screening): screening states, results, matches, decisions and report drafts. */
export default {
  package: 'SANC-003',
  forcedTables: ['screening_decision', 'screening_match', 'screening_report_draft', 'screening_result', 'screening_subject_state'],
  apiDefiners: ['screening_state', 'screening_own_status', 'screening_caller_suspended', 'screening_session_suspended', 'screening_file_appeal', 'screening_confirm_match',
    'screening_propose_not_same_person', 'screening_decide_proposal', 'screening_decide_appeal'],
  workerDefiners: ['screening_subject_names', 'screening_should_screen', 'screening_lists_now', 'screening_candidates', 'screening_record_result', 'screening_sweep_due'],
} satisfies AccessInventory;
