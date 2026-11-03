import type { AccessInventory } from '../inventory.js';

export default {
  package: 'AGT-023',
  forcedTables: ['agent_extension', 'agent_extension_engine', 'agent_extension_version', 'agent_extension_safety_run', 'agent_extension_transition', 'agent_extension_call'],
  apiDefiners: ['agent_extensions_staff_reader', 'agent_extensions_draft', 'agent_extensions_request_run', 'agent_extensions_draft_activation', 'agent_extensions_suspend', 'agent_extensions_retire'],
  workerDefiners: ['agent_extensions_load_run', 'agent_extensions_record_run', 'agent_extensions_engine_tick', 'agent_extensions_lock_gate', 'agent_extensions_begin_call', 'agent_extensions_finish_call', 'agent_extensions_record_reconciled'],
  internalDefiners: ['agent_extensions_record_transition', 'agent_extensions_on_activation'],
} satisfies AccessInventory;
