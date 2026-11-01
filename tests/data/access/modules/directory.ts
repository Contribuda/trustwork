import type { AccessInventory } from '../inventory.js';

/**
 * Directory module additions after the inventory split (packages/data/migrations/directory). QA-002 D2 (integrator fix
 * in BE-003's module): owner-run public reads of a published project's owner and of a company's published projects.
 * The earlier directory functions stay in access.test.ts.
 */
export default {
  package: 'BE-003',
  forcedTables: [],
  apiDefiners: ['directory_public_company_projects', 'directory_public_project_owners'],
} satisfies AccessInventory;
