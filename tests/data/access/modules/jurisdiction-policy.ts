import type { AccessInventory } from '../inventory.js';
export default {
  package: 'HUB-005',
  forcedTables: ['jurisdiction_source', 'jurisdiction_source_current', 'jurisdiction_applicability', 'jurisdiction_applicability_current', 'jurisdiction_intent_binding'],
  apiDefiners: ['jurisdiction_limits', 'jurisdiction_bind_intent', 'jurisdiction_recheck_intent', 'jurisdiction_preflight'],
  workerDefiners: ['jurisdiction_begin_attempt'],
  internalDefiners: ['jurisdiction_config_guard', 'jurisdiction_language_guard'],
} satisfies AccessInventory;
