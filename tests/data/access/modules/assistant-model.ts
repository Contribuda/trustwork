import type { AccessInventory } from '../inventory.js';
export default {
  package: 'AST-001',
  forcedTables: ['assistant_model_turn'],
  apiDefiners: ['assistant_begin_model_turn', 'assistant_fence_model_turn', 'assistant_finish_model_turn'],
} satisfies AccessInventory;
