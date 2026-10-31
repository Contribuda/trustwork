import test from 'node:test';
import assert from 'node:assert/strict';
import { affected } from '../../scripts/ci/affected.mjs';

test('pushes and merge-queue groups always run every suite', () => {
  assert.deepEqual(affected('push', ['docs/a.md']), { web: true, ui: true });
  assert.deepEqual(affected('merge_group', ['apps/api/x.ts']), { web: true, ui: true });
});

test('a backend-only pull request skips the browser and design-system suites', () => {
  assert.deepEqual(affected('pull_request', ['apps/api/src/m.ts', 'packages/data/migrations/x/1.sql', 'tests/data/access.test.ts', 'docs/engine/status.md']), { web: false, ui: false });
});

test('web, contracts, locales, lockfile and workflow changes run the browser suite', () => {
  for (const f of ['apps/web/app/page.tsx', 'packages/contracts/src/client.ts', 'packages/config/src/x.ts', 'package-lock.json', '.github/workflows/check.yml', 'tests/web/a.spec.ts', 'scripts/ci/bundle-budget.mjs']) {
    assert.equal(affected('pull_request', [f]).web, true, f);
  }
});

test('the design-system suite runs for ui package and dependency changes only', () => {
  assert.equal(affected('pull_request', ['packages/ui/src/Button.tsx']).ui, true);
  assert.equal(affected('pull_request', ['package-lock.json']).ui, true);
  assert.equal(affected('pull_request', ['apps/web/app/page.tsx']).ui, false);
});

test('an empty diff runs everything', () => {
  assert.deepEqual(affected('pull_request', []), { web: true, ui: true });
});
