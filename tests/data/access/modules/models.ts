import type { AccessInventory } from '../inventory.js';
export default {
  package: 'LLM-001',
  forcedTables: ['model_attempt_receipt', 'model_call'],
  apiDefiners: ['models_admit', 'models_begin', 'models_check_authority', 'models_check_receipt_authority', 'models_fallback', 'models_finish'],
} satisfies AccessInventory;
