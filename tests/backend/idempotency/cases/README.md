# Crash cases per module

Every route classified `in_transaction` in `apps/api/src/common/idempotency/routes.ts` must be crash-tested (BE-005). Modules added after the split put their cases here: one TypeScript file per module exporting a `CrashCase` (see `../cases.ts`) as its default export.

```ts
import type { CrashCase } from '../cases.js';

export default {
  name: 'SANC-003: screening decisions',
  async run({ h, seed, as, exactlyOnce }) {
    const officer = await as('anna');
    await exactlyOnce({ action: 'screening.decide', client: officer, url: '/v1/admin/screening/…', body: {}, effects: async () => 0 });
  },
} satisfies CrashCase;
```

The crash test runs these files in name order after its own cases, so a case may rely on the administration world built by the ADM-001 case. Use a file name that sorts after any case you depend on.
