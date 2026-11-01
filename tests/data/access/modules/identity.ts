import type { AccessInventory } from '../inventory.js';

/**
 * Identity module additions after the inventory split (packages/data/migrations/identity). QA-002 D5 (integrator fix
 * in BE-002's module): the language a person last used for their own account actions, and its tag-only owner-run read
 * for mail someone else causes for them. The earlier identity tables and functions stay in access.test.ts.
 */
export default {
  package: 'BE-002',
  forcedTables: ['person_mail_locale'],
  apiDefiners: ['identity_mail_locale'],
} satisfies AccessInventory;
