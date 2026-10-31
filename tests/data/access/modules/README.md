# Access inventory per module

One TypeScript file per module that adds migrations, exporting an `AccessInventory` (see `../inventory.ts`) as its default export:

```ts
import type { AccessInventory } from '../inventory.js';

export default {
  package: 'SANC-003',
  forcedTables: ['screening_result', 'screening_match'],
  apiDefiners: ['screening_decide'],
  workerDefiners: ['screening_run_due'],
} satisfies AccessInventory;
```

`tests/data/access.test.ts` adds every file's tables to the forced-RLS inventory and its functions to the SECURITY DEFINER allowlist. Add a file here instead of editing the shared lists in `access.test.ts`, so parallel slices do not conflict. Name the file after the migration directory (`screening.ts` for `packages/data/migrations/screening/`).
