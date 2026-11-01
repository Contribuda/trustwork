import type { AccessInventory } from '../inventory.js';
export default {
  package: 'CNT-003',
  forcedTables: ['content_render_blob'],
  apiDefiners: ['content_public_pdf'],
  workerDefiners: ['content_render_fail', 'content_render_finish', 'content_render_prepare'],
} satisfies AccessInventory;
