import type { AccessInventory } from '../inventory.js';

/**
 * REG-001 (packages/data/migrations/registers): register adapters, append-only sourced facts, reviewed links and expiry
 * reminders.
 */
export default {
  package: 'REG-001',
  forcedTables: ['register_adapter', 'register_fact', 'register_fact_link', 'register_reminder'],
  apiDefiners: [
    'registers_bind_adapter', 'registers_go_live', 'registers_retire_adapter', 'registers_record_fake_run', 'registers_link_record', 'registers_end_link',
    'registers_staff_reader', 'registers_company_facts', 'registers_public_facts', 'registers_own_reminders', 'registers_identifier_facts',
  ],
  workerDefiners: ['registers_due_adapters', 'registers_record_adapter_run', 'registers_run_expiry_watch', 'registers_adapter_subjects', 'registers_mark_visited'],
} satisfies AccessInventory;
